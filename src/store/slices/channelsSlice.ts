import type { StateCreator } from 'zustand'
import type { Channel, ChannelType, ChannelsSnapshot, SkillNode, OpenClawSkill, SkillsSnapshot, AbilitySnapshot } from '@/types'
import { channelsToSkills, openClawSkillsToNodes } from '@/utils/dataMapper'
import { chat, isLLMConfigured } from '@/services/llmService'
import { skillStatsService } from '@/services/skillStatsService'
import { ABILITY_DOMAIN_CONFIGS } from '@/services/skillStatsService'
import { mapAllSkills, groupByDomain } from '@/utils/skillsHouseMapper'
import { localServerService } from '@/services/localServerService'

// LocalStorage 键名
const SKILL_ANALYSIS_KEY = 'duncrew_skill_analysis'
const SKILL_ENV_DATA_KEY = 'skill_env_values'

// ============================================
// 结构化技能分析
// ============================================

export interface StructuredSkillAnalysis {
  domains: Array<{
    name: string
    coverage: 'strong' | 'moderate' | 'weak' | 'missing'
    skillCount: number
    highlights: string[]
  }>
  coreStrengths: string
  weaknesses: string
  oneLiner: string
}

// 分层更新级别
export type AnalysisRefreshLevel = 'none' | 'local_only' | 'incremental' | 'full'

// 技能分析状态
export interface SkillAnalysis {
  summary: string
  weaknesses: string
  loading: boolean
  error: string | null
  timestamp: number
  skillCountAtGen: number
  structured: StructuredSkillAnalysis | null
  skillFingerprint: string
}

function emptySkillAnalysis(): SkillAnalysis {
  return {
    summary: '', weaknesses: '', loading: false, error: null,
    timestamp: 0, skillCountAtGen: 0,
    structured: null, skillFingerprint: '',
  }
}

function loadSkillAnalysis(): SkillAnalysis {
  try {
    const data = localStorage.getItem(SKILL_ANALYSIS_KEY)
    if (data) {
      const parsed = JSON.parse(data)
      return { ...emptySkillAnalysis(), ...parsed, loading: false }
    }
  } catch { /* ignore */ }
  return emptySkillAnalysis()
}

function persistSkillAnalysis(analysis: SkillAnalysis) {
  try {
    const { loading: _, ...rest } = analysis
    localStorage.setItem(SKILL_ANALYSIS_KEY, JSON.stringify(rest))
  } catch { /* ignore */ }
}

/** 生成技能指纹（排序后的名称列表） */
function computeSkillFingerprint(skills: OpenClawSkill[]): string {
  return skills.map(s => s.name).sort().join(',')
}

/** 本地计算域覆盖（零 token，复用技工学院分类逻辑） */
function computeLocalDomains(
  skills: OpenClawSkill[],
  envValues: Record<string, Record<string, string>>,
): StructuredSkillAnalysis['domains'] {
  const allModels = mapAllSkills(skills, envValues)
  const domainGroups = groupByDomain(allModels)
  const existingDomainIds = new Set(domainGroups.map(g => g.id))

  const domains: StructuredSkillAnalysis['domains'] = domainGroups.map(group => ({
    name: group.name,
    coverage: group.skills.length >= 10 ? 'strong' as const
      : group.skills.length >= 3 ? 'moderate' as const
      : 'weak' as const,
    skillCount: group.skills.length,
    highlights: group.skills
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 3)
      .map(s => s.name),
  }))

  for (const config of ABILITY_DOMAIN_CONFIGS) {
    if (!existingDomainIds.has(config.id)) {
      domains.push({
        name: config.name,
        coverage: 'missing',
        skillCount: 0,
        highlights: [],
      })
    }
  }

  return domains
}

/** 判断分析刷新级别 */
function getAnalysisRefreshLevel(
  analysis: SkillAnalysis,
  currentSkills: OpenClawSkill[],
): AnalysisRefreshLevel {
  if (currentSkills.length === 0) return 'none'
  if (analysis.timestamp === 0) return 'full'

  const currentFingerprint = computeSkillFingerprint(currentSkills)
  if (currentFingerprint === analysis.skillFingerprint) return 'local_only'

  const oldNames = new Set(analysis.skillFingerprint.split(',').filter(Boolean))
  const newNames = new Set(currentSkills.map(s => s.name))
  const added = [...newNames].filter(n => !oldNames.has(n))
  const removed = [...oldNames].filter(n => !newNames.has(n))
  const totalSize = Math.max(oldNames.size, newNames.size, 1)
  const changeRatio = (added.length + removed.length) / totalSize

  if (changeRatio > 0.3) return 'full'
  return 'incremental'
}

/** 构建全量分析 prompt */
function buildFullAnalysisMessages(
  skills: OpenClawSkill[],
  domainSummary: string,
  statsInfo: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: '你是 DunCrew 技能分析引擎。基于 Agent 的技能列表和使用数据，输出结构化能力画像。只输出纯 JSON，不要加 markdown 代码块。',
    },
    {
      role: 'user',
      content: [
        `Agent 共挂载 ${skills.length} 项技能，按能力域分布：`,
        domainSummary,
        '',
        statsInfo,
        '',
        '完整能力域参考：开发编程、创意生成（图像/音频/视频）、系统操作（文件/命令）、知识检索（搜索/文档）、社交通讯、安全认证、日常工具。',
        '',
        '请输出纯 JSON：',
        '{"coreStrengths":"2句话描述核心优势","weaknesses":"1句话描述薄弱领域(无则空字符串)","oneLiner":"一句话总结(30-50字，用于核心球体展示)"}',
      ].filter(Boolean).join('\n'),
    },
  ]
}

/** 构建增量更新 prompt */
function buildIncrementalMessages(
  oldAnalysis: StructuredSkillAnalysis,
  added: string[],
  removed: string[],
): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: '你是 DunCrew 技能分析引擎。基于上次分析结果和技能变化，更新能力画像。只输出纯 JSON，不要加 markdown 代码块。',
    },
    {
      role: 'user',
      content: [
        '上次分析结果：',
        `- 核心优势：${oldAnalysis.coreStrengths}`,
        `- 薄弱领域：${oldAnalysis.weaknesses}`,
        `- 一句话总结：${oldAnalysis.oneLiner}`,
        '',
        '自上次分析以来的变化：',
        added.length > 0 ? `- 新增技能 (${added.length} 项)：${added.slice(0, 20).join(', ')}${added.length > 20 ? '...' : ''}` : '- 无新增技能',
        removed.length > 0 ? `- 移除技能 (${removed.length} 项)：${removed.slice(0, 20).join(', ')}${removed.length > 20 ? '...' : ''}` : '- 无移除技能',
        '',
        '请基于这些变化更新分析，输出纯 JSON：',
        '{"coreStrengths":"2句话描述核心优势","weaknesses":"1句话描述薄弱领域(无则空字符串)","oneLiner":"一句话总结(30-50字)"}',
      ].join('\n'),
    },
  ]
}

const initialSkillAnalysis = loadSkillAnalysis()

export interface ChannelsSlice {
  // 原始 OpenClaw 数据 (Channels - 保留兼容)
  channelOrder: ChannelType[]
  channels: Record<string, Channel>
  
  // 原始 OpenClaw 数据 (Skills - 新增)
  openClawSkills: OpenClawSkill[]
  
  // 加载状态
  channelsLoading: boolean
  selectedChannelId: ChannelType | null
  
  // 映射后的 UI 数据
  skills: SkillNode[]
  
  // 技能分析
  skillAnalysis: SkillAnalysis
  
  // 技能统计快照 (响应式: 工具执行后自动更新)
  skillStatsSnapshot: AbilitySnapshot | null
  skillStatsVersion: number
  
  // 技能环境变量 (持久化到后端)
  skillEnvValues: Record<string, Record<string, string>>
  
  // Actions - Channels (兼容)
  setChannelsSnapshot: (snapshot: ChannelsSnapshot) => void
  updateChannel: (id: ChannelType, updates: Partial<Channel>) => void
  setChannelConnected: (id: ChannelType, accountId: string, connected: boolean) => void
  setSelectedChannel: (id: ChannelType | null) => void
  setChannelsLoading: (loading: boolean) => void
  
  // Actions - Skills (新增)
  setSkillsSnapshot: (snapshot: SkillsSnapshot) => void
  setOpenClawSkills: (skills: OpenClawSkill[]) => void
  
  // Actions - 技能分析
  generateSkillAnalysis: (forceLevel?: AnalysisRefreshLevel) => Promise<void>
  shouldRefreshSkillAnalysis: () => boolean
  getAnalysisRefreshLevel: () => AnalysisRefreshLevel
  
  // Actions - 技能统计刷新
  refreshSkillSnapshot: () => void
  
  // Actions - 技能环境变量
  setSkillEnvValue: (skillName: string, key: string, value: string) => void
  loadSkillEnvValues: () => Promise<void>
}

export const createChannelsSlice: StateCreator<ChannelsSlice> = (set, get) => ({
  channelOrder: [],
  channels: {},
  openClawSkills: [],
  channelsLoading: true,
  selectedChannelId: null,
  skills: [],
  skillAnalysis: initialSkillAnalysis,
  skillStatsSnapshot: null,
  skillStatsVersion: 0,
  skillEnvValues: {},

  // 设置 Channels 数据 (兼容旧 API)
  setChannelsSnapshot: (snapshot) => {
    const channelOrder = snapshot.channelOrder || Object.keys(snapshot.channels || {}) as ChannelType[]
    const channels = snapshot.channels || {}
    
    set((state) => {
      // 如果已有 OpenClaw Skills，优先使用 Skills
      if (state.openClawSkills.length > 0) {
        return {
          channelOrder,
          channels,
          channelsLoading: false,
        }
      }
      // 否则使用 Channels 映射
      return {
        channelOrder,
        channels,
        skills: channelsToSkills(channels, channelOrder),
        channelsLoading: false,
      }
    })
  },
  
  // 设置 Skills 数据 (新 API: skills.list)
  setSkillsSnapshot: (snapshot) => {
    const skills = snapshot.skills || []
    set({
      openClawSkills: skills,
      skills: openClawSkillsToNodes(skills),
      channelsLoading: false,
    })
  },
  
  // 直接设置 OpenClaw Skills 数组
  setOpenClawSkills: (skills) => set({
    openClawSkills: skills,
    skills: openClawSkillsToNodes(skills),
    channelsLoading: false,
  }),
  
  updateChannel: (id, updates) => set((state) => {
    const newChannels = {
      ...state.channels,
      [id]: { ...state.channels[id], ...updates },
    }
    // 只有在没有 OpenClaw Skills 时才更新 skills
    if (state.openClawSkills.length > 0) {
      return { channels: newChannels }
    }
    return {
      channels: newChannels,
      skills: channelsToSkills(newChannels, state.channelOrder),
    }
  }),
  
  setChannelConnected: (id, accountId, connected) => set((state) => {
    const channel = state.channels[id]
    if (!channel) return state
    
    const newChannels = {
      ...state.channels,
      [id]: {
        ...channel,
        accounts: channel.accounts.map((acc) =>
          acc.accountId === accountId
            ? { ...acc, connected, connectedAt: connected ? Date.now() : acc.connectedAt }
            : acc
        ),
      },
    }
    // 只有在没有 OpenClaw Skills 时才更新 skills
    if (state.openClawSkills.length > 0) {
      return { channels: newChannels }
    }
    return {
      channels: newChannels,
      skills: channelsToSkills(newChannels, state.channelOrder),
    }
  }),
  
  setSelectedChannel: (id) => set({ selectedChannelId: id }),
  
  setChannelsLoading: (loading) => set({ channelsLoading: loading }),

  // 技能分析
  getAnalysisRefreshLevel: () => {
    const { skillAnalysis, openClawSkills } = get()
    return getAnalysisRefreshLevel(skillAnalysis, openClawSkills)
  },

  shouldRefreshSkillAnalysis: () => {
    const level = get().getAnalysisRefreshLevel()
    return level !== 'none'
  },

  generateSkillAnalysis: async (forceLevel?: AnalysisRefreshLevel) => {
    const { skillAnalysis, openClawSkills, skillEnvValues } = get()
    if (skillAnalysis.loading) return
    if (openClawSkills.length === 0) return

    const level = forceLevel || getAnalysisRefreshLevel(skillAnalysis, openClawSkills)
    if (level === 'none') return

    // Layer 1: 本地计算域覆盖（零 token，始终执行）
    const localDomains = computeLocalDomains(openClawSkills, skillEnvValues)

    if (level === 'local_only') {
      const updated: SkillAnalysis = {
        ...skillAnalysis,
        structured: skillAnalysis.structured
          ? { ...skillAnalysis.structured, domains: localDomains }
          : null,
      }
      persistSkillAnalysis(updated)
      set({ skillAnalysis: updated })
      return
    }

    // Layer 2 & 3: 需要调 LLM
    if (!isLLMConfigured()) return

    set({ skillAnalysis: { ...skillAnalysis, loading: true, error: null } })

    try {
      // 收集使用统计
      const allStats = skillStatsService.getAllStats()
      const topUsed = allStats
        .filter(s => s.callCount > 0)
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, 8)
      const statsInfo = topUsed.length > 0
        ? '高频技能：' + topUsed.map(s => {
            const total = s.successCount + s.failureCount
            const rate = total > 0 ? Math.round(s.successCount / total * 100) : 0
            return `${s.skillId}(${s.callCount}次,成功率${rate}%)`
          }).join('; ')
        : ''

      let messages: Array<{ role: 'system' | 'user'; content: string }>

      if (level === 'incremental' && skillAnalysis.structured) {
        // 增量更新：旧结果 + diff
        const oldNames = new Set(skillAnalysis.skillFingerprint.split(',').filter(Boolean))
        const newNames = new Set(openClawSkills.map(s => s.name))
        const added = [...newNames].filter(n => !oldNames.has(n))
        const removed = [...oldNames].filter(n => !newNames.has(n))
        messages = buildIncrementalMessages(skillAnalysis.structured, added, removed)
      } else {
        // 全量重建：按域聚合后给 LLM
        const domainSummary = localDomains
          .filter(d => d.skillCount > 0)
          .map(d => `- ${d.name}: ${d.skillCount} 项（${d.coverage === 'strong' ? '强' : d.coverage === 'moderate' ? '中' : '弱'}）代表：${d.highlights.slice(0, 3).join(', ')}`)
          .join('\n')
        messages = buildFullAnalysisMessages(openClawSkills, domainSummary, statsInfo)
      }

      const raw = await chat(messages)

      // 解析 JSON 响应
      let coreStrengths = ''
      let weaknessesText = ''
      let oneLiner = ''

      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          coreStrengths = parsed.coreStrengths || ''
          weaknessesText = parsed.weaknesses || ''
          oneLiner = parsed.oneLiner || ''
        }
      } catch {
        // JSON 解析失败，用原始文本降级
        oneLiner = raw.trim().replace(/^["「]|["」]$/g, '')
      }

      const structured: StructuredSkillAnalysis = {
        domains: localDomains,
        coreStrengths,
        weaknesses: weaknessesText,
        oneLiner,
      }

      const newAnalysis: SkillAnalysis = {
        summary: oneLiner || coreStrengths,
        weaknesses: weaknessesText,
        loading: false,
        error: null,
        timestamp: Date.now(),
        skillCountAtGen: openClawSkills.length,
        structured,
        skillFingerprint: computeSkillFingerprint(openClawSkills),
      }
      persistSkillAnalysis(newAnalysis)
      set({ skillAnalysis: newAnalysis })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '分析失败'
      set({
        skillAnalysis: {
          ...get().skillAnalysis,
          loading: false,
          error: message,
        },
      })
    }
  },

  refreshSkillSnapshot: () => {
    const { openClawSkills } = get()
    const snapshot = skillStatsService.computeSnapshot(openClawSkills)
    set(state => ({
      skillStatsSnapshot: snapshot,
      skillStatsVersion: state.skillStatsVersion + 1,
    }))
  },

  setSkillEnvValue: (skillName, key, value) => {
    const current = get().skillEnvValues
    const updated = {
      ...current,
      [skillName]: { ...current[skillName], [key]: value },
    }
    set({ skillEnvValues: updated })
    localServerService.setData(SKILL_ENV_DATA_KEY, updated).catch(() => {
      console.warn('[ChannelsSlice] Failed to persist skill env values')
    })
  },

  loadSkillEnvValues: async () => {
    try {
      const data = await localServerService.getData<Record<string, Record<string, string>>>(SKILL_ENV_DATA_KEY)
      if (data && typeof data === 'object') {
        set({ skillEnvValues: data })
      }
    } catch {
      console.warn('[ChannelsSlice] Failed to load skill env values')
    }
  },
})
