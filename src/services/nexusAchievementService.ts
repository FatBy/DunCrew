// ============================================
// Nexus 成就系统服务
// 基于 NexusScoring 触发成就检测, localStorage 持久化
// ============================================

import type { NexusScoring } from '@/types'
import { checkAchievements, type AchievementId } from '@/components/dashboard/nexusGrowth'

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
        for (const [nexusId, ids] of Object.entries(parsed)) {
          this.achievementsMap.set(nexusId, ids)
        }
      }
    } catch (e) {
      console.warn('[AchievementService] Failed to load:', e)
    }
  }

  private save() {
    try {
      const obj: Record<string, AchievementId[]> = {}
      for (const [nexusId, ids] of this.achievementsMap) {
        obj[nexusId] = ids
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch (e) {
      console.warn('[AchievementService] Failed to save:', e)
    }
  }

  /** 获取 Nexus 已获得的成就 */
  getAchievements(nexusId: string): AchievementId[] {
    return this.achievementsMap.get(nexusId) ?? []
  }

  /** 在每次评分更新后调用，返回新获得的成就 */
  checkAndUpdate(nexusId: string, scoring: NexusScoring): AchievementId[] {
    const existing = this.getAchievements(nexusId)
    const newlyEarned = checkAchievements(scoring, existing)

    if (newlyEarned.length > 0) {
      const updated = [...existing, ...newlyEarned]
      this.achievementsMap.set(nexusId, updated)
      this.save()
      console.log(`[Achievement] ${nexusId} earned: ${newlyEarned.join(', ')}`)
    }

    return newlyEarned
  }

  /** 手动添加成就 (用于特殊场景如 error_recovery, multi_tool_chain) */
  grant(nexusId: string, achievementId: AchievementId): boolean {
    const existing = this.getAchievements(nexusId)
    if (existing.includes(achievementId)) return false
    existing.push(achievementId)
    this.achievementsMap.set(nexusId, existing)
    this.save()
    console.log(`[Achievement] ${nexusId} granted: ${achievementId}`)
    return true
  }
}

export const nexusAchievementService = new NexusAchievementService()
