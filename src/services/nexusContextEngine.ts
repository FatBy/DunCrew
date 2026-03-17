/**
 * NexusContextEngine - 可插拔的上下文管理器
 *
 * 对标 OpenClaw ContextEngine 接口。
 * Nexus 作为上下文管理者，负责：
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
  NexusContextEngine,
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
  L1ActionSnapshot,
} from '@/types'
import { L1_MEMORY_CONFIG } from '@/types'
import { chat } from './llmService'
import { memoryStore } from './memoryStore'

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
  nexusId: string
  nexusLabel: string
  /** 获取动态上下文（SOP、基因、技能、记忆等） */
  getContext: (query: string) => Promise<string>
  /** 获取系统提示词 */
  getSystemPrompt: () => string
  /** 获取历史上下文（最近对话） */
  getConversationHistory?: () => ChatMessage[]
}

/**
 * DefaultNexusContextEngine
 *
 * 默认实现，封装现有 buildDynamicContext 逻辑
 * 按 token 预算智能分配各模块的上下文窗口
 */
export class DefaultNexusContextEngine implements NexusContextEngine {
  readonly info: { id: string; nexusId: string; name: string }

  private config: ContextEngineConfig
  private ingestedMessages: ChatMessage[] = []
  private compactionHistory: Array<{ before: number; after: number; ts: number }> = []
  /** V3: L1-Hot 记忆快照 (最近 N 轮的结构化操作摘要) */
  private l1HotSnapshots: L1ActionSnapshot[] = []

  constructor(config: ContextEngineConfig) {
    this.config = config
    this.info = {
      id: `ctx-engine-${config.nexusId}`,
      nexusId: config.nexusId,
      name: `ContextEngine[${config.nexusLabel}]`,
    }
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
    const { sessionId, tokenBudget, trigger, currentTokenCount } = params

    // 如果当前 token 在预算内，无需压缩
    if (currentTokenCount <= tokenBudget) {
      return {
        ok: true,
        compacted: false,
        tokensBefore: currentTokenCount,
        reason: 'Within budget, no compaction needed',
      }
    }

    // 计算需要压缩多少
    const targetTokens = Math.floor(tokenBudget * 0.75) // 压缩到预算的 75%
    const tokensToRemove = currentTokenCount - targetTokens

    console.log(`[ContextEngine] Compaction triggered (${trigger}): ${currentTokenCount} → target ${targetTokens} (remove ~${tokensToRemove} tokens)`)

    // 策略: 使用 LLM 对早期消息进行摘要
    try {
      const summaryPrompt = `请将以下对话历史压缩成一段简洁的摘要（200字以内），保留关键决策、工具调用结果和错误信息：
当前会话 ID: ${sessionId}
压缩触发器: ${trigger}
需要从 ${currentTokenCount} tokens 减少到 ${targetTokens} tokens`

      const summaryResponse = await chat([
        { role: 'user', content: summaryPrompt },
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

    // 2.5 V3: 收集 L1-Hot 快照
    const newSnapshots = this.collectL1Snapshots(toolResults, runState.seq)
    if (newSnapshots.length > 0) {
      this.l1HotSnapshots.push(...newSnapshots)
      // 保持固定大小窗口
      while (this.l1HotSnapshots.length > L1_MEMORY_CONFIG.HOT_MAX_SNAPSHOTS) {
        this.l1HotSnapshots.shift()
      }
      console.log(`[ContextEngine] L1-Hot: ${this.l1HotSnapshots.length} snapshots (added ${newSnapshots.length})`)

      // V3: L1-Cold 异步持久化到 memoryStore
      for (const snap of newSnapshots) {
        memoryStore.write({
          source: 'l1_memory',
          content: `[Turn ${snap.turn}] ${snap.action} → ${snap.target} (${snap.status}, ${snap.resultSize}B)${snap.resultPreview ? ' "' + snap.resultPreview.slice(0, 80) + '..."' : ''}`,
          nexusId: this.config.nexusId,
          tags: [snap.action, snap.status],
          metadata: { turn: snap.turn, resultSize: snap.resultSize },
        }).catch(() => {}) // 不阻塞
      }
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
    console.log(`[ContextEngine] Bootstrapping session: ${sessionId} for Nexus: ${this.config.nexusId}`)

    // 清理旧状态
    this.ingestedMessages = []
    this.compactionHistory = []
    this.l1HotSnapshots = []

    // 尝试从历史对话加载上下文
    const history = this.config.getConversationHistory?.() ?? []
    if (history.length > 0) {
      // 导入最近的消息作为初始上下文
      const recentHistory = history.slice(-10) // 最近 10 条
      for (const msg of recentHistory) {
        this.ingestedMessages.push(msg)
      }

      return {
        bootstrapped: true,
        importedMessages: recentHistory.length,
      }
    }

    return {
      bootstrapped: true,
      importedMessages: 0,
      reason: 'Fresh session, no prior history',
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
    const { childSessionId, childNexusId, reason, outcome } = params

    console.log(`[ContextEngine] Child ${childSessionId} (Nexus: ${childNexusId}) ended: ${reason}`)

    // 如果子智能体成功，将结果摘要注入到父上下文
    if (outcome?.success && outcome.result) {
      this.ingest({
        sessionId: '', // 使用当前会话
        message: {
          id: `child-result-${childSessionId}`,
          role: 'system',
          content: `[子智能体结果] Nexus ${childNexusId} 完成任务:\n${outcome.result.slice(0, 500)}`,
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
  // dispose: 清理资源
  // ═══════════════════════════════════════════

  async dispose(): Promise<void> {
    console.log(`[ContextEngine] Disposing engine for Nexus: ${this.config.nexusId}`)
    this.ingestedMessages = []
    this.compactionHistory = []
    this.l1HotSnapshots = []
  }

  // ═══════════════════════════════════════════
  // V3: L1 记忆辅助方法
  // ═══════════════════════════════════════════

  /** 从 ToolCallSummary 构建 L1ActionSnapshot 列表 */
  private collectL1Snapshots(
    toolResults: import('@/types').ToolCallSummary[],
    currentSeq: number,
  ): L1ActionSnapshot[] {
    const snapshots: L1ActionSnapshot[] = []

    for (const tr of toolResults) {
      // 提取操作目标：优先取 path 参数，fallback 到 args 摘要
      let target = ''
      if (tr.args.path) {
        target = String(tr.args.path)
      } else if (tr.args.query) {
        target = String(tr.args.query)
      } else if (tr.args.command) {
        target = String(tr.args.command)
      } else {
        target = JSON.stringify(tr.args).slice(0, L1_MEMORY_CONFIG.SNAPSHOT_TARGET_CHARS)
      }
      if (target.length > L1_MEMORY_CONFIG.SNAPSHOT_TARGET_CHARS) {
        target = target.slice(0, L1_MEMORY_CONFIG.SNAPSHOT_TARGET_CHARS - 3) + '...'
      }

      const resultText = tr.result || tr.error || ''
      snapshots.push({
        turn: currentSeq,
        action: tr.toolName,
        target,
        status: tr.status,
        resultSize: resultText.length,
        resultPreview: resultText.slice(0, L1_MEMORY_CONFIG.SNAPSHOT_PREVIEW_CHARS),
        nexusId: this.config.nexusId,
        timestamp: tr.timestamp,
      })
    }

    return snapshots
  }

  /** 构建 L1-Hot 上下文注入段落 */
  private buildL1HotSection(): string {
    const lines = this.l1HotSnapshots.map(snap => {
      const statusIcon = snap.status === 'success' ? '✓' : '✗'
      const preview = snap.resultPreview
        ? ` "${snap.resultPreview.slice(0, 60).replace(/\n/g, ' ')}${snap.resultPreview.length > 60 ? '...' : ''}"`
        : ''
      return `- [Turn ${snap.turn}] ${snap.action} → ${snap.target} ${statusIcon} (${snap.resultSize}B)${preview}`
    })

    return `## 最近操作回顾 (L1-Hot)\n以下是本次会话中最近的操作记录，可用于追踪执行进度：\n${lines.join('\n')}`
  }
}

// ============================================
// ContextEngine 注册表（管理多个 Nexus 的 engine）
// ============================================

class ContextEngineRegistry {
  private engines = new Map<string, NexusContextEngine>()

  /** 注册或获取一个 Nexus 的 ContextEngine */
  getOrCreate(nexusId: string, factory: () => NexusContextEngine): NexusContextEngine {
    const existing = this.engines.get(nexusId)
    if (existing) return existing

    const engine = factory()
    this.engines.set(nexusId, engine)
    console.log(`[ContextEngineRegistry] Created engine for Nexus: ${nexusId}`)
    return engine
  }

  /** 获取已注册的 engine */
  get(nexusId: string): NexusContextEngine | undefined {
    return this.engines.get(nexusId)
  }

  /** 移除并 dispose 一个 engine */
  async remove(nexusId: string): Promise<void> {
    const engine = this.engines.get(nexusId)
    if (engine) {
      await engine.dispose?.()
      this.engines.delete(nexusId)
      console.log(`[ContextEngineRegistry] Removed engine for Nexus: ${nexusId}`)
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
  list(): Array<{ nexusId: string; name: string }> {
    return Array.from(this.engines.entries()).map(([nexusId, engine]) => ({
      nexusId,
      name: engine.info.name,
    }))
  }
}

// 导出单例
export const contextEngineRegistry = new ContextEngineRegistry()

// 导出工具函数
export { estimateTokens, estimateMessagesTokens }
