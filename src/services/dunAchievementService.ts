// ============================================
// Nexus 成就系统服务
// 基于 DunScoring 触发成就检测, localStorage 持久化
// ============================================

import type { DunScoring } from '@/types'
import { checkAchievements, type AchievementId } from '@/components/dashboard/dunGrowth'

const STORAGE_KEY = 'duncrew_nexus_achievements'

class NexusAchievementService {
  private achievementsMap: Map<string, AchievementId[]> = new Map()

  constructor() {
    this.load()
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed: Record<string, AchievementId[]> = JSON.parse(raw)
        for (const [dunId, ids] of Object.entries(parsed)) {
          this.achievementsMap.set(dunId, ids)
        }
      }
    } catch (e) {
      console.warn('[AchievementService] Failed to load:', e)
    }
  }

  private save() {
    try {
      const obj: Record<string, AchievementId[]> = {}
      for (const [dunId, ids] of this.achievementsMap) {
        obj[dunId] = ids
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch (e) {
      console.warn('[AchievementService] Failed to save:', e)
    }
  }

  /** 获取 Nexus 已获得的成就 */
  getAchievements(dunId: string): AchievementId[] {
    return this.achievementsMap.get(dunId) ?? []
  }

  /** 在每次评分更新后调用，返回新获得的成就 */
  checkAndUpdate(dunId: string, scoring: DunScoring): AchievementId[] {
    const existing = this.getAchievements(dunId)
    const newlyEarned = checkAchievements(scoring, existing)

    if (newlyEarned.length > 0) {
      const updated = [...existing, ...newlyEarned]
      this.achievementsMap.set(dunId, updated)
      this.save()
      console.log(`[Achievement] ${dunId} earned: ${newlyEarned.join(', ')}`)
    }

    return newlyEarned
  }

  /** 手动添加成就 (用于特殊场景如 error_recovery, multi_tool_chain) */
  grant(dunId: string, achievementId: AchievementId): boolean {
    const existing = this.getAchievements(dunId)
    if (existing.includes(achievementId)) return false
    existing.push(achievementId)
    this.achievementsMap.set(dunId, existing)
    this.save()
    console.log(`[Achievement] ${dunId} granted: ${achievementId}`)
    return true
  }
}

export const dunAchievementService = new NexusAchievementService()
