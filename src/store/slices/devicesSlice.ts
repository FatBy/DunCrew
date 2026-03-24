import type { StateCreator } from 'zustand'
import type { Device, PresenceSnapshot, HealthSnapshot, SoulDimension, AgentIdentity, SoulIdentity, SoulTruth, SoulBoundary, MBTIResult, MBTIAxisScores } from '@/types'
import { healthToSoulDimensions } from '@/utils/dataMapper'
import type { ParsedSoul } from '@/utils/soulParser'

export interface DevicesSlice {
  // 原始 OpenClaw 数据
  devices: Record<string, Device>
  operators: string[]
  nodes: string[]
  health: HealthSnapshot | null
  devicesLoading: boolean
  
  // SOUL.md 原始内容
  soulRawContent: string
  
  // 映射后的 UI 数据 (灵魂 - 基于 SOUL.md)
  soulIdentity: SoulIdentity | null
  soulCoreTruths: SoulTruth[]
  soulBoundaries: SoulBoundary[]
  soulVibeStatement: string
  soulContinuityNote: string
  soulDimensions: SoulDimension[]
  soulPrompts: { identity: string; constraints: string; goals: string }
  soulDirty: boolean
  
  // MBTI 灵魂形象
  soulMBTI: MBTIResult | null
  soulMBTILoading: boolean
  
  // MBTI 双层演化
  soulMBTIBase: MBTIResult | null        // Layer 1: 基础类型 (来自 SOUL.md)
  soulMBTIExpressed: MBTIResult | null   // Layer 2: 行为调整后的表达类型
  soulMBTIAxes: MBTIAxisScores | null    // 四轴原始分数 (-1~+1)
  
  // 核心协议 LLM 总结
  soulTruthsSummary: string              // LLM 生成的一句话总结
  
  // Actions
  setPresenceSnapshot: (snapshot: PresenceSnapshot) => void
  updateDevice: (id: string, updates: Partial<Device>) => void
  removeDevice: (id: string) => void
  setHealth: (health: HealthSnapshot | null) => void
  setDevicesLoading: (loading: boolean) => void
  
  // 从解析后的 SOUL.md 设置灵魂数据
  setSoulFromParsed: (parsed: ParsedSoul, agentIdentity: AgentIdentity | null) => void
  
  // 更新灵魂维度 (基于 health, presence)
  updateSoulDimensions: (identity: AgentIdentity | null) => void
  
  // 兼容旧接口
  updateSoulFromState: (identity: AgentIdentity | null) => void
  setSoulDirty: (dirty: boolean) => void
  detectSoulMBTI: () => Promise<void>
  
  // MBTI 双层演化
  updateExpressedMBTI: (expressed: MBTIResult, axes: MBTIAxisScores) => void
  
  // 核心协议总结
  generateSoulSummary: () => Promise<void>
}

export const createDevicesSlice: StateCreator<DevicesSlice> = (set, get) => ({
  devices: {},
  operators: [],
  nodes: [],
  health: null,
  devicesLoading: true,
  soulRawContent: '',
  soulIdentity: null,
  soulCoreTruths: [],
  soulBoundaries: [],
  soulVibeStatement: '',
  soulContinuityNote: '',
  soulDimensions: [],
  soulPrompts: { identity: '', constraints: '', goals: '' },
  soulDirty: false,
  soulMBTI: null,
  soulMBTILoading: false,
  soulMBTIBase: null,
  soulMBTIExpressed: null,
  soulMBTIAxes: null,
  soulTruthsSummary: '',

  setPresenceSnapshot: (snapshot) => set((state) => {
    // 只更新 presence 相关数据和维度，不覆盖已解析的 soul 内容
    const dimensions = healthToSoulDimensions(state.health, snapshot, null)
    return {
      devices: snapshot.devices,
      operators: snapshot.operators,
      nodes: snapshot.nodes,
      devicesLoading: false,
      soulDimensions: dimensions,
    }
  }),
  
  updateDevice: (id, updates) => set((state) => ({
    devices: {
      ...state.devices,
      [id]: { ...state.devices[id], ...updates },
    },
  })),
  
  removeDevice: (id) => set((state) => {
    const { [id]: removed, ...rest } = state.devices
    const device = state.devices[id]
    return {
      devices: rest,
      operators: device?.role === 'operator' 
        ? state.operators.filter((o) => o !== id) 
        : state.operators,
      nodes: device?.role === 'node'
        ? state.nodes.filter((n) => n !== id)
        : state.nodes,
    }
  }),
  
  setHealth: (health) => set((state) => {
    // 只更新 health 和维度，不覆盖已解析的 soul 内容
    const dimensions = healthToSoulDimensions(
      health, 
      { operators: state.operators, nodes: state.nodes },
      null
    )
    return {
      health,
      soulDimensions: dimensions,
    }
  }),
  
  setDevicesLoading: (loading) => set({ devicesLoading: loading }),
  
  // 从解析后的 SOUL.md 设置灵魂数据
  setSoulFromParsed: (parsed, agentIdentity) => {
    set((state) => {
      const identity: SoulIdentity = {
        name: agentIdentity?.name || 'DunCrew Agent',
        essence: parsed.subtitle || parsed.title || 'AI Assistant',
        vibe: parsed.vibeStatement ? parsed.vibeStatement.slice(0, 100) : '',
        symbol: agentIdentity?.emoji || '🤖',
      }
      
      // 生成 prompts (兼容旧版)
      const prompts = {
        identity: agentIdentity 
          ? `I'm ${agentIdentity.name || 'DunCrew Agent'}, ID: ${agentIdentity.agentId}. ${agentIdentity.emoji || '🤖'}`
          : 'Connected, waiting for agent identity...',
        constraints: state.health
          ? `Status: ${state.health.status}\nUptime: ${Math.floor(state.health.uptime / 3600000)}h\nVersion: ${state.health.version || 'unknown'}`
          : 'Loading system status...',
        goals: `Operators: ${state.operators.length}\nNodes: ${state.nodes.length}`,
      }
      
      return {
        soulRawContent: parsed.rawContent,
        soulIdentity: identity,
        soulCoreTruths: parsed.coreTruths,
        soulBoundaries: parsed.boundaries,
        soulVibeStatement: parsed.vibeStatement,
        soulContinuityNote: parsed.continuityNote,
        soulPrompts: prompts,
      }
    })
    // Soul 数据更新后: 先标记需要重新检测，再触发
    set({ soulMBTILoading: false })
    setTimeout(() => get().detectSoulMBTI(), 0)
  },
  
  // 更新灵魂维度 (基于 health, presence)
  updateSoulDimensions: (identity) => set((state) => {
    const dimensions = healthToSoulDimensions(
      state.health,
      { operators: state.operators, nodes: state.nodes },
      identity
    )
    return { soulDimensions: dimensions }
  }),
  
  // 兼容旧接口 - 只更新维度，不覆盖解析的内容
  updateSoulFromState: (identity) => set((state) => {
    const dimensions = healthToSoulDimensions(
      state.health,
      { operators: state.operators, nodes: state.nodes },
      identity
    )
    
    // 如果还没有解析过 SOUL.md，设置默认 identity
    if (!state.soulIdentity && identity) {
      return {
        soulDimensions: dimensions,
        soulIdentity: {
          name: identity.name || 'DunCrew Agent',
          essence: 'AI Assistant',
          vibe: '',
          symbol: identity.emoji || '🤖',
        },
      }
    }
    
    // 如果已经有 identity，只更新 name 和 emoji
    if (state.soulIdentity && identity) {
      return {
        soulDimensions: dimensions,
        soulIdentity: {
          ...state.soulIdentity,
          name: identity.name || state.soulIdentity.name,
          symbol: identity.emoji || state.soulIdentity.symbol,
        },
      }
    }
    
    return { soulDimensions: dimensions }
  }),
  
  setSoulDirty: (dirty) => set({ soulDirty: dirty }),
  
  detectSoulMBTI: async () => {
    const state = get()
    if (state.soulMBTILoading) return
    set({ soulMBTILoading: true })
    try {
      const { detectMBTI, rulesAxisScores } = await import('@/services/mbtiAnalyzer')
      const result = await detectMBTI(
        state.soulCoreTruths,
        state.soulBoundaries,
        state.soulVibeStatement,
        state.soulRawContent,
        // LLM 后台分析完成后回调更新 store
        (llmResult) => {
          set({ soulMBTI: llmResult, soulMBTIBase: llmResult })
        },
      )
      // 规则引擎的轴分数作为初始 axes
      const axes = rulesAxisScores(state.soulCoreTruths, state.soulBoundaries, state.soulVibeStatement)
      set({
        soulMBTI: result,
        soulMBTIBase: result,
        soulMBTIExpressed: result,
        soulMBTIAxes: axes,
        soulMBTILoading: false,
      })
    } catch {
      set({ soulMBTILoading: false })
    }
  },
  
  updateExpressedMBTI: (expressed, axes) => {
    set({ soulMBTIExpressed: expressed, soulMBTI: expressed, soulMBTIAxes: axes })
  },
  
  generateSoulSummary: async () => {
    const state = get()
    const truths = state.soulCoreTruths
    const boundaries = state.soulBoundaries
    const vibe = state.soulVibeStatement
    
    if (truths.length === 0 && boundaries.length === 0) return
    
    // 构建内容 hash 用于缓存失效
    const contentForHash = truths.map(t => t.title).join('|') + '||' + boundaries.map(b => b.rule).join('|')
    let contentHash = 0
    for (let i = 0; i < contentForHash.length; i++) {
      contentHash = contentForHash.charCodeAt(i) + ((contentHash << 5) - contentHash)
    }
    
    // 检查缓存
    const cacheKey = 'duncrew_soul_truths_summary'
    try {
      const cached = localStorage.getItem(cacheKey)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (parsed.hash === contentHash && parsed.summary) {
          set({ soulTruthsSummary: parsed.summary })
          return
        }
      }
    } catch { /* ignore */ }
    
    // 先设置一个规则引擎降级总结
    const fallbackSummary = `${truths.length} 条核心原则 · ${boundaries.length} 条能力边界`
    set({ soulTruthsSummary: fallbackSummary })
    
    // 异步调 LLM 生成总结
    try {
      const { isLLMConfigured, chat } = await import('@/services/llmService')
      if (!isLLMConfigured()) return
      
      const truthsText = truths.map((t, i) => `${i + 1}. ${t.title}: ${t.description || t.principle || ''}`).join('\n')
      const boundariesText = boundaries.map(b => `- ${b.rule}`).join('\n')
      
      const result = await chat([
        {
          role: 'system',
          content: 'You are a concise summarizer. Output ONLY a single Chinese sentence (15-30 characters), no quotes, no punctuation at the end.',
        },
        {
          role: 'user',
          content: `用一句话总结这个 AI Agent 的核心协议特征（不要列举，要提炼本质）：\n\n核心原则:\n${truthsText}\n\n能力边界:\n${boundariesText}\n\n风格: ${vibe || '无'}`,
        },
      ])
      
      const summary = result.trim().replace(/^["'「]|["'」。]$/g, '')
      if (summary && summary.length >= 4 && summary.length <= 60) {
        set({ soulTruthsSummary: summary })
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ hash: contentHash, summary }))
        } catch { /* ignore */ }
      }
    } catch {
      // LLM 失败，保持降级总结
    }
  },
})
