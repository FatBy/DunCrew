/**
 * 技能统计服务
 * 
 * 用于跟踪技能使用情况，计算能力评分
 * 设计原则：
 * - 旁路架构：统计失败不影响主流程
 * - 批量持久化：减少 I/O 操作
 * - 内存优先：读取快速
 */

import type { 
  SkillStats, 
  AbilityDomain, 
  AbilityDomainConfig, 
  DomainStats, 
  AbilitySnapshot,
  OpenClawSkill 
} from '@/types'
import { localServerService } from '@/services/localServerService'

// ============================================
// 能力域配置
// ============================================

const DOMAIN_CONFIGS: AbilityDomainConfig[] = [
  {
    id: 'development',
    name: '开发',
    color: '#22d3ee', // cyan-400
    keywords: ['code', 'git', 'npm', 'debug', 'compile', 'build', 'test', 'coding', 'github', 'coding-agent', 'review', 'pr', 'merge'],
  },
  {
    id: 'creative',
    name: '创意',
    color: '#a78bfa', // violet-400
    keywords: ['image', 'video', 'audio', 'design', 'art', 'music', 'whisper', 'tts', 'gen', 'canvas', 'peekaboo'],
  },
  {
    id: 'system',
    name: '系统',
    color: '#4ade80', // green-400
    keywords: ['file', 'cmd', 'run', 'shell', 'dir', 'path', 'process', 'tmux', 'openhue'],
  },
  {
    id: 'knowledge',
    name: '知识',
    color: '#fbbf24', // amber-400
    keywords: ['search', 'web', 'fetch', 'notion', 'obsidian', 'bear', 'notes', 'wiki', 'doc', 'summarize', 'oracle'],
  },
  {
    id: 'social',
    name: '社交',
    color: '#f472b6', // pink-400
    keywords: ['slack', 'discord', 'telegram', 'whatsapp', 'email', 'imsg', 'wacli', 'bluebubbles', 'feishu', 'trello', 'voice-call'],
  },
  {
    id: 'security',
    name: '安全',
    color: '#ef4444', // red-400
    keywords: ['1password', 'auth', 'credential', 'secret', 'encrypt', 'security', 'healthcheck'],
  },
  {
    id: 'utility',
    name: '工具',
    color: '#94a3b8', // slate-400
    keywords: ['weather', 'calendar', 'reminder', 'things', 'gog', 'goplaces', 'order', 'food', 'spotify', 'sonos'],
  },
]

// ============================================
// 里程碑配置
// ============================================

interface Milestone {
  id: string
  name: string
  condition: (snapshot: AbilitySnapshot) => boolean
}

const MILESTONES: Milestone[] = [
  { id: 'beginner', name: '初学者', condition: s => s.totalScore >= 500 },
  { id: 'intermediate', name: '进阶者', condition: s => s.totalScore >= 2000 },
  { id: 'expert', name: '专家', condition: s => s.domains.some(d => d.abilityScore >= 500) },
  { id: 'versatile', name: '全能', condition: s => s.domains.filter(d => d.abilityScore >= 100).length >= 5 },
  { id: 'veteran', name: '老手', condition: s => s.domains.some(d => d.successRate >= 90) },
  { id: 'poweruser', name: '重度用户', condition: s => s.totalSkills >= 100 },
]

// ============================================
// 技能统计服务类
// ============================================

const STORAGE_KEY = 'duncrew-skill-stats'
const BACKEND_DATA_KEY = 'skill_stats'
const FLUSH_INTERVAL = 30000 // 30秒自动持久化

class SkillStatsService {
  private stats: Map<string, SkillStats> = new Map()
  private dirty = false
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private lastWeekSnapshot: AbilitySnapshot | null = null
  private storeRefresh: (() => void) | null = null
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private _beforeunloadHandler: (() => void) | null = null
  private static NOTIFY_DEBOUNCE = 500 // 500ms 防抖

  constructor() {
    this.loadFromStorage()
    this.startFlushTimer()
  }

  // ============================================
  // Store 注入 (避免循环依赖)
  // ============================================

  /**
   * 注入 store 刷新回调，由 App.tsx 在初始化时调用
   */
  injectStoreRefresh(fn: () => void): void {
    this.storeRefresh = fn
  }

  /**
   * 防抖通知 store 重新计算 snapshot
   */
  private notifyStore(): void {
    if (!this.storeRefresh) return
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.storeRefresh?.()
    }, SkillStatsService.NOTIFY_DEBOUNCE)
  }

  // ============================================
  // 埋点 API (旁路设计，不抛异常)
  // ============================================

  /**
   * 记录技能调用
   */
  recordCall(skillId: string): void {
    try {
      const stat = this.getOrCreateStat(skillId)
      stat.callCount++
      stat.lastUsedAt = Date.now()
      this.dirty = true
      this.notifyStore()
    } catch (e) {
      console.warn('[SkillStats] recordCall failed:', e)
    }
  }

  /**
   * 记录技能激活
   */
  recordActivation(skillId: string): void {
    try {
      const stat = this.getOrCreateStat(skillId)
      stat.activationCount++
      stat.lastUsedAt = Date.now()
      this.dirty = true
      this.notifyStore()
    } catch (e) {
      console.warn('[SkillStats] recordActivation failed:', e)
    }
  }

  /**
   * 记录执行结果
   */
  recordResult(skillId: string, success: boolean): void {
    try {
      const stat = this.getOrCreateStat(skillId)
      if (success) {
        stat.successCount++
      } else {
        stat.failureCount++
      }
      stat.lastUsedAt = Date.now()
      this.dirty = true
      this.notifyStore()
    } catch (e) {
      console.warn('[SkillStats] recordResult failed:', e)
    }
  }

  // ============================================
  // 查询 API
  // ============================================

  /**
   * 获取单个技能的统计
   */
  getSkillStats(skillId: string): SkillStats | null {
    return this.stats.get(skillId) || null
  }

  /**
   * 获取所有统计数据
   */
  getAllStats(): SkillStats[] {
    return Array.from(this.stats.values())
  }

  /**
   * 计算能力快照
   */
  computeSnapshot(skills: OpenClawSkill[]): AbilitySnapshot {
    // 按域分类技能
    const domainSkills = this.classifySkills(skills)
    
    // 计算各域统计
    const domains: DomainStats[] = DOMAIN_CONFIGS.map(config => {
      const skillIds = domainSkills.get(config.id) || []
      const domainStats = skillIds.map(id => this.stats.get(id)).filter(Boolean) as SkillStats[]
      
      const totalCalls = domainStats.reduce((sum, s) => sum + s.callCount, 0)
      const totalSuccess = domainStats.reduce((sum, s) => sum + s.successCount, 0)
      const totalFailure = domainStats.reduce((sum, s) => sum + s.failureCount, 0)
      
      const successRate = totalCalls > 0 
        ? Math.round((totalSuccess / (totalSuccess + totalFailure)) * 100) || 0
        : 0
      
      // 能力评分算法：调用频率 30% + 激活次数 20% + 成功率 50%
      const avgCalls = domainStats.length > 0 
        ? domainStats.reduce((sum, s) => sum + s.callCount, 0) / domainStats.length 
        : 0
      const avgActivations = domainStats.length > 0
        ? domainStats.reduce((sum, s) => sum + s.activationCount, 0) / domainStats.length
        : 0
      
      const abilityScore = Math.round(
        avgCalls * 0.3 * 10 +
        avgActivations * 0.2 * 15 +
        successRate * 0.5 * 5
      ) * skillIds.length
      
      // 计算趋势（与上周对比）
      let trend: 'up' | 'down' | 'stable' = 'stable'
      let trendPercent = 0
      if (this.lastWeekSnapshot) {
        const lastDomain = this.lastWeekSnapshot.domains.find(d => d.domain === config.id)
        if (lastDomain && lastDomain.abilityScore > 0) {
          const change = ((abilityScore - lastDomain.abilityScore) / lastDomain.abilityScore) * 100
          trendPercent = Math.round(change)
          if (change > 5) trend = 'up'
          else if (change < -5) trend = 'down'
        }
      }
      
      return {
        domain: config.id,
        skillCount: skillIds.length,
        totalCalls,
        totalSuccess,
        successRate,
        abilityScore,
        trend,
        trendPercent,
      }
    })
    
    // 计算总分
    const totalScore = domains.reduce((sum, d) => sum + d.abilityScore, 0)
    
    // 获取最近活跃技能
    const recentActive = Array.from(this.stats.values())
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 8)
      .map(s => s.skillId)
    
    // 计算周增长
    const weeklyGrowth = this.computeWeeklyGrowth(skills.length, totalScore, domains)
    
    // 检查里程碑
    const snapshot: AbilitySnapshot = {
      totalSkills: skills.length,
      totalScore,
      domains,
      recentActive,
      weeklyGrowth,
      milestones: [],
      updatedAt: Date.now(),
    }
    
    snapshot.milestones = MILESTONES
      .filter(m => m.condition(snapshot))
      .map(m => m.id)
    
    return snapshot
  }

  // ============================================
  // 内部方法
  // ============================================

  private getOrCreateStat(skillId: string): SkillStats {
    let stat = this.stats.get(skillId)
    if (!stat) {
      stat = {
        skillId,
        callCount: 0,
        activationCount: 0,
        successCount: 0,
        failureCount: 0,
        lastUsedAt: Date.now(),
        firstUsedAt: Date.now(),
      }
      this.stats.set(skillId, stat)
    }
    return stat
  }

  private classifySkills(skills: OpenClawSkill[]): Map<AbilityDomain, string[]> {
    const result = new Map<AbilityDomain, string[]>()
    
    for (const config of DOMAIN_CONFIGS) {
      result.set(config.id, [])
    }
    
    for (const skill of skills) {
      const skillName = skill.name.toLowerCase()
      const skillDesc = (skill.description || '').toLowerCase()
      const combined = `${skillName} ${skillDesc}`
      
      let matched = false
      for (const config of DOMAIN_CONFIGS) {
        if (config.keywords.some(kw => combined.includes(kw))) {
          result.get(config.id)!.push(skill.name)
          matched = true
          break
        }
      }
      
      // 未匹配的归入 utility
      if (!matched) {
        result.get('utility')!.push(skill.name)
      }
    }
    
    return result
  }

  private computeWeeklyGrowth(
    totalSkills: number, 
    totalScore: number, 
    domains: DomainStats[]
  ): AbilitySnapshot['weeklyGrowth'] {
    if (!this.lastWeekSnapshot) {
      return { newSkills: 0, scoreChange: 0, successRateChange: 0 }
    }
    
    const avgSuccessRate = domains.length > 0
      ? domains.reduce((sum, d) => sum + d.successRate, 0) / domains.length
      : 0
    const lastAvgSuccessRate = this.lastWeekSnapshot.domains.length > 0
      ? this.lastWeekSnapshot.domains.reduce((sum, d) => sum + d.successRate, 0) / this.lastWeekSnapshot.domains.length
      : 0
    
    return {
      newSkills: totalSkills - this.lastWeekSnapshot.totalSkills,
      scoreChange: totalScore - this.lastWeekSnapshot.totalScore,
      successRateChange: Math.round(avgSuccessRate - lastAvgSuccessRate),
    }
  }

  // ============================================
  // 持久化
  // ============================================

  private loadFromStorage(): void {
    try {
      const data = localStorage.getItem(STORAGE_KEY)
      if (data) {
        const parsed = JSON.parse(data)
        this.stats = new Map(Object.entries(parsed.stats || {}))
        this.lastWeekSnapshot = parsed.lastWeekSnapshot || null
        console.log(`[SkillStats] Loaded ${this.stats.size} skill stats from localStorage`)
      }
    } catch (e) {
      console.warn('[SkillStats] Failed to load from localStorage:', e)
    }
    // 异步从后端恢复 (后端优先: 如果后端数据更丰富则覆盖)
    this.loadFromBackend()
  }

  private async loadFromBackend(): Promise<void> {
    try {
      const data = await localServerService.getData<{ stats: Record<string, SkillStats>; lastWeekSnapshot: AbilitySnapshot | null }>(BACKEND_DATA_KEY)
      if (data && data.stats) {
        const backendStats = new Map(Object.entries(data.stats))
        // 合并: 取 callCount 较大的一方 (代表更完整的数据)
        for (const [key, bStat] of backendStats) {
          const lStat = this.stats.get(key)
          if (!lStat || bStat.callCount > lStat.callCount) {
            this.stats.set(key, bStat)
          }
        }
        if (data.lastWeekSnapshot && !this.lastWeekSnapshot) {
          this.lastWeekSnapshot = data.lastWeekSnapshot
        }
        console.log(`[SkillStats] Merged ${backendStats.size} skill stats from backend`)
      }
    } catch {
      // 后端不可用，仅用 localStorage
    }
  }

  private saveToStorage(): void {
    if (!this.dirty) return
    
    try {
      const data = {
        stats: Object.fromEntries(this.stats),
        lastWeekSnapshot: this.lastWeekSnapshot,
      }
      // 同步写入 localStorage (快速缓存)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      // 异步写入后端 (持久化)
      localServerService.setData(BACKEND_DATA_KEY, data).catch(() => {
        console.warn('[SkillStats] Failed to persist to backend')
      })
      this.dirty = false
      console.log(`[SkillStats] Saved ${this.stats.size} skill stats`)
    } catch (e) {
      console.warn('[SkillStats] Failed to save to storage:', e)
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return
    
    this.flushTimer = setInterval(() => {
      this.saveToStorage()
    }, FLUSH_INTERVAL)
    
    // 页面卸载时保存（防止重复注册）
    if (typeof window !== 'undefined' && !this._beforeunloadHandler) {
      this._beforeunloadHandler = () => this.saveToStorage()
      window.addEventListener('beforeunload', this._beforeunloadHandler)
    }
  }

  /**
   * 手动刷新到存储
   */
  flush(): void {
    this.saveToStorage()
  }

  /**
   * 销毁服务，清理定时器和事件监听器
   */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    if (typeof window !== 'undefined' && this._beforeunloadHandler) {
      window.removeEventListener('beforeunload', this._beforeunloadHandler)
      this._beforeunloadHandler = null
    }
  }

  /**
   * 保存本周快照（用于下周对比）
   */
  saveWeeklySnapshot(snapshot: AbilitySnapshot): void {
    this.lastWeekSnapshot = snapshot
    this.dirty = true
    this.saveToStorage()
  }
}

// 单例导出
export const skillStatsService = new SkillStatsService()

// 导出域配置（供 UI 使用）
export const ABILITY_DOMAIN_CONFIGS = DOMAIN_CONFIGS
