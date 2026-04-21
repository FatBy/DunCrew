/**
 * knowledgeIngestService.ts - LLM-Wiki 增量知识摄入管道 (V2: Entity-Claim-Evidence)
 *
 * V2 核心改造：
 * - LLM 直接输出 Entity/Claim/Evidence 结构化 JSON（而非 MD 文本）
 * - 写入 SQLite wiki 表（而非文件系统 .md）
 * - 支持 Entity 去重判断、Claim 冲突检测
 *
 * 触发机制不变：recordFlush() → 阈值触发 → ingest()
 */

import { chatBackground, isLLMConfigured } from './llmService'
import { memoryStore } from './memoryStore'
import { getServerUrl } from '@/utils/env'
import { useStore } from '@/store'

// ============================================
// INGEST_PROMPT (V2: Entity-Claim-Evidence)
// ============================================

export const INGEST_PROMPT = [
  '你是一个知识图谱编辑器。你的任务是将新的认知整合到结构化知识库中。',
  '',
  '## 输入',
  '你会收到三部分内容：',
  '1. **Entity 索引**：现有所有知识实体的 {id, title, type, tldr}',
  '2. **相关 Entity 详情**：与新认知最相关的 Entity 的完整 Claims 列表（可能为空）',
  '3. **新认知**：需要整合的内容',
  '',
  '## 判断流程',
  '在输出 JSON 前，先判断：',
  '1. 新认知是否属于已有 Entity？检查 Entity 索引中是否有语义相近的 title',
  '   - 如果是 → 输出 op: "update"，使用已有 entity id',
  '   - 如果否 → 输出 op: "create"，创建新 Entity',
  '2. 判断标准：同一概念的不同表述（"情绪消费" ≈ "情感经济"）应合并；',
  '   相关但不同的概念（"情绪消费" ≠ "冲动消费"）应分开',
  '3. 如果新认知只是常规操作记录、没有可复用价值 → 输出 {"op":"noop"}',
  '',
  '## 输出',
  '严格输出 JSON（不要输出任何其他内容，不要用 markdown 代码块包裹）：',
  '',
  '不值得记录时：',
  '{"op":"noop"}',
  '',
  '更新已有 Entity 时：',
  '{"op":"update","entity":{"id":"已有entity的id","title":"标题","type":"concept|topic|pattern","tldr":"一句话摘要","tags":["tag1"],"slug":"kebab-case","category":"分类(可选)","temporal_scope":"时间范围(可选)"},"claims":[{"content":"断言内容","type":"insight","confidence":0.8,"observed_at":"事实时间(可选)","source_summary":"来源摘要(可选)","evidence":{"source_name":"来源"}}],"relations":[{"target_title":"关联Entity标题","type":"related_to|contradicts|subtopic_of","description":"关系描述"}]}',
  '',
  '创建新 Entity 时：',
  '{"op":"create","entity":{"title":"新标题","type":"concept|topic|pattern","tldr":"一句话摘要","tags":["tag1"],"slug":"kebab-case","category":"分类(可选)","temporal_scope":"时间范围(可选)"},"claims":[...],"relations":[...]}',
  '',
  '## Entity 粒度',
  '- "可独立引用"为标准：主题/领域、概念 → Entity；数据点 → Claim；来源报告 → Evidence',
  '',
  '## Claim 结构',
  '{"content":"断言内容","type":"metric|insight|pattern|fact","value":"数值(仅metric)","trend":"up|down|stable(仅metric)","confidence":0.8,"observed_at":"事实观察时间(可选,如:2024-03)","source_summary":"一句话来源摘要(可选)","evidence":{"source_name":"来源","chunk_text":"原始片段(可选)"}}',
  '',
  '## Relation 结构',
  '{"target_title":"关联Entity标题","type":"related_to|contradicts|subtopic_of","description":"关系描述"}',
  '',
  '## 规则',
  '- 每次最多 1 个 Entity 操作（保持原子性）',
  '- Claims 不超过 5 条（只提取最有价值的）',
  '- 知识粒度：可复用的模式或关键认知，不是一次性事件',
  '- 如果新认知与现有 Claim 的数值/结论矛盾，在 relations 中用 contradicts 标注',
  '- 纯工具操作日志、没有可复用价值的内容，输出 {"op":"noop"}',
  '- category: 从内容推断的主题分类(经济/技术/政策/社会/产品)，不确定则不填',
  '- temporal_scope: 该 Entity 涉及的时间段，不确定则不填',
  '- observed_at: 该 Claim 对应事实的观察时间，不确定则不填',
  '- source_summary: 一句话概括该 Claim 的来源上下文',
  '- confidence: 原文明确=0.9, 推导=0.7, 不确定=0.5',
].join('\n')

// ============================================
// Types (V2: Entity-Claim-Evidence)
// ============================================

/** LLM 输出的 Entity 结构 */
interface IngestEntity {
  id?: string
  title: string
  type?: string
  tldr?: string
  tags?: string[]
  slug?: string
  category?: string
  temporal_scope?: string
}

/** LLM 输出的 Claim 结构 */
interface IngestClaim {
  content: string
  type?: string
  value?: string
  trend?: string
  confidence?: number
  observed_at?: string
  source_summary?: string
  evidence?: {
    source_name: string
    chunk_text?: string
  }
}

/** LLM 输出的 Relation 结构 */
interface IngestRelation {
  target_title: string
  type: string
  description?: string
}

/** LLM 输出的完整 JSON 结构 */
interface WikiIngestAction {
  op: 'create' | 'update' | 'noop'
  entity?: IngestEntity
  claims?: IngestClaim[]
  relations?: IngestRelation[]
}

/** Entity 索引项 (从后端 API 返回) */
interface EntityIndexEntry {
  id: string
  title: string
  type: string
  tldr: string | null
}

interface DunIngestState {
  pendingFlushCount: number
  lastIngestAt: number
  ingesting: boolean
}

// ============================================
// KnowledgeIngestService (V2)
// ============================================

const INGEST_THRESHOLD = 3

class KnowledgeIngestService {
  private serverUrl = getServerUrl()
  private dunStates = new Map<string, DunIngestState>()
  /** 全局 ingest 计数器（触发 lint 用） */
  private globalIngestCount = 0

  // ---- Public API ----

  /** 记录一次 flush 完成，检查是否触发 ingest */
  recordFlush(dunId: string): void {
    const state = this.getOrCreateState(dunId)
    state.pendingFlushCount++
    this.persistState(dunId, state)

    if (state.pendingFlushCount >= INGEST_THRESHOLD && !state.ingesting) {
      // 延迟 3 秒触发 ingest，等待同轮其他并行 flush（Memory Flush、Response Knowledge Flush 等）写入完成
      // 避免 ingest 读取到不完整的记忆批次
      setTimeout(() => {
        const freshState = this.getOrCreateState(dunId)
        if (!freshState.ingesting) {
          this.ingest(dunId).catch(err => {
            console.warn(`[KnowledgeIngest] Ingest failed for Dun ${dunId}:`, err)
          })
        }
      }, 3000)
    }
  }

  /** 手动触发 ingest */
  async manualIngest(dunId: string): Promise<boolean> {
    const state = this.getOrCreateState(dunId)
    if (state.ingesting) {
      console.log(`[KnowledgeIngest] Dun ${dunId} already ingesting, skipping`)
      return false
    }
    return this.ingest(dunId)
  }

  /** 获取全局 ingest 计数（供 lint 服务查询） */
  getGlobalIngestCount(): number {
    return this.globalIngestCount
  }

  /**
   * 缓冲 Consolidator 预提取的知识实体，直接写入 Wiki API（无 LLM 调用）
   * Consolidator 已完成实体识别，这里负责格式转换 + API 写入
   */
  bufferEntities(
    dunId: string,
    entities: Array<{
      op: string
      entity_name: string
      type?: string
      category?: string
      claims: Array<{ c: string; t?: string; conf?: number } | string>
      relations?: Array<{ target: string; rel?: string }>
    }>,
    context?: { userPrompt?: string },
  ): void {
    if (entities.length === 0) return

    // 异步批量写入，不阻塞 Consolidator
    const doWrite = async () => {
      // 预获取 entity 索引，用于 update op 的 id 查找
      let entityIndex: EntityIndexEntry[] = []
      const hasUpdate = entities.some(e => e.op === 'update')
      if (hasUpdate) {
        entityIndex = await this.fetchEntityIndex(dunId)
      }

      let writtenCount = 0
      for (const ent of entities) {
        if (ent.op === 'noop' || !ent.entity_name) continue

        // update op: 通过 title 匹配查找已有 entity 的 id
        let entityId: string | undefined
        if (ent.op === 'update' && entityIndex.length > 0) {
          const titleLower = ent.entity_name.toLowerCase()
          const match = entityIndex.find(e =>
            e.title.toLowerCase() === titleLower ||
            e.title.toLowerCase().includes(titleLower) ||
            titleLower.includes(e.title.toLowerCase())
          )
          entityId = match?.id
        }

        // Claims: 兼容旧格式（纯字符串）和新格式（{c,t,conf} 对象）
        const claims: IngestClaim[] = ent.claims.map(c => {
          if (typeof c === 'string') {
            return { content: c, type: 'insight' as const, confidence: 0.7 }
          }
          return {
            content: c.c,
            type: (c.t ?? 'insight') as string,
            confidence: c.conf ?? 0.7,
            source_summary: context?.userPrompt
              ? `任务执行: ${context.userPrompt.slice(0, 60)}`
              : undefined,
            evidence: { source_name: 'DunCrew 任务执行' },
          }
        })

        // 取第一条 claim 内容作为 tldr
        const firstClaimText = claims[0]?.content ?? ent.entity_name
        const action: WikiIngestAction = {
          op: (ent.op === 'update' && entityId) ? 'update' : 'create',
          entity: {
            ...(entityId ? { id: entityId } : {}),
            title: ent.entity_name,
            type: ent.type ?? 'concept',
            tldr: firstClaimText.slice(0, 100),
            slug: ent.entity_name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').slice(0, 50),
            category: ent.category,
          },
          claims,
          relations: (ent.relations ?? []).map(r => ({
            target_title: r.target,
            type: r.rel ?? 'related_to',
          })),
        }

        const claimTexts = claims.map(c => c.content).join('; ')
        const inputText = `[Consolidator] ${ent.entity_name}: ${claimTexts}`
        const success = await this.postIngest(dunId, action, inputText, '[from-consolidator]')
        if (success) writtenCount++
      }

      // 更新状态
      const state = this.getOrCreateState(dunId)
      state.pendingFlushCount = 0
      state.lastIngestAt = Date.now()
      this.persistState(dunId, state)
      this.globalIngestCount++
      try { localStorage.setItem('ki_global_count', String(this.globalIngestCount)) } catch { /* SSR safe */ }

      console.log(`[KnowledgeIngest] Buffered ${writtenCount}/${entities.length} entities from Consolidator for Dun ${dunId}`)

      // 通知 Store 刷新 UI
      if (writtenCount > 0) {
        useStore.getState().notifyWikiIngest(dunId)
      }
    }

    doWrite().catch(err => {
      console.warn(`[KnowledgeIngest] bufferEntities failed for Dun ${dunId}:`, err)
    })
  }

  /** 重置全局 ingest 计数（lint 完成后调用） */
  resetGlobalIngestCount(): void {
    this.globalIngestCount = 0
    try { localStorage.setItem('ki_global_count', '0') } catch { /* SSR safe */ }
  }

  /** 启动检查：对有数据但无知识的 Dun 触发 ingest */
  checkPendingOnStartup(): void {
    // 恢复全局计数
    try {
      const saved = localStorage.getItem('ki_global_count')
      if (saved) this.globalIngestCount = parseInt(saved, 10) || 0
    } catch { /* SSR safe */ }

    // 检查 localStorage 中的待处理 ingest
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('ki_flush_')) {
          const dunId = key.slice('ki_flush_'.length)
          const count = parseInt(localStorage.getItem(key) || '0', 10)
          if (count >= INGEST_THRESHOLD) {
            console.log(`[KnowledgeIngest] Startup: Dun ${dunId} has ${count} pending flushes, triggering ingest`)
            this.ingest(dunId).catch(err => {
              console.warn(`[KnowledgeIngest] Startup ingest failed for ${dunId}:`, err)
            })
          }
        }
      }
    } catch { /* SSR safe */ }

    // 检查数据库中有数据但无知识的 Dun + 迁移旧编译文件
    this.checkDatabaseForIngest().catch(err => {
      console.warn('[KnowledgeIngest] Database check failed:', err)
    })
  }

  // ---- Core Ingest (V2: Wiki API) ----

  private async ingest(dunId: string): Promise<boolean> {
    const state = this.getOrCreateState(dunId)
    if (!isLLMConfigured()) {
      console.log('[KnowledgeIngest] LLM not configured, skipping')
      return false
    }

    state.ingesting = true
    try {
      console.log(`[KnowledgeIngest] Starting ingest for Dun ${dunId} (${state.pendingFlushCount} pending)`)

      // 1. 收集最近的记忆
      const memories = await memoryStore.getByDun(dunId, 15)
      const recentMemories = memories.filter(m =>
        (m.source === 'memory' || m.source === 'exec_trace') &&
        m.content && m.content.length > 10 &&
        (m.createdAt || 0) > state.lastIngestAt
      )

      if (recentMemories.length < 1) {
        console.log(`[KnowledgeIngest] No new memories for Dun ${dunId} since last ingest, skipping`)
        state.pendingFlushCount = 0
        this.persistState(dunId, state)
        return false
      }

      // 记录本批次记忆的最大 createdAt（用于精确推进 lastIngestAt）
      const batchMaxCreatedAt = Math.max(...recentMemories.map(m => m.createdAt || 0))

      // 2. 拼接新认知文本
      const newKnowledge = recentMemories
        .slice(0, 5)
        .map(m => m.content || '')
        .join('\n')

      // 3. 获取 Entity 索引
      const entityIndex = await this.fetchEntityIndex(dunId)

      // 4. 简单关键词匹配找相关 Entity，获取其 Claims
      let relevantClaimsSection = ''
      if (entityIndex.length > 0) {
        const relevantEntity = this.findMostRelevantEntity(newKnowledge, entityIndex)
        if (relevantEntity) {
          const claims = await this.fetchEntityClaims(relevantEntity.id)
          if (claims.length > 0) {
            relevantClaimsSection = `## 最相关 Entity: ${relevantEntity.title}\n` +
              claims.map((c: { content: string; type?: string; value?: string }) =>
                `- [${c.type || 'fact'}] ${c.content}${c.value ? ` (${c.value})` : ''}`
              ).join('\n')
          }
        }
      }

      // 5. 构建 LLM 消息
      const indexSection = entityIndex.length > 0
        ? entityIndex.map(e =>
            `{id:"${e.id}", title:"${e.title}", type:"${e.type}", tldr:"${e.tldr || ''}"}`
          ).join('\n')
        : '（知识库为空，这是首次摄入）'

      const messages = [
        { role: 'system' as const, content: INGEST_PROMPT },
        {
          role: 'user' as const,
          content: [
            `## Entity 索引\n${indexSection}`,
            relevantClaimsSection || '（无相关已有 Entity）',
            `## 新认知\n${newKnowledge}`,
          ].join('\n\n'),
        },
      ]

      // 6. 调用 LLM（通过后台队列限流，内置指数退避重试）
      const llmResult = await chatBackground(messages, { priority: 7 })

      if (!llmResult) {
        console.warn('[KnowledgeIngest] LLM returned null')
        return false
      }

      // 7. 解析 V2 JSON
      const action = this.parseWikiIngestAction(llmResult)

      if (action.op === 'noop') {
        console.log('[KnowledgeIngest] LLM decided noop — content not worth ingesting')
        state.pendingFlushCount = 0
        // 只推进到实际处理过的记忆时间戳，避免跳过并行写入的新知识
        state.lastIngestAt = batchMaxCreatedAt
        this.persistState(dunId, state)
        return false
      }

      // 8. POST 到 wiki ingest API
      const success = await this.postIngest(dunId, action, newKnowledge, llmResult)

      if (success) {
        state.pendingFlushCount = 0
        state.lastIngestAt = batchMaxCreatedAt
        this.persistState(dunId, state)
        this.globalIngestCount++
        try { localStorage.setItem('ki_global_count', String(this.globalIngestCount)) } catch { /* SSR safe */ }

        console.log(`[KnowledgeIngest] ${action.op.toUpperCase()} entity "${action.entity?.title}" for Dun ${dunId}`)

        // 通知 Store 刷新 UI
        useStore.getState().notifyWikiIngest(dunId)

        // 通知 lint 服务检查
        if (this.globalIngestCount > 0 && this.globalIngestCount % 20 === 0) {
          this.onLintThresholdReached?.()
        }
      }

      return success
    } finally {
      state.ingesting = false
    }
  }

  /** lint 阈值回调，由外部设置 */
  onLintThresholdReached?: () => void

  // ---- Wiki API Helpers ----

  private async fetchEntityIndex(dunId: string): Promise<EntityIndexEntry[]> {
    try {
      const res = await fetch(
        `${this.serverUrl}/api/wiki/entity-index?dun_id=${encodeURIComponent(dunId)}`
      )
      if (res.ok) return await res.json()
    } catch { /* 静默 */ }
    return []
  }

  /** 获取指定 Dun 的知识库实体标题列表（供 Consolidator 注入 prompt） */
  async getEntityTitles(dunId: string): Promise<string[]> {
    const index = await this.fetchEntityIndex(dunId)
    return index.map(e => e.title)
  }

  private async fetchEntityClaims(
    entityId: string,
  ): Promise<Array<{ content: string; type?: string; value?: string }>> {
    try {
      const res = await fetch(
        `${this.serverUrl}/api/wiki/entity/${encodeURIComponent(entityId)}/claims`
      )
      if (res.ok) return await res.json()
    } catch { /* 静默 */ }
    return []
  }

  private async postIngest(
    dunId: string,
    action: WikiIngestAction,
    inputText: string,
    rawOutput: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/wiki/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dun_id: dunId,
          op: action.op,
          entity: action.entity,
          claims: action.claims || [],
          relations: action.relations || [],
          input_text: inputText.slice(0, 5000),
          raw_output: rawOutput,
        }),
      })
      return res.ok
    } catch { /* 静默 */ }
    return false
  }

  /** 简单关键词匹配：找到与新认知最相关的 Entity */
  private findMostRelevantEntity(
    text: string,
    index: EntityIndexEntry[],
  ): EntityIndexEntry | null {
    if (index.length === 0) return null

    const words = text
      .toLowerCase()
      .split(/[\s,，。！？、；：""''（）()\[\]{}]+/)
      .filter(w => w.length > 1)

    let best: EntityIndexEntry | null = null
    let bestScore = 0

    for (const entry of index) {
      const target = `${entry.title} ${entry.tldr || ''}`.toLowerCase()
      let score = 0
      for (const w of words) {
        if (target.includes(w)) score++
      }
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }

    // 至少 2 个关键词命中才认为相关
    return bestScore >= 2 ? best : null
  }

  // ---- JSON Parsing (V2) ----

  private parseWikiIngestAction(llmOutput: string): WikiIngestAction {
    // 清洗 think tags
    let cleaned = llmOutput
      .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
      .trim()
    // 移除 markdown 代码块包裹
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim()

    // 尝试直接 JSON.parse
    try {
      const parsed = JSON.parse(cleaned)
      if (parsed && typeof parsed.op === 'string') {
        return this.validateIngestAction(parsed)
      }
    } catch {
      // JSON 解析失败，尝试提取 JSON 块
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed && typeof parsed.op === 'string') {
            return this.validateIngestAction(parsed)
          }
        } catch { /* 继续 fallback */ }
      }

      // 最后尝试：检查是否包含 noop
      if (cleaned.includes('"noop"') || cleaned.includes("'noop'")) {
        return { op: 'noop' }
      }
    }

    console.warn('[KnowledgeIngest] JSON parse failed, returning noop')
    return { op: 'noop' }
  }

  private validateIngestAction(parsed: Record<string, unknown>): WikiIngestAction {
    const op = parsed.op as string
    if (op === 'noop') return { op: 'noop' }

    if ((op === 'create' || op === 'update') && parsed.entity) {
      return {
        op,
        entity: parsed.entity as IngestEntity,
        claims: Array.isArray(parsed.claims) ? parsed.claims as IngestClaim[] : [],
        relations: Array.isArray(parsed.relations) ? parsed.relations as IngestRelation[] : [],
      }
    }

    console.warn('[KnowledgeIngest] Invalid action structure, returning noop')
    return { op: 'noop' }
  }

  // ---- State Management ----

  private getOrCreateState(dunId: string): DunIngestState {
    let state = this.dunStates.get(dunId)
    if (!state) {
      let restoredCount = 0
      let restoredAt = 0
      try {
        const savedCount = localStorage.getItem(`ki_flush_${dunId}`)
        if (savedCount) restoredCount = parseInt(savedCount, 10) || 0
        const savedAt = localStorage.getItem(`ki_last_${dunId}`)
        if (savedAt) restoredAt = parseInt(savedAt, 10) || 0
      } catch { /* SSR safe */ }
      state = { pendingFlushCount: restoredCount, lastIngestAt: restoredAt, ingesting: false }
      this.dunStates.set(dunId, state)
    }
    return state
  }

  private persistState(dunId: string, state: DunIngestState): void {
    try {
      if (state.pendingFlushCount > 0) {
        localStorage.setItem(`ki_flush_${dunId}`, String(state.pendingFlushCount))
      } else {
        localStorage.removeItem(`ki_flush_${dunId}`)
      }
      if (state.lastIngestAt > 0) {
        localStorage.setItem(`ki_last_${dunId}`, String(state.lastIngestAt))
      }
    } catch { /* SSR safe */ }
  }

  // ---- Database Check & Auto-Ingest ----

  /** 查询后端，对有数据但无 wiki entity 的 Dun 触发首次 ingest；对有旧编译文件的 Dun 触发迁移 */
  private async checkDatabaseForIngest(): Promise<void> {
    if (!isLLMConfigured()) return

    try {
      const res = await fetch(`${this.serverUrl}/api/memory/compilable-duns`)
      if (!res.ok) return
      const duns: Array<{ dunId: string; traceCount: number; hasKnowledge: boolean }> =
        await res.json()

      // 1. 有旧 MD 知识的 Dun → 优先走迁移（读已提炼的 MD，而非 raw memory）
      const needMigrate = duns.filter(d => d.hasKnowledge)
      for (let i = 0; i < needMigrate.length; i++) {
        const { dunId } = needMigrate[i]
        try {
          if (localStorage.getItem(`ki_wiki_migrated_${dunId}`)) continue
        } catch { /* SSR safe */ }

        // 检查 wiki 是否已有 entity（已迁移则跳过）
        const entityIndex = await this.fetchEntityIndex(dunId)
        if (entityIndex.length > 0) {
          try { localStorage.setItem(`ki_wiki_migrated_${dunId}`, '1') } catch { /* SSR safe */ }
          continue
        }

        const delay = i * 5000
        setTimeout(() => {
          console.log(`[KnowledgeIngest] Migration: ${dunId} (has legacy MD files)`)
          this.migrateLegacyKnowledge(dunId).catch(err => {
            console.warn(`[KnowledgeIngest] Migration failed for ${dunId}:`, err)
          })
        }, delay)
      }

      // 2. 无旧 MD 知识、但有 trace 的 Dun → 从 raw memory 做首次 ingest
      const migrateSet = new Set(needMigrate.map(d => d.dunId))
      let autoIngestIdx = 0
      for (const { dunId, traceCount } of duns) {
        if (traceCount < 2) continue
        if (migrateSet.has(dunId)) continue // 有旧 MD 的走迁移路径，不做 raw memory ingest

        // 检查 wiki 是否已有 entity
        const entityIndex = await this.fetchEntityIndex(dunId)
        if (entityIndex.length > 0) continue

        const delay = (needMigrate.length * 5000) + autoIngestIdx * 8000
        autoIngestIdx++
        const capturedDunId = dunId
        setTimeout(() => {
          console.log(`[KnowledgeIngest] Auto-ingest: ${capturedDunId} (${traceCount} traces, no wiki entities, no legacy MD)`)
          // 重置 lastIngestAt — 旧 MD 系统留下的时间戳会挡住首次 wiki ingest
          const state = this.getOrCreateState(capturedDunId)
          state.lastIngestAt = 0
          this.persistState(capturedDunId, state)
          this.manualIngest(capturedDunId).catch(err => {
            console.warn(`[KnowledgeIngest] Auto-ingest failed for ${capturedDunId}:`, err)
          })
        }, delay)
      }
    } catch { /* 静默 */ }
  }

  // ---- Legacy Migration (V2: MD → Wiki SQLite) ----

  private static readonly LEGACY_FILENAMES = new Set([
    'environment.md', 'preferences.md', 'domain.md', 'tools.md', 'strategies.md',
  ])

  /** 将旧编译 MD 文件通过 LLM 整理为 Entity-Claim-Evidence 结构，写入 wiki 表 */
  private async migrateLegacyKnowledge(dunId: string): Promise<void> {
    if (!isLLMConfigured()) return

    console.log(`[KnowledgeIngest] Checking legacy migration for Dun ${dunId}`)

    try {
      // 1. 获取旧文件列表
      const listRes = await fetch(
        `${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge`
      )
      if (!listRes.ok) return
      const listData = await listRes.json()
      const files: Array<{ filename: string }> = listData.files || []

      const legacyFiles = files.filter(f =>
        KnowledgeIngestService.LEGACY_FILENAMES.has(f.filename)
      )
      if (legacyFiles.length === 0) {
        try { localStorage.setItem(`ki_wiki_migrated_${dunId}`, '1') } catch { /* SSR safe */ }
        return
      }

      console.log(`[KnowledgeIngest] Migrating ${legacyFiles.length} legacy files for Dun ${dunId}`)

      // 2. 读取所有旧文件内容
      const legacyContents: string[] = []
      for (const f of legacyFiles) {
        try {
          const res = await fetch(
            `${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/${encodeURIComponent(f.filename)}`
          )
          if (res.ok) {
            const data = await res.json()
            if (data.exists && data.content && data.content.trim().length > 20) {
              legacyContents.push(`### [来源: ${f.filename}]\n${data.content.slice(0, 3000)}`)
            }
          }
        } catch { /* 静默 */ }
      }

      if (legacyContents.length === 0) {
        try { localStorage.setItem(`ki_wiki_migrated_${dunId}`, '1') } catch { /* SSR safe */ }
        return
      }

      // 3. 逐个旧文件内容送入 V2 ingest 管道
      let migratedCount = 0
      for (const legacy of legacyContents) {
        const entityIndex = await this.fetchEntityIndex(dunId)

        const indexSection = entityIndex.length > 0
          ? entityIndex.map(e =>
              `{id:"${e.id}", title:"${e.title}", type:"${e.type}", tldr:"${e.tldr || ''}"}`
            ).join('\n')
          : '（知识库为空，这是首次摄入）'

        const messages = [
          { role: 'system' as const, content: INGEST_PROMPT },
          {
            role: 'user' as const,
            content: [
              `## Entity 索引\n${indexSection}`,
              '（无相关已有 Entity — 这是存量知识迁移）',
              `## 新认知\n${legacy}`,
            ].join('\n\n'),
          },
        ]

        // 通过后台队列限流，内置重试和间隔控制
        const llmResult = await chatBackground(messages, { priority: 9 })

        if (!llmResult) continue

        const action = this.parseWikiIngestAction(llmResult)
        if (action.op !== 'noop') {
          const migSuccess = await this.postIngest(dunId, action, legacy, llmResult)
          if (migSuccess) migratedCount++
        }
      }

      // 4. 标记已迁移
      try { localStorage.setItem(`ki_wiki_migrated_${dunId}`, '1') } catch { /* SSR safe */ }
      console.log(`[KnowledgeIngest] Migration complete for Dun ${dunId} (${legacyFiles.length} files)`)

      // 通知 Store 刷新 UI
      if (migratedCount > 0) {
        useStore.getState().notifyWikiIngest(dunId)
      }
    } catch (err) {
      console.warn(`[KnowledgeIngest] Migration error for ${dunId}:`, err)
    }
  }
}

/** 全局单例 */
export const knowledgeIngestService = new KnowledgeIngestService()

// App startup: check for pending ingests
if (typeof window !== 'undefined') {
  setTimeout(() => knowledgeIngestService.checkPendingOnStartup(), 5000)
}
