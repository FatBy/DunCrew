/**
 * DunContextEngine - 可插拔的上下文管理器
 *
 * 对标 OpenClaw ContextEngine 接口。
 * Dun 作为上下文管理者，负责：
 * - assemble(): 按 token 预算组装上下文（系统提示、SOP、记忆、基因、技能、历史）
 * - compact(): 超出预算时压缩上下文
 * - ingest(): 摄取新消息到上下文窗口
 * - afterTurn(): 每轮结束后的基因收割、评分更新
 * - bootstrap(): 会话初始化（导入历史）
 * - prepareChildSpawn(): 为子智能体准备上下文
 * - onChildEnded(): 处理子智能体完成
 * - dispose(): 清理资源
 */

import type {
  DunContextEngine,
  AssembleParams,
  AssembleResult,
  CompactParams,
  CompactResult,
  IngestParams,
  IngestResult,
  AfterTurnParams,
  BootstrapParams,
  BootstrapResult,
  PrepareChildSpawnParams,
  ChildSpawnPreparation,
  OnChildEndedParams,
  ChatMessage,
  ToolCallSummary,
} from '@/types'
import { chat, chatBackground, isLLMConfigured } from './llmService'
import { memoryStore } from './memoryStore'
import { knowledgeIngestService } from './knowledgeIngestService'
import { PROMOTION_PROMPT, RESPONSE_KNOWLEDGE_PROMPT, parsePromotionResult, classifyMemoryContent } from '@/utils/memoryPromotion'

// ============================================
// Token 估算工具
// ============================================

/** 粗略估算文本 token 数（中英文混合场景, 1 CJK ≈ 2 tokens, 1 word ≈ 1.3 tokens） */
function estimateTokens(text: string): number {
  if (!text) return 0
  // CJK 字符计为 2 tokens
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length
  // 非 CJK 部分按空格分词，每 word ≈ 1.3 tokens
  const nonCjk = text.replace(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g, '')
  const wordCount = nonCjk.split(/\s+/).filter(Boolean).length
  return Math.ceil(cjkCount * 2 + wordCount * 1.3)
}

/** 估算消息数组的总 token 数 */
function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    // 每条消息有 ~4 tokens 的元数据开销 (role + markers)
    total += 4 + estimateTokens(msg.content)
  }
  return total
}

// ============================================
// 默认 ContextEngine 实现
// ============================================

interface ContextEngineConfig {
  dunId: string
  dunLabel: string
  /** 获取动态上下文（SOP、基因、技能、记忆等） */
  getContext: (query: string) => Promise<string>
  /** 获取系统提示词 */
  getSystemPrompt: () => string
}

/**
 * DefaultDunContextEngine
 *
 * 默认实现，封装现有 buildDynamicContext 逻辑
 * 按 token 预算智能分配各模块的上下文窗口
 */
export class DefaultDunContextEngine implements DunContextEngine {
  readonly info: { id: string; dunId: string; name: string }

  private config: ContextEngineConfig
  private ingestedMessages: ChatMessage[] = []
  private compactionHistory: Array<{ before: number; after: number; ts: number }> = []
  private l1HotSnapshots: Array<{ content: string; ts: number }> = []

  constructor(config: ContextEngineConfig) {
    this.config = config
    this.info = {
      id: `ctx-engine-${config.dunId}`,
      dunId: config.dunId,
      name: `ContextEngine[${config.dunLabel}]`,
    }
  }

  // ═══════════════════════════════════════════
  // L1-Hot 快照管理
  // ═══════════════════════════════════════════

  private buildL1HotSection(): string {
    return this.l1HotSnapshots
      .map(s => s.content)
      .join('\n')
  }

  // ═══════════════════════════════════════════
  // assemble: 按 token 预算组装上下文
  // ═══════════════════════════════════════════

  assemble(params: AssembleParams): AssembleResult {
    const { messages, tokenBudget, taskDescription } = params
    const budget = tokenBudget > 0 ? tokenBudget : 128000 // 默认 128K

    // 预算分配策略（百分比）
    const BUDGET_RATIOS = {
      system: 0.15,     // 系统提示词
      sop: 0.10,        // SOP 指令
      memory: 0.10,     // 记忆上下文
      genes: 0.05,      // 基因经验
      skills: 0.10,     // 技能文档
      history: 0.50,    // 对话历史（最大份额）
    }

    const breakdown = {
      system: Math.floor(budget * BUDGET_RATIOS.system),
      sop: Math.floor(budget * BUDGET_RATIOS.sop),
      memory: Math.floor(budget * BUDGET_RATIOS.memory),
      genes: Math.floor(budget * BUDGET_RATIOS.genes),
      skills: Math.floor(budget * BUDGET_RATIOS.skills),
      history: Math.floor(budget * BUDGET_RATIOS.history),
    }

    // 1. 保留系统消息
    const systemMsg = messages.find(m => m.role === 'system')
    const nonSystemMsgs = messages.filter(m => m.role !== 'system')

    // 2. 从后往前保留对话历史，确保最近的消息优先
    const assembledMessages: ChatMessage[] = []
    let usedTokens = systemMsg ? estimateTokens(systemMsg.content) + 4 : 0

    // 保留系统消息
    if (systemMsg) {
      assembledMessages.push(systemMsg)
    }

    // 从最新消息开始，反向填充
    const reversedNonSystem = [...nonSystemMsgs].reverse()
    const keptMessages: ChatMessage[] = []

    for (const msg of reversedNonSystem) {
      const msgTokens = estimateTokens(msg.content) + 4
      if (usedTokens + msgTokens > budget * 0.95) {
        // 超出预算 95%，停止添加更早的消息
        break
      }
      keptMessages.unshift(msg) // 恢复正序
      usedTokens += msgTokens
    }

    assembledMessages.push(...keptMessages)

    // 2.5 V3: 注入 L1-Hot 快照 (最近操作回顾)
    if (this.l1HotSnapshots.length > 0) {
      const l1HotContent = this.buildL1HotSection()
      const l1HotTokens = estimateTokens(l1HotContent) + 4
      if (usedTokens + l1HotTokens < budget * 0.97) {
        assembledMessages.push({
          id: `l1-hot-${Date.now()}`,
          role: 'system',
          content: l1HotContent,
          timestamp: Date.now(),
        })
        usedTokens += l1HotTokens
      }
    }

    // 3. 注入 ingested 的新消息（如果有的话）
    for (const ingested of this.ingestedMessages) {
      const ingestTokens = estimateTokens(ingested.content) + 4
      if (usedTokens + ingestTokens < budget * 0.98) {
        assembledMessages.push(ingested)
        usedTokens += ingestTokens
      }
    }

    return {
      messages: assembledMessages,
      estimatedTokens: usedTokens,
      systemPromptAddition: taskDescription
        ? `\n\n当前任务: ${taskDescription}`
        : undefined,
      budgetBreakdown: breakdown,
    }
  }

  // ═══════════════════════════════════════════
  // compact: 上下文压缩
  // ═══════════════════════════════════════════

  async compact(params: CompactParams): Promise<CompactResult> {
    const { tokenBudget, trigger, currentTokenCount, messages } = params

    // 如果当前 token 在预算内，无需压缩
    if (currentTokenCount <= tokenBudget) {
      return {
        ok: true,
        compacted: false,
        tokensBefore: currentTokenCount,
        reason: 'Within budget, no compaction needed',
      }
    }

    // 必须提供消息历史才能生成有效摘要
    if (!messages || messages.length === 0) {
      return {
        ok: false,
        compacted: false,
        tokensBefore: currentTokenCount,
        reason: 'No messages provided for compaction',
      }
    }

    const targetTokens = Math.floor(tokenBudget * 0.75)
    console.log(`[ContextEngine] Compaction triggered (${trigger}): ${currentTokenCount} → target ${targetTokens}`)

    try {
      // 提取需要压缩的早期消息（跳过 system[0] 和最近 8 条）
      const earlyMessages = messages.slice(1, -8)
      if (earlyMessages.length === 0) {
        return {
          ok: true,
          compacted: false,
          tokensBefore: currentTokenCount,
          reason: 'Not enough early messages to compact',
        }
      }

      // 构建待压缩内容（限制输入总量，避免压缩请求本身也超长）
      const COMPACT_INPUT_LIMIT = 12000
      let compactInput = ''
      for (const msg of earlyMessages) {
        const content = typeof msg.content === 'string' ? msg.content : ''
        const roleName = msg.role === 'tool' ? 'tool_result' : msg.role
        const line = `[${roleName}]: ${content.slice(0, 500)}\n`
        if (compactInput.length + line.length > COMPACT_INPUT_LIMIT) break
        compactInput += line
      }

      const summaryResponse = await chat([
        {
          role: 'system',
          content: '你是一个对话压缩助手。请将以下对话历史压缩成一段简洁的摘要（300字以内），必须保留：1) 用户的核心任务目标 2) 已完成的关键操作和结果 3) 遇到的错误及解决方案 4) 当前进度。丢弃冗余的工具输出细节。',
        },
        {
          role: 'user',
          content: `请压缩以下 ${earlyMessages.length} 条对话历史:\n\n${compactInput}`,
        },
      ])

      const tokensAfter = estimateTokens(summaryResponse) + 4
      this.compactionHistory.push({
        before: currentTokenCount,
        after: tokensAfter,
        ts: Date.now(),
      })

      return {
        ok: true,
        compacted: true,
        tokensBefore: currentTokenCount,
        tokensAfter,
        summary: summaryResponse,
      }
    } catch (error: any) {
      console.error('[ContextEngine] Compaction failed:', error)
      return {
        ok: false,
        compacted: false,
        tokensBefore: currentTokenCount,
        reason: `Compaction failed: ${error.message}`,
      }
    }
  }

  // ═══════════════════════════════════════════
  // ingest: 摄取新消息
  // ═══════════════════════════════════════════

  ingest(params: IngestParams): IngestResult {
    const { message } = params
    this.ingestedMessages.push(message)

    // 限制 ingested 消息数量，防止无限增长
    if (this.ingestedMessages.length > 50) {
      this.ingestedMessages = this.ingestedMessages.slice(-30)
    }

    return { ingested: true }
  }

  // ═══════════════════════════════════════════
  // afterTurn: 每轮结束后处理
  // ═══════════════════════════════════════════

  async afterTurn(params: AfterTurnParams): Promise<void> {
    const { sessionId, toolResults, runState } = params

    // 1. 检查是否需要主动压缩
    if (runState.tokenBudget > 0 && runState.tokenUsed > 0) {
      const ratio = runState.tokenUsed / runState.tokenBudget
      if (ratio > 0.80) {
        console.log(`[ContextEngine] Token usage at ${Math.round(ratio * 100)}%, consider proactive compaction`)
      }
    }

    // 2. 记录工具结果摘要到上下文（供下轮使用）
    const successTools = toolResults.filter(t => t.status === 'success')
    const errorTools = toolResults.filter(t => t.status === 'error')

    if (errorTools.length > 0) {
      console.log(`[ContextEngine/${sessionId}] afterTurn: ${successTools.length} success, ${errorTools.length} errors in this turn`)
    }

    // 3. 清理过期的 ingested 消息
    const MAX_INGESTED_AGE = 30 * 60 * 1000 // 30 分钟
    const now = Date.now()
    this.ingestedMessages = this.ingestedMessages.filter(
      m => (now - m.timestamp) < MAX_INGESTED_AGE
    )
  }

  // ═══════════════════════════════════════════
  // bootstrap: 会话初始化
  // ═══════════════════════════════════════════

  async bootstrap(params: BootstrapParams): Promise<BootstrapResult> {
    const { sessionId } = params
    console.log(`[ContextEngine] Bootstrapping session: ${sessionId} for Dun: ${this.config.dunId}`)

    // 纯状态清理 — 记忆加载由 buildDynamicContext 按需驱动
    this.ingestedMessages = []
    this.compactionHistory = []

    return {
      bootstrapped: true,
      importedMessages: 0,
      memoriesLoaded: 0,
      reason: 'Lightweight bootstrap: state cleared, memory loading deferred to buildDynamicContext',
    }
  }

  // ═══════════════════════════════════════════
  // prepareChildSpawn: 为子智能体准备上下文
  // ═══════════════════════════════════════════

  async prepareChildSpawn(params: PrepareChildSpawnParams): Promise<ChildSpawnPreparation> {
    const { parentSessionId, childSessionId, inheritContext } = params

    if (!inheritContext) {
      return {
        rollback: async () => {
          console.log(`[ContextEngine] Rollback child spawn: ${childSessionId}`)
        },
      }
    }

    // 为子智能体生成上下文摘要
    const contextParts: string[] = []

    // 收集当前会话中的关键信息
    const recentMessages = this.ingestedMessages.slice(-5)
    if (recentMessages.length > 0) {
      const summary = recentMessages
        .map(m => `[${m.role}] ${m.content.slice(0, 200)}`)
        .join('\n')
      contextParts.push(`父会话上下文摘要:\n${summary}`)
    }

    return {
      contextSummary: contextParts.join('\n\n') || undefined,
      sharedGenes: [], // TODO: Step 9 实现基因共享
      rollback: async () => {
        console.log(`[ContextEngine] Rollback child spawn: ${childSessionId} from parent ${parentSessionId}`)
      },
    }
  }

  // ═══════════════════════════════════════════
  // onChildEnded: 子智能体完成后处理
  // ═══════════════════════════════════════════

  async onChildEnded(params: OnChildEndedParams): Promise<void> {
    const { childSessionId, childDunId, reason, outcome } = params

    console.log(`[ContextEngine] Child ${childSessionId} (Dun: ${childDunId}) ended: ${reason}`)

    // 如果子智能体成功，将结果摘要注入到父上下文
    if (outcome?.success && outcome.result) {
      this.ingest({
        sessionId: '', // 使用当前会话
        message: {
          id: `child-result-${childSessionId}`,
          role: 'system',
          content: `[子智能体结果] Dun ${childDunId} 完成任务:\n${outcome.result.slice(0, 500)}`,
          timestamp: Date.now(),
        },
      })
    }

    // 如果子智能体产生了新基因，记录到上下文
    if (outcome?.genesHarvested && outcome.genesHarvested.length > 0) {
      console.log(`[ContextEngine] Harvested ${outcome.genesHarvested.length} genes from child ${childSessionId}`)
    }
  }

  // ═══════════════════════════════════════════
  // flushMemory: ReAct 循环结束后提炼本轮认知
  // ═══════════════════════════════════════════

  async flushMemory(toolHistory: ToolCallSummary[], signal?: AbortSignal): Promise<void> {
    // 检测本轮是否有产出型工具（writeFile/appendFile 且携带了 contentPreview）
    const OUTPUT_TOOLS = ['writeFile', 'appendFile']
    const hasOutputTools = toolHistory.some(
      t => OUTPUT_TOOLS.includes(t.toolName) && t.status === 'success' && t.args.contentPreview
    )

    // F3 优化：saveMemory 已调用时，仅在有产出型工具时继续（只处理产出知识）
    const saveMemoryCalled = toolHistory.some(t => t.toolName === 'saveMemory' && t.status === 'success')
    if (saveMemoryCalled && !hasOutputTools) {
      console.log('[ContextEngine] Skipping Memory Flush: saveMemory already called, no output tools')
      // saveMemory 直接写入后端 memory 表，仍需触发 recordFlush 让 ingest 管道处理
      knowledgeIngestService.recordFlush(this.config.dunId)
      return
    }

    const successTools = toolHistory.filter(t => t.status === 'success')
    if (successTools.length < 1) return

    if (!isLLMConfigured()) return

    try {
      // 如果 saveMemory 已调用但有产出，只处理产出型工具
      const toolsToProcess = saveMemoryCalled
        ? successTools.filter(t => OUTPUT_TOOLS.includes(t.toolName))
        : successTools

      // 构建本轮工具执行摘要
      const toolSummary = toolsToProcess
        .slice(-10)
        .map(t => {
          // 产出型工具：展示文件路径和内容摘要
          if (OUTPUT_TOOLS.includes(t.toolName) && t.args.contentPreview) {
            return `${t.toolName}: 写入 ${t.args.path}\n产出内容摘要:\n${String(t.args.contentPreview)}`
          }
          return `${t.toolName}: ${JSON.stringify(t.args).slice(0, 100)} → ${(t.result || '').slice(0, 80)}`
        })
        .join('\n')

      const flushMessages = [
        { role: 'system' as const, content: PROMOTION_PROMPT },
        { role: 'user' as const, content: `本轮执行了 ${successTools.length} 个工具：\n${toolSummary}` },
      ]

      // LLM 调用（通过后台队列限流，内置指数退避重试）
      const flushResult = await chatBackground(flushMessages, { signal, priority: 5 })

      const trimmed = parsePromotionResult(flushResult?.trim() || '')
      if (!trimmed) {
        console.log('[ContextEngine] Memory Flush: nothing worth remembering')
        return
      }

      const category = classifyMemoryContent(trimmed).category

      // 通过 writeWithDedup 写入，自动去重
      const written = await memoryStore.writeWithDedup({
        source: 'memory',
        content: trimmed,
        dunId: this.config.dunId,
        tags: ['memory_flush'],
        metadata: {
          flushSource: 'react_loop',
          toolCount: successTools.length,
          flushedAt: Date.now(),
          category,
        },
      })

      if (written) {
        console.log(`[ContextEngine] Memory Flush: saved "${trimmed.slice(0, 60)}..."`)
        // Phase 1: 通知编译管道累积 flush 计数
        knowledgeIngestService.recordFlush(this.config.dunId)
      }
    } catch (error) {
      console.warn('[ContextEngine] Memory Flush failed:', error)
    }
  }

  // ═══════════════════════════════════════════
  // flushResponseKnowledge: 从 AI 分析性响应中提取领域知识
  // ═══════════════════════════════════════════

  /** 响应内容长度阈值：低于此值认为不含可提取的深度知识 */
  private static RESPONSE_KNOWLEDGE_MIN_LENGTH = 500

  async flushResponseKnowledge(userPrompt: string, response: string, signal?: AbortSignal): Promise<void> {
    // 短响应大概率不含深度知识
    if (response.length < DefaultDunContextEngine.RESPONSE_KNOWLEDGE_MIN_LENGTH) return
    if (!isLLMConfigured()) return

    try {
      const flushMessages = [
        { role: 'system' as const, content: RESPONSE_KNOWLEDGE_PROMPT },
        {
          role: 'user' as const,
          content: `用户问题：${userPrompt.slice(0, 300)}\n\nAI 响应：\n${response.slice(0, 4000)}`,
        },
      ]

      // LLM 调用（通过后台队列限流，内置指数退避重试）
      const result = await chatBackground(flushMessages, { signal, priority: 5 })

      const trimmed = parsePromotionResult(result?.trim() || '')
      if (!trimmed) {
        console.log('[ContextEngine] Response Knowledge Flush: nothing worth remembering')
        return
      }

      const category = classifyMemoryContent(trimmed).category

      const written = await memoryStore.writeWithDedup({
        source: 'memory',
        content: trimmed,
        dunId: this.config.dunId,
        tags: ['response_knowledge'],
        metadata: {
          flushSource: 'response_analysis',
          promptPreview: userPrompt.slice(0, 100),
          responseLength: response.length,
          flushedAt: Date.now(),
          category,
        },
      })

      if (written) {
        console.log(`[ContextEngine] Response Knowledge Flush: saved "${trimmed.slice(0, 60)}..."`)
        knowledgeIngestService.recordFlush(this.config.dunId)
      }
    } catch (error) {
      console.warn('[ContextEngine] Response Knowledge Flush failed:', error)
    }
  }

  // ═══════════════════════════════════════════
  // dispose: 清理资源
  // ═══════════════════════════════════════════

  async dispose(): Promise<void> {
    console.log(`[ContextEngine] Disposing engine for Dun: ${this.config.dunId}`)
    this.ingestedMessages = []
    this.compactionHistory = []
  }


}

// ============================================
// ContextEngine 注册表（管理多个 Dun 的 engine）
// ============================================

class ContextEngineRegistry {
  private engines = new Map<string, DunContextEngine>()

  /** 注册或获取一个 Dun 的 ContextEngine */
  getOrCreate(dunId: string, factory: () => DunContextEngine): DunContextEngine {
    const existing = this.engines.get(dunId)
    if (existing) return existing

    const engine = factory()
    this.engines.set(dunId, engine)
    console.log(`[ContextEngineRegistry] Created engine for Dun: ${dunId}`)
    return engine
  }

  /** 获取已注册的 engine */
  get(dunId: string): DunContextEngine | undefined {
    return this.engines.get(dunId)
  }

  /** 移除并 dispose 一个 engine */
  async remove(dunId: string): Promise<void> {
    const engine = this.engines.get(dunId)
    if (engine) {
      await engine.dispose?.()
      this.engines.delete(dunId)
      console.log(`[ContextEngineRegistry] Removed engine for Dun: ${dunId}`)
    }
  }

  /** 清理所有 engine */
  async disposeAll(): Promise<void> {
    for (const [id, engine] of this.engines) {
      try {
        await engine.dispose?.()
      } catch (e) {
        console.warn(`[ContextEngineRegistry] Failed to dispose engine ${id}:`, e)
      }
    }
    this.engines.clear()
  }

  /** 列出所有已注册的 engine */
  list(): Array<{ dunId: string; name: string }> {
    return Array.from(this.engines.entries()).map(([dunId, engine]) => ({
      dunId,
      name: engine.info.name,
    }))
  }
}

// 导出单例
export const contextEngineRegistry = new ContextEngineRegistry()

// 导出工具函数
export { estimateTokens, estimateMessagesTokens }
