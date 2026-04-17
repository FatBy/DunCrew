/**
 * ConfidenceTracker - 记忆置信度追踪服务
 *
 * Phase 2 核心服务：为 L1 记忆条目追踪多信号置信度，决定是否晋升到 L0 全局记忆。
 *
 * 信号来源：
 * - Environment Assertion (+0.15): Critic 验证通过
 * - Human Positive (+0.20): 用户正面反馈/审批通过
 * - Human Negative (-0.20): 用户负面反馈/审批拒绝
 * - System Failure (-0.15): 系统/工具执行失败
 * - Gene Match (+0.05): 与高置信基因匹配
 * - Repeated Success (+0.10): 同类工具重复成功
 *
 * 晋升条件：
 * - confidence >= 0.65
 * - signals >= 2
 *
 * 追踪粒度：按 dunId + toolName 聚合（而非按 callId），支持跨循环信号积累
 * 持久化：localStorage，页面刷新不丢失
 *
 * L0 衰减：半衰期 30 天
 */

import type { ConfidenceSignal, L1MemoryEntry } from '@/types'
import { CONFIDENCE_SIGNALS, L0_PROMOTION_CONFIG } from '@/types'
import { memoryStore } from './memoryStore'
import { chatBackground, isLLMConfigured } from './llmService'
import { PROMOTION_PROMPT, parsePromotionResult, classifyMemoryContent } from '@/utils/memoryPromotion'
import { getServerUrl } from '@/utils/env'

const TRACKER_STORAGE_KEY = 'duncrew_confidence_tracker'
const MIGRATION_FLAG_KEY = 'duncrew_confidence_migrated'

// ============================================
// ConfidenceTrackerService
// ============================================

class ConfidenceTrackerService {
  /** 按 memoryId 索引的追踪条目 */
  private trackedEntries = new Map<string, L1MemoryEntry>()
  /** L0 衰减定时器 */
  private decayTimer: ReturnType<typeof setInterval> | null = null
  /** 批量操作时跳过中间持久化 */
  private _skipPersist = false
  /** 初始化完成 Promise（加载 + 迁移），所有关键方法前 await */
  private readyPromise: Promise<void>

  constructor() {
    this.readyPromise = this.initialize()
  }

  /** 串联加载 + 迁移两个异步操作 */
  private async initialize(): Promise<void> {
    await this.loadFromStorage()
    await this.migrateToBackend()
  }

  // ═══ 持久化 ═══

  /** 从 localStorage 恢复追踪状态，为空时从后端恢复 */
  private async loadFromStorage(): Promise<void> {
    try {
      const raw = localStorage.getItem(TRACKER_STORAGE_KEY)
      if (raw) {
        const entries: L1MemoryEntry[] = JSON.parse(raw)
        for (const entry of entries) {
          this.trackedEntries.set(entry.id, entry)
        }
        console.log(`[ConfidenceTracker] Restored ${entries.length} entries from localStorage`)
        return
      }

      // localStorage 为空（用户清了缓存），从后端恢复
      console.log('[ConfidenceTracker] localStorage empty, recovering from backend...')
      const serverUrl = getServerUrl()
      const res = await fetch(`${serverUrl}/api/confidence/entries`)
      if (res.ok) {
        const entries: L1MemoryEntry[] = await res.json()
        for (const entry of entries) {
          this.trackedEntries.set(entry.id, entry)
        }
        if (entries.length > 0) {
          this.saveToStorage()
          console.log(`[ConfidenceTracker] Recovered ${entries.length} entries from backend`)
        }
      }
    } catch {
      console.warn('[ConfidenceTracker] Failed to load from storage/backend')
    }
  }

  /** 将 localStorage 数据迁移到后端（一次性，有 flag 防重复） */
  private async migrateToBackend(): Promise<void> {
    if (localStorage.getItem(MIGRATION_FLAG_KEY)) return
    if (this.trackedEntries.size === 0) return

    try {
      const serverUrl = getServerUrl()
      const entries = Array.from(this.trackedEntries.values())
      const res = await fetch(`${serverUrl}/api/confidence/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      })
      if (res.ok) {
        localStorage.setItem(MIGRATION_FLAG_KEY, '1')
        console.log(`[ConfidenceTracker] Migrated ${entries.length} entries to backend`)
      }
    } catch {
      console.warn('[ConfidenceTracker] Migration to backend failed (will retry next time)')
    }
  }

  /** 持久化追踪状态到 localStorage */
  private saveToStorage(): void {
    if (this._skipPersist) return
    try {
      const entries = Array.from(this.trackedEntries.values())
      const trimmed = entries
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 2000)  // localStorage 5MB 配额，2000 条约 1-2MB
      localStorage.setItem(TRACKER_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      console.warn('[ConfidenceTracker] Failed to save to storage')
    }
  }

  // ═══ 条目管理 ═══

  /** 创建新的追踪条目 */
  async trackEntry(memoryId: string, dunId: string, content: string, initialConfidence?: number): Promise<void> {
    await this.readyPromise
    if (this.trackedEntries.has(memoryId)) return

    const entry: L1MemoryEntry = {
      id: memoryId,
      dunId,
      content,
      confidence: initialConfidence ?? L0_PROMOTION_CONFIG.INITIAL_CONFIDENCE,
      signals: [],
      promotedToL0: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.trackedEntries.set(memoryId, entry)
    this.saveToStorage()
  }

  /** 获取追踪条目 */
  async getEntry(memoryId: string): Promise<L1MemoryEntry | undefined> {
    await this.readyPromise
    return this.trackedEntries.get(memoryId)
  }

  /** 获取某个 Dun 的所有追踪条目 */
  async getEntriesByDun(dunId: string): Promise<L1MemoryEntry[]> {
    await this.readyPromise
    return Array.from(this.trackedEntries.values())
      .filter(e => e.dunId === dunId)
  }

  /** 批量获取追踪条目（单次 await，替代逐条 getEntry 的 N+1 调用） */
  async getEntriesBatch(ids: string[]): Promise<Map<string, L1MemoryEntry>> {
    await this.readyPromise
    const result = new Map<string, L1MemoryEntry>()
    for (const id of ids) {
      const entry = this.trackedEntries.get(id)
      if (entry) result.set(id, entry)
    }
    return result
  }

  // ═══ 信号收集 ═══

  /** 添加置信度信号 */
  async addSignal(memoryId: string, signal: ConfidenceSignal): Promise<void> {
    await this.readyPromise
    const entry = this.trackedEntries.get(memoryId)
    if (!entry) return

    entry.signals.push(signal)
    entry.confidence = Math.max(0, Math.min(1, entry.confidence + signal.delta))
    entry.updatedAt = Date.now()
    this.saveToStorage()
  }

  /** 环境验证信号 (Critic 验证结果) */
  async addEnvironmentSignal(memoryId: string, verified: boolean): Promise<void> {
    await this.addSignal(memoryId, {
      type: 'environment',
      delta: verified ? CONFIDENCE_SIGNALS.ENVIRONMENT_ASSERTION : -CONFIDENCE_SIGNALS.ENVIRONMENT_ASSERTION * 0.5,
      source: verified ? 'critic_verified' : 'critic_failed',
      timestamp: Date.now(),
    })
  }

  /** 人类反馈信号 */
  async addHumanFeedback(memoryId: string, positive: boolean): Promise<void> {
    await this.addSignal(memoryId, {
      type: 'human_feedback',
      delta: positive ? CONFIDENCE_SIGNALS.HUMAN_POSITIVE : CONFIDENCE_SIGNALS.HUMAN_NEGATIVE,
      source: positive ? 'user_approved' : 'user_rejected',
      timestamp: Date.now(),
    })
  }

  /** 系统失败信号 */
  async addFailureSignal(memoryId: string): Promise<void> {
    await this.addSignal(memoryId, {
      type: 'system_failure',
      delta: CONFIDENCE_SIGNALS.SYSTEM_FAILURE,
      source: 'tool_failure',
      timestamp: Date.now(),
    })
  }

  /** 基因匹配信号 */
  async addGeneMatchSignal(memoryId: string): Promise<void> {
    await this.addSignal(memoryId, {
      type: 'environment',
      delta: CONFIDENCE_SIGNALS.GENE_MATCH,
      source: 'gene_match',
      timestamp: Date.now(),
    })
  }

  /** 同类工具重复成功信号 */
  async addRepeatedSuccessSignal(memoryId: string): Promise<void> {
    await this.addSignal(memoryId, {
      type: 'environment',
      delta: CONFIDENCE_SIGNALS.REPEATED_SUCCESS,
      source: 'repeated_success',
      timestamp: Date.now(),
    })
  }

  // ═══ 晋升评估 ═══

  /**
   * 评估某个 Dun 下可晋升到 L0 的记忆条目
   * 条件：confidence >= PROMOTION_THRESHOLD && signals.length >= MIN_SIGNALS
   */
  async evaluatePromotions(dunId: string): Promise<L1MemoryEntry[]> {
    await this.readyPromise
    const entries = await this.getEntriesByDun(dunId)
    return entries.filter(entry =>
      !entry.promotedToL0 &&
      entry.confidence >= L0_PROMOTION_CONFIG.PROMOTION_THRESHOLD &&
      entry.signals.length >= L0_PROMOTION_CONFIG.MIN_SIGNALS_FOR_PROMOTION,
    )
  }

  /** 安全版：await readyPromise 后再评估晋升 */
  async evaluatePromotionsSafe(dunId: string): Promise<L1MemoryEntry[]> {
    return this.evaluatePromotions(dunId)
  }

  /**
   * 将高置信度 L1 记忆晋升到 L0 全局记忆
   * V2: 聚合同 Dun 的多条 L1 记忆，调用 LLM 生成语义摘要后通过 writeWithDedup 写入
   */
  async promoteToL0(entries: L1MemoryEntry[]): Promise<number> {
    await this.readyPromise
    if (entries.length === 0) return 0

    // 按 dunId 分组
    const byDun = new Map<string, L1MemoryEntry[]>()
    for (const entry of entries) {
      if (entry.promotedToL0) continue
      const group = byDun.get(entry.dunId) || []
      group.push(entry)
      byDun.set(entry.dunId, group)
    }

    let promoted = 0

    for (const [dunId, groupEntries] of byDun) {
      const rawContents = groupEntries.map(e => e.content).join('\n')
      const avgConfidence = groupEntries.reduce((sum, e) => sum + e.confidence, 0) / groupEntries.length

      // 尝试用 LLM 做语义提炼（使用共享的 PROMOTION_PROMPT）
      let summarizedContent: string | null = null
      if (isLLMConfigured()) {
        try {
          const summaryResult = await chatBackground([
            { role: 'system', content: PROMOTION_PROMPT },
            { role: 'user', content: rawContents.slice(0, 2000) },
          ], { priority: 6 })

          summarizedContent = parsePromotionResult(summaryResult?.trim() || '')

          // LLM 判断不值得保留则标记并跳过
          if (!summarizedContent) {
            console.log(`[ConfidenceTracker] LLM judged entries not worth promoting for Dun ${dunId}, skipping`)
            for (const entry of groupEntries) {
              entry.promotedToL0 = true
              entry.updatedAt = Date.now()
            }
            continue
          }
        } catch (summarizeError) {
          console.warn('[ConfidenceTracker] LLM summarize failed, using fallback:', summarizeError)
          summarizedContent = this.fallbackSummarize(groupEntries)
        }
      } else {
        summarizedContent = this.fallbackSummarize(groupEntries)
      }

      // fallback 也可能返回空（无有价值内容）
      if (!summarizedContent) {
        console.log(`[ConfidenceTracker] Fallback found no valuable content for Dun ${dunId}, skipping`)
        for (const entry of groupEntries) {
          entry.promotedToL0 = true
          entry.updatedAt = Date.now()
        }
        continue
      }

      // 使用 writeWithDedup 写入，自动去重
      const writeSuccess = await memoryStore.writeWithDedup({
        source: 'memory',
        content: summarizedContent,
        dunId: dunId, // 确保作为独立字段传递，支持按 Dun 搜索
        tags: ['l0_promoted', `from_dun:${dunId}`],
        metadata: {
          sourceDunId: dunId,
          sourceEntryIds: groupEntries.map(e => e.id),
          confidence: avgConfidence,
          signalCount: groupEntries.reduce((sum, e) => sum + e.signals.length, 0),
          promotedAt: Date.now(),
          entryCount: groupEntries.length,
          category: classifyMemoryContent(summarizedContent).category,
        },
      })

      if (writeSuccess) {
        for (const entry of groupEntries) {
          entry.promotedToL0 = true
          entry.updatedAt = Date.now()
        }
        promoted += groupEntries.length
        console.log(`[ConfidenceTracker] Promoted ${groupEntries.length} L1 → L0 for Dun ${dunId}: "${summarizedContent.slice(0, 80)}..."`)
      }
    }

    if (promoted > 0) {
      this.saveToStorage()
    }

    return promoted
  }

  /** 安全版：await readyPromise 后再执行晋升 */
  async promoteToL0Safe(entries: L1MemoryEntry[]): Promise<number> {
    return this.promoteToL0(entries)
  }

  /**
   * 本地 fallback 提炼：优先提取用户意图，无意图时返回空字符串
   */
  private fallbackSummarize(entries: L1MemoryEntry[]): string {
    // 优先：从带 [toolName] 前缀的条目中提取用户意图
    const intentEntries = entries.filter(e => e.content.startsWith('['))
    if (intentEntries.length > 0) {
      const intents = new Set<string>()
      for (const entry of intentEntries) {
        const closeBracket = entry.content.indexOf(']')
        if (closeBracket > 0) {
          intents.add(entry.content.slice(closeBracket + 1).trim())
        }
      }
      const uniqueIntents = Array.from(intents).slice(0, 3)
      if (uniqueIntents.length > 0) {
        return uniqueIntents.join('；')
      }
    }

    // 降级：从工具输出中提取文件路径等有价值信息
    const targets = new Set<string>()
    for (const entry of entries) {
      const pathMatch = entry.content.match(/(?:[\w./\\-]+\.[\w]{1,6})/g)
      if (pathMatch) {
        for (const path of pathMatch.slice(0, 3)) {
          targets.add(path)
        }
      }
    }

    // 如果连文件路径都没有，说明这批记忆没有价值，返回空
    if (targets.size === 0) return ''

    const toolNames = new Set<string>()
    for (const entry of entries) {
      const colonIndex = entry.content.indexOf(':')
      if (colonIndex > 0 && colonIndex < 30) {
        toolNames.add(entry.content.slice(0, colonIndex).trim())
      }
    }

    const toolList = Array.from(toolNames).slice(0, 5).join('、')
    const targetList = Array.from(targets).slice(0, 3).join('、')

    return `使用 ${toolList} 操作了 ${targetList}`
  }

  // ═══ L0 衰减 ═══

  /**
   * 对内存中的追踪条目应用时间衰减
   * 已晋升的 L0 条目：confidence 按半衰期衰减
   * 长期未更新的条目：自动清理
   */
  async applyDecay(): Promise<void> {
    await this.readyPromise
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

      // 对已晋升的条目应用衰减（使用增量时间，避免复合衰减）
      if (entry.promotedToL0) {
        const lastDecayAt = entry.lastDecayAt || entry.updatedAt || entry.createdAt
        const deltaMs = now - lastDecayAt

        // 增量时间 > 0 才应用衰减，避免刚更新的条目被重复衰减
        if (deltaMs > 0) {
          const decayFactor = Math.pow(0.5, deltaMs / halfLifeMs)
          entry.confidence *= decayFactor
          entry.lastDecayAt = now // 记录本次衰减时间，下次基于此计算增量
        }
      }
    }

    for (const id of toRemove) {
      this.trackedEntries.delete(id)
    }

    if (toRemove.length > 0) {
      console.log(`[ConfidenceTracker] Decay cleanup: removed ${toRemove.length} stale entries`)
    }

    this.saveToStorage()
  }

  /** 启动周期性衰减 (每 6 小时) */
  async startDecayLoop(): Promise<void> {
    await this.readyPromise
    if (this.decayTimer) return
    const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 小时
    this.decayTimer = setInterval(() => void this.applyDecay(), DECAY_INTERVAL_MS)
    console.log('[ConfidenceTracker] Decay loop started (interval: 6h)')
  }

  /** 停止衰减循环 */
  async stopDecayLoop(): Promise<void> {
    await this.readyPromise
    if (this.decayTimer) {
      clearInterval(this.decayTimer)
      this.decayTimer = null
    }
  }

  // ═══ 批量操作 ═══

  /**
   * 按 dunId + toolName 聚合追踪（而非按 callId）
   * 同一个 Dun 下多次成功使用同一个工具 → 给同一个条目追加信号
   */
  /**
   * 按 dunId + toolName 聚合追踪（而非按 callId）
   * 同一个 Dun 下多次成功使用同一个工具 → 给同一个条目追加信号
   *
   * @param userIntent 用户原始意图（来自 userPrompt），用于提升 L1 内容质量
   */
  async trackToolResults(
    dunId: string,
    toolResults: Array<{ callId: string; toolName: string; status: 'success' | 'error'; result?: string }>,
    userIntent?: string,
  ): Promise<string[]> {
    await this.readyPromise
    const trackedIds: string[] = []

    // 批量操作期间跳过中间持久化
    this._skipPersist = true
    try {
      for (const tr of toolResults) {
        const memoryId = `l1-${dunId}-${tr.toolName}`
        const existingEntry = this.trackedEntries.get(memoryId)

        if (existingEntry) {
          if (tr.status === 'success') {
            await this.addRepeatedSuccessSignal(memoryId)
          } else {
            await this.addFailureSignal(memoryId)
          }
          // 只在 content 还是工具原始输出格式时才用意图覆盖
          // 已有 [toolName] 前缀说明之前已写入过高价值意图，不再覆盖
          if (userIntent && !existingEntry.content.startsWith('[')) {
            existingEntry.content = `[${tr.toolName}] ${userIntent}`
          }
          existingEntry.updatedAt = Date.now()
        } else {
          // 新条目：优先用意图，fallback 到工具输出
          const content = userIntent
            ? `[${tr.toolName}] ${userIntent}`
            : `${tr.toolName}: ${(tr.result || '').slice(0, 200)}`
          await this.trackEntry(memoryId, dunId, content)

          if (tr.status === 'success') {
            await this.addEnvironmentSignal(memoryId, true)
          } else {
            await this.addFailureSignal(memoryId)
          }
        }

        trackedIds.push(memoryId)
      }
    } finally {
      this._skipPersist = false
    }

    this.saveToStorage()
    return trackedIds
  }

  /** 获取统计信息 */
  async getStats(): Promise<{ total: number; promoted: number; avgConfidence: number }> {
    await this.readyPromise
    const entries = Array.from(this.trackedEntries.values())
    const promoted = entries.filter(e => e.promotedToL0).length
    const avgConfidence = entries.length > 0
      ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length
      : 0

    return { total: entries.length, promoted, avgConfidence }
  }

  /** 销毁服务：停止衰减循环并清理状态 */
  async destroy(): Promise<void> {
    await this.readyPromise
    await this.stopDecayLoop()
    this.saveToStorage()
  }

  /** 清空 (测试用) */
  async clear(): Promise<void> {
    await this.readyPromise
    this.trackedEntries.clear()
    await this.stopDecayLoop()
    localStorage.removeItem(TRACKER_STORAGE_KEY)
  }

  // ═══ Consolidator 接口 ═══

  /**
   * 获取可晋升到 L0 的候选条目（纯数据查询，无 LLM）
   * 供 postExecutionConsolidator 在 Phase 1 收集 payload 时调用
   */
  async getPromotableCandidates(dunId: string): Promise<L1MemoryEntry[]> {
    return this.evaluatePromotionsSafe(dunId)
  }

  /**
   * 应用 Consolidator 的晋升判定结果（无 LLM 调用）
   *
   * @param entries 所有候选条目
   * @param promotedIds Consolidator 判定值得晋升的条目 ID 列表
   * @returns 实际写入 L0 的条目数
   */
  async applyPromotionResults(entries: L1MemoryEntry[], promotedIds: string[]): Promise<number> {
    await this.readyPromise
    if (entries.length === 0) return 0

    const promotedSet = new Set(promotedIds)

    // 按 dunId 分组
    const byDun = new Map<string, { promoted: L1MemoryEntry[]; skipped: L1MemoryEntry[] }>()
    for (const entry of entries) {
      if (entry.promotedToL0) continue
      const group = byDun.get(entry.dunId) || { promoted: [], skipped: [] }
      if (promotedSet.has(entry.id)) {
        group.promoted.push(entry)
      } else {
        group.skipped.push(entry)
      }
      byDun.set(entry.dunId, group)
    }

    let totalPromoted = 0

    for (const [dunId, { promoted, skipped }] of byDun) {
      // 标记不值得晋升的条目（避免下次重复评估）
      for (const entry of skipped) {
        entry.promotedToL0 = true
        entry.updatedAt = Date.now()
      }

      if (promoted.length === 0) continue

      // 对值得晋升的条目，构建摘要并写入 L0
      const rawContents = promoted.map(e => e.content).join('\n')
      const avgConfidence = promoted.reduce((sum, e) => sum + e.confidence, 0) / promoted.length

      // 使用 fallback 提炼（Consolidator 已通过 LLM 做了判定，这里只做格式化）
      const summarizedContent = this.fallbackSummarize(promoted) || rawContents.slice(0, 500)

      const writeSuccess = await memoryStore.writeWithDedup({
        source: 'memory',
        content: summarizedContent,
        dunId,
        tags: ['l0_promoted', `from_dun:${dunId}`],
        metadata: {
          sourceDunId: dunId,
          sourceEntryIds: promoted.map(e => e.id),
          confidence: avgConfidence,
          signalCount: promoted.reduce((sum, e) => sum + e.signals.length, 0),
          promotedAt: Date.now(),
          entryCount: promoted.length,
          category: classifyMemoryContent(summarizedContent).category,
        },
      })

      if (writeSuccess) {
        for (const entry of promoted) {
          entry.promotedToL0 = true
          entry.updatedAt = Date.now()
        }
        totalPromoted += promoted.length
        console.log(`[ConfidenceTracker/Consolidator] Promoted ${promoted.length} L1 → L0 for Dun ${dunId}`)
      }
    }

    if (totalPromoted > 0 || entries.length > 0) {
      this.saveToStorage()
    }

    return totalPromoted
  }
}

// 导出单例
export const confidenceTracker = new ConfidenceTrackerService()
