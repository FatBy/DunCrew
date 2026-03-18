import type { StateCreator } from 'zustand'
import type { Session, TaskItem, ExecutionStep, TaskStatus, TaskCheckpoint } from '@/types'
import { sessionsToTasks } from '@/utils/dataMapper'
import { chat, isLLMConfigured } from '@/services/llmService'
import { executionLogger } from '@/services/executionLogger'

// LocalStorage 键名
const STORAGE_KEYS = {
  TASK_HISTORY: 'duncrew_task_history',
  SILENT_ANALYSIS: 'duncrew_silent_analysis',
}

// 批量持久化控制
let _lastPersistTime = Date.now()

// 优化建议动作
export interface OptimizationAction {
  target: string        // 目标 Nexus/SKILL ID，如 'skill-scout', 'dev-assistant'
  targetType: 'nexus' | 'skill'
  label: string         // 显示标签，如 "优化任务规划"
  prompt: string        // 预填的优化指令
}

// 静默分析状态
export interface SilentAnalysis {
  content: string
  loading: boolean
  error: string | null
  timestamp: number
  taskCountAtGen: number
  optimizations?: OptimizationAction[]  // 结构化优化建议
}

function emptySilentAnalysis(): SilentAnalysis {
  return { content: '', loading: false, error: null, timestamp: 0, taskCountAtGen: 0 }
}

function loadSilentAnalysis(): SilentAnalysis {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.SILENT_ANALYSIS)
    if (data) {
      const parsed = JSON.parse(data)
      return { ...emptySilentAnalysis(), ...parsed, loading: false }
    }
  } catch {
    // ignore
  }
  return emptySilentAnalysis()
}

function persistSilentAnalysis(analysis: SilentAnalysis) {
  try {
    const { loading: _, ...rest } = analysis
    localStorage.setItem(STORAGE_KEYS.SILENT_ANALYSIS, JSON.stringify(rest))
  } catch {
    // ignore
  }
}

// 任务历史持久化
function loadTaskHistory(): TaskItem[] {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.TASK_HISTORY)
    if (data) {
      return JSON.parse(data)
    }
  } catch (e) {
    console.warn('[Sessions] Failed to load task history from localStorage:', e)
  }
  return []
}

// 导出持久化函数，供 App.tsx 在刷新前调用
export function persistTaskHistory(tasks: TaskItem[]) {
  try {
    // 只保留最近 50 条任务，清理 executionSteps 中的大数据
    const trimmed = tasks.slice(-50).map(t => ({
      ...t,
      executionSteps: t.executionSteps?.slice(-20), // 每个任务最多保留 20 个步骤
    }))
    localStorage.setItem(STORAGE_KEYS.TASK_HISTORY, JSON.stringify(trimmed))
    _lastPersistTime = Date.now()
  } catch (e) {
    console.warn('[Sessions] Failed to persist task history:', e)
  }
}

// 初始化时加载
const initialTaskHistory = loadTaskHistory()
const initialSilentAnalysis = loadSilentAnalysis()

export interface SessionsSlice {
  // 原始 OpenClaw 数据
  sessions: Session[]
  sessionsLoading: boolean
  selectedSessionKey: string | null
  
  // 映射后的 UI 数据
  tasks: TaskItem[]
  
  // Native 模式: 实时执行任务 (持久化)
  activeExecutions: TaskItem[]
  
  // 中断任务提示
  hasInterruptedTasks: boolean
  
  // 静默分析
  silentAnalysis: SilentAnalysis
  
  // Actions
  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  updateSession: (key: string, updates: Partial<Session>) => void
  removeSession: (key: string) => void
  setSelectedSession: (key: string | null) => void
  setSessionsLoading: (loading: boolean) => void
  
  // Native 模式: 实时执行任务管理
  addActiveExecution: (task: TaskItem) => void
  updateActiveExecution: (id: string, updates: Partial<TaskItem>) => void
  removeActiveExecution: (id: string) => void
  appendExecutionStep: (taskId: string, step: ExecutionStep) => void
  updateExecutionStep: (taskId: string, stepId: string, updates: Partial<ExecutionStep>) => void
  clearTaskHistory: () => void
  
  // 中断任务处理
  checkInterruptedTasks: () => void
  markInterruptedTasksAsFailed: () => void
  dismissInterruptedTasksWarning: () => void
  retryInterruptedTask: (taskId: string) => TaskItem | null
  getInterruptedTasks: () => TaskItem[]
  
  // 任务监管控制
  pauseTask: (taskId: string) => void
  resumeTask: (taskId: string) => void
  retryFailedTask: (taskId: string) => TaskItem | null
  
  // 检查点管理
  saveCheckpoint: (taskId: string, checkpoint: TaskCheckpoint) => void
  restoreFromCheckpoint: (taskId: string) => TaskCheckpoint | null
  
  // 静默分析
  generateSilentAnalysis: () => Promise<void>
  shouldRefreshAnalysis: () => boolean
}

export const createSessionsSlice: StateCreator<SessionsSlice> = (set, get) => ({
  sessions: [],
  sessionsLoading: true,
  selectedSessionKey: null,
  tasks: [],
  // 从 localStorage 恢复任务历史
  activeExecutions: initialTaskHistory,
  // 检查是否有中断的任务
  hasInterruptedTasks: initialTaskHistory.some(t => t.status === 'executing'),
  silentAnalysis: initialSilentAnalysis,

  setSessions: (sessions) => set({ 
    sessions, 
    tasks: sessionsToTasks(sessions),
    sessionsLoading: false,
  }),
  
  addSession: (session) => set((state) => {
    const newSessions = [session, ...state.sessions]
    return {
      sessions: newSessions,
      tasks: sessionsToTasks(newSessions),
    }
  }),
  
  updateSession: (key, updates) => set((state) => {
    const newSessions = state.sessions.map((s) =>
      s.key === key ? { ...s, ...updates } : s
    )
    return {
      sessions: newSessions,
      tasks: sessionsToTasks(newSessions),
    }
  }),
  
  removeSession: (key) => set((state) => {
    const newSessions = state.sessions.filter((s) => s.key !== key)
    return {
      sessions: newSessions,
      tasks: sessionsToTasks(newSessions),
      selectedSessionKey: state.selectedSessionKey === key ? null : state.selectedSessionKey,
    }
  }),
  
  setSelectedSession: (key) => set({ selectedSessionKey: key }),
  
  setSessionsLoading: (loading) => set({ sessionsLoading: loading }),
  
  // Native 模式: 实时执行任务管理 (带持久化)
  addActiveExecution: (task) => set((state) => {
    // 去重：如果已存在相同 ID 的任务，先过滤掉旧的
    const filtered = state.activeExecutions.filter(t => t.id !== task.id)
    const newExecutions = [...filtered, task].slice(-50)
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),
  
  updateActiveExecution: (id, updates) => set((state) => {
    const newExecutions = state.activeExecutions.map(t =>
      t.id === id ? { ...t, ...updates } : t
    )
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),
  
  removeActiveExecution: (id) => set((state) => {
    const newExecutions = state.activeExecutions.filter(t => t.id !== id)
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),
  
  // 追加执行步骤到指定任务（带批量持久化）
  appendExecutionStep: (taskId, step) => set((state) => {
    const newExecutions = state.activeExecutions.map(t => {
      if (t.id !== taskId) return t
      const existingSteps = t.executionSteps || []
      return {
        ...t,
        executionSteps: [...existingSteps, step].slice(-50), // 最多保留 50 步
      }
    })
    // 批量持久化：每 5 步或超过 10 秒持久化一次
    const task = newExecutions.find(t => t.id === taskId)
    const stepCount = task?.executionSteps?.length || 0
    const timeSinceLastPersist = Date.now() - _lastPersistTime
    if (stepCount % 5 === 0 || timeSinceLastPersist > 10000) {
      persistTaskHistory(newExecutions)
    }
    return { activeExecutions: newExecutions }
  }),
  
  // 更新指定任务中的指定执行步骤（用于累积 assistant delta 到单个 thinking step）
  updateExecutionStep: (taskId, stepId, updates) => set((state) => {
    const newExecutions = state.activeExecutions.map(t => {
      if (t.id !== taskId) return t
      const steps = t.executionSteps || []
      return {
        ...t,
        executionSteps: steps.map(s =>
          s.id === stepId ? { ...s, ...updates } : s
        ),
      }
    })
    return { activeExecutions: newExecutions }
  }),

  clearTaskHistory: () => {
    localStorage.removeItem(STORAGE_KEYS.TASK_HISTORY)
    localStorage.removeItem(STORAGE_KEYS.SILENT_ANALYSIS)
    set({ activeExecutions: [], silentAnalysis: emptySilentAnalysis(), hasInterruptedTasks: false })
  },

  // 中断任务处理
  checkInterruptedTasks: () => {
    const { activeExecutions } = get()
    const hasInterrupted = activeExecutions.some(t => t.status === 'executing')
    set({ hasInterruptedTasks: hasInterrupted })
  },

  markInterruptedTasksAsFailed: () => {
    const { activeExecutions } = get()
    const newExecutions = activeExecutions.map(t => {
      if (t.status === 'executing') {
        return {
          ...t,
          status: 'interrupted' as TaskStatus,
          executionError: '任务因页面刷新而中断',
          executionDuration: Date.now() - (t.timestamp ? new Date(t.timestamp).getTime() : Date.now()),
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    set({ activeExecutions: newExecutions, hasInterruptedTasks: false })
  },

  dismissInterruptedTasksWarning: () => {
    set({ hasInterruptedTasks: false })
  },

  // 获取所有中断的任务
  getInterruptedTasks: () => {
    const { activeExecutions } = get()
    return activeExecutions.filter(t => t.status === 'executing' || t.status === 'interrupted')
  },

  // 重试中断的任务：标记原任务为 interrupted，返回任务信息供调用方重新执行
  retryInterruptedTask: (taskId) => {
    const { activeExecutions } = get()
    const task = activeExecutions.find(t => t.id === taskId)
    if (!task) return null
    
    // 标记原任务为 interrupted
    const newExecutions = activeExecutions.map(t => {
      if (t.id === taskId) {
        return {
          ...t,
          status: 'interrupted' as TaskStatus,
          executionError: '任务已重新执行',
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    set({ activeExecutions: newExecutions })
    
    // 返回任务信息，供调用方使用 sendChat 重新执行
    return task
  },

  // 任务监管控制
  pauseTask: (taskId) => set((state) => {
    const newExecutions = state.activeExecutions.map(t => {
      if (t.id === taskId && t.status === 'executing') {
        executionLogger.log(taskId, 'task_paused', { previousStatus: t.status })
        return {
          ...t,
          status: 'paused' as TaskStatus,
          pausedAt: Date.now(),
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),

  resumeTask: (taskId) => set((state) => {
    const newExecutions = state.activeExecutions.map(t => {
      if (t.id === taskId && t.status === 'paused') {
        executionLogger.log(taskId, 'task_resumed', { pausedDuration: t.pausedAt ? Date.now() - t.pausedAt : 0 })
        return {
          ...t,
          status: 'executing' as TaskStatus,
          pausedAt: undefined,
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),

  retryFailedTask: (taskId) => {
    const { activeExecutions } = get()
    const task = activeExecutions.find(t => t.id === taskId)
    if (!task || (task.status !== 'interrupted' && task.status !== 'terminated')) return null
    
    const maxRetries = task.maxRetries ?? 2
    const currentRetry = task.retryCount ?? 0
    
    if (currentRetry >= maxRetries) {
      console.warn(`[Sessions] Task ${taskId} has exceeded max retries (${maxRetries})`)
      return null
    }
    
    // 标记为重试中
    const newExecutions = activeExecutions.map(t => {
      if (t.id === taskId) {
        executionLogger.log(taskId, 'task_retrying', { retryCount: currentRetry + 1 })
        return {
          ...t,
          status: 'retrying' as TaskStatus,
          retryCount: currentRetry + 1,
          executionError: undefined,
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    set({ activeExecutions: newExecutions })
    
    return task
  },

  // 检查点管理
  saveCheckpoint: (taskId, checkpoint) => set((state) => {
    const newExecutions = state.activeExecutions.map(t => {
      if (t.id === taskId) {
        executionLogger.log(taskId, 'checkpoint_saved', { stepIndex: checkpoint.stepIndex })
        return {
          ...t,
          checkpoint: { ...checkpoint, savedAt: Date.now() },
        }
      }
      return t
    })
    persistTaskHistory(newExecutions)
    return { activeExecutions: newExecutions }
  }),

  restoreFromCheckpoint: (taskId) => {
    const { activeExecutions } = get()
    const task = activeExecutions.find(t => t.id === taskId)
    if (!task?.checkpoint) return null
    
    executionLogger.log(taskId, 'checkpoint_restored', { stepIndex: task.checkpoint.stepIndex })
    return task.checkpoint
  },

  // 静默分析
  shouldRefreshAnalysis: () => {
    const { silentAnalysis, activeExecutions } = get()
    const doneCount = activeExecutions.filter(
      t => t.status === 'done' || t.status === 'terminated'
    ).length

    // 首次加载 / 无缓存
    if (silentAnalysis.timestamp === 0) return doneCount > 0

    // 新增 3+ 完成任务
    return doneCount - silentAnalysis.taskCountAtGen >= 3
  },

  generateSilentAnalysis: async () => {
    if (!isLLMConfigured()) return
    
    const { silentAnalysis, activeExecutions } = get()
    if (silentAnalysis.loading) return

    const doneTasks = activeExecutions.filter(
      t => t.status === 'done' || t.status === 'terminated'
    )

    if (doneTasks.length === 0) return

    set({ silentAnalysis: { ...get().silentAnalysis, loading: true, error: null } })

    try {
      const taskSummaries = doneTasks.slice(-20).map(t => {
        const duration = t.executionDuration
          ? `${(t.executionDuration / 1000).toFixed(1)}s`
          : '未知'
        const status = t.status === 'done'
          ? (t.executionError ? '完成(有错误)' : '成功')
          : '已终止'
        return `- [${t.title}] ${status} | 耗时 ${duration}${t.executionError ? ` | 错误: ${t.executionError.slice(0, 60)}` : ''}`
      }).join('\n')

      const messages = [
        {
          role: 'system' as const,
          content: `你是 DunCrew 任务分析师。分析历史任务，输出 JSON 格式：
{
  "summary": "2-3句话的能力画像总结",
  "optimizations": [
    {"target": "nexus-id", "targetType": "nexus", "label": "优化建议标签", "prompt": "具体优化指令"}
  ]
}
optimizations 规则：
- target: 推荐优化的 Nexus ID (${(() => { const nx = (get() as any).nexuses; return nx instanceof Map ? Array.from(nx.keys()).join('/') : 'default' })()}) 或 skill 名称
- targetType: "nexus" 或 "skill"
- prompt: 给该 Nexus/Skill 的优化指令，包含具体改进建议
- 必须至少给出 1 条优化建议，最多 2 条
仅输出 JSON，无其他文字。`,
        },
        {
          role: 'user' as const,
          content: `历史任务 (${doneTasks.length} 条):\n${taskSummaries}`,
        },
      ]

      const rawContent = await chat(messages)
      
      // 解析 JSON 响应
      let summary = rawContent
      let optimizations: OptimizationAction[] = []
      try {
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          summary = parsed.summary || rawContent
          optimizations = (parsed.optimizations || []).filter(
            (o: any) => o.target && o.label && o.prompt
          )
        }
      } catch {
        // JSON 解析失败，使用原始文本
      }

      // 如果没有解析到优化建议，生成默认建议
      if (optimizations.length === 0 && summary) {
        const activeNexusId = (get() as any).activeNexusId as string | null
        const targetId = activeNexusId || 'default'
        optimizations.push({
          target: targetId,
          targetType: 'nexus',
          label: '根据分析优化',
          prompt: `根据以下 AI 分析改进执行策略:\n${summary.slice(0, 300)}`,
        })
      }

      const newAnalysis: SilentAnalysis = {
        content: summary,
        loading: false,
        error: null,
        timestamp: Date.now(),
        taskCountAtGen: doneTasks.length,
        optimizations,
      }
      persistSilentAnalysis(newAnalysis)
      set({ silentAnalysis: newAnalysis })
    } catch (err: any) {
      set({
        silentAnalysis: {
          ...get().silentAnalysis,
          loading: false,
          error: err.message || '分析失败',
        },
      })
    }
  },
})
