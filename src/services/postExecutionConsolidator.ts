/**
 * postExecutionConsolidator.ts - 执行后统一归纳器
 *
 * 核心架构改进：将 ReAct 循环结束后分散的 2-5 次 LLM 调用
 * 合并为单次调用，解决三个问题：
 * 1. LLM 调用碎片化 → 单次全局视角
 * 2. Store 写冲突（updateDunScoring + updateDun 浅展开覆盖）→ 原子写回
 * 3. 知识存储无统一决策 → Consolidator 一次性归纳
 *
 * 三阶段管线：
 * Phase 1 (COLLECT) - 纯同步，收集所有上下文到 payload
 * Phase 2 (FUSE)    - 单次 chatBackground 调用
 * Phase 3 (APPLY)   - 原子化分发结果到各服务
 */

import type { ExecTrace, DunScoring, L1MemoryEntry } from '@/types'
import type { SimpleChatMessage } from './llmService'
import { chatBackground } from './llmService'
import { memoryStore } from './memoryStore'
import { knowledgeIngestService } from './knowledgeIngestService'
import { confidenceTracker } from './confidenceTracker'
import { sopEvolutionService } from './sopEvolutionService'
import { dunScoringService } from './dunScoringService'
import { cleanThinkTags, classifyMemoryContent } from '@/utils/memoryPromotion'

// ============================================
// Types
// ============================================

export interface ConsolidationPayload {
  dunId: string
  trace: ExecTrace
  traceTools: Array<{
    name: string
    status: string
    result?: string
    args?: Record<string, unknown>
    latency?: number
  }>
  userPrompt: string
  finalResponse: string | null
  runSuccess: boolean
  turnCount: number
  /** Scoring 预计算结果（纯统计，Consolidator 之前同步完成） */
  precomputedScoring: { scoring: DunScoring; scoreChange: number }
  /** L1 候选（confidenceTracker.getPromotableCandidates 返回） */
  promotableCandidates: L1MemoryEntry[]
  /** 当前 SOP 内容 */
  sopContent?: string
  /** SOP 执行历史摘要（sopEvolutionService.buildGoldenPathContext 返回） */
  sopFitnessContext?: string
  /** 中止信号 */
  bgSignal?: AbortSignal
  /** 服务器地址 */
  serverUrl: string
  /** 知识库实体标题索引（供 LLM 建立 relations） */
  entityTitles?: string[]
}

export interface ConsolidationResult {
  memories: Array<{ content: string; category: string; confidence: number }> | null
  knowledge: Array<{
    op: string
    entity_name: string
    type?: string
    category?: string
    claims: Array<{ c: string; t?: string; conf?: number } | string>
    relations?: Array<{ target: string; rel?: string }>
  }> | null
  l0Promotions: string[] | null
  sopFeedback: { action: string; suggestion?: string; goldenPathSummary?: unknown } | null
  observerHints: { repeated_pattern?: boolean; potential_skill?: string | null; confidence?: number } | null
  rawLLMOutput: string | null
}

/** Store 操作接口（从 LocalClawService 传入，避免直接依赖 store） */
export interface ConsolidatorStoreActions {
  updateDun: (id: string, updates: Record<string, unknown>) => void
  addToast: (toast: { type: string; title: string; message: string }) => void
  duns?: Map<string, { label?: string }>
}

// ============================================
// 常量
// ============================================

const OUTPUT_TOOLS = ['writeFile', 'appendFile']
const PER_FILE_CONTENT_LIMIT = 2000
const MAX_TOOLS_IN_PROMPT = 10
const MAX_RESPONSE_LENGTH = 4000
const MIN_RESPONSE_FOR_KNOWLEDGE = 200
const MAX_L1_CANDIDATES_IN_PROMPT = 10

// ============================================
// System Prompt
// ============================================

const CONSOLIDATION_SYSTEM_PROMPT = [
  '你是执行后分析器。从一次任务执行的完整数据中，一次性完成以下分析任务。',
  '每个任务输出到对应的 XML 标签中。标签外不要输出任何内容。',
  '',
  '== 任务 1: 记忆提炼 → <MEMORIES> ==',
  '',
  '从操作记录中提炼可复用的行为准则或关键认知。',
  '',
  '格式 A（优先）：行为准则',
  '  "[场景触发条件] → [应该怎么做]（因为[原因]）"',
  '',
  '格式 B：环境事实（仅当无法提炼准则时）',
  '  一句话陈述事实（如技术栈、偏好）',
  '',
  '格式 C：产出知识（当有 writeFile/appendFile 产出时）',
  '  提炼产出内容中的核心结论或发现，不是"产出了文件"本身。',
  '',
  '不值得保留的：纯工具执行细节、临时操作、无上下文碎片。',
  '',
  '输出 JSON 数组:',
  '[{"content":"提炼内容","category":"procedural|factual|insight","confidence":0.0-1.0}]',
  '无可复用记忆时输出: <MEMORIES>[]</MEMORIES>',
  '',
  '== 任务 2: 知识实体提取 → <KNOWLEDGE> ==',
  '',
  '仅当 AI 响应包含以下内容时才提取：',
  '1. 研究成果与结论（经过搜索/分析验证的发现）',
  '2. 数据洞察（数字、百分比、趋势）',
  '3. 领域知识体系（分类框架、因果关系）',
  '4. 反直觉发现或关键差异对比',
  '',
  '每条知识应自包含（脱离原文后仍可理解），保留关键数据和限定语。',
  '',
  '输出 JSON 数组(短键名节省空间):',
  '[{"op":"create|update","entity_name":"实体名称","type":"concept|topic|pattern","category":"分类(如:经济/技术/产品,可省略)","claims":[{"c":"断言内容","t":"metric|insight|pattern|fact","conf":0.8}],"relations":[{"target":"已有Entity标题","rel":"related_to|contradicts|subtopic_of"}]}]',
  '',
  '关联规则: 参考下方"知识库索引"中的实体标题建立 relations。无相关则省略 relations。',
  '无值得提取的知识时输出: <KNOWLEDGE>[]</KNOWLEDGE>',
  '',
  '== 任务 3: L1 记忆晋升判定 → <L0_PROMOTIONS> ==',
  '',
  '评估"待评估 L1 候选"列表中哪些值得保留为长期记忆。',
  '值得保留的标准：可复用的行为模式、环境事实、重要发现。',
  '不值得的：纯工具日志、一次性操作、碎片信息。',
  '',
  '输出值得保留的候选 ID 数组: ["id1","id2"]',
  '无候选或都不值得时输出: <L0_PROMOTIONS>[]</L0_PROMOTIONS>',
  '',
  '== 任务 4: SOP 执行反馈 → <SOP_FEEDBACK> ==',
  '',
  '仅当输入中包含"SOP 执行历史"段时才输出。',
  '分析执行模式，识别 golden/stable/bottleneck 阶段。',
  '',
  '输出:',
  '{"action":"noop|minor_adjust","suggestion":"改进建议","phaseInsights":[{"phaseName":"Phase N","status":"golden|stable|bottleneck","insight":"简短观察"}],"confidence":0.0-1.0}',
  '不需要反馈时输出: <SOP_FEEDBACK>{"action":"noop"}</SOP_FEEDBACK>',
  '',
  '== 任务 5: Observer 模式提示 → <OBSERVER_HINTS> ==',
  '',
  '观察工具使用模式，判断是否有重复出现的工具组合可封装为技能。',
  '',
  '输出:',
  '{"repeated_pattern":false,"potential_skill":null,"confidence":0.0}',
].join('\n')

// ============================================
// 工具函数
// ============================================

/**
 * 从 LLM 输出中安全提取指定标签的 JSON 内容
 * 每个标签独立解析，一个失败不影响其他
 */
export function safeExtractTag<T>(raw: string, tag: string): T | null {
  const regex = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  const match = raw.match(regex)
  if (!match) return null

  try {
    let content = cleanThinkTags(match[1]).trim()

    // 处理 null 字面量
    if (content === 'null' || content === '') return null

    // 兼容 markdown 代码块包裹
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (jsonMatch) content = jsonMatch[1].trim()

    return JSON.parse(content) as T
  } catch {
    console.warn(`[Consolidator] Failed to parse <${tag}>, degrading gracefully`)
    return null
  }
}

// ============================================
// Phase 2: Prompt 构建
// ============================================

function buildConsolidationPrompt(payload: ConsolidationPayload): SimpleChatMessage[] {
  const sections: string[] = []

  // 1. 执行概况
  sections.push(
    '## 执行概况',
    `- 任务: ${payload.userPrompt.slice(0, 200)}`,
    `- 结果: ${payload.runSuccess ? '成功' : '失败'} (${payload.trace.completionPath || 'unknown'})`,
    `- 工具链: ${payload.traceTools.map(t => `${t.name}(${t.status})`).join(', ') || '无工具调用'}`,
    `- 耗时: ${payload.trace.duration}ms, ${payload.turnCount} 轮`,
    '',
  )

  // 2. 工具执行详情（最多 MAX_TOOLS_IN_PROMPT 条）
  if (payload.traceTools.length > 0) {
    sections.push('## 工具执行详情')
    const toolsToShow = payload.traceTools.slice(-MAX_TOOLS_IN_PROMPT)
    for (const t of toolsToShow) {
      const isOutputTool = OUTPUT_TOOLS.includes(t.name) && t.status === 'success'
      if (isOutputTool && t.args) {
        const contentPreview = String(t.args.content || '').slice(0, PER_FILE_CONTENT_LIMIT)
        sections.push(`- ${t.name}(${t.status}): path=${t.args.path || '?'}, 产出摘要: ${contentPreview.slice(0, 300)}`)
      } else if (t.status === 'error') {
        sections.push(`- ${t.name}(error): ${(t.result || '').slice(0, 200)}`)
      } else {
        sections.push(`- ${t.name}(${t.status}): ${(t.result || '').slice(0, 200)}`)
      }
    }
    sections.push('')
  }

  // 3. AI 响应（仅当足够长时包含）
  if (payload.finalResponse && payload.finalResponse.length > MIN_RESPONSE_FOR_KNOWLEDGE) {
    sections.push(
      '## AI 响应',
      payload.finalResponse.slice(0, MAX_RESPONSE_LENGTH),
      '',
    )
  }

  // 4. 待评估 L1 候选
  if (payload.promotableCandidates.length > 0) {
    sections.push('## 待评估 L1 候选')
    const candidates = payload.promotableCandidates.slice(0, MAX_L1_CANDIDATES_IN_PROMPT)
    for (const c of candidates) {
      sections.push(`- [${c.id}] ${c.content.slice(0, 200)} (confidence=${c.confidence.toFixed(2)})`)
    }
    sections.push('')
  }

  // 5. SOP 执行历史（如果有）
  if (payload.sopFitnessContext) {
    sections.push(
      '## SOP 执行历史',
      payload.sopFitnessContext,
      '',
    )
  }

  // 6. 知识库 Entity 索引（供 relations 引用）
  if (payload.entityTitles && payload.entityTitles.length > 0) {
    sections.push(
      '## 知识库索引 (可建立 relations 关联)',
      payload.entityTitles.slice(0, 15).join(', '),
      '',
    )
  }

  return [
    { role: 'system', content: CONSOLIDATION_SYSTEM_PROMPT },
    { role: 'user', content: sections.join('\n') },
  ]
}

// ============================================
// Phase 2: LLM 调用 + 解析
// ============================================

async function consolidate(payload: ConsolidationPayload): Promise<ConsolidationResult> {
  const emptyResult: ConsolidationResult = {
    memories: null,
    knowledge: null,
    l0Promotions: null,
    sopFeedback: null,
    observerHints: null,
    rawLLMOutput: null,
  }

  // 无工具调用 + 短响应 → 跳过 LLM（节省 token）
  if (payload.traceTools.length === 0 &&
      (!payload.finalResponse || payload.finalResponse.length < MIN_RESPONSE_FOR_KNOWLEDGE) &&
      payload.promotableCandidates.length === 0) {
    return emptyResult
  }

  const messages = buildConsolidationPrompt(payload)
  const rawOutput = await chatBackground(messages, {
    signal: payload.bgSignal,
    priority: 4,
  })

  if (!rawOutput) return emptyResult

  return {
    memories: safeExtractTag<ConsolidationResult['memories']>(rawOutput, 'MEMORIES'),
    knowledge: safeExtractTag<ConsolidationResult['knowledge']>(rawOutput, 'KNOWLEDGE'),
    l0Promotions: safeExtractTag<string[]>(rawOutput, 'L0_PROMOTIONS'),
    sopFeedback: safeExtractTag<ConsolidationResult['sopFeedback']>(rawOutput, 'SOP_FEEDBACK'),
    observerHints: safeExtractTag<ConsolidationResult['observerHints']>(rawOutput, 'OBSERVER_HINTS'),
    rawLLMOutput: rawOutput,
  }
}

// ============================================
// Phase 3: 原子化分发
// ============================================

async function applyResult(
  payload: ConsolidationPayload,
  result: ConsolidationResult,
  storeActions: ConsolidatorStoreActions,
): Promise<number> {
  const { dunId, precomputedScoring } = payload
  const { scoring, scoreChange } = precomputedScoring

  // --- 1. SOP fitness + rewrite（纯统计，不依赖 LLM 结果） ---
  const sopTraceTools = payload.traceTools.map(t => ({
    name: t.name,
    status: t.status as 'success' | 'error',
    result: t.result,
    duration: t.latency,
  }))

  let evolutionData: Record<string, unknown> | undefined
  let rewriteInfo: Record<string, unknown> | undefined
  let newSopContent: string | undefined

  try {
    await sopEvolutionService.computeAndPersistFitness(
      dunId, sopTraceTools, payload.runSuccess, payload.userPrompt,
    )

    if (payload.finalResponse) {
      const rewriteResult = await sopEvolutionService.detectRewrite(dunId, payload.finalResponse)
      if (rewriteResult.rewritten) {
        rewriteInfo = {
          rewrittenAt: Date.now(),
          triggerLevel: rewriteResult.triggerLevel,
          basedOnExecutions: rewriteResult.basedOnExecutions,
          historyVersion: rewriteResult.historyVersion,
        }
        newSopContent = rewriteResult.newSopContent
      }
    }

    // Golden Path 写入（如果 Consolidator 的 SOP_FEEDBACK 有效）
    if (result.sopFeedback && result.sopFeedback.action !== 'noop') {
      await sopEvolutionService.applyGoldenPathFromConsolidator(dunId, result.sopFeedback)
    }

    evolutionData = await sopEvolutionService.getEvolutionSnapshot(dunId) as Record<string, unknown>
  } catch (err) {
    console.warn('[Consolidator] SOP Evolution failed:', err)
  }

  // --- 2. 原子写回 Store（单次 updateDun） ---
  try {
    const dunUpdate: Record<string, unknown> = { scoring }
    if (evolutionData) dunUpdate.sopEvolutionData = evolutionData
    if (rewriteInfo) dunUpdate.sopRewriteInfo = rewriteInfo
    if (newSopContent) dunUpdate.sopContent = newSopContent

    storeActions.updateDun(dunId, dunUpdate)
  } catch (err) {
    console.warn('[Consolidator] Store atomic update failed:', err)
  }

  // --- 3. Scoring 持久化到后端（fire-and-forget） ---
  dunScoringService.saveToServer(dunId, payload.serverUrl).catch(err => {
    console.warn('[Consolidator] Scoring persistence failed:', err)
  })

  // --- 4. 记忆写入 ---
  if (result.memories && result.memories.length > 0) {
    for (const mem of result.memories) {
      if (!mem.content || mem.content === '无') continue
      const classification = classifyMemoryContent(mem.content)
      memoryStore.writeWithDedup({
        source: 'memory',
        content: mem.content,
        dunId,
        tags: ['consolidator', classification.category],
        metadata: {
          flushedAt: Date.now(),
          category: classification.category,
          layer: classification.layer,
          confidence: mem.confidence ?? 0.5,
        },
      }).then(written => {
        if (written) knowledgeIngestService.recordFlush(dunId)
      }).catch(err => console.warn('[Consolidator] Memory write failed:', err))
    }
  }

  // --- 5. Knowledge 缓冲 ---
  if (result.knowledge && result.knowledge.length > 0) {
    const validEntities = result.knowledge.filter(k => k.op !== 'noop' && k.entity_name)
    if (validEntities.length > 0) {
      knowledgeIngestService.bufferEntities(dunId, validEntities, {
        userPrompt: payload.userPrompt,
      })
    }
  }

  // --- 6. L0 晋升 ---
  if (result.l0Promotions && result.l0Promotions.length > 0 && payload.promotableCandidates.length > 0) {
    confidenceTracker.applyPromotionResults(
      payload.promotableCandidates,
      result.l0Promotions,
    ).catch(err => console.warn('[Consolidator] L0 promotion failed:', err))
  } else if (payload.promotableCandidates.length > 0 && result.l0Promotions !== null) {
    // LLM 返回空数组 → 标记所有候选为已评估（不再重复评估）
    confidenceTracker.applyPromotionResults(
      payload.promotableCandidates,
      [],
    ).catch(err => console.warn('[Consolidator] L0 skip-mark failed:', err))
  }

  // --- 7. Observer Hints（仅日志记录，供未来 Observer 消费） ---
  if (result.observerHints) {
    console.log('[Consolidator] Observer hints:', JSON.stringify(result.observerHints))
  }

  // --- 8. SOP Toast 通知 ---
  if (rewriteInfo) {
    const dunLabel = storeActions.duns?.get(dunId)?.label || dunId
    storeActions.addToast({
      type: 'warning',
      title: 'SOP 已自动改写',
      message: `Dun "${dunLabel}" 的 SOP 已根据执行数据自动优化 (${(rewriteInfo.triggerLevel as string) || 'AUTO'})`,
    })
  }

  console.log(`[Consolidator] Applied: memories=${result.memories?.length ?? 0}, knowledge=${result.knowledge?.length ?? 0}, l0=${result.l0Promotions?.length ?? 0}, sop=${result.sopFeedback?.action ?? 'skip'}, score=${scoreChange > 0 ? '+' : ''}${scoreChange}`)

  return scoreChange
}

// ============================================
// 单入口函数
// ============================================

/**
 * Post-Execution Consolidator 单入口
 *
 * 编排 Phase 2 (LLM 调用) → Phase 3 (结果分发)
 * 异步不阻塞用户响应，由 LocalClawService fire-and-forget 调用
 *
 * @returns scoreChange（预计算值，即使 LLM 失败也能返回）
 */
export async function consolidatePostExecution(
  payload: ConsolidationPayload,
  storeActions: ConsolidatorStoreActions,
): Promise<number> {
  try {
    const result = await consolidate(payload)
    return await applyResult(payload, result, storeActions)
  } catch (err) {
    console.warn('[Consolidator] Top-level failure, applying scoring only:', err)

    // 降级：至少完成 scoring 的 Store 写回
    try {
      storeActions.updateDun(payload.dunId, {
        scoring: payload.precomputedScoring.scoring,
      })
      dunScoringService.saveToServer(payload.dunId, payload.serverUrl).catch(() => {})
    } catch {
      // 最终兜底
    }

    return payload.precomputedScoring.scoreChange
  }
}
