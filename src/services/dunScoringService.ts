/**
 * DunScoringService - Dun 评分制服务
 *
 * 替代原有 level/XP 系统，使用 0-100 分数制：
 * - 基于任务成功/失败动态调整分数
 * - 连胜/连败 streak 奖惩
 * - 工具维度分数追踪
 * - 分数等级驱动行为策略（Critic频率、Reflexion深度、上下文预算）
 */

import type {
  DunScoring,
  ToolDimensionScore,
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
  dunId: string
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
// DunScoringService
// ============================================

class DunScoringService {
  /** 各 Dun 的评分缓存 */
  private scoringCache = new Map<string, DunScoring>()

  // ═══ 分数更新 ═══

  /**
   * 根据一次执行结果更新 Dun 分数
   *
   * 计算公式:
   * - 成功: +SUCCESS_BASE + min(streak * STREAK_BONUS, MAX_BONUS) + 复杂度奖励
   * - 失败: +FAILURE_BASE + max(streak * STREAK_PENALTY, MAX_PENALTY)
   */
  updateScore(params: ScoringUpdateParams): { scoring: DunScoring; scoreChange: number } {
    const scoring = this.getOrCreate(params.dunId)
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
    this.scoringCache.set(params.dunId, scoring)

    const tier = getScoreTier(scoring.score)
    console.log(`[DunScoring] ${params.dunId}: ${scoring.score - delta} → ${scoring.score} (${delta > 0 ? '+' : ''}${delta}), tier: ${tier}, streak: ${scoring.streak}`)

    // 成就检测 (异步, 不阻塞评分返回)
    import('./dunAchievementService').then(({ dunAchievementService }) => {
      const newAchievements = dunAchievementService.checkAndUpdate(params.dunId, scoring)
      if (newAchievements.length > 0) {
        console.log(`[DunScoring] New achievements for ${params.dunId}:`, newAchievements)
      }
    }).catch(() => { /* 成就系统不影响核心评分 */ })

    return { scoring, scoreChange: delta }
  }

  /**
   * 从 ExecTrace 提取参数并更新分数
   * 便捷方法，对接现有 trace 保存流程
   */
  updateFromTrace(dunId: string, trace: ExecTrace, _finalResponse?: string): { scoring: DunScoring; scoreChange: number } {
    return this.updateScore({
      dunId,
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

  /** 获取 Dun 的评分 */
  getScoring(dunId: string): DunScoring | undefined {
    return this.scoringCache.get(dunId)
  }

  /** 获取或创建初始评分 */
  getOrCreate(dunId: string): DunScoring {
    const existing = this.scoringCache.get(dunId)
    if (existing) return existing

    const initial = createInitialScoring()
    this.scoringCache.set(dunId, initial)
    return initial
  }

  /** 获取所有 Dun 的评分摘要 */
  getAllScorings(): Array<{ dunId: string; scoring: DunScoring }> {
    return Array.from(this.scoringCache.entries()).map(([dunId, scoring]) => ({
      dunId,
      scoring,
    }))
  }

  // ═══ 工具维度 ═══

  /** 更新工具维度分数 */
  private updateToolDimension(scoring: DunScoring, toolName: string, success: boolean, latencyMs: number): void {
    // 防御：从旧版本持久化数据加载时 dimensions 字段可能缺失
    if (!scoring.dimensions) {
      scoring.dimensions = {}
    }

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

  /** 从后端加载 Dun 评分 */
  async loadFromServer(dunId: string, serverUrl: string): Promise<DunScoring | null> {
    try {
      const res = await fetch(`${serverUrl}/api/dun/${encodeURIComponent(dunId)}/scoring`)
      if (res.ok) {
        const raw = await res.json()
        if (!raw || typeof raw !== 'object') return null
        const scoring = normalizeScoring(raw)
        this.scoringCache.set(dunId, scoring)
        return scoring
      }
      return null
    } catch {
      return null
    }
  }

  /** 保存评分到后端 */
  async saveToServer(dunId: string, serverUrl: string): Promise<boolean> {
    const scoring = this.scoringCache.get(dunId)
    if (!scoring) return false

    try {
      const res = await fetch(`${serverUrl}/api/dun/${encodeURIComponent(dunId)}/scoring`, {
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

  /** 重置指定 Dun 评分 */
  resetScoring(dunId: string): DunScoring {
    const fresh = createInitialScoring()
    this.scoringCache.set(dunId, fresh)
    return fresh
  }

  /** 清除所有缓存 */
  clearCache(): void {
    this.scoringCache.clear()
  }
}

/**
 * 规范化从外部加载的 scoring 数据，补全可能缺失的字段
 * 兼容旧版 sop-fitness.json / nexus_scoring 等遗留数据格式
 */
export function normalizeScoring(raw: Record<string, unknown>): DunScoring {
  const base = createInitialScoring()
  return {
    score:        typeof raw.score === 'number' ? raw.score : base.score,
    streak:       typeof raw.streak === 'number' ? raw.streak : base.streak,
    totalRuns:    typeof raw.totalRuns === 'number' ? raw.totalRuns : base.totalRuns,
    successCount: typeof raw.successCount === 'number' ? raw.successCount : base.successCount,
    failureCount: typeof raw.failureCount === 'number' ? raw.failureCount : base.failureCount,
    successRate:  typeof raw.successRate === 'number' ? raw.successRate : base.successRate,
    dimensions:   (raw.dimensions && typeof raw.dimensions === 'object') ? raw.dimensions as Record<string, ToolDimensionScore> : base.dimensions,
    recentRuns:   Array.isArray(raw.recentRuns) ? raw.recentRuns as RecentRunEntry[] : base.recentRuns,
    lastUpdated:  typeof raw.lastUpdated === 'number' ? raw.lastUpdated : base.lastUpdated,
  }
}

// 导出单例
export const dunScoringService = new DunScoringService()
