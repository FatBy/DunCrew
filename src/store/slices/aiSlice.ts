import type { StateCreator } from 'zustand'
import type { ChatMessage, AISummary, LLMConfig, ViewType, ExecutionStatus, ApprovalRequest, MemoryEntry, JournalEntry, Conversation, ConversationMeta, ConversationType } from '@/types'
import { getLLMConfig, saveLLMConfig, isLLMConfigured, streamChat, chat } from '@/services/llmService'
import { buildSummaryMessages, buildChatMessages, parseExecutionCommands, stripExecutionBlocks, buildJournalPrompt, parseJournalResult } from '@/services/contextBuilder'
import { localClawService } from '@/services/LocalClawService'
import { confidenceTracker } from '@/services/confidenceTracker'
import { getCurrentLocale } from '@/i18n/core'
import { localServerService } from '@/services/localServerService'

// 摘要缓存时间 (5分钟)
const SUMMARY_CACHE_MS = 5 * 60 * 1000

// localStorage 缓存最近 N 个完整对话（快速恢复用）
const LOCAL_CACHE_COUNT = 20

// localStorage 缓存时每个对话最多保留的消息数（防止数据量过大写入失败）
const LOCAL_CACHE_MSG_LIMIT = 100

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
  LEGACY_DUN_CHAT_MAP: 'duncrew_dun_chat_map',
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
    const cached = sorted.slice(0, LOCAL_CACHE_COUNT).map(c => ({
      ...c,
      messages: c.messages.slice(-LOCAL_CACHE_MSG_LIMIT),
    }))
    localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(cached))
    
    // 异步写入后端：每个对话独立文件 + 更新元数据列表
    const metaList: ConversationMeta[] = sorted.map(conv => ({
      id: conv.id,
      type: conv.type,
      title: conv.title,
      dunId: conv.dunId,
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
// 使用每会话独立防抖 timer，避免闭包捕获过期数据
const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const _pendingFlushData = new Map<string, Map<string, Conversation>>()

/** 执行元数据刷新（写入 conversations_meta + localStorage 缓存） */
function _executeMetaFlush(allConversations: Map<string, Conversation>) {
  const sorted = [...allConversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  const metaList: ConversationMeta[] = sorted.map(c => ({
    id: c.id, type: c.type, title: c.title, dunId: c.dunId,
    messageCount: c.messages.length, createdAt: c.createdAt, updatedAt: c.updatedAt,
    pinned: c.pinned, autoTitled: c.autoTitled,
  }))
  localServerService.setData('conversations_meta', metaList).catch(() => {})
  
  const cached = sorted.slice(0, LOCAL_CACHE_COUNT).map(c => ({
    ...c,
    messages: c.messages.slice(-LOCAL_CACHE_MSG_LIMIT),
  }))
  try { localStorage.setItem(STORAGE_KEYS.CONVERSATIONS, JSON.stringify(cached)) } catch {}
}

function persistSingleConversation(conv: Conversation, allConversations: Map<string, Conversation>) {
  // 写入单个对话文件
  localServerService.setData(`conv_${conv.id}`, conv).catch(() => {})
  
  // 防抖更新元数据列表 (1s) - 每会话独立 timer
  if (_persistTimers.has(conv.id)) {
    clearTimeout(_persistTimers.get(conv.id)!)
  }
  
  // 保存 allConversations 引用，供 flush 时使用
  _pendingFlushData.set(conv.id, allConversations)
  
  _persistTimers.set(conv.id, setTimeout(() => {
    _executeMetaFlush(allConversations)
    _persistTimers.delete(conv.id)
    _pendingFlushData.delete(conv.id)
  }, 1000))
}

/** 立即刷新所有待执行的防抖持久化（用于 beforeunload 等关闭前场景） */
export function flushPendingPersistence() {
  if (_persistTimers.size === 0) return
  
  let latestConversations: Map<string, Conversation> | null = null
  for (const [, timer] of _persistTimers) {
    clearTimeout(timer)
  }
  for (const [, data] of _pendingFlushData) {
    latestConversations = data
  }
  
  if (latestConversations) {
    _executeMetaFlush(latestConversations)
  }
  
  _persistTimers.clear()
  _pendingFlushData.clear()
}

// loadConversationsFromServer 异常时的重试计数（最多重试 1 次）
let _serverLoadRetryCount = 0

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
    
    // 迁移旧 Dun 聊天记录
    const oldDunMap = localStorage.getItem(STORAGE_KEYS.LEGACY_DUN_CHAT_MAP)
    if (oldDunMap) {
      const dunChats: Record<string, ChatMessage[]> = JSON.parse(oldDunMap)
      for (const [dunId, messages] of Object.entries(dunChats)) {
        if (messages.length > 0) {
          const convId = `dun-${dunId}`
          conversations.set(convId, {
            id: convId,
            type: 'dun',
            title: `Dun-${dunId.slice(-6)}`,
            dunId,
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
      localStorage.removeItem(STORAGE_KEYS.LEGACY_DUN_CHAT_MAP)
      console.log('[AI] Migrated', conversations.size, 'conversations from legacy format')
    }
    
  } catch (e) {
    console.warn('[AI] Migration failed:', e)
  }
  
  return { conversations, activeId }
}

const emptySummary = (): AISummary => ({ content: '', loading: false, error: null, timestamp: 0 })

// 空消息数组常量，避免每次 getCurrentMessages 返回新引用破坏选择器记忆化
const EMPTY_MESSAGES: ChatMessage[] = []

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
  createConversation: (type: ConversationType, options?: { dunId?: string; title?: string }) => string
  switchConversation: (id: string) => void
  deleteConversation: (id: string) => void
  renameConversation: (id: string, title: string) => void
  getOrCreateDunConversation: (dunId: string) => string
  /** 强制创建新的 Dun 会话（每次执行按钮点击时使用） */
  createNewDunConversation: (dunId: string) => string
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

  // 消息操作
  likeMessage: (msgId: string) => void
  regenerateMessage: (msgId: string, view: ViewType) => void

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


  // 内部辅助方法
  _addMessageToActiveConv: (msg: ChatMessage) => void
  _addMessageToConv: (convId: string, msg: ChatMessage) => void
  _updateMessageInActiveConv: (msgId: string, updates: Partial<ChatMessage>) => void
  _updateMessageInConv: (convId: string, msgId: string, updates: Partial<ChatMessage>) => void
  /** 执行ID -> 会话ID 映射，确保异步回调更新正确的会话 */
  _execConvMap: Map<string, string>
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
  _execConvMap: new Map(),

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
      let serverMeta = await localServerService.getConversationMetaList()
      const serverActiveId = await localServerService.getData<string>(DATA_KEYS.ACTIVE_CONVERSATION)
      
      // 3. 读取 localStorage 缓存数据
      const localConversations = loadConversationsFromLocalStorage()
      const localActiveId = loadActiveConversationId()
      
      // 4. 检查是否需要从旧 blob 格式迁移
      if (serverMeta.length === 0) {
        // 如果本地已有数据但后端返回空，可能是后端延迟，重试一次
        if (storeConversations.size > 0 || localConversations.size > 0) {
          console.log('[AI] Server returned empty meta but local has data, retrying in 2s...')
          await new Promise(r => setTimeout(r, 2000))
          serverMeta = await localServerService.getConversationMetaList()
        }
        
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
            dunId: meta.dunId,
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
      // 保留现有 store 数据，安排延迟重试一次
      if (_serverLoadRetryCount < 1) {
        _serverLoadRetryCount++
        console.log('[AI] Scheduling retry in 3s...')
        setTimeout(() => {
          get().loadConversationsFromServer().catch(() => {})
        }, 3000)
      }
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

  // ============================================
  // 会话管理 Actions
  // ============================================
  
  createConversation: (type, options = {}) => {
    const id = type === 'dun' && options.dunId 
      ? `dun-${options.dunId}` 
      : `${type}-${Date.now()}`
    
    const title = options.title || '新对话'
    
    const conversation: Conversation = {
      id,
      type,
      title,
      dunId: options.dunId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messagesLoaded: true,
    }
    
    let capturedConversations: Map<string, Conversation> | undefined
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(id, conversation)
      capturedConversations = newConversations
      return { 
        conversations: newConversations, 
        activeConversationId: id 
      }
    })
    
    persistSingleConversation(conversation, capturedConversations!)
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
    let capturedConv: Conversation | undefined
    let capturedConversations: Map<string, Conversation> | undefined
    set((state) => {
      const conv = state.conversations.get(id)
      if (!conv) return state
        
      const newConversations = new Map(state.conversations)
      const updated = { ...conv, title, updatedAt: Date.now() }
      newConversations.set(id, updated)
      capturedConv = updated
      capturedConversations = newConversations
      return { conversations: newConversations }
    })
  
    if (capturedConv && capturedConversations) {
      persistSingleConversation(capturedConv, capturedConversations)
    }
  },
  
  getOrCreateDunConversation: (dunId) => {
    const conversations = get().conversations
    
    // 查找已存在的 Dun 会话
    for (const [id, conv] of conversations) {
      if (conv.type === 'dun' && conv.dunId === dunId) {
        set({ activeConversationId: id })
        persistActiveConversationId(id)
        get().loadConversationMessages(id)
        return id
      }
    }
    
    // 创建新的 Dun 会话
    // 尝试获取 Dun 名称
    let dunTitle = `Dun-${dunId.slice(-6)}`
    try {
      const fullState = get() as any
      const dun = fullState.duns?.get?.(dunId)
      if (dun?.label) {
        dunTitle = dun.label
      }
    } catch {}
    
    return get().createConversation('dun', { dunId, title: dunTitle })
  },
  
  createNewDunConversation: (dunId) => {
    // 强制创建新的 Dun 会话（使用唯一 ID，不覆盖旧会话）
    let dunTitle = `Dun-${dunId.slice(-6)}`
    try {
      const fullState = get() as any
      const dun = fullState.duns?.get?.(dunId)
      if (dun?.label) {
        dunTitle = `${dun.label} #${Date.now().toString(36).slice(-4)}`
      }
    } catch {}
    
    // 生成唯一 ID（不使用固定的 dun-{dunId} 格式）
    const uniqueId = `dun-${dunId}-${Date.now()}`
    
    const conversation: Conversation = {
      id: uniqueId,
      type: 'dun',
      title: dunTitle,
      dunId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messagesLoaded: true,
    }
    
    let capturedConversations: Map<string, Conversation> | undefined
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(uniqueId, conversation)
      capturedConversations = newConversations
      return { 
        conversations: newConversations, 
        activeConversationId: uniqueId 
      }
    })
  
    persistSingleConversation(conversation, capturedConversations!)
    persistActiveConversationId(uniqueId)
      
    return uniqueId
  },
    
  getCurrentMessages: () => {
    const { conversations, activeConversationId } = get()
    if (!activeConversationId) return EMPTY_MESSAGES
    return conversations.get(activeConversationId)?.messages || EMPTY_MESSAGES
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
        if (conv && !conv.autoTitled && (conv.title === '新对话' || conv.title.startsWith('Dun-'))) {
          generateConversationTitle(activeId, msg.content, get, set)
        }
      }
    }
  },
  // 内部辅助：向指定会话添加消息 (不依赖 activeConversationId)
  _addMessageToConv: (convId: string, msg: ChatMessage) => {
    const conv = get().conversations.get(convId)
    if (!conv) return
    const updated = { 
      ...conv, 
      messages: [...conv.messages, msg],
      updatedAt: Date.now()
    }
    let capturedConversations: Map<string, Conversation> | undefined
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(convId, updated)
      capturedConversations = newConversations
      return { conversations: newConversations }
    })
    if (capturedConversations) {
      persistSingleConversation(updated, capturedConversations)
    }
  },
  _updateMessageInActiveConv: (msgId: string, updates: Partial<ChatMessage>) => {
    const { activeConversationId } = get()
    if (!activeConversationId) return
    get()._updateMessageInConv(activeConversationId, msgId, updates)
  },
  _updateMessageInConv: (convId: string, msgId: string, updates: Partial<ChatMessage>) => {
    const { conversations } = get()
    const conv = conversations.get(convId)
    if (!conv) return
    
    const updated = {
      ...conv,
      messages: conv.messages.map(m => m.id === msgId ? { ...m, ...updates } : m),
      updatedAt: Date.now()
    }
    set((state) => {
      const newConversations = new Map(state.conversations)
      newConversations.set(convId, updated)
      return { conversations: newConversations }
    })
    persistSingleConversation(updated, get().conversations)
  },

  setLlmConfig: (config) => {
    // 1. 写入 localStorage（向后兼容）
    saveLLMConfig(config)
    // 2. 同步更新 aiSlice 的 llmConfig 状态
    set((state) => ({
      llmConfig: { ...state.llmConfig, ...config },
    }))
    // 3. 桥接写入 linkStationSlice（如果 Store 已初始化）
    // 当用户通过旧的 SettingsHouse 或 FirstLaunchSetup 修改配置时，
    // 自动同步到联络站的 Provider + ChannelBindings
    try {
      const fullState = get() as any
      if (fullState.linkStation && fullState.addProvider) {
        const merged = { ...get().llmConfig, ...config }
        const providers = fullState.linkStation.providers as Array<{ id: string; baseUrl: string }>
        // 查找是否已有匹配的 Provider
        const existingProvider = providers.find(
          (p: any) => p.baseUrl === merged.baseUrl || p.id.startsWith('migrated-')
        )
        if (existingProvider) {
          fullState.updateProvider(existingProvider.id, {
            apiKey: merged.apiKey,
            baseUrl: merged.baseUrl,
          })
          if (merged.model) {
            fullState.setChannelBinding('chat', {
              providerId: existingProvider.id,
              modelId: merged.model,
            })
          }
        }
      }
    } catch {
      // linkStationSlice 未就绪，静默忽略
    }
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
      // 从 store 获取当前数据 - 懒加载 useStore 避免循环依赖
      const { useStore } = await import('@/store')
      const state = useStore.getState()
      const storeData = {
        tasks: state.tasks || [],
        skills: state.skills || [],
        memories: state.memories || [],
        soulCoreTruths: state.soulCoreTruths || [],
        soulBoundaries: state.soulBoundaries || [],
        soulVibeStatement: state.soulVibeStatement || '',
        soulRawContent: state.soulRawContent || '',
      }

      const messages = buildSummaryMessages(view, storeData, getCurrentLocale())
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

  likeMessage: (msgId) => {
    const { activeConversationId, conversations } = get()
    if (!activeConversationId) return
    const conv = conversations.get(activeConversationId)
    if (!conv) return
    const msg = conv.messages.find(m => m.id === msgId)
    if (!msg || msg.role !== 'assistant') return

    const newLiked = !msg.liked
    get()._updateMessageInConv(activeConversationId, msgId, { liked: newLiked })

    // 关联 trace 的 L1 记忆条目发送反馈信号
    if (msg.traceId) {
      const activeDunId = conv.dunId || (get() as any).activeDunId || ''
      // 构造与 LocalClawService.lastRunL1Ids 相同格式的 L1 ID
      // trace 保存时 trackedToolResults 使用 `l1-${dunId}-${toolName}`
      // 这里用 traceId 反查最近执行的工具，简化为直接发送 human_feedback
      confidenceTracker.addHumanFeedback(`l1-${activeDunId}-trace-${msg.traceId}`, newLiked)
    }
  },

  regenerateMessage: (msgId, view) => {
    const { activeConversationId, conversations } = get()
    if (!activeConversationId) return
    const conv = conversations.get(activeConversationId)
    if (!conv) return

    // 找到该 assistant 消息之前最近的 user 消息
    const msgIndex = conv.messages.findIndex(m => m.id === msgId)
    if (msgIndex < 0) return
    let userMessage: string | null = null
    for (let i = msgIndex - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user') {
        userMessage = conv.messages[i].content
        break
      }
    }
    if (!userMessage) return

    // 追加新回复（不删除旧回复）
    get().sendChat(userMessage, view)
  },

  sendChat: async (message, view, hiddenContext?) => {
    // isLLMConfigured 检查下移到前端 LLM fallback 分支
    // Native 模式由 LocalClawService 内部检查, OpenClaw 模式由 Gateway 处理 LLM

    // 确保有活跃会话
    let activeId = get().activeConversationId
    if (!activeId) {
      activeId = get().createConversation('general')
    }
    // 捕获发起任务的会话 ID，后续所有更新都绑定到此 ID，避免切换会话后串台
    const originConvId = activeId!

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
    get()._addMessageToConv(originConvId, userMsg)
    // 自动标题生成: 第一条用户消息触发
    {
      const conv = get().conversations.get(originConvId)
      if (conv && !conv.autoTitled && (conv.title === '新对话' || conv.title.startsWith('Dun-'))) {
        generateConversationTitle(originConvId, userMsg.content, get, set)
      }
    }
    set({
      chatStreaming: true,
      chatStreamContent: '',
      chatError: null,
      chatContext: view,
      _chatAbort: abortController,
    })

    try {
      const state = get() as any
      const connectionStatus = state.connectionStatus || 'disconnected'
      const isNativeConnected = connectionStatus === 'connected'

      console.log('[sendChat] connectionStatus:', connectionStatus)

      // ========== Native 模式: 直通 ReAct (跳过前端 LLM) ==========
      if (isNativeConnected) {
        const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        const execStartTime = Date.now()
        // 注册 execId -> convId 映射，供 updateExecutionStatus 使用
        get()._execConvMap.set(execId, originConvId)
        
        // 1. 创建占位消息 (聊天面板只显示简要状态)
        const placeholderMsg: ChatMessage = {
          id: execId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          execution: { id: execId, status: 'running', timestamp: Date.now() },
        }
        get()._addMessageToConv(originConvId, placeholderMsg)
        set((s) => ({
          chatStreaming: true,
          chatStreamContent: '',
          executionStatuses: { ...s.executionStatuses, [execId]: placeholderMsg.execution! },
        }))
        persistExecutionStatuses(get().executionStatuses)

        // 2. 创建实时任务 (在 TaskHouse 显示，含执行步骤)
        const fullState = get() as any
        
        // 🔧 修复：优先使用当前会话的 dunId，而非全局 activeDunId
        const activeConv = fullState.conversations?.get(originConvId)
        const activeDunId = activeConv?.dunId || fullState.activeDunId
        
        fullState.addActiveExecution?.({
          id: execId,
          title: message.slice(0, 50),
          description: message,
          status: 'executing',
          priority: 'high',
          timestamp: new Date().toISOString(),
          executionSteps: [],
        })

        // 2.5. 启动 Dun 执行状态 (如果有激活的 Dun)
        if (activeDunId) {
          fullState.startDunExecution?.(activeDunId)
        }

        // 3. 执行 ReAct 模式
        try {
          let result: string
          
          {
            // ReAct 模式 (传入 dunId 以注入 SOP)

            // 构建对话历史：从当前会话中提取最近的 user/assistant 消息对
            // 排除当前消息(已在 userMsg 中)和占位消息(execution 消息)
            const convForHistory = get().conversations.get(originConvId)
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
              activeDunId || undefined,
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
          const traceId = localClawService.lastTraceId || undefined
          // 替换占位消息为最终结果（无 execution 卡片，附带创建的文件列表）
          get()._updateMessageInConv(originConvId, execId, { content: result, execution: undefined, createdFiles, traceId })
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

          // 5. 完成 Dun 执行状态 + 发送 Toast 通知
          const executingDunId = fullState.executingDunId
          if (executingDunId) {
            fullState.completeDunExecution?.(executingDunId, {
              status: 'success',
              output: result.slice(0, 200), // 截断避免过长
            })
            // 成功 Toast 通知，点击打开 Dun 面板
            const dun = fullState.duns?.get(executingDunId)
            fullState.addToast?.({
              type: 'success',
              title: `${dun?.label || 'Dun'} 执行完成`,
              message: '任务已成功完成',
              duration: 6000,
              onClick: () => {
                fullState.selectDun?.(executingDunId)
                fullState.openDunPanel?.(executingDunId)
              },
            })
          }

        } catch (err: any) {
          const execDuration = Date.now() - execStartTime
          const isAborted = abortController.signal.aborted || err.name === 'AbortError'

          if (isAborted) {
            // 用户主动终止 — 不显示为错误
            get()._updateMessageInConv(originConvId, execId, { content: '任务已被终止。', execution: undefined })
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
          get()._updateMessageInConv(originConvId, execId, { content: `执行失败: ${err.message}`, error: true, execution: undefined })
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
            status: 'error',
            executionError: err.message,
            executionDuration: execDuration,
          })
          }
          persistExecutionStatuses(get().executionStatuses)

          // 完成 Dun 执行状态 + 发送错误 Toast 通知
          const executingDunId = fullState.executingDunId
          if (executingDunId) {
            fullState.completeDunExecution?.(executingDunId, {
              status: 'error',
              error: err.message,
            })
            const dun = fullState.duns?.get(executingDunId)
            fullState.addToast?.({
              type: 'error',
              title: `${dun?.label || 'Dun'} 执行失败`,
              message: err.message.slice(0, 80),
              duration: 8000,
              persistent: true,
              onClick: () => {
                fullState.selectDun?.(executingDunId)
                fullState.openDunPanel?.(executingDunId)
              },
            })
          }
        }

        // Observer 集成：记录用户行为，异步分析会自动触发
        if (fullState.addBehaviorRecord) {
          fullState.addBehaviorRecord({ type: 'chat', content: message })
        }

        return // Native 分支结束，不进入前端 LLM 流程
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
      const messages = buildChatMessages(view, storeData, history, message, state.locale)

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

      get()._addMessageToConv(originConvId, assistantMsg)
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
        // 获取当前会话的 dunId
        const cmdFullState = get() as any
        const cmdActiveConv = cmdFullState.conversations?.get(originConvId)
        const cmdDunId = cmdActiveConv?.dunId || cmdFullState.activeDunId
        
        for (const cmd of commands) {
          const execId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
          // 注册 execId -> convId 映射
          get()._execConvMap.set(execId, originConvId)
          
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
            get()._addMessageToConv(originConvId, suggestionMsg)
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
          get()._addMessageToConv(originConvId, execMsg)
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
                get()._updateMessageInConv(originConvId, execId, { execution: updatedStatus })
                set((state) => ({
                  executionStatuses: { ...state.executionStatuses, [execId]: updatedStatus },
                }))
              },
              undefined,  // onStep
              cmdDunId || undefined
            )
            
            // 执行完成
            const finalStatus: ExecutionStatus = {
              id: execId,
              status: 'success',
              output: result,
              outputLines: result.split('\n'),
              timestamp: Date.now(),
            }
            get()._updateMessageInConv(originConvId, execId, { execution: finalStatus })
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
            get()._updateMessageInConv(originConvId, execId, { execution: errorStatus })
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
          get()._addMessageToConv(originConvId, assistantMsg)
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
        // 清理执行映射，防止内存泄漏
        get()._execConvMap.clear()
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
    
    // 更新对应会话中的消息 (优先使用映射表，避免切换会话后串台)
    const targetConvId = get()._execConvMap.get(id) || get().activeConversationId
    if (targetConvId) {
      get()._updateMessageInConv(targetConvId, id, { execution: updated })
    }

    // 终态时清理映射，防止内存泄漏
    if (updated.status === 'success' || updated.status === 'error') {
      get()._execConvMap.delete(id)
    }
    
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
          const messages = buildJournalPrompt(date, dayMemories, getCurrentLocale())
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
      const messages = buildJournalPrompt(today, todayMemories, getCurrentLocale())
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
