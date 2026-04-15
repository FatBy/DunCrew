import type { StateCreator } from 'zustand'
import type { AgentIdentity, AgentEvent, AgentRunStatus, LogEntry, MemoryEntry, MemorySearchResult, JournalEntry, Session } from '@/types'
import { sessionsToMemories } from '@/utils/dataMapper'

// ============================================
// localStorage 缓存恢复 (stale-while-revalidate)
// key 带版本号，结构变更时改版本让旧缓存自然失效
// 持久化写入见 store/index.ts 的 subscribe 逻辑
// ============================================
export const MEMORY_CACHE_STORAGE_KEY = 'duncrew_memory_cache_v1'

function restoreMemoryCacheFromStorage(): MemorySearchResult[] {
  try {
    const cached = localStorage.getItem(MEMORY_CACHE_STORAGE_KEY)
    if (cached) {
      const parsed = JSON.parse(cached)
      if (Array.isArray(parsed) && parsed.length > 0
          && parsed[0].id && parsed[0].source) {
        return parsed.slice(0, 500)
      }
    }
  } catch { /* 损坏/格式不兼容 — 静默降级 */ }
  return []
}

export interface AgentSlice {
  // 原始 OpenClaw 数据
  agentIdentity: AgentIdentity | null
  agentStatus: AgentRunStatus | 'idle'
  logs: LogEntry[]
  agentLoading: boolean
  
  // 当前任务上下文 (Native 模式 Agent 状态广播)
  currentTaskDescription: string | null
  currentTaskId: string | null
  
  // 映射后的 UI 数据 (记忆) — OpenClaw 遗留
  memories: MemoryEntry[]
  selectedMemoryId: string | null
  
  // Native 模式记忆缓存 (memoryStore → SQLite)
  memoryCacheRaw: MemorySearchResult[]
  memoryCacheVersion: number
  memoryCacheLoaded: boolean
  
  // 冒险日志 (AI 生成的叙事)
  journalEntries: JournalEntry[]
  journalLoading: boolean
  
  // Actions
  setAgentIdentity: (identity: AgentIdentity | null) => void
  setAgentStatus: (status: AgentRunStatus | 'idle') => void
  setCurrentTask: (id: string | null, description: string | null) => void
  addRunEvent: (event: AgentEvent) => void
  addLog: (log: LogEntry) => void
  clearLogs: () => void
  setAgentLoading: (loading: boolean) => void
  
  // 记忆 actions (OpenClaw 遗留)
  setMemories: (memories: MemoryEntry[]) => void
  setMemoriesFromSessions: (sessions: Session[]) => void
  setSelectedMemory: (id: string | null) => void
  
  // Native 记忆缓存 actions
  setMemoryCacheRaw: (data: MemorySearchResult[]) => void
  appendMemoryCacheEntries: (entries: MemorySearchResult[]) => void
  invalidateMemoryCache: () => void
  
  // 日志 actions
  setJournalEntries: (entries: JournalEntry[]) => void
  setJournalLoading: (loading: boolean) => void
}

const MAX_LOGS = 500

export const createAgentSlice: StateCreator<AgentSlice> = (set) => ({
  agentIdentity: null,
  agentStatus: 'idle',
  logs: [],
  agentLoading: true,
  currentTaskDescription: null,
  currentTaskId: null,
  memories: [],
  selectedMemoryId: null,
  memoryCacheRaw: restoreMemoryCacheFromStorage(),
  memoryCacheVersion: 0,
  memoryCacheLoaded: false,  // 即使有缓存仍标记未加载，后台会从后端刷新
  journalEntries: [],
  journalLoading: false,

  setAgentIdentity: (identity) => set({ agentIdentity: identity, agentLoading: false }),
  
  setAgentStatus: (status) => set({ agentStatus: status }),
  
  setCurrentTask: (id, description) => set({ currentTaskId: id, currentTaskDescription: description }),
  
  addRunEvent: (event) => set((state) => ({
    logs: [...state.logs, {
      id: `${event.runId}-${event.seq}`,
      timestamp: event.ts,
      level: 'info' as const,
      message: `[${event.stream}] ${JSON.stringify(event.data).slice(0, 200)}`,
    }].slice(-MAX_LOGS),
  })),
  
  addLog: (log) => set((state) => ({
    logs: [...state.logs, log].slice(-MAX_LOGS),
  })),
  
  clearLogs: () => set({ logs: [] }),
  
  setAgentLoading: (loading) => set({ agentLoading: loading }),
  
  setMemories: (memories) => set({ memories }),
  
  setMemoriesFromSessions: (sessions) => set((state) => ({
    memories: sessionsToMemories(sessions),
    selectedMemoryId: state.selectedMemoryId || (sessions.length > 0 ? sessions[0].key + '-last' : null),
  })),
  
  setSelectedMemory: (id) => set({ selectedMemoryId: id }),

  // Native 记忆缓存 actions
  // merge 策略：后端数据为权威源，但保留未被后端覆盖的本地条目
  setMemoryCacheRaw: (freshData) => set((state) => {
    // 安全网：后端返回空数据时，保留本地缓存不变，避免误清空
    if (freshData.length === 0 && state.memoryCacheRaw.length > 0) {
      return {
        memoryCacheLoaded: true,  // 标记已尝试加载，避免重复 fetch
      }
    }

    const freshIds = new Set(freshData.map(d => d.id))
    // 保留 10 分钟内的本地新增条目（可能刚写入还没同步到后端）
    const localOnly = state.memoryCacheRaw.filter(
      r => !freshIds.has(r.id) && (Date.now() - (r.createdAt || 0)) < 600_000
    )
    return {
      memoryCacheRaw: [...freshData, ...localOnly],
      memoryCacheVersion: state.memoryCacheVersion + 1,
      memoryCacheLoaded: true,
    }
  }),

  // 增量追加：放宽 id 前缀过滤，只要求 id 和 source 存在即可
  // 注意：synthesizeResult 生成 id 格式为 "mem-{uuid}"，但后端 id 格式可能不同
  appendMemoryCacheEntries: (entries) => set((state) => ({
    memoryCacheRaw: [
      ...state.memoryCacheRaw,
      ...entries.filter(e => e.id && typeof e.id === 'string' && e.source)
    ].slice(-5000),
    memoryCacheVersion: state.memoryCacheVersion + 1,
  })),

  invalidateMemoryCache: () => set({ memoryCacheLoaded: false }),
  
  setJournalEntries: (entries) => set({ journalEntries: entries }),
  setJournalLoading: (loading) => set({ journalLoading: loading }),
})
