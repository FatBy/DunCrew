/**
 * knowledgeCompiler.ts - Per-Dun 知识编译管道
 *
 * Phase 1: experience 条目 → knowledge/*.md 结构化文档
 * 触发条件：experience 积累 ≥10 条 / 用户手动 / 空闲时
 * 输出：完整文档（Phase 1 不做 diff patch）
 */

import { chatBackground, isLLMConfigured } from './llmService'
import { memoryStore } from './memoryStore'
import { classifyMemoryContent, PROMOTION_PROMPT, parsePromotionResult } from '@/utils/memoryPromotion'
import { getServerUrl } from '@/utils/env'

// ============================================
// 编译 Prompt
// ============================================

/** 知识编译 Prompt — V1: 完整文档输出 */
export const KNOWLEDGE_COMPILE_PROMPT = [
  '你是一个知识库维护者。你的任务是将一组操作经验整合到一份结构化的操作手册中。',
  '',
  '## 输入',
  '你会收到三部分内容：',
  '1. **Dun 角色描述**（这个知识库服务于什么角色）',
  '2. **现有文档**（可能为空，表示首次编译）',
  '3. **新经验条目**（本次需要整合的操作记录）',
  '',
  '## 输出要求',
  '输出更新后的**完整文档**（Markdown 格式）。',
  '',
  '### 知识粒度控制（最重要的规则）',
  '',
  '每条知识必须是**可复用的模式**，不是一次性事件：',
  '',
  '正确粒度：',
  '- ✓ "读取用户上传的文本文件时，需检查 UTF-8 BOM 头"',
  '- ✓ "当 readFile 返回乱码时 → 检查文件 BOM 头，必要时用 utf-8-sig 编码读取"',
  '- ✓ "writeFile 写入超过 3000 字符时 → 分段写入（先 writeFile 创建，再 appendFile 追加）"',
  '',
  '错误粒度（过于具体）：',
  '- ✗ "2026-04-03 在 App.tsx 第 42 行遇到 BOM 问题"',
  '- ✗ "用户让我修改 config.json，我先读取了内容"',
  '',
  '错误粒度（过于笼统）：',
  '- ✗ "注意文件编码问题"',
  '- ✗ "操作前要先确认"',
  '',
  '### 合并规则',
  '',
  '当多条经验描述同一件事时，合并为一条更完整的准则：',
  '',
  '合并示例：',
  '原有两条：',
  '- "writeFile 超过 3000 字符时可能截断"',
  '- "大内容写入时需要分段"',
  '合并为：',
  '- "writeFile 写入超过 3000 字符时 → 分段写入（先 writeFile 创建，再 appendFile 追加）"',
  '',
  '### 文档结构',
  '按主题分节，每节包含相关的操作准则。推荐格式：',
  '',
  '```markdown',
  '## [主题名称]',
  '',
  '- [场景触发条件] → [应该怎么做]（因为[原因]）',
  '- [另一条准则]',
  '```',
  '',
  '### 冲突处理规则',
  '',
  '当新经验与现有知识矛盾时：',
  '- **环境/配置类**（端口、路径、版本等）→ 更新为最新状态，保留变更说明',
  '  例：`端口 3001 被占用（2026-04 确认，此前长期可用）→ 优先使用 3002`',
  '- **行为准则类**（操作方法、最佳实践）→ 以更多成功案例支持的版本为准',
  '- **工具行为类**（工具在不同条件下的表现差异）→ 标注条件分支，保留两种情况',
  '  例：`writeFile 在 Windows 上默认 CRLF，在 Linux 上默认 LF`',
  '- **无法判断** → 保留两个版本并标注"待验证"',
  '',
  '### 其他规则',
  '- 删除被新经验明确覆盖的旧知识',
  '- 每个主题节不超过 10 条准则',
  '- 整份文档不超过 5000 字',
  '- 不要输出任何解释或元评论，只输出文档本身',
].join('\n')

// ============================================
// 知识文件分类
// ============================================

/**
 * 编译管道产出的知识文件类型。
 * 注意：'strategies' 由 Phase 0 deriveStrategies() 纯代码生成，不走编译 Prompt。
 */
export type CompilableKnowledgeFileType =
  | 'environment'     // 环境知识（端口、路径、配置）
  | 'preferences'     // 用户偏好（工具选择、风格偏好）
  | 'domain'          // 领域知识（特定技术栈的操作模式）
  | 'tools'           // 工具使用经验

/** 根据记忆分类映射到知识文件 */
export function mapCategoryToKnowledgeFile(
  category: string,
  content: string,
): CompilableKnowledgeFileType {
  if (category === 'preference') return 'preferences'
  if (category === 'project_context') return 'environment'

  if (category === 'discovery') {
    if (/writeFile|readFile|runCmd|appendFile|listDir|searchFiles|webSearch|webFetch/.test(content)) {
      return 'tools'
    }
    return 'domain'
  }

  return 'domain'
}

// ============================================
// 编译消息构建
// ============================================

/** 单条经验条目 */
export interface ExperienceEntry {
  content: string
  category: string
  timestamp: number
}

/**
 * 构建编译消息（供 LLM 调用）。
 *
 * @param dunNexusSummary - Dun 的角色描述（从 NEXUS.md 提取的一两句话）
 * @param existingDocument - 现有文档内容（空字符串表示首次编译）
 * @param newExperiences - 新的经验条目
 */
export function buildCompileMessages(
  dunNexusSummary: string,
  existingDocument: string,
  newExperiences: ExperienceEntry[],
): Array<{ role: 'system' | 'user'; content: string }> {
  const experienceBlock = newExperiences
    .map((exp, index) => {
      // 精确到小时，帮助 LLM 判断因果顺序
      const dateStr = new Date(exp.timestamp).toISOString().slice(0, 13).replace('T', ' ') + 'h'
      return `${index + 1}. [${dateStr}] ${exp.content}`
    })
    .join('\n')

  const userContentParts = [
    `## Dun 角色\n${dunNexusSummary || '通用执行智能体'}`,
    existingDocument ? `## 现有文档\n\n${existingDocument}` : '',
    `## 新经验条目（${newExperiences.length} 条${!existingDocument ? '，首次编译' : ''}）\n\n${experienceBlock}`,
  ].filter(Boolean)

  return [
    { role: 'system' as const, content: KNOWLEDGE_COMPILE_PROMPT },
    { role: 'user' as const, content: userContentParts.join('\n\n') },
  ]
}

// ============================================
// 输出后处理
// ============================================

/** 文档最大字符数（硬截断兜底） */
const MAX_DOCUMENT_CHARS = 5500

/**
 * 对 LLM 产出的文档做硬截断兜底。
 * LLM 不擅长精确计数，可能产出超过 5000 字的文档。
 * 按 heading 级别从末尾截断，保证文档结构完整。
 */
export function truncateDocumentIfNeeded(document: string): { content: string; truncated: boolean } {
  if (document.length <= MAX_DOCUMENT_CHARS) {
    return { content: document, truncated: false }
  }

  // 按 ## heading 分段
  const sections = document.split(/(?=^## )/m)
  let result = ''

  for (const section of sections) {
    if (result.length + section.length > MAX_DOCUMENT_CHARS) {
      break
    }
    result += section
  }

  // 如果连第一个 section 都超长，硬截断
  if (!result) {
    result = document.slice(0, MAX_DOCUMENT_CHARS)
  }

  return { content: result.trimEnd(), truncated: true }
}

// ============================================
// _index.md 管理
// ============================================

/** _index.md 中的一行条目 */
interface IndexEntry {
  filename: string
  summary: string
  lastHit: string  // ISO date "2026-04-03"
}

/** 解析 _index.md 内容为结构化条目 */
export function parseIndex(content: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue
    // 格式: filename | 摘要描述 | 2026-04-03
    const parts = trimmed.split('|').map(p => p.trim())
    if (parts.length >= 3) {
      entries.push({
        filename: parts[0],
        summary: parts[1],
        lastHit: parts[2],
      })
    }
  }
  return entries
}

/** 将结构化条目序列化为 _index.md 内容 */
export function serializeIndex(entries: IndexEntry[]): string {
  const lines = ['<!-- Knowledge Index - Auto-generated -->']
  for (const entry of entries) {
    lines.push(`${entry.filename} | ${entry.summary} | ${entry.lastHit}`)
  }
  return lines.join('\n') + '\n'
}

/** 简版 BM25 对 _index.md 条目做相关性排序（支持中文 bigram） */
export function rankIndexEntries(query: string, entries: IndexEntry[]): Array<{ entry: IndexEntry; score: number }> {
  if (entries.length === 0 || !query.trim()) return []

  const queryTokens = tokenize(query)
  const N = entries.length
  const avgDl = entries.reduce((sum, e) => sum + e.summary.length, 0) / N

  // 计算每个 token 的 IDF
  const idf = new Map<string, number>()
  for (const token of queryTokens) {
    const df = entries.filter(e => tokenize(e.summary).includes(token)).length
    idf.set(token, Math.log((N - df + 0.5) / (df + 0.5) + 1))
  }

  const k1 = 1.2
  const b = 0.75

  return entries
    .map(entry => {
      const docTokens = tokenize(entry.summary)
      const dl = entry.summary.length
      let score = 0

      for (const token of queryTokens) {
        const tf = docTokens.filter(t => t === token).length
        const idfVal = idf.get(token) || 0
        score += idfVal * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl))
      }

      return { entry, score }
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** 中英文混合分词：英文按空格，中文按 bigram */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 英文单词
  const words = lower.match(/[a-z0-9]+/g)
  if (words) tokens.push(...words)

  // 中文 bigram
  const cjk = lower.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk.slice(i, i + 2))
  }
  // 单字也加入（兜底短文本）
  for (const ch of cjk) {
    tokens.push(ch)
  }

  return tokens
}

// ============================================
// 编译管道服务
// ============================================

/** 编译触发阈值 */
const COMPILE_THRESHOLD = 3

/** Per-Dun 编译状态 */
interface DunCompileState {
  /** 自上次编译以来累积的 flush 次数 */
  pendingFlushCount: number
  /** 上次编译时间 */
  lastCompileAt: number
  /** 是否正在编译中 */
  compiling: boolean
}

/**
 * KnowledgeCompilerService - 编译管道编排器
 *
 * 职责：
 * 1. 追踪每个 Dun 的 flush 计数
 * 2. 达到阈值时触发编译（收集记忆 → 分类 → LLM 编译 → 写入 knowledge/）
 * 3. 管理 _index.md
 */
class KnowledgeCompilerService {
  private serverUrl = getServerUrl()
  private dunStates = new Map<string, DunCompileState>()

  /** 记录一次 flush 完成，检查是否达到编译阈值 */
  recordFlush(dunId: string): void {
    const state = this.getOrCreateState(dunId)
    state.pendingFlushCount++
    this.persistFlushCount(dunId, state.pendingFlushCount)
    if (state.pendingFlushCount >= COMPILE_THRESHOLD && !state.compiling) {
      this.compile(dunId).catch(err => {
        console.warn(`[KnowledgeCompiler] Compile failed for Dun ${dunId}:`, err)
      })
    }
  }

  /** 手动触发编译（用户主动调用或空闲时触发） */
  async manualCompile(dunId: string): Promise<boolean> {
    const state = this.getOrCreateState(dunId)
    if (state.compiling) {
      console.log(`[KnowledgeCompiler] Dun ${dunId} already compiling, skipping`)
      return false
    }
    return this.compile(dunId)
  }

  /** 核心编译流程 */
  private async compile(dunId: string): Promise<boolean> {
    const state = this.getOrCreateState(dunId)
    if (!isLLMConfigured()) {
      console.log('[KnowledgeCompiler] LLM not configured, skipping compile')
      return false
    }

    state.compiling = true
    try {
      console.log(`[KnowledgeCompiler] Starting compile for Dun ${dunId} (${state.pendingFlushCount} pending flushes)`)

      // 1. 从 memoryStore 收集该 Dun 的未编译记忆（memory + exec_trace 都作为编译素材）
      const memories = await memoryStore.getByDun(dunId, 50)
      const compilableMemories = memories.filter(m =>
        (m.source === 'memory' || m.source === 'exec_trace') &&
        m.content &&
        m.content.length > 10
      )

      if (compilableMemories.length < 2) {
        console.log(`[KnowledgeCompiler] Not enough memories for Dun ${dunId} (${compilableMemories.length}), skipping`)
        state.pendingFlushCount = 0
        this.persistFlushCount(dunId, 0)
        return false
      }

      // 2. 按 category 分组
      const grouped = new Map<CompilableKnowledgeFileType, ExperienceEntry[]>()
      for (const mem of compilableMemories) {
        const category = (mem.metadata?.category as string) || classifyMemoryContent(mem.content || '').category
        const fileType = mapCategoryToKnowledgeFile(category, mem.content || '')
        if (!grouped.has(fileType)) grouped.set(fileType, [])
        grouped.get(fileType)!.push({
          content: mem.content || '',
          category,
          timestamp: mem.createdAt || Date.now(),
        })
      }

      // 3. 获取 Dun 角色描述
      const dunSummary = await this.fetchDunSummary(dunId)

      // 4. 对每个文件类型执行编译
      let compiledCount = 0
      for (const [fileType, experiences] of grouped) {
        if (experiences.length < 1) continue

        const filename = `${fileType}.md`

        // 读取现有文档
        const existing = await this.readKnowledgeFile(dunId, filename)

        // 构建 LLM 消息
        const messages = buildCompileMessages(dunSummary, existing || '', experiences)

        // 调用 LLM（通过后台队列限流，内置指数退避重试）
        const result = await chatBackground(messages, { priority: 9 })

        if (!result) continue

        // 后处理：截断
        const { content: finalContent } = truncateDocumentIfNeeded(result.trim())

        // 写入 knowledge/ 文件
        const written = await this.writeKnowledgeFile(dunId, filename, finalContent)
        if (written) {
          compiledCount++
          await this.updateIndex(dunId, filename, this.extractSummary(finalContent))
        }
      }

      state.pendingFlushCount = 0
      this.persistFlushCount(dunId, 0)
      state.lastCompileAt = Date.now()
      console.log(`[KnowledgeCompiler] Compiled ${compiledCount} files for Dun ${dunId}`)
      return compiledCount > 0
    } finally {
      state.compiling = false
    }
  }

  // ---- I/O 方法 ----

  private async fetchDunSummary(dunId: string): Promise<string> {
    try {
      const res = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}`)
      if (res.ok) {
        const data = await res.json()
        const parts = [data.description, data.objective].filter(Boolean)
        return parts.join('。') || '通用执行智能体'
      }
    } catch { /* 静默 */ }
    return '通用执行智能体'
  }

  private async readKnowledgeFile(dunId: string, filename: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/${encodeURIComponent(filename)}`)
      if (res.ok) {
        const data = await res.json()
        return data.exists ? data.content : null
      }
    } catch { /* 静默 */ }
    return null
  }

  private async writeKnowledgeFile(dunId: string, filename: string, content: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      })
      return res.ok
    } catch { /* 静默 */ }
    return false
  }

  private async updateIndex(dunId: string, filename: string, summary: string): Promise<void> {
    try {
      const listRes = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge`)
      let entries: IndexEntry[] = []
      if (listRes.ok) {
        const data = await listRes.json()
        if (data.indexContent) {
          entries = parseIndex(data.indexContent)
        }
      }

      const today = new Date().toISOString().slice(0, 10)

      // 更新或新增条目
      const existingIdx = entries.findIndex(e => e.filename === filename)
      if (existingIdx >= 0) {
        entries[existingIdx].summary = summary
        entries[existingIdx].lastHit = today
      } else {
        entries.push({ filename, summary, lastHit: today })
      }

      await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: serializeIndex(entries) }),
      })
    } catch {
      console.warn('[KnowledgeCompiler] Failed to update _index.md')
    }
  }

  /** 从文档中提取第一句话作为摘要 */
  private extractSummary(document: string): string {
    for (const line of document.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('<!--')) continue
      if (trimmed.startsWith('-')) {
        return trimmed.slice(1).trim().slice(0, 80)
      }
      return trimmed.slice(0, 80)
    }
    return '知识文档'
  }

  private getOrCreateState(dunId: string): DunCompileState {
    let state = this.dunStates.get(dunId)
    if (!state) {
      // Restore from localStorage to survive page reloads
      let restored = 0
      try {
        const saved = localStorage.getItem(`kc_flush_${dunId}`)
        if (saved) restored = parseInt(saved, 10) || 0
      } catch { /* SSR safe */ }
      state = { pendingFlushCount: restored, lastCompileAt: 0, compiling: false }
      this.dunStates.set(dunId, state)
    }
    return state
  }

  private persistFlushCount(dunId: string, count: number): void {
    try {
      if (count > 0) {
        localStorage.setItem(`kc_flush_${dunId}`, String(count))
      } else {
        localStorage.removeItem(`kc_flush_${dunId}`)
      }
    } catch { /* SSR safe */ }
  }

  checkPendingOnStartup(): void {
    // 1. 检查 localStorage 中的待处理编译（原有逻辑）
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith('kc_flush_')) {
          const dunId = key.slice('kc_flush_'.length)
          const count = parseInt(localStorage.getItem(key) || '0', 10)
          if (count >= COMPILE_THRESHOLD) {
            console.log(`[KnowledgeCompiler] Startup: Dun ${dunId} has ${count} pending flushes, triggering compile`)
            this.compile(dunId).catch(err => {
              console.warn(`[KnowledgeCompiler] Startup compile failed for ${dunId}:`, err)
            })
          }
        }
      }
    } catch { /* SSR safe */ }

    // 2. 检查数据库中有足够数据但尚无知识文件的 Dun（后端同步的数据不走 localStorage）
    this.checkDatabaseForCompilation().catch(err => {
      console.warn('[KnowledgeCompiler] Database check failed:', err)
    })
  }

  /** 查询后端，对有足够 exec_trace 但无 knowledge 文件的 Dun 触发编译 */
  private async checkDatabaseForCompilation(): Promise<void> {
    if (!isLLMConfigured()) return

    try {
      const res = await fetch(`${this.serverUrl}/api/memory/compilable-duns`)
      if (!res.ok) return
      const duns: Array<{ dunId: string; traceCount: number; hasKnowledge: boolean }> = await res.json()

      const needCompile = duns.filter(d => !d.hasKnowledge && d.traceCount >= 2)

      // 对有 output 文件但知识库为空的 Dun，触发一次性回填
      const needBackfill = duns.filter(d => !d.hasKnowledge)
      for (const dun of needBackfill) {
        this.backfillFromOutputs(dun.dunId).catch(err =>
          console.warn(`[KnowledgeCompiler] Backfill check failed for ${dun.dunId}:`, err)
        )
      }

      if (needCompile.length === 0) return

      console.log(`[KnowledgeCompiler] Found ${needCompile.length} Duns with data but no knowledge, scheduling compilation`)

      // 错开编译，避免同时大量 LLM 调用
      for (let i = 0; i < needCompile.length; i++) {
        const { dunId, traceCount } = needCompile[i]
        setTimeout(() => {
          console.log(`[KnowledgeCompiler] Auto-compile: ${dunId} (${traceCount} traces)`)
          this.manualCompile(dunId).catch(err => {
            console.warn(`[KnowledgeCompiler] Auto-compile failed for ${dunId}:`, err)
          })
        }, i * 10000) // 每个 Dun 间隔 10 秒
      }
    } catch {
      // 后端可能未启动，静默处理
    }
  }

  /** 一次性回填：从 output 目录读取历史产出文件，提炼知识写入 memoryStore */
  private async backfillFromOutputs(dunId: string): Promise<number> {
    const BACKFILL_MAX_CONTENT = 2000
    const BACKFILL_MAX_FILES = 10

    if (!isLLMConfigured()) return 0

    // 检查是否已有 knowledge 文件（已有则不需要回填）
    try {
      const knowledgeRes = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge`)
      if (knowledgeRes.ok) {
        const data = await knowledgeRes.json()
        if (data.files && data.files.length > 0) return 0
      }
    } catch { /* 继续检查 output */ }

    try {
      // 1. 列出 output 目录下的文件
      const response = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/output-files`)
      if (!response.ok) return 0
      const { files } = await response.json() as { files: Array<{ name: string; size: number }> }

      // 只处理有实际内容的文本文件
      const textFiles = files.filter(f => f.size > 50 && f.size < 500_000)
      if (textFiles.length === 0) return 0

      console.log(`[KnowledgeCompiler] Backfill: ${dunId} has ${textFiles.length} output files, processing up to ${BACKFILL_MAX_FILES}`)

      let backfilledCount = 0
      for (const file of textFiles.slice(0, BACKFILL_MAX_FILES)) {
        try {
          // 2. 读取文件内容
          const contentResp = await fetch(
            `${this.serverUrl}/duns/${encodeURIComponent(dunId)}/output-file/${encodeURIComponent(file.name)}`
          )
          if (!contentResp.ok) continue
          const { content } = await contentResp.json() as { content: string }
          if (!content || content.length < 50) continue

          const contentPreview = content.slice(0, BACKFILL_MAX_CONTENT)

          // 3. 用 LLM 提炼知识（通过后台队列限流）
          const messages = [
            { role: 'system' as const, content: PROMOTION_PROMPT },
            { role: 'user' as const, content: `以下是 AI 助手产出的文件 "${file.name}" 的内容：\n${contentPreview}` },
          ]

          const result = await chatBackground(messages, { priority: 9 })

          const trimmed = parsePromotionResult(result?.trim() || '')
          if (!trimmed) continue

          const category = classifyMemoryContent(trimmed).category
          const written = await memoryStore.writeWithDedup({
            source: 'memory',
            content: trimmed,
            dunId,
            tags: ['backfill_output'],
            metadata: { backfillSource: 'output_file', fileName: file.name, category },
          })

          if (written) backfilledCount++

          // 间隔 2 秒，避免 LLM 限流
          await new Promise(r => setTimeout(r, 2000))
        } catch (err) {
          console.warn(`[KnowledgeCompiler] Backfill failed for ${file.name}:`, err)
        }
      }

      if (backfilledCount > 0) {
        console.log(`[KnowledgeCompiler] Backfilled ${backfilledCount} output files for Dun ${dunId}`)
        this.recordFlush(dunId)
      }

      return backfilledCount
    } catch (err) {
      console.warn('[KnowledgeCompiler] Backfill scan failed:', err)
      return 0
    }
  }
}

/** 全局单例 (已弃用 — 由 knowledgeIngestService 接管增量摄入) */
export const knowledgeCompilerService = new KnowledgeCompilerService()

// [DEPRECATED] 自启动已禁用 — 增量 ingest 管道由 knowledgeIngestService 驱动
// if (typeof window !== 'undefined') {
//   setTimeout(() => knowledgeCompilerService.checkPendingOnStartup(), 5000)
// }
