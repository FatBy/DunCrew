/**
 * ConfidenceTracker - 记忆置信度追踪服务
 *
 * Phase 2 核心服务：为 L1 记忆条目追踪多信号置信度，决定是否晋升到 L0 全局记忆。
 *
 * 信号来源：
 * - Environment Assertion (+0.15): Critic 验证通过
 * - Human Positive (+0.15): 用户正面反馈/审批通过
 * - Human Negative (-0.15): 用户负面反馈/审批拒绝
 * - System Failure (-0.2): 工具执行失败
 * - Gene Match (+0.05): 与高置信基因匹配
 *
 * 晋升条件：
 * - confidence >= 0.7
 * - signals >= 3
 *
 * L0 衰减：半衰期 30 天
 */

import type { ConfidenceSignal, L1MemoryEntry } from '@/types'
import { CONFIDENCE_SIGNALS, L0_PROMOTION_CONFIG } from '@/types'
import { memoryStore } from './memoryStore'

// ============================================
// ConfidenceTrackerService
// ============================================

class ConfidenceTrackerService {
  /** 按 memoryId 索引的追踪条目 */
  private trackedEntries = new Map<string, L1MemoryEntry>()
  /** L0 衰减定时器 */
  private decayTimer: ReturnType<typeof setInterval> | null = null

  // ═══ 条目管理 ═══

  /** 创建新的追踪条目 */
  trackEntry(memoryId: string, nexusId: string, content: string, initialConfidence?: number): void {
    if (this.trackedEntries.has(memoryId)) return

    const entry: L1MemoryEntry = {
      id: memoryId,
      nexusId,
      content,
      confidence: initialConfidence ?? L0_PROMOTION_CONFIG.INITIAL_CONFIDENCE,
      signals: [],
      promotedToL0: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.trackedEntries.set(memoryId, entry)
  }

  /** 获取追踪条目 */
  getEntry(memoryId: string): L1MemoryEntry | undefined {
    return this.trackedEntries.get(memoryId)
  }

  /** 获取某个 Nexus 的所有追踪条目 */
  getEntriesByNexus(nexusId: string): L1MemoryEntry[] {
    return Array.from(this.trackedEntries.values())
      .filter(e => e.nexusId === nexusId)
  }

  // ═══ 信号收集 ═══

  /** 添加置信度信号 */
  addSignal(memoryId: string, signal: ConfidenceSignal): void {
    const entry = this.trackedEntries.get(memoryId)
    if (!entry) return

    entry.signals.push(signal)
    entry.confidence = Math.max(0, Math.min(1, entry.confidence + signal.delta))
    entry.updatedAt = Date.now()
  }

  /** 环境验证信号 (Critic 验证结果) */
  addEnvironmentSignal(memoryId: string, verified: boolean): void {
    this.addSignal(memoryId, {
      type: 'environment',
      delta: verified ? CONFIDENCE_SIGNALS.ENVIRONMENT_ASSERTION : -CONFIDENCE_SIGNALS.ENVIRONMENT_ASSERTION * 0.5,
      source: verified ? 'critic_verified' : 'critic_failed',
      timestamp: Date.now(),
    })
  }

  /** 人类反馈信号 */
  addHumanFeedback(memoryId: string, positive: boolean): void {
    this.addSignal(memoryId, {
      type: 'human_feedback',
      delta: positive ? CONFIDENCE_SIGNALS.HUMAN_POSITIVE : CONFIDENCE_SIGNALS.HUMAN_NEGATIVE,
      source: positive ? 'user_approved' : 'user_rejected',
      timestamp: Date.now(),
    })
  }

  /** 系统失败信号 */
  addFailureSignal(memoryId: string): void {
    this.addSignal(memoryId, {
      type: 'system_failure',
      delta: CONFIDENCE_SIGNALS.SYSTEM_FAILURE,
      source: 'tool_failure',
      timestamp: Date.now(),
    })
  }

  /** 基因匹配信号 */
  addGeneMatchSignal(memoryId: string): void {
    this.addSignal(memoryId, {
      type: 'environment',
      delta: CONFIDENCE_SIGNALS.GENE_MATCH,
      source: 'gene_match',
      timestamp: Date.now(),
    })
  }

  // ═══ 晋升评估 ═══

  /**
   * 评估某个 Nexus 下可晋升到 L0 的记忆条目
   * 条件：confidence >= PROMOTION_THRESHOLD && signals.length >= MIN_SIGNALS
   */
  evaluatePromotions(nexusId: string): L1MemoryEntry[] {
    return this.getEntriesByNexus(nexusId).filter(entry =>
      !entry.promotedToL0 &&
      entry.confidence >= L0_PROMOTION_CONFIG.PROMOTION_THRESHOLD &&
      entry.signals.length >= L0_PROMOTION_CONFIG.MIN_SIGNALS_FOR_PROMOTION,
    )
  }

  /**
   * 将高置信度 L1 记忆晋升到 L0 全局记忆
   * L0 = 写入 memoryStore 时不带 nexusId
   */
  async promoteToL0(entries: L1MemoryEntry[]): Promise<number> {
    let promoted = 0

    for (const entry of entries) {
      if (entry.promotedToL0) continue

      const ok = await memoryStore.write({
        source: 'memory',
        content: `[L0 Promoted] ${entry.content}`,
        tags: ['l0_promoted', `from_nexus:${entry.nexusId}`],
        metadata: {
          originalId: entry.id,
          sourceNexusId: entry.nexusId,
          confidence: entry.confidence,
          signalCount: entry.signals.length,
          promotedAt: Date.now(),
        },
      })

      if (ok) {
        entry.promotedToL0 = true
        entry.updatedAt = Date.now()
        promoted++
        console.log(`[ConfidenceTracker] Promoted to L0: ${entry.id} (confidence=${entry.confidence.toFixed(2)}, signals=${entry.signals.length})`)
      }
    }

    return promoted
  }

  // ═══ L0 衰减 ═══

  /**
   * 对内存中的追踪条目应用时间衰减
   * 已晋升的 L0 条目：confidence 按半衰期衰减
   * 长期未更新的条目：自动清理
   */
  applyDecay(): void {
    const now = Date.now()
    const halfLifeMs = L0_PROMOTION_CONFIG.DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000
    const maxAgeMs = halfLifeMs * 4 // 4 倍半衰期后清理

    const toRemove: string[] = []

    for (const [id, entry] of this.trackedEntries) {
      const ageMs = now - entry.updatedAt

      // 清理过老的条目
      if (ageMs > maxAgeMs) {
        toRemove.push(id)
        continue
      }

      // 对已晋升的条目应用衰减
      if (entry.promotedToL0) {
        const decayFactor = Math.pow(0.5, ageMs / halfLifeMs)
        entry.confidence *= decayFactor
        // 衰减后低于阈值不需要特殊处理，只是标记置信度下降
      }
    }

    for (const id of toRemove) {
      this.trackedEntries.delete(id)
    }

    if (toRemove.length > 0) {
      console.log(`[ConfidenceTracker] Decay cleanup: removed ${toRemove.length} stale entries`)
    }
  }

  /** 启动周期性衰减 (每 6 小时) */
  startDecayLoop(): void {
    if (this.decayTimer) return
    const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时
    this.decayTimer = setInterval(() => this.applyDecay(), DECAY_INTERVAL_MS)
    console.log('[ConfidenceTracker] Decay loop started (interval: 6h)')
  }

  /** 停止衰减循环 */
  stopDecayLoop(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
  }

  // ═══ 批量操作 ═══

  /**
   * 为最近一轮的工具执行结果批量创建追踪条目并添加初始信号
   * 在 ReAct 循环结束时调用
   */
  trackToolResults(
    nexusId: string,
    toolResults: Array<{ callId: string; toolName: string; status: 'success' | 'error'; result?: string }>,
  ): string[] {
    const trackedIds: string[] = []

    for (const tr of toolResults) {
      const memoryId = `l1-${nexusId}-${tr.callId}`
      const content = `${tr.toolName}: ${(tr.result || '').slice(0, 200)}`

      this.trackEntry(memoryId, nexusId, content)

      // 根据执行状态添加初始信号
      if (tr.status === 'success') {
        this.addEnvironmentSignal(memoryId, true)
      } else {
        this.addFailureSignal(memoryId)
      }

      trackedIds.push(memoryId)
    }

    return trackedIds
  }

  /** 获取统计信息 */
  getStats(): { total: number; promoted: number; avgConfidence: number } {
    const entries = Array.from(this.trackedEntries.values())
    const promoted = entries.filter(e => e.promotedToL0).length
    const avgConfidence = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length
      : 0

    return { total: entries.length, promoted, avgConfidence }
  }

  /** 清空 (测试用) */
  clear(): void {
    this.trackedEntries.clear()
    this.stopDecayLoop()
  }
}

// 导出单例
export const confidenceTracker = new ConfidenceTrackerService()
