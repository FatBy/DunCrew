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
 * 追踪粒度：按 nexusId + toolName 聚合（而非按 callId），支持跨循环信号积累
 * 持久化：localStorage，页面刷新不丢失
 *
 * L0 衰减：半衰期 30 天
 */

import type { ConfidenceSignal, L1MemoryEntry } from '@/types'
import { CONFIDENCE_SIGNALS, L0_PROMOTION_CONFIG } from '@/types'
import { memoryStore } from './memoryStore'
import { chat, isLLMConfigured } from './llmService'

const TRACKER_STORAGE_KEY = 'duncrew_confidence_tracker'

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

  constructor() {
    this.loadFromStorage()
  }

  // ═══ 持久化 ═══

  /** 从 localStorage 恢复追踪状态 */
  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(TRACKER_STORAGE_KEY)
      if (!raw) return
      const entries: L1MemoryEntry[] = JSON.parse(raw)
      for (const entry of entries) {
        this.trackedEntries.set(entry.id, entry)
      }
      console.log(`[ConfidenceTracker] Restored ${entries.length} entries from storage`)
    } catch {
      console.warn('[ConfidenceTracker] Failed to load from storage')
    }
  }

  /** 持久化追踪状态到 localStorage */
  private saveToStorage(): void {
    if (this._skipPersist) return
    try {
      const entries = Array.from(this.trackedEntries.values())
      const trimmed = entries
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 500)
      localStorage.setItem(TRACKER_STORAGE_KEY, JSON.stringify(trimmed))
    } catch {
      console.warn('[ConfidenceTracker] Failed to save to storage')
    }
  }

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
    this.saveToStorage()
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
    this.saveToStorage()
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

  /** 同类工具重复成功信号 */
  addRepeatedSuccessSignal(memoryId: string): void {
    this.addSignal(memoryId, {
      type: 'environment',
      delta: CONFIDENCE_SIGNALS.REPEATED_SUCCESS,
      source: 'repeated_success',
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
   * V2: 聚合同 Nexus 的多条 L1 记忆，调用 LLM 生成语义摘要后写入
   */
  async promoteToL0(entries: L1MemoryEntry[]): Promise<number> {
    if (entries.length === 0) return 0

    // 按 nexusId 分组
    const byNexus = new Map<string, L1MemoryEntry[]>()
    for (const entry of entries) {
      if (entry.promotedToL0) continue
      const group = byNexus.get(entry.nexusId) || []
      group.push(entry)
      byNexus.set(entry.nexusId, group)
    }

    let promoted = 0

    for (const [nexusId, groupEntries] of byNexus) {
      const rawContents = groupEntries.map(e => e.content).join('\n')
      const avgConfidence = groupEntries.reduce((sum, e) => sum + e.confidence, 0) / groupEntries.length

      // 尝试用 LLM 做语义提炼
      let summarizedContent: string
      if (isLLMConfigured()) {
        try {
          const summaryResult = await chat([
            {
              role: 'system',
              content: [
                '你是一个记忆提炼助手。判断以下工具执行记录是否值得作为长期记忆保留。',
                '',
                '## 值得保留的记忆',
                '- 用户的具体意图和目标（"用户想修复 config.json 的端口配置"）',
                '- 关键发现和结论（"发现端口 3001 被占用，改为 3002 后解决"）',
                '- 用户偏好和习惯（"用户偏好用 pnpm 而非 npm"）',
                '- 重要的项目上下文（"项目使用 Vite + React + TypeScript"）',
                '',
                '## 不值得保留的记忆',
                '- 纯粹的工具执行细节（"readFile 返回了 200 字节"）',
                '- 临时性操作（"列出了目录内容"）',
                '- 无上下文的碎片信息',
                '',
                '## 输出规则',
                '- 如果值得保留：用一两句自然语言概括核心信息，像人类笔记一样',
                '- 如果不值得保留：只输出"无"',
                '- 不要解释你的判断过程',
              ].join('\n'),
            },
            { role: 'user', content: rawContents.slice(0, 2000) },
          ])

          const trimmedResult = summaryResult?.trim() || ''

          // "无"跳过机制：LLM 判断不值得保留则标记并跳过
          if (trimmedResult === '无' || trimmedResult === '') {
            console.log(`[ConfidenceTracker] LLM judged entries not worth promoting for Nexus ${nexusId}, skipping`)
            for (const entry of groupEntries) {
              entry.promotedToL0 = true
              entry.updatedAt = Date.now()
            }
            continue
          }

          summarizedContent = trimmedResult
        } catch (summarizeError) {
          console.warn('[ConfidenceTracker] LLM summarize failed, using fallback:', summarizeError)
          summarizedContent = this.fallbackSummarize(groupEntries)
        }
      } else {
        summarizedContent = this.fallbackSummarize(groupEntries)
      }

      // fallback 也可能返回空（无有价值内容）
      if (!summarizedContent) {
        console.log(`[ConfidenceTracker] Fallback found no valuable content for Nexus ${nexusId}, skipping`)
        for (const entry of groupEntries) {
          entry.promotedToL0 = true
          entry.updatedAt = Date.now()
        }
        continue
      }

      const ok = await memoryStore.write({
        source: 'memory',
        content: summarizedContent,
        tags: ['l0_promoted', `from_nexus:${nexusId}`],
        metadata: {
          sourceNexusId: nexusId,
          sourceEntryIds: groupEntries.map(e => e.id),
          confidence: avgConfidence,
          signalCount: groupEntries.reduce((sum, e) => sum + e.signals.length, 0),
          promotedAt: Date.now(),
          entryCount: groupEntries.length,
        },
      })

      if (ok) {
        for (const entry of groupEntries) {
          entry.promotedToL0 = true
          entry.updatedAt = Date.now()
        }
        promoted += groupEntries.length
        console.log(`[ConfidenceTracker] Promoted ${groupEntries.length} L1 → L0 for Nexus ${nexusId}: "${summarizedContent.slice(0, 80)}..."`)
      }
    }

    if (promoted > 0) {
      this.saveToStorage()
    }

    return promoted
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

    this.saveToStorage()
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
   * 按 nexusId + toolName 聚合追踪（而非按 callId）
   * 同一个 Nexus 下多次成功使用同一个工具 → 给同一个条目追加信号
   */
  /**
   * 按 nexusId + toolName 聚合追踪（而非按 callId）
   * 同一个 Nexus 下多次成功使用同一个工具 → 给同一个条目追加信号
   *
   * @param userIntent 用户原始意图（来自 userPrompt），用于提升 L1 内容质量
   */
  trackToolResults(
    nexusId: string,
    toolResults: Array<{ callId: string; toolName: string; status: 'success' | 'error'; result?: string }>,
    userIntent?: string,
  ): string[] {
    const trackedIds: string[] = []

    // 批量操作期间跳过中间持久化
    this._skipPersist = true
    try {
      for (const tr of toolResults) {
        const memoryId = `l1-${nexusId}-${tr.toolName}`
        const existingEntry = this.trackedEntries.get(memoryId)

        if (existingEntry) {
          if (tr.status === 'success') {
            this.addRepeatedSuccessSignal(memoryId)
          } else {
            this.addFailureSignal(memoryId)
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
          this.trackEntry(memoryId, nexusId, content)

          if (tr.status === 'success') {
            this.addEnvironmentSignal(memoryId, true)
          } else {
            this.addFailureSignal(memoryId)
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
    localStorage.removeItem(TRACKER_STORAGE_KEY)
  }
}

// 导出单例
export const confidenceTracker = new ConfidenceTrackerService()
