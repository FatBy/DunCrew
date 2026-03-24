import type { StateCreator } from 'zustand'
import type { AgentIdentity, AgentEvent, AgentRunStatus, LogEntry, MemoryEntry, MemorySearchResult, JournalEntry, Session } from '@/types'
import { sessionsToMemories } from '@/utils/dataMapper'

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
  memoryCacheRaw: [],
  memoryCacheVersion: 0,
  memoryCacheLoaded: false,
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
  setMemoryCacheRaw: (data) => set((state) => ({
    memoryCacheRaw: data,
    memoryCacheVersion: state.memoryCacheVersion + 1,
    memoryCacheLoaded: true,
  })),

  appendMemoryCacheEntries: (entries) => set((state) => ({
    memoryCacheRaw: [...state.memoryCacheRaw, ...entries],
    memoryCacheVersion: state.memoryCacheVersion + 1,
  })),

  invalidateMemoryCache: () => set({ memoryCacheLoaded: false }),
  
  setJournalEntries: (entries) => set({ journalEntries: entries }),
  setJournalLoading: (loading) => set({ journalLoading: loading }),
})
