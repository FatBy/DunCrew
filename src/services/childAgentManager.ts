/**
 * ChildAgentManager - 子智能体生成与生命周期管理
 *
 * 支持父 Agent 动态生成子 Agent 执行子任务：
 * - 限制生成深度和并行数
 * - 生命周期管理（启动/监控/完成/超时/终止）
 * - 结果聚合与上下文回传
 * - EventBus 事件通知
 */

import type {
  SpawnChildParams,
  SpawnChildResult,
  ChildRunRecord,
  ChildOutcome,
  AgentPhase,
  ChildContextEnvelope,
} from '@/types'
import { CHILD_LIMITS } from '@/types'
import { agentEventBus } from './agentEventBus'
import { getLLMConfig } from './llmService'

// ============================================
// 子智能体管理器
// ============================================

class ChildAgentManager {
  /** 活跃的子智能体记录 */
  private children = new Map<string, ChildRunRecord>()
  /** 历史记录（最近 50 条） */
  private history: ChildRunRecord[] = []
  /** 定时器引用（用于超时检测） */
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // ═══ 生成子智能体 ═══

  /**
   * 生成子智能体
   *
   * 检查深度/并行限制 → 创建会话 → 注册记录 → 发出事件
   */
  async spawn(
    _parentRunId: string,
    parentSessionId: string,
    params: SpawnChildParams,
    currentDepth: number = 0,
  ): Promise<SpawnChildResult> {
    // 1. 深度检查
    if (currentDepth >= CHILD_LIMITS.maxSpawnDepth) {
      console.warn(`[ChildAgent] Spawn rejected: depth ${currentDepth} >= max ${CHILD_LIMITS.maxSpawnDepth}`)
      return {
        status: 'forbidden',
        error: `子智能体嵌套深度超出限制 (max: ${CHILD_LIMITS.maxSpawnDepth})`,
      }
    }

    // 2. 并行数检查
    const activeCount = this.getActiveCount()
    if (activeCount >= CHILD_LIMITS.maxChildrenPerSession) {
      console.warn(`[ChildAgent] Spawn rejected: ${activeCount} active >= max ${CHILD_LIMITS.maxChildrenPerSession}`)
      return {
        status: 'forbidden',
        error: `并行子智能体数超出限制 (max: ${CHILD_LIMITS.maxChildrenPerSession})`,
      }
    }

    // 3. 创建子运行记录
    const childRunId = `child-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const childSessionId = `session-child-${Date.now()}`
    const model = params.model || getLLMConfig().model || 'unknown'
    const dunId = params.dunId || 'default'

    const record: ChildRunRecord = {
      runId: childRunId,
      childSessionId,
      parentSessionId,
      dunId,
      dunLabel: dunId, // 后续可从 store 获取真实 label
      task: params.task,
      status: 'pending',
      depth: currentDepth + 1,
      model,
      createdAt: Date.now(),
      turns: 0,
      toolsCalled: [],
      currentPhase: 'idle',
    }

    this.children.set(childRunId, record)

    // 4. 发出子智能体生成事件
    agentEventBus.childSpawned({
      childRunId,
      childSessionId,
      dunId,
      task: params.task,
      depth: currentDepth + 1,
      model,
    })

    // 5. 设置超时
    const timeoutMs = (params.timeout || CHILD_LIMITS.defaultTimeoutSeconds) * 1000
    const timer = setTimeout(() => {
      this.handleTimeout(childRunId)
    }, timeoutMs)
    this.timeoutTimers.set(childRunId, timer)

    console.log(`[ChildAgent] Spawned ${childRunId} for task: "${params.task.slice(0, 80)}" (depth: ${currentDepth + 1}, timeout: ${timeoutMs}ms)`)

    return {
      status: 'accepted',
      childSessionId,
      runId: childRunId,
      dunId,
    }
  }

  // ═══ V8: 碱基 Ledger 驱动的 spawn ═══

  /**
   * V8: 带上下文信封的 spawn（由 Transcriptase 触发）
   *
   * 相比普通 spawn，额外携带 ChildContextEnvelope（mRNA），
   * 子 Agent 可以从中获取父 Ledger 快照和共享 facts。
   */
  async spawnWithEnvelope(
    _parentRunId: string,
    parentSessionId: string,
    params: SpawnChildParams,
    envelope: ChildContextEnvelope,
    currentDepth: number = 0,
  ): Promise<SpawnChildResult> {
    // 将 envelope 附加到 params
    const enrichedParams: SpawnChildParams = {
      ...params,
      contextEnvelope: envelope,
      // 使用 envelope 的超时设置
      timeout: Math.ceil(envelope.returnContract.maxDurationMs / 1000),
    }

    // 复用现有 spawn 逻辑
    const result = await this.spawn(_parentRunId, parentSessionId, enrichedParams, currentDepth)

    if (result.status === 'accepted' && result.runId) {
      console.log(`[ChildAgent] V8: Spawned with envelope, parent seq: ${envelope.parentBaseSequence.slice(0, 40)}...`)
    }

    return result
  }

  // ═══ 生命周期管理 ═══

  /** 标记子智能体开始执行 */
  markRunning(childRunId: string): void {
    const record = this.children.get(childRunId)
    if (!record) return

    record.status = 'running'
    record.startedAt = Date.now()
    record.currentPhase = 'planning'
  }

  /** 更新子智能体进度 */
  updateProgress(childRunId: string, phase: AgentPhase, turns: number, currentTool?: string): void {
    const record = this.children.get(childRunId)
    if (!record) return

    record.currentPhase = phase
    record.turns = turns
    if (currentTool) {
      record.toolsCalled.push(currentTool)
    }

    agentEventBus.childProgress(childRunId, phase, turns, currentTool)
  }

  /** 标记子智能体完成 */
  markCompleted(childRunId: string, outcome: ChildOutcome): void {
    const record = this.children.get(childRunId)
    if (!record) return

    // 清除超时定时器
    const timer = this.timeoutTimers.get(childRunId)
    if (timer) {
      clearTimeout(timer)
      this.timeoutTimers.delete(childRunId)
    }

    record.status = outcome.success ? 'completed' : 'error'
    record.endedAt = Date.now()
    record.outcome = outcome

    // 发出完成事件
    agentEventBus.childCompleted({
      childRunId,
      dunId: record.dunId,
      success: outcome.success,
      result: outcome.result,
      error: outcome.error,
      durationMs: outcome.durationMs,
      scoreChange: outcome.scoreChange,
      genesHarvested: outcome.genesHarvested,
    })

    // 移到历史
    this.children.delete(childRunId)
    this.history.push(record)
    if (this.history.length > 50) {
      this.history = this.history.slice(-50)
    }

    console.log(`[ChildAgent] ${childRunId} completed: success=${outcome.success}, duration=${outcome.durationMs}ms`)
  }

  /** 终止子智能体 */
  kill(childRunId: string, reason: string = 'User killed'): void {
    const record = this.children.get(childRunId)
    if (!record) return

    const timer = this.timeoutTimers.get(childRunId)
    if (timer) {
      clearTimeout(timer)
      this.timeoutTimers.delete(childRunId)
    }

    record.status = 'killed'
    record.endedAt = Date.now()
    record.outcome = {
      success: false,
      error: reason,
      tokensUsed: 0,
      durationMs: Date.now() - (record.startedAt || record.createdAt),
      scoreChange: 0,
      genesHarvested: 0,
    }

    agentEventBus.childCompleted({
      childRunId,
      dunId: record.dunId,
      success: false,
      error: reason,
      durationMs: record.outcome.durationMs,
      scoreChange: 0,
      genesHarvested: 0,
    })

    this.children.delete(childRunId)
    this.history.push(record)

    console.log(`[ChildAgent] ${childRunId} killed: ${reason}`)
  }

  // ═══ 查询 ═══

  /** 获取活跃子智能体数量 */
  getActiveCount(): number {
    return this.children.size
  }

  /** 获取活跃子智能体列表 */
  getActiveChildren(): ChildRunRecord[] {
    return Array.from(this.children.values())
  }

  /** 获取历史记录 */
  getHistory(limit: number = 20): ChildRunRecord[] {
    return this.history.slice(-limit)
  }

  /** 获取指定子智能体记录 */
  getChild(childRunId: string): ChildRunRecord | undefined {
    return this.children.get(childRunId) || this.history.find(h => h.runId === childRunId)
  }

  // ═══ 内部方法 ═══

  /** 处理超时 */
  private handleTimeout(childRunId: string): void {
    const record = this.children.get(childRunId)
    if (!record) return

    console.warn(`[ChildAgent] ${childRunId} timed out after ${CHILD_LIMITS.defaultTimeoutSeconds}s`)

    record.status = 'timeout'
    record.endedAt = Date.now()
    record.outcome = {
      success: false,
      error: `子智能体执行超时 (${CHILD_LIMITS.defaultTimeoutSeconds}s)`,
      tokensUsed: 0,
      durationMs: Date.now() - (record.startedAt || record.createdAt),
      scoreChange: -5,
      genesHarvested: 0,
    }

    agentEventBus.childCompleted({
      childRunId,
      dunId: record.dunId,
      success: false,
      error: record.outcome.error,
      durationMs: record.outcome.durationMs,
      scoreChange: -5,
      genesHarvested: 0,
    })

    this.children.delete(childRunId)
    this.timeoutTimers.delete(childRunId)
    this.history.push(record)
  }

  /** 清理所有子智能体 */
  disposeAll(): void {
    for (const [id] of this.children) {
      this.kill(id, 'Parent disposed')
    }
    for (const [, timer] of this.timeoutTimers) {
      clearTimeout(timer)
    }
    this.timeoutTimers.clear()
  }
}

// 导出单例
export const childAgentManager = new ChildAgentManager()
