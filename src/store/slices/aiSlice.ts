import type { StateCreator } from 'zustand'
import type { ChatMessage, AISummary, LLMConfig, ViewType, ExecutionStatus, ApprovalRequest, MemoryEntry, JournalEntry, Conversation, ConversationType, QuestSession, QuestPhase, ExplorationResult, Subagent, SubagentTask, ContextEntry, TaskPlan } from '@/types'
import { getLLMConfig, saveLLMConfig, isLLMConfigured, streamChat, chat } from '@/services/llmService'
import { buildSummaryMessages, buildChatMessages, parseExecutionCommands, stripExecutionBlocks, buildJournalPrompt, parseJournalResult } from '@/services/contextBuilder'
import { localClawService } from '@/services/LocalClawService'
import { localServerService } from '@/services/localServerService'

// 摘要缓存时间 (5分钟)
const SUMMARY_CACHE_MS = 5 * 60 * 1000

// 内存限制常量 - 防止 OOM
const MAX_CONVERSATIONS = 20          // 最多保留 20 个会话
const MAX_MESSAGES_PER_CONV = 50      // 每个会话最多保留 50 条消息

// 自动标题生成 (异步，不阻塞消息发送)
async function generateConversationTitle(
  convId: string,
  firstMessage: string,
  get: () => AiSlice,
  set: (partial: Partial<AiSlice> | ((s: AiSlice) => Partial<AiSlice>)) => void,
) {
  // 立即标记 autoTitled 防止重复触发
  set((state) => {
    const conv = state.conversations.get(convId)
    if (!conv) return state
    const updated = new Map(state.conversations)
    updated.set(convId, { ...conv, autoTitled: true })
    return { conversations: updated }
  })

  try {
    if (!isLLMConfigured()) return

    const title = await chat([{
      role: 'user',
      content: `用5-10个中文字给这段对话起一个简短标题，只输出标题本身，不要引号不要标点：\n${firstMessage.slice(0, 200)}`,
    }])

    const cleanTitle = title.trim().replace(/^["'「《]|["'」》]$/g, '').slice(0, 20)
    if (!cleanTitle) return

    set((state) => {
      const conv = state.conversations.get(convId)
      if (!conv) return state
      const updated = new Map(state.conversations)
      updated.set(convId, { ...conv, title: cleanTitle })
      return { conversations: updated }
    })
    persistConversations(get().conversations)
  } catch {
    // 静默失败，保留默认标题
  }
}

// LocalStorage 键名
// 后端数据键名
const DATA_KEYS = {
  CONVERSATIONS: 'conversations',
  ACTIVE_CONVERSATION: 'active_conversation_id',
  EXECUTION_STATUS: 'execution_status',
}

// LocalStorage 键名 (作为备份/缓存)
const STORAGE_KEYS = {
  CONVERSATIONS: 'ddos_conversations_v2',
  ACTIVE_CONVERSATION: 'ddos_active_conv_id',
  EXECUTION_STATUS: 'ddos_execution_status',
  // 旧键名 (用于迁移)
  LEGACY_CHAT_HISTORY: 'ddos_chat_history',
  LEGACY_NEXUS_CHAT_MAP: 'ddos_nexus_chat_map',
}

// ============================================
// 会话持久化函数 (后端 + localStorage 双写)
// ============================================

function loadConversationsFromLocalStorage(): Map<string, Conversation> {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS)
    if (!data) return new Map()
    const array = JSON.parse(data) as Conversation[]
    return new Map(array.map(c => [c.id, c]))
  } catch (e) {
    console.warn('[AI] Failed to load conversations from localStorage:', e)
    return new Map()
  }
}

function persistConversations(conversations: Map<string, Conversation>) {
  try {
    // 按更新时间排序，只保留最近 MAX_CONVERSATIONS 个
    const sorted = [...conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS)
    
    // 每个会话只保留最近 MAX_MESSAGES_PER_CONV 条消息
    const trimmed = sorted.map(conv => ({
      ...conv,
      messages: conv.messages.slice(-MAX_MESSAGES_PER_CONV),
    }))
    
    // 同步写入 localStorage (快速缓存)
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(trimmed))
    
    // 异步写入后端 (持久化) — 带 1 次重试
    const persistToBackend = async (retries = 1) => {
      const ok = await localServerService.setData(DATA_KEYS.CONVERSATIONS, trimmed)
      if (!ok && retries > 0) {
        await new Promise(r => setTimeout(r, 2000))
        return persistToBackend(retries - 1)
      }
      if (!ok) {
        console.warn('[AI] Failed to persist conversations to server after retry')
      }
    }
    persistToBackend().catch(() => {})
  } catch (e) {
    console.warn('[AI] Failed to persist conversations:', e)
  }
}

function loadActiveConversationId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_CONVERSATION)
  } catch {
    return null
  }
}

function persistActiveConversationId(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, id)
      localServerService.setData(DATA_KEYS.ACTIVE_CONVERSATION, id).catch(() => {})
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_CONVERSATION)
      localServerService.deleteData(DATA_KEYS.ACTIVE_CONVERSATION).catch(() => {})
    }
  } catch {}
}

function loadExecutionStatuses(): Record<string, ExecutionStatus> {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.EXECUTION_STATUS)
    return data ? JSON.parse(data) : {}
  } catch {
    return {}
  }
}

function persistExecutionStatuses(statuses: Record<string, ExecutionStatus>) {
  try {
    const cleanStatuses: Record<string, ExecutionStatus> = {}
    for (const [k, v] of Object.entries(statuses)) {
      cleanStatuses[k] = { ...v, outputLines: undefined }
    }
    localStorage.setItem(STORAGE_KEYS.EXECUTION_STATUS, JSON.stringify(cleanStatuses))
  } catch {}
}

// 迁移旧数据到新会话系统
function migrateFromLegacy(): { conversations: Map<string, Conversation>; activeId: string | null } {
  const conversations = new Map<string, Conversation>()
  let activeId: string | null = null
  
  try {
    // 检查是否已经有新格式数据
    const existingData = localStorage.getItem(STORAGE_KEYS.CONVERSATIONS)
    if (existingData) {
      // 已有新数据，无需迁移
      const loaded = loadConversationsFromLocalStorage()
      const savedActiveId = loadActiveConversationId()
      return { 
        conversations: loaded, 
        activeId: savedActiveId || (loaded.size > 0 ? [...loaded.keys()][0] : null)
      }
    }
    
    // 迁移旧主聊天记录
    const oldChatHistory = localStorage.getItem(STORAGE_KEYS.LEGACY_CHAT_HISTORY)
    if (oldChatHistory) {
      const messages: ChatMessage[] = JSON.parse(oldChatHistory)
      if (messages.length > 0) {
        const convId = `general-${Date.now()}`
        conversations.set(convId, {
          id: convId,
          type: 'general',
          title: '主对话',
          messages,
          createdAt: messages[0]?.timestamp || Date.now(),
          updatedAt: messages[messages.length - 1]?.timestamp || Date.now(),
        })
        activeId = convId
      }
    }
    
    // 迁移旧 Nexus 聊天记录
    const oldNexusMap = localStorage.getItem(STORAGE_KEYS.LEGACY_NEXUS_CHAT_MAP)
    if (oldNexusMap) {
      const nexusChats: Record<string, ChatMessage[]> = JSON.parse(oldNexusMap)
      for (const [nexusId, messages] of Object.entries(nexusChats)) {
        if (messages.length > 0) {
          const convId = `nexus-${nexusId}`
          conversations.set(convId, {
            id: convId,
            type: 'nexus',
            title: `Nexus-${nexusId.slice(-6)}`,
            nexusId,
            messages,
            createdAt: messages[0].timestamp,
            updatedAt: messages[messages.length - 1].timestamp,
          })
        }
      }
    }
    
    // 持久化新格式并清理旧键
    if (conversations.size > 0) {
      persistConversations(conversations)
      if (activeId) persistActiveConversationId(activeId)
      localStorage.removeItem(STORAGE_KEYS.LEGACY_CHAT_HISTORY)
      localStorage.removeItem(STORAGE_KEYS.LEGACY_NEXUS_CHAT_MAP)
      console.log('[AI] Migrated', conversations.size, 'conversations from legacy format')
    }
    
  } catch (e) {
    console.warn('[AI] Migration failed:', e)
  }
  
  return { conversations, activeId }
}

const emptySummary = (): AISummary => ({ content: '', loading: false, error: null, timestamp: 0 })

// 初始化时加载持久化数据
const { conversations: initialConversations, activeId: initialActiveId } = migrateFromLegacy()
const initialExecutionStatuses = loadExecutionStatuses()

export interface AiSlice {
  // LLM 配置
  llmConfig: LLMConfig
  llmConnected: boolean

  // 每页独立摘要
  summaries: Record<string, AISummary>

  // ============================================
  // 多会话系统
  // ============================================
  conversations: Map<string, Conversation>
  activeConversationId: string | null
  
  // 流式状态 (全局共享，同时只有一个流)
  chatStreaming: boolean
  chatStreamContent: string
  chatContext: ViewType
  chatError: string | null
  _chatAbort: AbortController | null

  // 会话管理 Actions
  createConversation: (type: ConversationType, options?: { nexusId?: string; title?: string }) => string
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  getOrCreateNexusConversation: (nexusId: string) => string
  /** 强制创建新的 Nexus 会话（每次执行按钮点击时使用） */
  createNewNexusConversation: (nexusId: string) => string
  getCurrentMessages: () => ChatMessage[]

  // Actions
  setLlmConfig: (config: Partial<LLMConfig>) => void
  setLlmConnected: (connected: boolean) => void

  // 摘要
  generateSummary: (view: ViewType) => Promise<void>
  getSummary: (view: ViewType) => AISummary
  clearSummary: (view: ViewType) => void

  // 聊天 (基于当前激活会话)
  sendChat: (message: string, view: ViewType, hiddenContext?: string) => Promise<void>
  clearChat: () => void
  abortChat: () => void
  setChatContext: (view: ViewType) => void

  // AI 执行
  executionStatuses: Record<string, ExecutionStatus>
  updateExecutionStatus: (id: string, updates: Partial<ExecutionStatus>) => void

  // P3: 危险操作审批
  pendingApproval: (ApprovalRequest & { resolve: (approved: boolean) => void }) | null
  requestApproval: (req: Omit<ApprovalRequest, 'id' | 'timestamp'>) => Promise<boolean>
  respondToApproval: (approved: boolean) => void

  // 冒险日志生成
  generateJournal: (memories: MemoryEntry[]) => Promise<void>
  generateSilentJournal: () => Promise<void>

  // 聊天面板开关
  isChatOpen: boolean
  setChatOpen: (open: boolean) => void

  // 从后端加载数据 (应用启动后调用)
  loadConversationsFromServer: () => Promise<void>

  // ============================================
  // 交互式 Quest 系统 (Qoder 风格)
  // ============================================
  activeQuestSession: QuestSession | null
  questSubagents: Map<string, Subagent>
  
  // Quest Actions
  startQuestSession: (userGoal: string) => void
  updateQuestPhase: (phase: QuestPhase) => void
  setQuestProposedPlan: (plan: TaskPlan | null) => void
  addExplorationResult: (result: ExplorationResult) => void
  spawnSubagent: (task: SubagentTask) => string
  updateSubagent: (id: string, updates: Partial<Subagent>) => void
  collectSubagentResults: () => ExplorationResult[]
  confirmQuestPlan: () => void
  cancelQuestSession: () => void
  appendToQuestContext: (entry: ContextEntry) => void
  completeQuestSession: (result: string) => void

  // 内部辅助方法
  _addMessageToActiveConv: (msg: ChatMessage) => void
  _updateMessageInActiveConv: (msgId: string, updates: Partial<ChatMessage>) => void
}

export const createAiSlice: StateCreator<AiSlice, [], [], AiSlice> = (set, get) => ({
  llmConfig: getLLMConfig(),
  llmConnected: false,
  summaries: {},
  
  // 多会话系统
  conversations: initialConversations,
  activeConversationId: initialActiveId,
  
  // 流式状态
  chatStreaming: false,
  chatStreamContent: '',
  chatContext: 'world',
  chatError: null,
  _chatAbort: null,
  executionStatuses: initialExecutionStatuses,

  // 聊天面板开关
  isChatOpen: false,
  setChatOpen: (open) => set({ isChatOpen: open }),

  // ============================================
  // 交互式 Quest 系统状态
  // ============================================
  activeQuestSession: null,
  questSubagents: new Map(),

  startQuestSession: (userGoal) => {
    const sessionId = `quest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const session: QuestSession = {
      id: sessionId,
      phase: 'exploring',
      userGoal,
      explorationResults: [],
      proposedPlan: null,
      accumulatedContext: [],
      subagents: [],
      createdAt: Date.now(),
    }
    set({ activeQuestSession: session, questSubagents: new Map() })
    console.log('[Quest] Started session:', sessionId)
  },

  updateQuestPhase: (phase) => {
    const session = get().activeQuestSession
    if (!session) return
    set({ activeQuestSession: { ...session, phase } })
  },

  setQuestProposedPlan: (plan) => {
    const session = get().activeQuestSession
    if (!session) return
    set({ activeQuestSession: { ...session, proposedPlan: plan, phase: plan ? 'confirming' : session.phase } })
  },

  addExplorationResult: (result) => {
    const session = get().activeQuestSession
    if (!session) return
    set({ activeQuestSession: { ...session, explorationResults: [...session.explorationResults, result] } })
  },

  spawnSubagent: (task) => {
    const agentId = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const subagent: Subagent = { id: agentId, type: task.type, task: task.task, status: 'pending', tools: task.tools, startedAt: Date.now() }
    const newMap = new Map(get().questSubagents)
    newMap.set(agentId, subagent)
    const session = get().activeQuestSession
    if (session) {
      set({ questSubagents: newMap, activeQuestSession: { ...session, subagents: [...session.subagents, subagent] } })
    } else {
      set({ questSubagents: newMap })
    }
    return agentId
  },

  updateSubagent: (id, updates) => {
    const newMap = new Map(get().questSubagents)
    const existing = newMap.get(id)
    if (!existing) return
    const updated = { ...existing, ...updates }
    newMap.set(id, updated)
    const session = get().activeQuestSession
    if (session) {
      set({ questSubagents: newMap, activeQuestSession: { ...session, subagents: session.subagents.map(s => s.id === id ? updated : s) } })
    } else {
      set({ questSubagents: newMap })
    }
  },

  collectSubagentResults: () => {
    const session = get().activeQuestSession
    if (!session) return []
    const results: ExplorationResult[] = []
    for (const agent of session.subagents) {
      if (agent.status === 'completed' && agent.result) {
        results.push({ source: 'codebase', query: agent.task, summary: agent.result.slice(0, 500), details: [], timestamp: agent.completedAt || Date.now() })
      }
    }
    return results
  },

  confirmQuestPlan: () => {
    const session = get().activeQuestSession
    if (!session || !session.proposedPlan) return
    set({ activeQuestSession: { ...session, phase: 'executing' } })
    
    // 创建任务条目以便在 TaskHouse 中显示
    const execId = `quest-${session.id}`
    const fullState = get() as any
    fullState.addActiveExecution?.({
      id: execId,
      title: session.proposedPlan.title || session.userGoal.slice(0, 50),
      description: session.userGoal,
      status: 'executing',
      priority: 'high',
      timestamp: new Date().toISOString(),
      executionSteps: [],
    })
    
    const execStartTime = Date.now()
    
    // 异步执行确认后的计划（不阻塞 UI）
    localClawService.executeConfirmedQuestPlan(session, (step) => {
      // 将执行步骤追加到 TaskHouse
      fullState.appendExecutionStep?.(execId, step)
    }).then(result => {
      const execDuration = Date.now() - execStartTime
      get().completeQuestSession(result)
      
      // 更新任务状态为完成
      fullState.updateActiveExecution?.(execId, {
        status: 'done',
        executionOutput: result,
        executionDuration: execDuration,
      })
      
      // 添加最终结果消息到聊天
      get()._addMessageToActiveConv({
        id: `quest-result-${Date.now()}`,
        role: 'assistant',
        content: result,
        timestamp: Date.now(),
      })
    }).catch((err: any) => {
      const execDuration = Date.now() - execStartTime
      get().completeQuestSession(`执行失败: ${err.message}`)
      
      // 更新任务状态为失败
      fullState.updateActiveExecution?.(execId, {
        status: 'failed',
        executionOutput: `执行失败: ${err.message}`,
        executionDuration: execDuration,
      })
      
      get()._addMessageToActiveConv({
        id: `quest-error-${Date.now()}`,
        role: 'assistant',
        content: `Quest 执行失败: ${err.message}`,
        timestamp: Date.now(),
        error: true,
      })
    })
  },

  cancelQuestSession: () => {
    set({ activeQuestSession: null, questSubagents: new Map() })
  },

  appendToQuestContext: (entry) => {
    const session = get().activeQuestSession
    if (!session) return
    const newContext = [...session.accumulatedContext, entry].slice(-50)
    set({ activeQuestSession: { ...session, accumulatedContext: newContext } })
  },

  completeQuestSession: (result) => {
    const session = get().activeQuestSession
    if (!session) return
    set({ activeQuestSession: { ...session, phase: 'completed', finalResult: result, completedAt: Date.now() } })
  },

  // 从后端加载数据 (应用启动后调用)
  // 合并三个数据源: 当前 store(初始化时从 localStorage 加载) + 后端 + localStorage
  loadConversationsFromServer: async () => {
    try {
      // 1. 当前 store 数据 (初始化时已从 localStorage/旧格式迁移加载)
      const storeConversations = get().conversations
      const storeActiveId = get().activeConversationId
      
      // 2. 读取后端数据
      const serverConversations = await localServerService.getData<Conversation[]>(DATA_KEYS.CONVERSATIONS)
      const serverActiveId = await localServerService.getData<string>(DATA_KEYS.ACTIVE_CONVERSATION)
      
      // 3. 读取 localStorage 数据 (可能有其他 tab 写入的新数据)
      const localConversations = loadConversationsFromLocalStorage()
      const localActiveId = loadActiveConversationId()
      
      // 4. 合并三方数据 (以 updatedAt 最新者为准)
      const mergedMap = new Map<string, Conversation>()
      
      // 先添加当前 store 数据 (包含从旧格式迁移的数据)
      for (const [id, conv] of storeConversations) {
        mergedMap.set(id, conv)
      }
      
      // 再合并 localStorage 数据 (如果更新)
      for (const [id, localConv] of localConversations) {
        const existing = mergedMap.get(id)
        if (!existing || localConv.updatedAt > existing.updatedAt) {
          mergedMap.set(id, localConv)
        }
      }
      
      // 最后合并后端数据 (如果更新)
      if (serverConversations && serverConversations.length > 0) {
        for (const serverConv of serverConversations) {
          const existing = mergedMap.get(serverConv.id)
          if (!existing || serverConv.updatedAt >= existing.updatedAt) {
            mergedMap.set(serverConv.id, serverConv)
          }
        }
      }
      
      // 确定活跃会话 ID (优先: 后端 > localStorage > store > 第一个)
      const activeId = serverActiveId || localActiveId || storeActiveId || 
        (mergedMap.size > 0 ? [...mergedMap.keys()][0] : null)
      
      if (mergedMap.size > 0) {
        set({ 
          conversations: mergedMap, 
          activeConversationId: activeId 
        })
        
        // 5. 双写同步 (确保浏览器数据也推送到后端)
        const mergedArray = [...mergedMap.values()]
        localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(mergedArray))
        localServerService.setData(DATA_KEYS.CONVERSATIONS, mergedArray).catch(() => {})
        
        if (activeId) {
          localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, activeId)
          localServerService.setData(DATA_KEYS.ACTIVE_CONVERSATION, activeId).catch(() => {})
        }
        
        console.log('[AI] Merged conversations from 3 sources:',
          'store=' + storeConversations.size,
          'localStorage=' + localConversations.size,
          'server=' + (serverConversations?.length || 0),
          '→ total=' + mergedMap.size)
      }
    } catch (error) {
      console.warn('[AI] Failed to load from server, keeping current store data:', error)
      // 失败时确保当前 store 数据推送到后端
      const current = get().conversations
      if (current.size > 0) {
        const arr = [...current.values()]
        localServerService.setData(DATA_KEYS.CONVERSATIONS, arr).catch(() => {})
      }
    }
  },

  // ============================================
  // 会话管理 Actions
  // ============================================
  
  createConversation: (type, options = {}) => {
    const id = type === 'nexus' && options.nexusId 
      ? `nexus-${options.nexusId}` 
      : `${type}-${Date.now()}`
    
    const title = options.title || '新对话'
    
    const conversation: Conversation = {
      id,
      type,
      title,
      nexusId: options.nexusId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(id, conversation)
      return { 
        conversations: newConversations, 
        activeConversationId: id 
      }
    })
    
    persistConversations(get().conversations)
    persistActiveConversationId(id)
    
    return id
  },
  
  switchConversation: (id) => {
    const conversations = get().conversations
    if (conversations.has(id)) {
      set({ activeConversationId: id })
      persistActiveConversationId(id)
    }
  },
  
  deleteConversation: (id) => {
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.delete(id)
      
      // 如果删除的是当前会话，切换到第一个会话
      let newActiveId = state.activeConversationId
      if (newActiveId === id) {
        newActiveId = newConversations.size > 0 ? [...newConversations.keys()][0] : null
      }
      
      return { 
        conversations: newConversations, 
        activeConversationId: newActiveId 
      }
    })
    
    persistConversations(get().conversations)
    persistActiveConversationId(get().activeConversationId)
  },
  
  renameConversation: (id, title) => {
    set((state) => {
      const conv = state.conversations.get(id)
      if (!conv) return state
      
      const newConversations = new Map(state.conversations)
      newConversations.set(id, { ...conv, title, updatedAt: Date.now() })
      return { conversations: newConversations }
    })
    
    persistConversations(get().conversations)
  },
  
  getOrCreateNexusConversation: (nexusId) => {
    const conversations = get().conversations
    
    // 查找已存在的 Nexus 会话
    for (const [id, conv] of conversations) {
      if (conv.type === 'nexus' && conv.nexusId === nexusId) {
        set({ activeConversationId: id })
        persistActiveConversationId(id)
        return id
      }
    }
    
    // 创建新的 Nexus 会话
    // 尝试获取 Nexus 名称
    let nexusTitle = `Nexus-${nexusId.slice(-6)}`
    try {
      const fullState = get() as any
      const nexus = fullState.nexuses?.get?.(nexusId)
      if (nexus?.label) {
        nexusTitle = nexus.label
      }
    } catch {}
    
    return get().createConversation('nexus', { nexusId, title: nexusTitle })
  },
  
  createNewNexusConversation: (nexusId) => {
    // 强制创建新的 Nexus 会话（使用唯一 ID，不覆盖旧会话）
    let nexusTitle = `Nexus-${nexusId.slice(-6)}`
    try {
      const fullState = get() as any
      const nexus = fullState.nexuses?.get?.(nexusId)
      if (nexus?.label) {
        nexusTitle = `${nexus.label} #${Date.now().toString(36).slice(-4)}`
      }
    } catch {}
    
    // 生成唯一 ID（不使用固定的 nexus-{nexusId} 格式）
    const uniqueId = `nexus-${nexusId}-${Date.now()}`
    
    const conversation: Conversation = {
      id: uniqueId,
      type: 'nexus',
      title: nexusTitle,
      nexusId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(uniqueId, conversation)
      return { 
        conversations: newConversations, 
        activeConversationId: uniqueId 
      }
    })
    
    persistConversations(get().conversations)
    persistActiveConversationId(uniqueId)
    
    return uniqueId
  },
  
  getCurrentMessages: () => {
    const { conversations, activeConversationId } = get()
    if (!activeConversationId) return []
    return conversations.get(activeConversationId)?.messages || []
  },

  // 内部辅助：向当前会话添加消息
  _addMessageToActiveConv: (msg: ChatMessage) => {
    const { conversations, activeConversationId } = get()
    if (!activeConversationId) {
      // 如果没有活跃会话，创建一个
      const newId = get().createConversation('general')
      const conv = get().conversations.get(newId)!
      const updated = { 
        ...conv, 
        messages: [...conv.messages, msg].slice(-MAX_MESSAGES_PER_CONV),
        updatedAt: Date.now()
      }
      set((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set(newId, updated)
        return { conversations: newConversations }
      })
    } else {
      const conv = conversations.get(activeConversationId)
      if (!conv) return
      const updated = { 
        ...conv, 
        messages: [...conv.messages, msg].slice(-MAX_MESSAGES_PER_CONV),
        updatedAt: Date.now()
      }
      set((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set(activeConversationId, updated)
        return { conversations: newConversations }
      })
    }
    persistConversations(get().conversations)

    // 自动标题生成: 第一条用户消息触发
    if (msg.role === 'user') {
      const activeId = get().activeConversationId
      if (activeId) {
        const conv = get().conversations.get(activeId)
        if (conv && !conv.autoTitled && (conv.title === '新对话' || conv.title.startsWith('Nexus-'))) {
          generateConversationTitle(activeId, msg.content, get, set)
        }
      }
    }
  },
  _updateMessageInActiveConv: (msgId: string, updates: Partial<ChatMessage>) => {
    const { conversations, activeConversationId } = get()
    if (!activeConversationId) return
    const conv = conversations.get(activeConversationId)
    if (!conv) return
    
    const updated = {
      ...conv,
      messages: conv.messages.map(m => m.id === msgId ? { ...m, ...updates } : m),
      updatedAt: Date.now()
    }
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(activeConversationId, updated)
      return { conversations: newConversations }
    })
    persistConversations(get().conversations)
  },

  setLlmConfig: (config) => {
    saveLLMConfig(config)
    set((state) => ({
      llmConfig: { ...state.llmConfig, ...config },
    }))
  },

  setLlmConnected: (connected) => set({ llmConnected: connected }),

  getSummary: (view) => {
    return get().summaries[view] || emptySummary()
  },

  generateSummary: async (view) => {
    if (!isLLMConfigured()) return

    const current = get().summaries[view]
    // 缓存未过期则跳过
    if (current && current.content && !current.error && Date.now() - current.timestamp < SUMMARY_CACHE_MS) {
      return
    }

    // 设置 loading
    set((state) => ({
      summaries: {
        ...state.summaries,
        [view]: { content: '', loading: true, error: null, timestamp: 0 },
      },
    }))

    try {
      // 从 store 获取当前数据 - 使用 get() 获取完整 state
      const state = get() as any
      const storeData = {
        tasks: state.tasks || [],
        skills: state.skills || [],
        memories: state.memories || [],
        soulCoreTruths: state.soulCoreTruths || [],
        soulBoundaries: state.soulBoundaries || [],
        soulVibeStatement: state.soulVibeStatement || '',
        soulRawContent: state.soulRawContent || '',
      }

      const messages = buildSummaryMessages(view, storeData)
      const content = await chat(messages)

      set((state) => ({
        summaries: {
          ...state.summaries,
          [view]: { content, loading: false, error: null, timestamp: Date.now() },
        },
      }))
    } catch (err: any) {
      set((state) => ({
        summaries: {
          ...state.summaries,
          [view]: { content: '', loading: false, error: err.message, timestamp: 0 },
        },
      }))
    }
  },

  clearSummary: (view) => {
    set((state) => ({
      summaries: {
        ...state.summaries,
        [view]: emptySummary(),
      },
    }))
  },

  sendChat: async (message, view, hiddenContext?) => {
    if (!isLLMConfigured()) return

    // 确保有活跃会话
    let activeId = get().activeConversationId
    if (!activeId) {
      activeId = get().createConversation('general')
    }

    // 中止之前的请求
    const prevAbort = get()._chatAbort
    if (prevAbort) prevAbort.abort()

    const abortController = new AbortController()

    // 添加用户消息
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
    }

    // 添加到当前会话
    get()._addMessageToActiveConv(userMsg)
    set({
      chatStreaming: true,
      chatStreamContent: '',
      chatError: null,
      chatContext: view,
      _chatAbort: abortController,
    })

    try {
      const state = get() as any
      const connectionMode = state.connectionMode || 'native'
      const connectionStatus = state.connectionStatus || 'disconnected'
      const isNativeConnected = connectionMode === 'native' && connectionStatus === 'connected'

      // ========== Native 模式: 直通 ReAct (跳过前端 LLM) ==========
      if (isNativeConnected) {
        const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const execStartTime = Date.now()
        
        // 1. 创建占位消息 (聊天面板只显示简要状态)
        const placeholderMsg: ChatMessage = {
          id: execId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          execution: { id: execId, status: 'running', timestamp: Date.now() },
        }
        get()._addMessageToActiveConv(placeholderMsg)
        set((s) => ({
          chatStreaming: true,
          chatStreamContent: '',
          executionStatuses: { ...s.executionStatuses, [execId]: placeholderMsg.execution! },
        }))

        // 2. 创建实时任务 (在 TaskHouse 显示，含执行步骤)
        // 注意：Quest 模式下，任务由 sendMessageWithQuestPlan 创建，这里先不创建
        const fullState = get() as any
        
        // 🔧 修复：优先使用当前会话的 nexusId，而非全局 activeNexusId
        const activeConv = fullState.conversations?.get(fullState.activeConversationId)
        const activeNexusId = activeConv?.nexusId || fullState.activeNexusId
        
        // Quest 模式已禁用：所有任务走传统 ReAct 直接执行
        const useQuestMode = false
        
        // 仅在传统模式下预先创建任务
        if (!useQuestMode) {
          fullState.addActiveExecution?.({
            id: execId,
            title: message.slice(0, 50),
            description: message,
            status: 'executing',
            priority: 'high',
            timestamp: new Date().toISOString(),
            executionSteps: [],
          })
        }

        // 2.5. 启动 Nexus 执行状态 (如果有激活的 Nexus)
        if (activeNexusId) {
          fullState.startNexusExecution?.(activeNexusId)
        }

        // 3. 选择执行模式：Quest 模式（有 Nexus 或复杂任务）vs 传统 ReAct 模式
        // Quest 模式触发条件（放宽）：
        // - 消息包含 /quest 命令
        // - 或者有激活的 Nexus（无论消息长度）
        // - 或者消息长度超过 50 字符（可能需要分解任务）
        
        try {
          let result: string
          
          if (useQuestMode) {
            // Quest 模式：交互式规划流程（探索→规划→确认→执行）
            console.log('[AI] Using Interactive Quest mode')
            
            // 移除 /quest 标记
            const cleanMessage = message.replace(/\/quest\s*/gi, '').trim()
            
            // 启动交互式 Quest（到确认阶段暂停，不自动执行）
            try {
              const session = await localClawService.startInteractiveQuest(
                cleanMessage,
                activeNexusId || undefined,
                (phase) => get().updateQuestPhase(phase),
                (explorationResult) => get().addExplorationResult(explorationResult)
              )
              // session.phase === 'confirming'，UI 渲染 QuestPlanConfirmation
              // 用户点击确认后由 confirmQuestPlan 触发执行
              result = `已生成任务计划「${session.proposedPlan?.title || cleanMessage.slice(0, 30)}」，请在下方确认执行。`
            } catch (questError: any) {
              console.error('[AI] Interactive Quest failed, falling back to direct execution:', questError)
              // 降级：直接执行
              result = await localClawService.sendMessageWithQuestPlan(
                cleanMessage,
                activeNexusId || undefined,
                (step) => {
                  (get() as any).appendExecutionStep?.(execId, step)
                }
              )
            }
          } else {
            // 传统 ReAct 模式 (传入 nexusId 以注入 SOP)

            // 构建对话历史：从当前会话中提取最近的 user/assistant 消息对
            // 排除当前消息(已在 userMsg 中)和占位消息(execution 消息)
            const convForHistory = get().conversations.get(get().activeConversationId || '')
            const chatHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []
            if (convForHistory) {
              // 取倒数第二条之前的消息 (最后两条是当前 userMsg + placeholderMsg)
              const pastMessages = convForHistory.messages.slice(0, -2)
              for (const m of pastMessages) {
                if ((m.role === 'user' || m.role === 'assistant') && m.content && m.content.length > 0 && !m.execution) {
                  chatHistory.push({ role: m.role as 'user' | 'assistant', content: m.content })
                }
              }
            }

            // 构建实际发送给 LLM 的消息（包含隐形上下文）
            const llmMessage = hiddenContext
              ? `${message}\n\n[上下文参考]\n${hiddenContext}`
              : message

            result = await localClawService.sendMessage(
              llmMessage,
              // onUpdate: 仅更新流式内容指示
              (_content) => {
                set({ chatStreamContent: '...' })
              },
              // onStep: 将执行步骤追加到任务屋
              (step) => {
                (get() as any).appendExecutionStep?.(execId, step)
              },
              activeNexusId || undefined,
              // onCheckpoint: 保存断点用于恢复
              (checkpoint) => {
                (get() as any).saveCheckpoint?.(execId, checkpoint)
              },
              abortController.signal,  // 传入 AbortSignal，支持终止
              chatHistory.length > 0 ? chatHistory : undefined  // 传入对话历史
            )
          }

          // 4. 完成 - 聊天面板显示最终结果（普通文本消息）
          const execDuration = Date.now() - execStartTime
          const createdFiles = localClawService.lastCreatedFiles.length > 0
            ? [...localClawService.lastCreatedFiles]
            : undefined
          // 替换占位消息为最终结果（无 execution 卡片，附带创建的文件列表）
          get()._updateMessageInActiveConv(execId, { content: result, execution: undefined, createdFiles })
          set((s) => ({
            chatStreaming: false,
            chatStreamContent: '',
            _chatAbort: null,
            executionStatuses: {
              ...s.executionStatuses,
              [execId]: { id: execId, status: 'success', output: result, timestamp: Date.now() },
            },
          }))
          // 更新任务状态 + 存储执行结果
          fullState.updateActiveExecution?.(execId, {
            status: 'done',
            executionOutput: result,
            executionDuration: execDuration,
          })
          persistExecutionStatuses(get().executionStatuses)

          // 5. 完成 Nexus 执行状态 + 发送 Toast 通知
          const executingNexusId = fullState.executingNexusId
          if (executingNexusId) {
            fullState.completeNexusExecution?.(executingNexusId, {
              status: 'success',
              output: result.slice(0, 200), // 截断避免过长
            })
            // 成功 Toast 通知，点击打开 Nexus 面板
            const nexus = fullState.nexuses?.get(executingNexusId)
            fullState.addToast?.({
              type: 'success',
              title: `${nexus?.label || 'Nexus'} 执行完成`,
              message: '任务已成功完成',
              duration: 6000,
              onClick: () => {
                fullState.selectNexus?.(executingNexusId)
                fullState.openNexusPanel?.()
              },
            })
          }

        } catch (err: any) {
          const execDuration = Date.now() - execStartTime
          const isAborted = abortController.signal.aborted || err.name === 'AbortError'

          if (isAborted) {
            // 用户主动终止 — 不显示为错误
            get()._updateMessageInActiveConv(execId, { content: '任务已被终止。', execution: undefined })
            set((s) => ({
              chatStreaming: false,
              chatStreamContent: '',
              _chatAbort: null,
              executionStatuses: {
                ...s.executionStatuses,
                [execId]: { id: execId, status: 'error', error: '已终止', timestamp: Date.now() },
              },
            }))
            fullState.updateActiveExecution?.(execId, {
              status: 'terminated',
              executionDuration: execDuration,
            })
          } else {
            // 真正的错误
          // 显示错误消息（普通文本，无执行卡片）
          get()._updateMessageInActiveConv(execId, { content: `执行失败: ${err.message}`, error: true, execution: undefined })
          set((s) => ({
            chatStreaming: false,
            chatStreamContent: '',
            _chatAbort: null,
            executionStatuses: {
              ...s.executionStatuses,
              [execId]: { id: execId, status: 'error', error: err.message, timestamp: Date.now() },
            },
          }))
          fullState.updateActiveExecution?.(execId, {
            status: 'done',
            executionError: err.message,
            executionDuration: execDuration,
          })
          }
          persistExecutionStatuses(get().executionStatuses)

          // 完成 Nexus 执行状态 + 发送错误 Toast 通知
          const executingNexusId = fullState.executingNexusId
          if (executingNexusId) {
            fullState.completeNexusExecution?.(executingNexusId, {
              status: 'error',
              error: err.message,
            })
            const nexus = fullState.nexuses?.get(executingNexusId)
            fullState.addToast?.({
              type: 'error',
              title: `${nexus?.label || 'Nexus'} 执行失败`,
              message: err.message.slice(0, 80),
              duration: 8000,
              persistent: true,
              onClick: () => {
                fullState.selectNexus?.(executingNexusId)
                fullState.openNexusPanel?.()
              },
            })
          }
        }

        // Observer 集成：记录用户行为，异步分析会自动触发
        if (fullState.addBehaviorRecord) {
          fullState.addBehaviorRecord({ type: 'chat', content: message })
        }

        return // Native 分支结束，不进入 OpenClaw/前端 LLM 流程
      }

      // ========== OpenClaw / 未连接模式: 保持原有前端 LLM 流程 ==========
      const storeData = {
        tasks: state.tasks || [],
        skills: state.skills || [],
        memories: state.memories || [],
        soulCoreTruths: state.soulCoreTruths || [],
        soulBoundaries: state.soulBoundaries || [],
        soulVibeStatement: state.soulVibeStatement || '',
        soulRawContent: state.soulRawContent || '',
        connectionStatus: state.connectionStatus || 'disconnected',
      }

      const history = get().getCurrentMessages()
      const messages = buildChatMessages(view, storeData, history, message)

      let fullContent = ''

      await streamChat(
        messages,
        (chunk) => {
          fullContent += chunk
          set({ chatStreamContent: fullContent })
        },
        abortController.signal,
      )

      // 流式完成，检测执行命令
      const commands = parseExecutionCommands(fullContent)
      const displayContent = commands.length > 0 ? stripExecutionBlocks(fullContent) : fullContent

      // 添加 assistant 消息
      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: displayContent,
        timestamp: Date.now(),
      }

      get()._addMessageToActiveConv(assistantMsg)
      set({
        chatStreaming: false,
        chatStreamContent: '',
        _chatAbort: null,
      })

      // === Observer 集成：记录行为，异步分析会自动触发 ===
      const fullState = get() as any
      if (fullState.addBehaviorRecord) {
        fullState.addBehaviorRecord({
          type: 'chat',
          content: message,
        })
      }

      // 通过 LocalClawService 执行任务 (Native 模式)
      if (commands.length > 0) {
        // 获取当前会话的 nexusId
        const cmdFullState = get() as any
        const cmdActiveConv = cmdFullState.conversations?.get(cmdFullState.activeConversationId)
        const cmdNexusId = cmdActiveConv?.nexusId || cmdFullState.activeNexusId
        
        for (const cmd of commands) {
          const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          
          // 检查 Native 服务是否可用
          const serverAvailable = await localClawService.checkStatus()
          
          if (!serverAvailable) {
            // 服务不可用，显示任务建议
            const suggestionMsg: ChatMessage = {
              id: execId,
              role: 'assistant',
              content: cmd.prompt,
              timestamp: Date.now(),
              execution: {
                id: execId,
                status: 'suggestion',
                timestamp: Date.now(),
              },
            }
            get()._addMessageToActiveConv(suggestionMsg)
            continue
          }
          
          // 创建执行中状态消息
          const execMsg: ChatMessage = {
            id: execId,
            role: 'assistant',
            content: cmd.prompt,
            timestamp: Date.now(),
            execution: {
              id: execId,
              status: 'running',
              timestamp: Date.now(),
            },
          }
          get()._addMessageToActiveConv(execMsg)
          set((state) => ({
            executionStatuses: { 
              ...state.executionStatuses, 
              [execId]: execMsg.execution! 
            },
          }))
          
          // 使用 LocalClawService ReAct 循环执行任务
          try {
            const result = await localClawService.sendMessage(
              cmd.prompt,
              (content) => {
                // 流式更新输出
                const outputLines = content.split('\n')
                const updatedStatus: ExecutionStatus = {
                  id: execId,
                  status: 'running',
                  output: content,
                  outputLines,
                  timestamp: Date.now(),
                }
                get()._updateMessageInActiveConv(execId, { execution: updatedStatus })
                set((state) => ({
                  executionStatuses: { ...state.executionStatuses, [execId]: updatedStatus },
                }))
              },
              undefined,  // onStep
              cmdNexusId || undefined
            )
            
            // 执行完成
            const finalStatus: ExecutionStatus = {
              id: execId,
              status: 'success',
              output: result,
              outputLines: result.split('\n'),
              timestamp: Date.now(),
            }
            get()._updateMessageInActiveConv(execId, { execution: finalStatus })
            set((state) => ({
              executionStatuses: { ...state.executionStatuses, [execId]: finalStatus },
            }))
            persistExecutionStatuses(get().executionStatuses)
            
          } catch (err: any) {
            // 执行失败
            const errorStatus: ExecutionStatus = {
              id: execId,
              status: 'error',
              error: err.message,
              timestamp: Date.now(),
            }
            get()._updateMessageInActiveConv(execId, { execution: errorStatus })
            set((state) => ({
              executionStatuses: { ...state.executionStatuses, [execId]: errorStatus },
            }))
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // 用户取消，保留已收到的内容
        const partial = get().chatStreamContent
        if (partial) {
          const assistantMsg: ChatMessage = {
            id: `assistant-${Date.now()}`,
            role: 'assistant',
            content: partial + ' [已中断]',
            timestamp: Date.now(),
          }
          get()._addMessageToActiveConv(assistantMsg)
          set({
            chatStreaming: false,
            chatStreamContent: '',
            _chatAbort: null,
          })
        } else {
          set({ chatStreaming: false, chatStreamContent: '', _chatAbort: null })
        }
      } else {
        set({
          chatStreaming: false,
          chatStreamContent: '',
          chatError: err.message,
          _chatAbort: null,
        })
      }
    }
  },

  clearChat: () => {
    const abort = get()._chatAbort
    if (abort) abort.abort()
    
    // 清空当前会话的消息
    const { conversations, activeConversationId } = get()
    if (activeConversationId) {
      const conv = conversations.get(activeConversationId)
      if (conv) {
        const updated = { ...conv, messages: [], updatedAt: Date.now() }
        set((state) => {
          const newConversations = new Map(state.conversations)
          newConversations.set(activeConversationId, updated)
          return { 
            conversations: newConversations,
            chatStreaming: false, 
            chatStreamContent: '', 
            chatError: null, 
            _chatAbort: null, 
            executionStatuses: {} 
          }
        })
        persistConversations(get().conversations)
      }
    }
    localStorage.removeItem(STORAGE_KEYS.EXECUTION_STATUS)
  },

  abortChat: () => {
    const abort = get()._chatAbort
    if (abort) abort.abort()
  },

  setChatContext: (view) => set({ chatContext: view }),

  updateExecutionStatus: (id, updates) => {
    const current = get().executionStatuses[id]
    if (!current) return
    const updated = { ...current, ...updates }
    
    // 更新执行状态
    set((state) => ({
      executionStatuses: { ...state.executionStatuses, [id]: updated },
    }))
    
    // 更新当前会话中的消息
    get()._updateMessageInActiveConv(id, { execution: updated })
    
    // 持久化
    persistExecutionStatuses(get().executionStatuses)
  },

  // P3: 危险操作审批
  pendingApproval: null,

  requestApproval: (req) => {
    return new Promise((resolve) => {
      const approvalRequest = {
        ...req,
        id: `approval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        resolve, // 存储 Promise 的 resolver
      }
      set({ pendingApproval: approvalRequest })

      // 60秒超时自动拒绝
      setTimeout(() => {
        const current = get().pendingApproval
        if (current && current.id === approvalRequest.id) {
          console.log('[Approval] Auto-reject due to timeout')
          set({ pendingApproval: null })
          resolve(false)
        }
      }, 60000)
    })
  },

  respondToApproval: (approved) => {
    const pending = get().pendingApproval
    if (pending) {
      pending.resolve(approved)
      set({ pendingApproval: null })
      console.log(`[Approval] User ${approved ? 'approved' : 'rejected'} operation: ${pending.toolName}`)
    }
  },

  // ============================================
  // 冒险日志生成
  // ============================================
  generateJournal: async (memories) => {
    if (!isLLMConfigured() || memories.length === 0) return

    const fullState = get() as any
    // 避免重复生成
    if (fullState.journalLoading) return
    fullState.setJournalLoading?.(true)

    try {
      // 按日期分组
      const groups = new Map<string, MemoryEntry[]>()
      for (const mem of memories) {
        const date = (() => {
          try {
            const d = new Date(mem.timestamp)
            return isNaN(d.getTime()) ? 'unknown' : d.toLocaleDateString('sv-SE')
          } catch { return 'unknown' }
        })()
        if (date === 'unknown') continue
        if (!groups.has(date)) groups.set(date, [])
        groups.get(date)!.push(mem)
      }

      // 检查 localStorage 缓存
      const CACHE_KEY = 'ddos_journal_entries'
      let cached: JournalEntry[] = []
      try {
        const raw = localStorage.getItem(CACHE_KEY)
        if (raw) cached = JSON.parse(raw)
      } catch {}

      const cachedDates = new Set(cached.map(e => e.date))
      const entries: JournalEntry[] = [...cached]
      const newDates = Array.from(groups.keys()).filter(d => !cachedDates.has(d))

      // 只生成缺失的日期（最多 5 天，避免 API 过载）
      const datesToGenerate = newDates.slice(-5)

      for (const date of datesToGenerate) {
        const dayMemories = groups.get(date)!
        try {
          const messages = buildJournalPrompt(date, dayMemories)
          const response = await chat(messages)
          const result = parseJournalResult(response)

          entries.push({
            id: `journal-${date}`,
            date,
            title: result.title,
            narrative: result.narrative,
            mood: result.mood,
            keyFacts: result.keyFacts,
            memoryCount: dayMemories.length,
            generatedAt: Date.now(),
          })
        } catch (err) {
          console.warn(`[Journal] Failed to generate for ${date}:`, err)
        }
      }

      // 按日期排序（最新在前）
      entries.sort((a, b) => b.date.localeCompare(a.date))

      // 持久化到 localStorage
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, 30)))
      } catch {}

      fullState.setJournalEntries?.(entries)
    } catch (err) {
      console.error('[Journal] Generation failed:', err)
    } finally {
      fullState.setJournalLoading?.(false)
    }
  },

  // ============================================
  // 静默日志生成 (每日自动触发)
  // ============================================
  generateSilentJournal: async () => {
    const fullState = get() as any

    // 1. 从 localStorage 加载缓存的日志条目
    const CACHE_KEY = 'ddos_journal_entries'
    let cached: JournalEntry[] = []
    try {
      const raw = localStorage.getItem(CACHE_KEY)
      if (raw) cached = JSON.parse(raw)
    } catch {}

    // 如果 state 中没有条目但缓存中有，先同步缓存
    if (cached.length > 0 && (fullState.journalEntries || []).length === 0) {
      fullState.setJournalEntries?.(cached)
    }

    // 2. 检查今天的日志是否已存在
    const today = new Date().toLocaleDateString('sv-SE')
    const existingEntries: JournalEntry[] = cached.length > 0 ? cached : (fullState.journalEntries || [])
    if (existingEntries.some((e: JournalEntry) => e.date === today)) {
      return // 今天已有日志
    }

    // 3. 检查生成条件
    if (!isLLMConfigured()) return
    if (fullState.journalLoading) return

    // 4. 收集今天的对话记录 (从当前会话获取)
    const currentMessages: ChatMessage[] = get().getCurrentMessages()
    const memories: MemoryEntry[] = fullState.memories || []
    
    // 过滤今天的聊天记录
    const todayChats = currentMessages.filter((m: ChatMessage) => {
      if (m.role === 'system') return false
      try {
        return new Date(m.timestamp).toLocaleDateString('sv-SE') === today
      } catch { return false }
    })
    
    // 如果有今天的聊天记录，转换为 MemoryEntry 格式
    let todayMemories: MemoryEntry[] = []
    if (todayChats.length >= 2) {
      todayMemories = todayChats.map((m: ChatMessage) => ({
        id: m.id,
        title: m.role === 'user' ? '用户消息' : 'AI 回复',
        content: m.content.slice(0, 500),
        type: 'short-term' as const,
        timestamp: new Date(m.timestamp).toISOString(),
        role: m.role as 'user' | 'assistant',
        tags: [],
      }))
    } else {
      // 回退：使用 memories 中今天的记录
      todayMemories = memories.filter((m: MemoryEntry) => {
        try {
          return new Date(m.timestamp).toLocaleDateString('sv-SE') === today
        } catch { return false }
      })
    }
    
    if (todayMemories.length < 2) return // 至少需要 2 条记录

    // 5. 静默生成
    fullState.setJournalLoading?.(true)
    try {
      const messages = buildJournalPrompt(today, todayMemories)
      const response = await chat(messages)
      const result = parseJournalResult(response)

      const newEntry: JournalEntry = {
        id: `journal-${today}`,
        date: today,
        title: result.title,
        narrative: result.narrative,
        mood: result.mood,
        keyFacts: result.keyFacts,
        memoryCount: todayMemories.length,
        generatedAt: Date.now(),
      }

      const updatedEntries = [...cached.filter((e: JournalEntry) => e.date !== today), newEntry]
      updatedEntries.sort((a: JournalEntry, b: JournalEntry) => b.date.localeCompare(a.date))

      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(updatedEntries.slice(0, 30)))
      } catch {}

      fullState.setJournalEntries?.(updatedEntries)
    } catch (err) {
      console.warn('[Journal] Silent generation failed:', err)
    } finally {
      fullState.setJournalLoading?.(false)
    }
  },
})
