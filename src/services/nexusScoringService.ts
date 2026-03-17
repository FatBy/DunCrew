/**
 * NexusScoringService - Nexus 评分制服务
 *
 * 替代原有 level/XP 系统，使用 0-100 分数制：
 * - 基于任务成功/失败动态调整分数
 * - 连胜/连败 streak 奖惩
 * - 工具维度分数追踪
 * - 分数等级驱动行为策略（Critic频率、Reflexion深度、上下文预算）
 */

import type {
  NexusScoring,
  RecentRunEntry,
  ExecTrace,
} from '@/types'
import {
  SCORING_RULES,
  getScoreTier,
  createInitialScoring,
} from '@/types'

// ============================================
// 评分更新参数
// ============================================

export interface ScoringUpdateParams {
  nexusId: string
  runId: string
  task: string
  success: boolean
  turns: number
  toolsCalled: string[]
  toolResults: Array<{ name: string; success: boolean; latencyMs: number }>
  durationMs: number
  genesHarvested?: number
}

// ============================================
// NexusScoringService
// ============================================

class NexusScoringService {
  /** 各 Nexus 的评分缓存 */
  private scoringCache = new Map<string, NexusScoring>()

  // ═══ 分数更新 ═══

  /**
   * 根据一次执行结果更新 Nexus 分数
   *
   * 计算公式:
   * - 成功: +SUCCESS_BASE + min(streak * STREAK_BONUS, MAX_BONUS) + 复杂度奖励
   * - 失败: +FAILURE_BASE + max(streak * STREAK_PENALTY, MAX_PENALTY)
   */
  updateScore(params: ScoringUpdateParams): { scoring: NexusScoring; scoreChange: number } {
    const scoring = this.getOrCreate(params.nexusId)
    const { success, turns, toolsCalled, toolResults, durationMs, task, runId, genesHarvested } = params

    let delta = 0

    if (success) {
      // 基础成功分数
      delta = SCORING_RULES.SUCCESS_BASE

      // 连胜奖励
      if (scoring.streak > 0) {
        const streakBonus = Math.min(
          scoring.streak * SCORING_RULES.SUCCESS_STREAK_BONUS,
          SCORING_RULES.SUCCESS_STREAK_MAX_BONUS,
        )
        delta += streakBonus
      }

      // 复杂度奖励（多工具 + 多轮次 = 更复杂的任务）
      if (toolsCalled.length >= 3 || turns >= 5) {
        delta += SCORING_RULES.SUCCESS_COMPLEXITY_BONUS
      }

      // 更新 streak
      scoring.streak = scoring.streak >= 0 ? scoring.streak + 1 : 1
      scoring.successCount++
    } else {
      // 基础失败惩罚
      delta = SCORING_RULES.FAILURE_BASE

      // 连败加重
      if (scoring.streak < 0) {
        const streakPenalty = Math.max(
          scoring.streak * SCORING_RULES.FAILURE_STREAK_PENALTY,
          SCORING_RULES.FAILURE_STREAK_MAX_PENALTY,
        )
        delta += streakPenalty
      }

      // 更新 streak
      scoring.streak = scoring.streak <= 0 ? scoring.streak - 1 : -1
      scoring.failureCount++
    }

    // 应用分数变化，限制在 [0, 100]
    scoring.score = Math.max(
      SCORING_RULES.SCORE_MIN,
      Math.min(SCORING_RULES.SCORE_MAX, scoring.score + delta),
    )

    scoring.totalRuns++
    scoring.successRate = scoring.totalRuns > 0
      ? scoring.successCount / scoring.totalRuns
      : 0

    // 更新工具维度分数
    for (const tr of toolResults) {
      this.updateToolDimension(scoring, tr.name, tr.success, tr.latencyMs)
    }

    // 记录到 recentRuns
    const entry: RecentRunEntry = {
      runId,
      task: task.slice(0, 80),
      success,
      scoreChange: delta,
      turns,
      toolsCalled: [...new Set(toolsCalled)],
      durationMs,
      timestamp: Date.now(),
      genesHarvested,
    }
    scoring.recentRuns.push(entry)
    if (scoring.recentRuns.length > SCORING_RULES.MAX_RECENT_RUNS) {
      scoring.recentRuns = scoring.recentRuns.slice(-SCORING_RULES.MAX_RECENT_RUNS)
    }

    scoring.lastUpdated = Date.now()

    // 保存到缓存
    this.scoringCache.set(params.nexusId, scoring)

    const tier = getScoreTier(scoring.score)
    console.log(`[NexusScoring] ${params.nexusId}: ${scoring.score - delta} → ${scoring.score} (${delta > 0 ? '+' : ''}${delta}), tier: ${tier}, streak: ${scoring.streak}`)

    // 成就检测 (异步, 不阻塞评分返回)
    import('./nexusAchievementService').then(({ nexusAchievementService }) => {
      const newAchievements = nexusAchievementService.checkAndUpdate(params.nexusId, scoring)
      if (newAchievements.length > 0) {
        console.log(`[NexusScoring] New achievements for ${params.nexusId}:`, newAchievements)
      }
    }).catch(() => { /* 成就系统不影响核心评分 */ })

    return { scoring, scoreChange: delta }
  }

  /**
   * 从 ExecTrace 提取参数并更新分数
   * 便捷方法，对接现有 trace 保存流程
   */
  updateFromTrace(nexusId: string, trace: ExecTrace, _finalResponse?: string): { scoring: NexusScoring; scoreChange: number } {
    return this.updateScore({
      nexusId,
      runId: trace.id,
      task: trace.task,
      success: trace.success,
      turns: trace.turnCount || 0,
      toolsCalled: trace.tools.map(t => t.name),
      toolResults: trace.tools.map(t => ({
        name: t.name,
        success: t.status === 'success',
        latencyMs: t.latency,
      })),
      durationMs: trace.duration,
    })
  }

  // ═══ 查询 ═══

  /** 获取 Nexus 的评分 */
  getScoring(nexusId: string): NexusScoring | undefined {
    return this.scoringCache.get(nexusId)
  }

  /** 获取或创建初始评分 */
  getOrCreate(nexusId: string): NexusScoring {
    const existing = this.scoringCache.get(nexusId)
    if (existing) return existing

    const initial = createInitialScoring()
    this.scoringCache.set(nexusId, initial)
    return initial
  }

  /** 获取所有 Nexus 的评分摘要 */
  getAllScorings(): Array<{ nexusId: string; scoring: NexusScoring }> {
    return Array.from(this.scoringCache.entries()).map(([nexusId, scoring]) => ({
      nexusId,
      scoring,
    }))
  }

  // ═══ 工具维度 ═══

  /** 更新工具维度分数 */
  private updateToolDimension(scoring: NexusScoring, toolName: string, success: boolean, latencyMs: number): void {
    const dim = scoring.dimensions[toolName] || {
      toolName,
      score: 50,
      calls: 0,
      successes: 0,
      failures: 0,
      avgDurationMs: 0,
      lastUsedAt: 0,
    }

    dim.calls++
    if (success) {
      dim.successes++
      dim.score = Math.min(100, dim.score + SCORING_RULES.TOOL_SUCCESS_DELTA)
    } else {
      dim.failures++
      dim.score = Math.max(0, dim.score + SCORING_RULES.TOOL_FAILURE_DELTA)
    }

    // 滑动平均延迟
    dim.avgDurationMs = dim.calls === 1
      ? latencyMs
      : dim.avgDurationMs * 0.8 + latencyMs * 0.2
    dim.lastUsedAt = Date.now()

    scoring.dimensions[toolName] = dim
  }

  // ═══ 持久化 ═══

  /** 从后端加载 Nexus 评分 */
  async loadFromServer(nexusId: string, serverUrl: string): Promise<NexusScoring | null> {
    try {
      const res = await fetch(`${serverUrl}/api/nexus/${encodeURIComponent(nexusId)}/scoring`)
      if (res.ok) {
        const scoring: NexusScoring = await res.json()
        this.scoringCache.set(nexusId, scoring)
        return scoring
      }
      return null
    } catch {
      return null
    }
  }

  /** 保存评分到后端 */
  async saveToServer(nexusId: string, serverUrl: string): Promise<boolean> {
    const scoring = this.scoringCache.get(nexusId)
    if (!scoring) return false

    try {
      const res = await fetch(`${serverUrl}/api/nexus/${encodeURIComponent(nexusId)}/scoring`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scoring),
      })
      return res.ok
    } catch {
      return false
    }
  }

  // ═══ 管理 ═══

  /** 重置指定 Nexus 评分 */
  resetScoring(nexusId: string): NexusScoring {
    const fresh = createInitialScoring()
    this.scoringCache.set(nexusId, fresh)
    return fresh
  }

  /** 清除所有缓存 */
  clearCache(): void {
    this.scoringCache.clear()
  }
}

// 导出单例
export const nexusScoringService = new NexusScoringService()
