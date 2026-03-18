import type { StateCreator } from 'zustand'
import type { Channel, ChannelType, ChannelsSnapshot, SkillNode, OpenClawSkill, SkillsSnapshot, TaskItem, AbilitySnapshot } from '@/types'
import { channelsToSkills, openClawSkillsToNodes } from '@/utils/dataMapper'
import { chat, isLLMConfigured } from '@/services/llmService'
import { skillStatsService } from '@/services/skillStatsService'
import { localServerService } from '@/services/localServerService'

// LocalStorage 键名
const SKILL_ANALYSIS_KEY = 'duncrew_skill_analysis'
const SKILL_ENV_DATA_KEY = 'skill_env_values'

// 技能分析状态
export interface SkillAnalysis {
  summary: string
  weaknesses: string
  loading: boolean
  error: string | null
  timestamp: number
  skillCountAtGen: number
}

function emptySkillAnalysis(): SkillAnalysis {
  return { summary: '', weaknesses: '', loading: false, error: null, timestamp: 0, skillCountAtGen: 0 }
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
  generateSkillAnalysis: () => Promise<void>
  shouldRefreshSkillAnalysis: () => boolean
  
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
  shouldRefreshSkillAnalysis: () => {
    const { skillAnalysis, openClawSkills } = get()
    if (openClawSkills.length === 0) return false
    // 首次加载
    if (skillAnalysis.timestamp === 0) return true
    // 技能数量变化 >=5
    return Math.abs(openClawSkills.length - skillAnalysis.skillCountAtGen) >= 5
  },

  generateSkillAnalysis: async () => {
    if (!isLLMConfigured()) return

    const { skillAnalysis, openClawSkills } = get()
    if (skillAnalysis.loading) return
    if (openClawSkills.length === 0) return

    set({ skillAnalysis: { ...get().skillAnalysis, loading: true, error: null } })

    try {
      // 收集技能列表
      const skillList = openClawSkills.slice(0, 30).map(s =>
        `- [${s.name}] ${s.description || '(无描述)'}${s.status !== 'active' ? ` (${s.status})` : ''}`
      ).join('\n')

      // 跨 slice 访问任务执行历史
      const fullState = get() as unknown as { activeExecutions?: TaskItem[] }
      const activeExecutions: TaskItem[] = fullState.activeExecutions || []
      const recentTasks = activeExecutions
        .filter(t => t.status === 'done' || t.status === 'terminated')
        .slice(-15)

      let taskHistory = ''
      if (recentTasks.length > 0) {
        taskHistory = '\n\n最近任务执行记录 (' + recentTasks.length + ' 条):\n' +
          recentTasks.map(t => {
            const status = t.status === 'done' ? (t.executionError ? '完成(有错误)' : '成功') : '已终止'
            const tools = t.executionSteps
              ?.filter(s => s.type === 'tool_call' && s.toolName)
              .map(s => s.toolName)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(', ') || '无'
            return `- [${status}] ${t.title} | 工具: ${tools}`
          }).join('\n')
      }

      const messages = [
        {
          role: 'system' as const,
          content: '你是 DunCrew 技能分析师。基于 Agent 当前的技能列表和任务执行历史，总结能力画像。输出纯 JSON（无 markdown）：{"summary":"...","weaknesses":"..."}。summary 用 2-3 句中文叙事描述 Agent 擅长什么；weaknesses 用 1 句描述缺失或薄弱的能力域（如无明显短板则返回空字符串）。',
        },
        {
          role: 'user' as const,
          content: `当前技能列表 (${openClawSkills.length} 个):\n${skillList}${taskHistory}\n\n请分析 Agent 的能力画像。`,
        },
      ]

      const raw = await chat(messages)

      // 解析 JSON 响应
      let summary = raw
      let weaknesses = ''
      try {
        // 尝试提取 JSON（可能被 markdown 包裹）
        const jsonMatch = raw.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          summary = parsed.summary || raw
          weaknesses = parsed.weaknesses || ''
        }
      } catch {
        // JSON 解析失败，直接用原始文本作为 summary
      }

      const newAnalysis: SkillAnalysis = {
        summary,
        weaknesses,
        loading: false,
        error: null,
        timestamp: Date.now(),
        skillCountAtGen: openClawSkills.length,
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
