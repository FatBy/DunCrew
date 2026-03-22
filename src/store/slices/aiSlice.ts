import type { StateCreator } from 'zustand'
import type { ChatMessage, AISummary, LLMConfig, ViewType, ExecutionStatus, ApprovalRequest, MemoryEntry, JournalEntry, Conversation, ConversationMeta, ConversationType, Session } from '@/types'
import { getLLMConfig, saveLLMConfig, isLLMConfigured, streamChat, chat } from '@/services/llmService'
import { buildSummaryMessages, buildChatMessages, parseExecutionCommands, stripExecutionBlocks, buildJournalPrompt, parseJournalResult } from '@/services/contextBuilder'
import { localClawService } from '@/services/LocalClawService'
import { openClawService } from '@/services/OpenClawService'
import { localServerService } from '@/services/localServerService'

// 摘要缓存时间 (5分钟)
const SUMMARY_CACHE_MS = 5 * 60 * 1000

// localStorage 缓存最近 N 个完整对话（快速恢复用）
const LOCAL_CACHE_COUNT = 5

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
    const conv = get().conversations.get(convId)
    if (conv) persistSingleConversation(conv, get().conversations)
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
  CONVERSATIONS: 'duncrew_conversations_v2',
  ACTIVE_CONVERSATION: 'duncrew_active_conv_id',
  EXECUTION_STATUS: 'duncrew_execution_status',
  // 旧键名 (用于迁移)
  LEGACY_CHAT_HISTORY: 'duncrew_chat_history',
  LEGACY_NEXUS_CHAT_MAP: 'duncrew_nexus_chat_map',
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
    // localStorage 缓存最近 LOCAL_CACHE_COUNT 个完整对话（快速恢复用）
    const sorted = [...conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const cached = sorted.slice(0, LOCAL_CACHE_COUNT)
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(cached))
    
    // 异步写入后端：每个对话独立文件 + 更新元数据列表
    const metaList: ConversationMeta[] = sorted.map(conv => ({
      id: conv.id,
      type: conv.type,
      title: conv.title,
      nexusId: conv.nexusId,
      messageCount: conv.messages.length,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      pinned: conv.pinned,
      autoTitled: conv.autoTitled,
    }))
    localServerService.setData('conversations_meta', metaList).catch(() => {})
    
    // 写入每个对话的完整数据
    for (const conv of sorted) {
      localServerService.setData(`conv_${conv.id}`, conv).catch(() => {})
    }
  } catch (e) {
    console.warn('[AI] Failed to persist conversations:', e)
  }
}

// 保存单个对话（增量写入，用于消息添加时的高效持久化）
let _persistSingleTimer: ReturnType<typeof setTimeout> | null = null
function persistSingleConversation(conv: Conversation, allConversations: Map<string, Conversation>) {
  // 写入单个对话文件
  localServerService.setData(`conv_${conv.id}`, conv).catch(() => {})
  
  // 防抖更新元数据列表 (1s)
  if (_persistSingleTimer) clearTimeout(_persistSingleTimer)
  _persistSingleTimer = setTimeout(() => {
    const sorted = [...allConversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const metaList: ConversationMeta[] = sorted.map(c => ({
      id: c.id, type: c.type, title: c.title, nexusId: c.nexusId,
      messageCount: c.messages.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
      pinned: c.pinned, autoTitled: c.autoTitled,
    }))
    localServerService.setData('conversations_meta', metaList).catch(() => {})
    
    // 更新 localStorage 缓存
    const cached = sorted.slice(0, LOCAL_CACHE_COUNT)
    try { localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(cached)) } catch {}
  }, 1000)
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
  // 懒加载单个对话的消息
  loadConversationMessages: (id: string) => Promise<void>
  // 将 Gateway sessions 的完成结果回填到 DunCrew 对话
  syncGatewaySessionsToConversations: (sessions: Session[]) => void


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


  // 从后端加载数据 (应用启动后调用)
  // 新架构: 先加载元数据列表，消息按需懒加载
  loadConversationsFromServer: async () => {
    try {
      // 1. 当前 store 数据 (初始化时已从 localStorage/旧格式迁移加载)
      const storeConversations = get().conversations
      const storeActiveId = get().activeConversationId
      
      // 2. 尝试从后端加载新格式元数据
      const serverMeta = await localServerService.getConversationMetaList()
      const serverActiveId = await localServerService.getData<string>(DATA_KEYS.ACTIVE_CONVERSATION)
      
      // 3. 读取 localStorage 缓存数据
      const localConversations = loadConversationsFromLocalStorage()
      const localActiveId = loadActiveConversationId()
      
      // 4. 检查是否需要从旧 blob 格式迁移
      if (serverMeta.length === 0) {
        // 尝试读取旧格式 blob
        const oldBlob = await localServerService.getData<Conversation[]>(DATA_KEYS.CONVERSATIONS)
        if (oldBlob && oldBlob.length > 0) {
          console.log('[AI] Migrating', oldBlob.length, 'conversations from blob to per-file storage...')
          // 迁移：拆分写入每个对话文件 + 元数据列表
          for (const conv of oldBlob) {
            await localServerService.saveConversation({ ...conv, messagesLoaded: true })
          }
          // 删除旧 blob
          await localServerService.deleteData(DATA_KEYS.CONVERSATIONS)
          console.log('[AI] Migration complete')
          
          // 合并旧 blob 数据到 store
          const mergedMap = new Map<string, Conversation>(storeConversations)
          for (const conv of oldBlob) {
            const existing = mergedMap.get(conv.id)
            if (!existing || conv.updatedAt >= existing.updatedAt) {
              mergedMap.set(conv.id, { ...conv, messagesLoaded: true })
            }
          }
          // 合并 localStorage 缓存
          for (const [id, localConv] of localConversations) {
            const existing = mergedMap.get(id)
            if (!existing || localConv.updatedAt > existing.updatedAt) {
              mergedMap.set(id, { ...localConv, messagesLoaded: true })
            }
          }
          const activeId = serverActiveId || localActiveId || storeActiveId ||
            (mergedMap.size > 0 ? [...mergedMap.keys()][0] : null)
          set({ conversations: mergedMap, activeConversationId: activeId })
          if (activeId) persistActiveConversationId(activeId)
          return
        }
      }
      
      // 5. 正常加载：用元数据构建对话 Map（消息懒加载）
      const mergedMap = new Map<string, Conversation>()
      
      // 先加载 store 中已有的数据（含完整消息）
      for (const [id, conv] of storeConversations) {
        mergedMap.set(id, { ...conv, messagesLoaded: true })
      }
      
      // 合并 localStorage 缓存（含完整消息）
      for (const [id, localConv] of localConversations) {
        const existing = mergedMap.get(id)
        if (!existing || localConv.updatedAt > existing.updatedAt) {
          mergedMap.set(id, { ...localConv, messagesLoaded: true })
        }
      }
      
      // 合并后端元数据（仅元数据，消息标记为未加载）
      for (const meta of serverMeta) {
        const existing = mergedMap.get(meta.id)
        if (!existing) {
          // 后端有但本地没有：创建空壳，消息待加载
          mergedMap.set(meta.id, {
            id: meta.id,
            type: meta.type,
            title: meta.title,
            nexusId: meta.nexusId,
            messages: [],
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
            pinned: meta.pinned,
            autoTitled: meta.autoTitled,
            messagesLoaded: false,
          })
        } else if (meta.updatedAt > existing.updatedAt) {
          // 后端更新：保留元数据但标记消息需重新加载
          mergedMap.set(meta.id, {
            ...existing,
            title: meta.title,
            updatedAt: meta.updatedAt,
            pinned: meta.pinned,
            autoTitled: meta.autoTitled,
            messagesLoaded: false,
          })
        }
      }
      
      const activeId = serverActiveId || localActiveId || storeActiveId || 
        (mergedMap.size > 0 ? [...mergedMap.keys()][0] : null)
      
      if (mergedMap.size > 0) {
        set({ 
          conversations: mergedMap, 
          activeConversationId: activeId 
        })
        
        if (activeId) {
          localStorage.setItem(STORAGE_KEYS.ACTIVE_CONVERSATION, activeId)
          localServerService.setData(DATA_KEYS.ACTIVE_CONVERSATION, activeId).catch(() => {})
          // 懒加载当前活跃对话的消息
          get().loadConversationMessages(activeId)
        }
        
        console.log('[AI] Loaded conversations:',
          'store=' + storeConversations.size,
          'localStorage=' + localConversations.size,
          'serverMeta=' + serverMeta.length,
          '→ total=' + mergedMap.size)
      }
    } catch (error) {
      console.warn('[AI] Failed to load from server, keeping current store data:', error)
    }
  },
  
  // 懒加载单个对话的消息
  loadConversationMessages: async (id: string) => {
    const conv = get().conversations.get(id)
    if (!conv || conv.messagesLoaded) return
    
    const fullConv = await localServerService.getConversation(id)
    if (fullConv) {
      set((state) => {
        const current = state.conversations.get(id)
        if (!current || current.messagesLoaded) return state
        const newConversations = new Map(state.conversations)
        newConversations.set(id, { 
          ...current, 
          messages: fullConv.messages || [],
          messagesLoaded: true,
        })
        return { conversations: newConversations }
      })
    } else {
      // 后端无数据，标记为已加载（空消息）
      set((state) => {
        const current = state.conversations.get(id)
        if (!current) return state
        const newConversations = new Map(state.conversations)
        newConversations.set(id, { ...current, messagesLoaded: true })
        return { conversations: newConversations }
      })
    }
  },

  // 将 Gateway sessions 的完成结果回填到 DunCrew 对话
  syncGatewaySessionsToConversations: (sessions: Session[]) => {
    if (sessions.length === 0) return
    
    const conversations = get().conversations
    if (conversations.size === 0) return
    
    // 建立 sessionKey → Session 的快速查找表
    const sessionMap = new Map<string, Session>()
    for (const s of sessions) {
      sessionMap.set(s.key, s)
    }
    
    let changed = false
    const newConversations = new Map(conversations)
    
    for (const [convId, conv] of conversations) {
      const sessionKey = conv.openClawSessionKey
      if (!sessionKey) continue
      
      const gatewaySession = sessionMap.get(sessionKey)
      if (!gatewaySession?.lastMessage) continue
      if (gatewaySession.lastMessage.role !== 'assistant') continue
      
      const lastMsg = gatewaySession.lastMessage
      if (!lastMsg.content || lastMsg.content.trim() === '') continue
      
      // 检查对话中是否有空的 assistant 占位消息（流式中断场景）
      const messages = [...conv.messages]
      let lastAssistantIdx = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant') {
          lastAssistantIdx = i
          break
        }
      }
      
      if (lastAssistantIdx >= 0 && messages[lastAssistantIdx].content === '') {
        // 场景 1: 流式中断 — 占位消息内容为空，用 Gateway 结果填充
        messages[lastAssistantIdx] = {
          ...messages[lastAssistantIdx],
          content: lastMsg.content,
        }
        newConversations.set(convId, {
          ...conv,
          messages,
          updatedAt: lastMsg.timestamp || Date.now(),
        })
        changed = true
        console.log('[AI] Synced interrupted session result to conversation:', convId)
      } else if (lastAssistantIdx < 0 || 
                 (conv.messages.length > 0 && 
                  conv.messages[conv.messages.length - 1].role === 'user')) {
        // 场景 2: 对话最后一条是 user 消息，说明 assistant 回复完全丢失
        messages.push({
          id: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: lastMsg.content,
          timestamp: lastMsg.timestamp || Date.now(),
        })
        newConversations.set(convId, {
          ...conv,
          messages,
          updatedAt: lastMsg.timestamp || Date.now(),
        })
        changed = true
        console.log('[AI] Synced missing session result to conversation:', convId)
      }
    }
    
    if (changed) {
      set({ conversations: newConversations })
      persistConversations(newConversations)
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
      messagesLoaded: true,
    }
    
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(id, conversation)
      return { 
        conversations: newConversations, 
        activeConversationId: id 
      }
    })
    
    persistSingleConversation(conversation, get().conversations)
    persistActiveConversationId(id)
    
    return id
  },
  
  switchConversation: (id) => {
    const conversations = get().conversations
    if (conversations.has(id)) {
      set({ activeConversationId: id })
      persistActiveConversationId(id)
      // 触发懒加载（如果消息尚未加载）
      get().loadConversationMessages(id)
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
    
    // 从后端删除对话文件
    localServerService.deleteConversation(id).catch(() => {})
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
    
    const conv = get().conversations.get(id)
    if (conv) persistSingleConversation(conv, get().conversations)
  },
  
  getOrCreateNexusConversation: (nexusId) => {
    const conversations = get().conversations
    
    // 查找已存在的 Nexus 会话
    for (const [id, conv] of conversations) {
      if (conv.type === 'nexus' && conv.nexusId === nexusId) {
        set({ activeConversationId: id })
        persistActiveConversationId(id)
        get().loadConversationMessages(id)
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
      messagesLoaded: true,
    }
    
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(uniqueId, conversation)
      return { 
        conversations: newConversations, 
        activeConversationId: uniqueId 
      }
    })
    
    persistSingleConversation(conversation, get().conversations)
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
        messages: [...conv.messages, msg],
        updatedAt: Date.now()
      }
      set((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set(newId, updated)
        return { conversations: newConversations }
      })
      persistSingleConversation(updated, get().conversations)
    } else {
      const conv = conversations.get(activeConversationId)
      if (!conv) return
      const updated = { 
        ...conv, 
        messages: [...conv.messages, msg],
        updatedAt: Date.now()
      }
      set((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set(activeConversationId, updated)
        return { conversations: newConversations }
      })
      persistSingleConversation(updated, get().conversations)
    }

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
    persistSingleConversation(updated, get().conversations)
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
    // isLLMConfigured 检查下移到前端 LLM fallback 分支
    // Native 模式由 LocalClawService 内部检查, OpenClaw 模式由 Gateway 处理 LLM

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

      console.log('[sendChat] connectionMode:', connectionMode, 'connectionStatus:', connectionStatus)

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
        persistExecutionStatuses(get().executionStatuses)

        // 2. 创建实时任务 (在 TaskHouse 显示，含执行步骤)
        const fullState = get() as any
        
        // 🔧 修复：优先使用当前会话的 nexusId，而非全局 activeNexusId
        const activeConv = fullState.conversations?.get(fullState.activeConversationId)
        const activeNexusId = activeConv?.nexusId || fullState.activeNexusId
        
        fullState.addActiveExecution?.({
          id: execId,
          title: message.slice(0, 50),
          description: message,
          status: 'executing',
          priority: 'high',
          timestamp: new Date().toISOString(),
          executionSteps: [],
        })

        // 2.5. 启动 Nexus 执行状态 (如果有激活的 Nexus)
        if (activeNexusId) {
          fullState.startNexusExecution?.(activeNexusId)
        }

        // 3. 执行 ReAct 模式
        try {
          let result: string
          
          {
            // ReAct 模式 (传入 nexusId 以注入 SOP)

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
            persistExecutionStatuses(get().executionStatuses)
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

      // ========== OpenClaw 模式: 通过 Gateway chat.send ==========
      const isOpenClawConnected = connectionMode === 'openclaw' && connectionStatus === 'connected'
      if (isOpenClawConnected) {
        const execId = `oc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const idempotencyKey = `duncrew-${execId}`
        const chatTaskId = `oc-chat-${execId}`
        const chatTaskStartedAt = Date.now()

        // 0. 获取当前 Nexus 上下文（与 Native 模式对齐）
        const fullState = get() as any
        const activeConvId: string | undefined = fullState.activeConversationId
        const activeConv = activeConvId ? fullState.conversations?.get(activeConvId) : undefined
        const activeNexusId: string | undefined = activeConv?.nexusId || fullState.activeNexusId || undefined
        let nexusContext = ''
        if (activeNexusId) {
          const nexus = fullState.nexuses?.get(activeNexusId)
          if (nexus) {
            const parts: string[] = ['[Nexus 上下文]']
            if (nexus.label) parts.push(`名称: ${nexus.label}`)
            if (nexus.objective) parts.push(`目标: ${nexus.objective}`)
            if (nexus.metrics && nexus.metrics.length > 0) {
              parts.push(`验收标准:\n${nexus.metrics.map((m: string, i: number) => `  ${i + 1}. ${m}`).join('\n')}`)
            }
            if (nexus.sopContent) parts.push(`流程(SOP):\n${nexus.sopContent}`)
            if (nexus.strategy) parts.push(`失败策略: ${nexus.strategy}`)
            if (nexus.boundSkillIds && nexus.boundSkillIds.length > 0) {
              // 解析绑定技能名称
              const skillNames = nexus.boundSkillIds.map((sid: string) => {
                const skill = fullState.openClawSkills?.find((s: any) => s.name === sid)
                return skill ? `${skill.name}${skill.description ? ` - ${skill.description}` : ''}` : sid
              })
              parts.push(`绑定技能: ${skillNames.join(', ')}`)
            }
            parts.push('---')
            // 输出格式指令：当有多个选择时使用 suggestion 标记
            parts.push('[输出格式] 当你完成任务或需要用户做选择时，如果有多个可选的下一步操作，请用以下格式输出：')
            parts.push('<!-- suggestions -->')
            parts.push('引导语（告诉用户为什么选择）')
            parts.push('- 选项A')
            parts.push('- 选项B')
            parts.push('<!-- /suggestions -->')
            nexusContext = parts.join('\n')
          }
        }

        // 0.5. 创建 TaskItem 到 activeExecutions (任务面板显示)
        fullState.addActiveExecution?.({
          id: chatTaskId,
          title: message.slice(0, 80),
          description: message,
          status: 'executing' as const,
          priority: 'medium' as const,
          timestamp: new Date().toISOString(),
          executionSteps: [],
          startedAt: chatTaskStartedAt,
        })

        // 0.6. 启动 Nexus 执行状态 (如果有激活的 Nexus)
        if (activeNexusId) {
          fullState.startNexusExecution?.(activeNexusId)
        }

        // 1. 创建占位消息
        const placeholderMsg: ChatMessage = {
          id: execId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        }
        get()._addMessageToActiveConv(placeholderMsg)

        try {
          // 2. 获取或创建 OpenClaw 会话 key (同一对话复用，保持上下文连贯)
          let sessionKey = activeConv?.openClawSessionKey || ''
          let isNewSession = false
          if (!sessionKey) {
            sessionKey = openClawService.createChatSession(message.slice(0, 50))
            isNewSession = true
            // 持久化到 Conversation 对象，后续消息复用同一 session
            if (activeConvId) {
              const convs = get().conversations
              const conv = convs.get(activeConvId)
              if (conv) {
                const updated = new Map(convs)
                updated.set(activeConvId, { ...conv, openClawSessionKey: sessionKey })
                set({ conversations: updated })
              }
            }
          }

          // 3. 用 Promise 包装事件驱动的流式响应
          // 注册 listener 用 idempotencyKey (即 Gateway 的 runId，不会被规范化)
          const resultPromise = new Promise<string>((resolve, reject) => {
            let fullContent = ''
            let settled = false

            // 滑动活动超时 (300秒)
            // Agent 任务可能涉及网页抓取/工具调用等耗时操作，
            // 期间 Gateway 不发 chat delta，只在 agent 完成后发 final
            // 每次收到任何活动信号 (agent keep-alive / delta / tool) 都重置
            const ACTIVITY_TIMEOUT = 300000
            let activityTimer = setTimeout(() => {
              if (!settled) {
                settled = true
                openClawService.unsubscribeChatSession(idempotencyKey)
                reject(new Error(`Gateway 响应超时 (300s) [key=${idempotencyKey}]`))
              }
            }, ACTIVITY_TIMEOUT)

            const resetActivityTimer = () => {
              clearTimeout(activityTimer)
              activityTimer = setTimeout(() => {
                if (!settled) {
                  settled = true
                  openClawService.unsubscribeChatSession(idempotencyKey)
                  reject(new Error(`Gateway 响应超时 (300s) [key=${idempotencyKey}]`))
                }
              }, ACTIVITY_TIMEOUT)
            }

            openClawService.subscribeChatSession(idempotencyKey, {
              onDelta: (text, _seq) => {
                resetActivityTimer()
                // 空 delta 是 agent 事件的 keep-alive 信号，不追加到内容
                if (text) {
                  fullContent += text
                  set({ chatStreamContent: fullContent })
                }
              },
              onFinal: (text) => {
                if (!settled) {
                  settled = true
                  clearTimeout(activityTimer)
                  // final 可能包含完整内容，也可能为空 (依赖 delta 累积)
                  resolve(text || fullContent)
                }
              },
              onError: (error) => {
                if (!settled) {
                  settled = true
                  clearTimeout(activityTimer)
                  reject(new Error(error))
                }
              },
              onAborted: () => {
                if (!settled) {
                  settled = true
                  clearTimeout(activityTimer)
                  reject(Object.assign(new Error('已终止'), { name: 'AbortError' }))
                }
              },
            })

            // abort 信号处理：发送 chat.abort 到 Gateway
            abortController.signal.addEventListener('abort', () => {
              clearTimeout(activityTimer)
              openClawService.abortChatSession(sessionKey).catch(() => {})
              // 不在这里 reject —— 等 Gateway 发回 aborted 事件
            }, { once: true })
          })

          // 4. 发送消息 (listener 已就绪，不会丢事件)
          // Nexus 上下文仅在会话首条消息注入，后续消息 Gateway 已有对话历史
          let llmMessage = message
          if (nexusContext && isNewSession) {
            llmMessage = `${nexusContext}\n${llmMessage}`
          }
          if (hiddenContext) {
            llmMessage = `${llmMessage}\n\n[上下文参考]\n${hiddenContext}`
          }
          // 预注册 chat 任务，让 agent 事件复用而非重复创建
          openClawService.registerChatTask(idempotencyKey, chatTaskId, message.slice(0, 80))
          console.log('[aiSlice] Sending chat.send with sessionKey:', sessionKey, 'idempotencyKey:', idempotencyKey)
          await openClawService.sendToSession(sessionKey, llmMessage, idempotencyKey)
          console.log('[aiSlice] chat.send returned, waiting for events...')

          // 5. 等待结果
          const result = await resultPromise

          // 6. 更新占位消息为最终结果
          get()._updateMessageInActiveConv(execId, { content: result })
          set({
            chatStreaming: false,
            chatStreamContent: '',
            _chatAbort: null,
          })

          // 7. 更新 TaskItem 状态为完成
          fullState.updateActiveExecution?.(chatTaskId, {
            status: 'done' as const,
            executionOutput: result.slice(0, 5000),
            executionDuration: Date.now() - chatTaskStartedAt,
          })

          // 8. 完成 Nexus 执行状态
          if (activeNexusId) {
            fullState.completeNexusExecution?.(activeNexusId, {
              success: true,
              output: result.slice(0, 2000),
            })
          }

        } catch (err: any) {
          const isAborted = abortController.signal.aborted || err.name === 'AbortError'
          if (isAborted) {
            const partial = get().chatStreamContent
            get()._updateMessageInActiveConv(execId, {
              content: partial ? partial + ' [已中断]' : '任务已被终止。',
            })
          } else {
            // 将常见 Gateway 错误翻译为更友好的提示
            const rawMsg = err.message || String(err)
            let userMsg = rawMsg
            if (/timed?\s*out/i.test(rawMsg) || /timeout/i.test(rawMsg)) {
              userMsg = `LLM 请求超时 — 请检查: 1) Gateway 配置的模型是否可用 2) API Key 是否有效 3) 网络是否通畅。\n原始错误: ${rawMsg}`
            } else if (/rate.?limit/i.test(rawMsg) || /429/i.test(rawMsg)) {
              userMsg = `LLM 请求被限流 (429) — 请稍后重试或更换模型。\n原始错误: ${rawMsg}`
            } else if (/auth|unauthorized|401|403/i.test(rawMsg)) {
              userMsg = `LLM 认证失败 — 请检查 Gateway 端的 API Key 配置。\n原始错误: ${rawMsg}`
            }
            get()._updateMessageInActiveConv(execId, {
              content: `OpenClaw 执行失败: ${userMsg}`,
              error: true,
            })
          }
          set({
            chatStreaming: false,
            chatStreamContent: '',
            _chatAbort: null,
            ...(isAborted ? {} : { chatError: err.message }),
          })

          // 更新 TaskItem 状态
          fullState.updateActiveExecution?.(chatTaskId, {
            status: isAborted ? 'interrupted' as const : 'terminated' as const,
            executionError: isAborted ? '用户中断' : err.message,
            executionDuration: Date.now() - chatTaskStartedAt,
          })

          // 完成 Nexus 执行状态（失败/中断）
          if (activeNexusId) {
            fullState.completeNexusExecution?.(activeNexusId, {
              success: false,
              output: isAborted ? '用户中断' : err.message,
            })
          }
        }

        // Observer 行为记录
        const ocFullState = get() as any
        if (ocFullState.addBehaviorRecord) {
          ocFullState.addBehaviorRecord({ type: 'chat', content: message })
        }

        return // OpenClaw 分支结束
      }

      // ========== 未连接模式: 前端 LLM 流式 fallback ==========
      if (!isLLMConfigured()) {
        set({ chatStreaming: false, chatStreamContent: '', _chatAbort: null, chatError: '请先在设置中配置 LLM (API Key / Base URL / Model)' })
        return
      }
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
          persistExecutionStatuses(get().executionStatuses)
          
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
            persistExecutionStatuses(get().executionStatuses)
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
        persistSingleConversation(updated, get().conversations)
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
      const CACHE_KEY = 'duncrew_journal_entries'
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
    const CACHE_KEY = 'duncrew_journal_entries'
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
