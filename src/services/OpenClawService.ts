import type { 
  RequestMessage, ResponseMessage, EventMessage, ServerMessage,
  Session, ChannelsSnapshot, AgentEvent, Device, HealthSnapshot, HelloOkPayload, LogEntry,
  OpenClawSkill, ConnectionStatus, Toast, ChannelType, AgentRunStatus, ExecutionStatus,
  TaskItem, ExecutionStep
} from '@/types'
import type { ParsedSoul } from '@/utils/soulParser'

// Gateway skills.status 返回类型 (映射用，无需完整字段)
interface SkillStatusEntry {
  name: string
  description: string
  source: string
  bundled: boolean
  filePath: string
  baseDir: string
  skillKey: string
  primaryEnv?: string
  emoji?: string
  homepage?: string
  always: boolean
  disabled: boolean
  blockedByAllowlist: boolean
  eligible: boolean
}
// Gateway agents.list 返回类型
interface GatewayAgentRow {
  id: string
  name?: string
  identity?: {
    name?: string
    theme?: string
    emoji?: string
    avatar?: string
    avatarUrl?: string
  }
}
interface AgentsListResponse {
  defaultId: string
  mainKey: string
  scope: string
  agents: GatewayAgentRow[]
}

interface SkillStatusReport {
  workspaceDir: string
  managedSkillsDir: string
  skills: SkillStatusEntry[]
}

// ============================================
// 配置常量
// ============================================
const CONFIG = {
  HEARTBEAT_INTERVAL: 15000,     // 心跳间隔 15 秒 (OpenClaw 规范)
  HEARTBEAT_TIMEOUT: 90000,      // 心跳超时 90 秒 (需大于 Gateway tick 间隔，通常 30s)
  RECONNECT_BASE_DELAY: 1000,    // 重连基础延迟 1 秒
  RECONNECT_MAX_DELAY: 30000,    // 重连最大延迟 30 秒
  RECONNECT_MAX_ATTEMPTS: 10,    // 最大重连次数
  REQUEST_TIMEOUT: 30000,        // 请求超时 30 秒
  PROTOCOL_VERSION: 3,           // 协议版本
}

// ============================================
// 类型定义
// ============================================
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timeout: number
}

// OpenClaw Gateway 标准 Chat 事件协议 (Protocol v3)
interface ChatEventPayload {
  runId: string
  sessionKey: string
  seq: number
  state: 'delta' | 'final' | 'aborted' | 'error'
  message?: unknown    // delta 时为增量内容, final 时为完整消息
  errorMessage?: string
  usage?: unknown
  stopReason?: string
}

// 会话级事件回调
interface ChatSessionCallbacks {
  onDelta: (text: string, seq: number) => void
  onFinal: (text: string) => void
  onError: (error: string) => void
  onAborted: () => void
}

type StoreActions = {
  // Connection
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionMode: (mode: 'native' | 'openclaw') => void
  getConnectionMode: () => 'native' | 'openclaw'
  setConnectionError: (error: string | null) => void
  setReconnectAttempt: (attempt: number) => void
  setReconnectCountdown: (countdown: number | null) => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  
  // Sessions → Tasks
  setSessions: (sessions: Session[]) => void
  addSession: (session: Session) => void
  updateSession: (key: string, updates: Partial<Session>) => void
  removeSession: (key: string) => void
  setSessionsLoading: (loading: boolean) => void
  
  // Channels → Skills (兼容旧 API)
  setChannelsSnapshot: (snapshot: ChannelsSnapshot) => void
  setChannelConnected: (id: ChannelType, accountId: string, connected: boolean) => void
  setChannelsLoading: (loading: boolean) => void
  
  // OpenClaw Skills → Skills (新 API)
  setOpenClawSkills: (skills: OpenClawSkill[]) => void
  
  // Agent → Memories
  setAgentIdentity: (identity: { agentId: string; name?: string; emoji?: string } | null) => void
  setAgentStatus: (status: AgentRunStatus) => void
  addRunEvent: (event: AgentEvent) => void
  addLog: (log: LogEntry) => void
  setAgentLoading: (loading: boolean) => void
  setMemoriesFromSessions: (sessions: Session[]) => void
  
  // Devices → Soul
  setPresenceSnapshot: (snapshot: { devices: Record<string, Device>; operators: string[]; nodes: string[] }) => void
  updateDevice: (id: string, updates: Partial<Device>) => void
  removeDevice: (id: string) => void
  setHealth: (health: HealthSnapshot | null) => void
  setDevicesLoading: (loading: boolean) => void
  updateSoulFromState: (identity: { agentId: string; name?: string; emoji?: string } | null) => void
  
  // Soul from SOUL.md
  setSoulFromParsed: (parsed: ParsedSoul, agentIdentity: { agentId: string; name?: string; emoji?: string } | null) => void
  
  // AI 执行状态
  updateExecutionStatus: (id: string, updates: Partial<ExecutionStatus>) => void
  
  // Gateway sessions → DD-OS 对话回填
  syncGatewaySessionsToConversations: (sessions: Session[]) => void
  
  // Task Panel (sessionsSlice → activeExecutions)
  addActiveExecution: (task: TaskItem) => void
  updateActiveExecution: (id: string, updates: Partial<TaskItem>) => void
  removeActiveExecution: (id: string) => void
  appendExecutionStep: (taskId: string, step: ExecutionStep) => void
  updateExecutionStep: (taskId: string, stepId: string, updates: Partial<ExecutionStep>) => void
  
  // Nexus Scoring (V2: OpenClaw 模式也同步评分)
  updateNexusScoring?: (id: string, scoring: import('@/types').NexusScoring) => void
  setActiveNexus?: (id: string | null) => void
  bindSkillToNexus?: (nexusId: string, skillName: string) => void
  getNexuses?: () => Map<string, any>
  activeNexusId?: string | null
  
  // OpenClaw agents → DD-OS Nexuses 同步
  syncAgentsAsNexuses?: (agents: GatewayAgentRow[], skills: OpenClawSkill[]) => void
}

// ============================================
// WebSocket 服务类
// ============================================
class OpenClawService {
  private ws: WebSocket | null = null
  private pendingRequests: Map<string, PendingRequest> = new Map()
  private reconnectAttempt = 0
  private reconnectTimer: number | null = null
  private heartbeatTimer: number | null = null
  private heartbeatTimeoutTimer: number | null = null
  private countdownTimer: number | null = null
  private isManualDisconnect = false
  private storeActions: StoreActions | null = null
  private authToken: string = ''
  private gatewayUrl: string = ''  // 自定义 Gateway 地址
  private tickInterval: number = CONFIG.HEARTBEAT_INTERVAL
  private chatListeners = new Map<string, ChatSessionCallbacks>()
  // Gateway restart hint: set by shutdown event, consumed by handleClose
  private pendingRestartHint: { expectedMs: number; receivedAt: number } | null = null
  // Track auth failure to prevent blind reconnect with invalid token
  private lastCloseWasAuthFailure = false
  // 追踪活跃的 agent runId → taskId 映射 (用于关联后续事件到 TaskItem)
  private agentRunTasks = new Map<string, { taskId: string; startedAt: number; thinkingStepId: string | null; thinkingBuffer: string; toolNames: string[]; taskTitle: string; hasError: boolean }>()
  // 预注册的 chat 任务 (aiSlice chat.send 时注册，避免 agent 事件重复创建 TaskItem)
  private preRegisteredTasks = new Map<string, { taskId: string; title: string }>()
  // 追踪已通过 chat 通道收到实际内容 delta 的 runId，避免 agent 桥接重复
  private chatChannelActiveRunIds = new Set<string>()
  // runId → listenerKey 反向映射（Gateway 可能返回与 idempotencyKey 不同的 runId）
  private runIdToListenerKey = new Map<string, string>()

  // 注入 Store actions (避免循环依赖)
  injectStore(actions: StoreActions) {
    this.storeActions = actions
  }

  // 设置认证 Token
  setAuthToken(token: string) {
    this.authToken = token.trim()
  }

  // 设置 Gateway 地址 (支持远程直连，不走代理)
  setGatewayUrl(url: string) {
    if (!url) {
      this.gatewayUrl = ''
      return
    }
    // 自动补全协议
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = `ws://${url}`
    }
    // 移除首尾空白 + 尾部斜杠
    this.gatewayUrl = url.trim().replace(/\/+$/, '')
  }

  // 获取 WebSocket URL
  private getWsUrl(): string {
    // 1. 如果指定了自定义 Gateway 地址，直连（用于远程调试）
    if (this.gatewayUrl) {
      return this.gatewayUrl
    }
    // 2. 默认使用相对路径 /ws，通过代理转发
    //    - 开发环境: Vite 代理 (vite.config.ts 配置 target)
    //    - 生产环境: nginx/Caddy 代理
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${protocol}//${window.location.host}/ws`
  }

  // 生成唯一 ID
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  // ============================================
  // 公开方法
  // ============================================

  // ============================================
  // 公开方法 - 会话级事件监听
  // ============================================

  subscribeChatSession(sessionKey: string, callbacks: ChatSessionCallbacks): void {
    this.chatListeners.set(sessionKey, callbacks)
  }

  unsubscribeChatSession(sessionKey: string): void {
    this.removeChatListener(sessionKey)
  }

  /**
   * 删除 chatListener 并同步清理 runIdToListenerKey 反向映射
   */
  private removeChatListener(key: string): void {
    this.chatListeners.delete(key)
    for (const [runId, listenerKey] of this.runIdToListenerKey) {
      if (listenerKey === key || runId === key) {
        this.runIdToListenerKey.delete(runId)
      }
    }
  }

  /**
   * 预注册 chat 任务关联 (aiSlice 在 chat.send 之前调用)
   * 当 agent lifecycle start 事件到达时，直接复用此 TaskItem，避免重复创建
   */
  registerChatTask(runId: string, taskId: string, title: string): void {
    this.preRegisteredTasks.set(runId, { taskId, title })
  }

  // ============================================
  // 公开方法 - 连接
  // ============================================

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    // If last disconnect was an auth failure, clear the flag but warn
    if (this.lastCloseWasAuthFailure) {
      console.log('[OpenClawService] Reconnecting after auth failure — previous rate limit may still apply')
      this.lastCloseWasAuthFailure = false
    }

    this.isManualDisconnect = false
    this.storeActions?.setConnectionStatus('connecting')
    this.storeActions?.setConnectionError(null)

    return new Promise((resolve, reject) => {
      try {
        // 构建带 token 的 URL (浏览器 WebSocket 不支持自定义 headers)
        let url = this.getWsUrl()
        if (this.authToken) {
          url += `?token=${encodeURIComponent(this.authToken)}`
        }
        
        console.log('[OpenClawService] Connecting to:', url.replace(/token=.*/, 'token=***'))
        this.ws = new WebSocket(url)

        const timeout = window.setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close()
            reject(new Error('Connection timeout'))
          }
        }, CONFIG.REQUEST_TIMEOUT)

        this.ws.onopen = () => {
          clearTimeout(timeout)
          this.handleOpen()
          resolve()
        }

        this.ws.onclose = (event) => {
          clearTimeout(timeout)
          this.handleClose(event)
        }

        this.ws.onerror = (error) => {
          clearTimeout(timeout)
          this.handleError(error)
          reject(error)
        }

        this.ws.onmessage = (event) => {
          this.handleMessage(event)
        }
      } catch (error) {
        this.storeActions?.setConnectionStatus('error')
        this.storeActions?.setConnectionError(String(error))
        reject(error)
      }
    })
  }

  disconnect(): void {
    this.isManualDisconnect = true
    this.cleanup()
    
    if (this.ws) {
      this.ws.close(1000, 'Manual disconnect')
      this.ws = null
    }

    this.storeActions?.setConnectionStatus('disconnected')
    this.storeActions?.setConnectionError(null)
    this.storeActions?.setReconnectAttempt(0)
    this.storeActions?.setReconnectCountdown(null)
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected')
    }

    const id = this.generateId()
    const message: RequestMessage = {
      type: 'req',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, CONFIG.REQUEST_TIMEOUT)

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      })

      this.ws!.send(JSON.stringify(message))
    })
  }

  retry(): void {
    this.reconnectAttempt = 0
    this.connect().catch(console.error)
  }

  // 加载初始数据
  async loadInitialData(): Promise<void> {
    try {
      // 并行请求初始数据 (仅调用 Gateway 实际支持的方法)
      // 注意: agent.identity / files.read 已被 Gateway 标记为 unknown method，
      // 改为从 agents.list 返回的 identity 字段获取 Agent 身份信息
      const [sessionsResult, skillsResult, channelsResult, agentsListResult] = await Promise.allSettled([
        this.send<{ sessions: Session[] }>('sessions.list', { limit: 50, includeLastMessage: true }),
        this.send<SkillStatusReport>('skills.status', {}),
        this.send<ChannelsSnapshot>('channels.status', {}),
        // agents.list 包含 identity / skills 等信息，替代 agent.identity + files.read
        this.send<AgentsListResponse>('agents.list', {}),
      ])

      let sessions: Session[] = []
      let agentIdentity: { agentId: string; name?: string; emoji?: string } | null = null

      // 处理 Sessions → Tasks + Memories
      if (sessionsResult.status === 'fulfilled' && sessionsResult.value) {
        console.log('[OpenClawService] sessions.list raw response:', sessionsResult.value)
        sessions = (sessionsResult.value as { sessions?: Session[] }).sessions || []
        this.storeActions?.setSessions(sessions)
        this.storeActions?.setMemoriesFromSessions(sessions)
        // 将 Gateway 会话的完成结果回填到 DD-OS 对话（修复刷新后结果丢失）
        if (sessions.length > 0) {
          this.storeActions?.syncGatewaySessionsToConversations(sessions)
        }
      }
      this.storeActions?.setSessionsLoading(false)

      // 处理 Skills (使用 skills.status API — Gateway 的真实方法)
      let skillsLoaded = false
      if (skillsResult.status === 'fulfilled' && skillsResult.value) {
        const report = skillsResult.value as SkillStatusReport
        console.log('[OpenClawService] skills.status raw response:', report)
        const entries = report.skills || (report as any).skills || []
        if (Array.isArray(entries) && entries.length > 0) {
          // 映射 SkillStatusEntry → OpenClawSkill
          const mapped: OpenClawSkill[] = entries.map((entry: SkillStatusEntry) => ({
            name: entry.name,
            description: entry.description || '',
            status: entry.eligible ? 'active' as const : entry.disabled ? 'inactive' as const : 'error' as const,
            enabled: entry.eligible && !entry.disabled,
            location: entry.bundled ? 'global' as const : 'local' as const,
            path: entry.filePath,
            keywords: [],
          }))
          this.storeActions?.setOpenClawSkills(mapped)
          skillsLoaded = true
        }
      } else if (skillsResult.status === 'rejected') {
        console.log('[OpenClawService] skills.status API not available:', skillsResult.reason)
      }
      
      // 如果 skills.list 没有返回数据，回退到 channels.status
      if (!skillsLoaded && channelsResult.status === 'fulfilled' && channelsResult.value) {
        console.log('[OpenClawService] channels.status raw response (fallback):', channelsResult.value)
        this.storeActions?.setChannelsSnapshot(channelsResult.value as ChannelsSnapshot)
      }
      
      // 确保 channelsLoading 变为 false（无论 API 是否成功）
      this.storeActions?.setChannelsLoading(false)

      // 处理 agents.list → Agent Identity + 同步为 DD-OS Nexuses
      // (替代之前调用 Gateway 不支持的 agent.identity / files.read 方法)
      if (agentsListResult.status === 'fulfilled' && agentsListResult.value) {
        const agentsData = agentsListResult.value as AgentsListResponse
        console.log('[OpenClawService] agents.list raw response:', agentsData)

        // 提取 Agent Identity (从 defaultAgent 的 identity 字段)
        const defaultAgent = agentsData.agents?.find(a => a.id === agentsData.defaultId) || agentsData.agents?.[0]
        if (defaultAgent?.identity) {
          agentIdentity = {
            agentId: defaultAgent.id,
            name: defaultAgent.identity.name || defaultAgent.name,
            emoji: defaultAgent.identity.emoji,
          }
          this.storeActions?.setAgentIdentity(agentIdentity)
        }

        // 同步 Agents → Nexuses
        if (agentsData.agents && agentsData.agents.length > 0) {
          const currentSkills = skillsLoaded
            ? (skillsResult.status === 'fulfilled' && skillsResult.value
                ? ((skillsResult.value as SkillStatusReport).skills || []).map((entry: SkillStatusEntry) => ({
                    name: entry.name,
                    description: entry.description || '',
                    status: (entry.eligible ? 'active' : entry.disabled ? 'inactive' : 'error') as 'active' | 'inactive' | 'error',
                    enabled: entry.eligible && !entry.disabled,
                    location: (entry.bundled ? 'global' : 'local') as 'global' | 'local',
                    path: entry.filePath,
                    keywords: [] as string[],
                  }))
                : [])
            : []
          this.storeActions?.syncAgentsAsNexuses?.(agentsData.agents, currentSkills)
        }
      } else if (agentsListResult.status === 'rejected') {
        console.log('[OpenClawService] agents.list API not available:', agentsListResult.reason)
      }
      this.storeActions?.setAgentLoading(false)

      // SOUL.md: Gateway 不支持 files.read，使用 agent identity 更新基本信息
      this.storeActions?.updateSoulFromState(agentIdentity)

    } catch (error) {
      console.error('[OpenClawService] Failed to load initial data:', error)
      // 即使出错也要确保 loading 状态结束
      this.storeActions?.setSessionsLoading(false)
      this.storeActions?.setChannelsLoading(false)
      this.storeActions?.setAgentLoading(false)
      this.storeActions?.setDevicesLoading(false)
    }
  }

  // ============================================
  // 私有方法 - 事件处理
  // ============================================

  private handleOpen(): void {
    console.log('[OpenClawService] WebSocket connected, waiting for challenge...')
    this.reconnectAttempt = 0
    this.storeActions?.setReconnectAttempt(0)
    this.storeActions?.setReconnectCountdown(null)
  }

  private async handleChallenge(_payload: { nonce: string; ts: number }): Promise<void> {
    console.log('[OpenClawService] Received challenge, sending connect request...')
    
    const instanceId = this.getDeviceId()

    try {
      // webclaw 风格: 不发送 device，只用 token/password 认证
      const response = await this.send('connect', {
        minProtocol: CONFIG.PROTOCOL_VERSION,
        maxProtocol: CONFIG.PROTOCOL_VERSION,
        client: {
          id: 'gateway-client',
          displayName: 'DD-OS',
          version: '1.0.0',
          platform: 'browser',
          mode: 'ui',
          instanceId,
        },
        caps: ['tool-events'],  // 顶层字段：声明支持工具事件，Gateway 才会路由 agent 事件给我们
        auth: {
          token: this.authToken || undefined,
        },
        role: 'operator',
        scopes: ['operator.admin'],
      })

      console.log('[OpenClawService] Connect response:', response)
      this.handleHelloResponse(response as HelloOkPayload)
    } catch (error) {
      const errMsg = String(error)
      console.error('[OpenClawService] Connect failed:', error)
      // Detect auth-level rejection during handshake (before WebSocket close)
      const isAuthErr = errMsg.includes('unauthorized') || errMsg.includes('forbidden') || errMsg.includes('auth')
      if (isAuthErr) {
        this.lastCloseWasAuthFailure = true
      }
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError('认证失败: ' + errMsg)
    }
  }

  private handleHelloResponse(response: HelloOkPayload): void {
    // 更新心跳间隔
    if (response?.policy?.tickIntervalMs) {
      this.tickInterval = response.policy.tickIntervalMs
      console.log('[OpenClawService] Using server tick interval:', this.tickInterval)
    }
    
    // 处理初始 presence 数据
    if (response?.presence) {
      this.storeActions?.setPresenceSnapshot(response.presence)
    } else {
      // 如果握手响应不包含 presence，也要确保 loading 结束
      this.storeActions?.setDevicesLoading(false)
    }
    
    // 处理初始 health 数据
    if (response?.health) {
      this.storeActions?.setHealth(response.health)
    }
    
    // 握手完成 — 仅当用户当前选择的就是 openclaw 模式时才设置
    // 避免在 Native 模式下因 OpenClaw 自动重连而覆盖用户的模式选择
    const currentMode = this.storeActions?.getConnectionMode?.()
    if (currentMode !== 'native') {
      this.storeActions?.setConnectionMode('openclaw')
    }
    this.storeActions?.setConnectionStatus('connected')
    this.storeActions?.addToast({
      type: 'success',
      title: '已连接',
      message: '已连接到 DD-OS Cloud Gateway',
    })
    
    // 启动心跳
    this.startHeartbeat()
    
    // 加载初始数据
    this.loadInitialData()
  }

  private getDeviceId(): string {
    const key = 'openclaw_device_id'
    let deviceId = localStorage.getItem(key)
    if (!deviceId) {
      deviceId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
      localStorage.setItem(key, deviceId)
    }
    return deviceId
  }

  // 重置设备身份（清除旧密钥和设备 ID）
  resetDeviceIdentity(): void {
    localStorage.removeItem('openclaw_device_id')
    localStorage.removeItem('openclaw_device_pubkey')
    localStorage.removeItem('openclaw_device_privkey')
  }

  private handleClose(event: CloseEvent): void {
    console.log('[OpenClawService] Connection closed:', event.code, event.reason)
    const restartHint = this.pendingRestartHint
    this.pendingRestartHint = null
    this.cleanup()

    if (this.isManualDisconnect) return

    // 1008 = Policy Violation — Gateway uses this for auth failures
    const reason = (event.reason || '').toLowerCase()
    const isAuthFailure = event.code === 1008 && (
      reason.includes('unauthorized') || reason.includes('rate_limited') || reason.includes('rate limit')
    )

    if (isAuthFailure) {
      this.lastCloseWasAuthFailure = true
      const isRateLimited = reason.includes('rate_limited') || reason.includes('rate limit')
      console.warn('[OpenClawService] Auth failure detected, stopping auto-reconnect:', event.reason)
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError(
        isRateLimited
          ? '认证请求过于频繁，Gateway 已限流。请稍后手动重连。'
          : '认证失败，请检查 Token 是否正确。'
      )
      this.storeActions?.addToast({
        type: 'error',
        title: isRateLimited ? '连接被限流' : '认证失败',
        message: isRateLimited
          ? 'Gateway 因多次认证失败限制了连接，请等待 1-2 分钟后手动重试'
          : '连接认证失败，请检查 Token 配置后重试',
      })
      // Do NOT schedule reconnect — user must fix token or wait out rate limit
      return
    }

    this.lastCloseWasAuthFailure = false

    if (restartHint) {
      // Gateway announced restart with expected time — use optimized reconnect
      const elapsed = Date.now() - restartHint.receivedAt
      const waitMs = Math.max(restartHint.expectedMs - elapsed, 500)
      console.log(`[OpenClawService] Gateway restart detected, waiting ${waitMs}ms before reconnect`)
      this.storeActions?.addToast({
        type: 'info',
        title: '重连中',
        message: `Gateway 重启中，${Math.ceil(waitMs / 1000)}s 后自动重连...`,
      })
      this.scheduleRestartReconnect(waitMs)
    } else {
      this.storeActions?.addToast({
        type: 'warning',
        title: '连接断开',
        message: '正在尝试重新连接...',
      })
      this.scheduleReconnect()
    }
  }

  private handleError(error: Event): void {
    console.error('[OpenClawService] WebSocket error:', error)
    this.storeActions?.setConnectionError('WebSocket connection error')
  }

  private handleMessage(event: MessageEvent): void {
    this.resetHeartbeatTimeout()

    try {
      const message: ServerMessage = JSON.parse(event.data)

      if (message.type === 'res') {
        this.handleResponse(message)
      } else if (message.type === 'event') {
        this.dispatchEvent(message)
      }
    } catch (error) {
      console.error('[OpenClawService] Failed to parse message:', error)
    }
  }

  private handleResponse(response: ResponseMessage): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      // 静默处理：可能是超时后到达的响应或服务端主动推送
      // console.debug('[OpenClawService] No pending request for id:', response.id)
      return
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(response.id)

    if (response.ok) {
      pending.resolve(response.payload)
    } else {
      pending.reject(new Error(response.error?.message || 'Request failed'))
    }
  }

  // ============================================
  // 私有方法 - 事件分发 (OpenClaw 真实事件)
  // ============================================

  private dispatchEvent(event: EventMessage): void {
    console.log('[OpenClawService] Event received:', event.event, JSON.stringify(event.payload).slice(0, 500))
    console.log('[OpenClawService] Current chatListeners keys:', [...this.chatListeners.keys()])

    switch (event.event) {
      // 握手事件
      case 'connect.challenge': {
        const challengePayload = event.payload as { nonce: string; ts: number }
        this.handleChallenge(challengePayload)
        break
      }

      // 心跳响应
      case 'tick':
      case 'pong':
        break

      // 健康状态更新
      case 'health': {
        const healthPayload = event.payload as HealthSnapshot
        this.storeActions?.setHealth(healthPayload)
        break
      }

      // 设备在线状态
      case 'presence': {
        const presencePayload = event.payload as { devices: Record<string, Device>; operators: string[]; nodes: string[] }
        this.storeActions?.setPresenceSnapshot(presencePayload)
        break
      }

      // Agent 执行事件
      case 'agent': {
        const agentPayload = event.payload as AgentEvent
        // --- 保留: AI 日志面板 ---
        this.storeActions?.addRunEvent(agentPayload)
        this.storeActions?.addLog({
          id: `${agentPayload.runId}-${agentPayload.seq}`,
          timestamp: agentPayload.ts,
          level: 'info',
          message: `[${agentPayload.stream}] ${JSON.stringify(agentPayload.data).slice(0, 100)}`,
        })

        // --- 新增: Task Panel 映射 (agent event → TaskItem/ExecutionStep) ---
        const d = agentPayload.data as Record<string, any>
        const { runId, stream: agentStream, ts } = agentPayload

        if (agentStream === 'lifecycle') {
          if (d.phase === 'start' || d.status === 'started') {
            // 检查是否有 aiSlice 预注册的 chat 任务 (避免重复创建)
            const preReg = this.preRegisteredTasks.get(runId)
            if (preReg) {
              // 复用已有 TaskItem，只建立 agent 事件追踪
              this.agentRunTasks.set(runId, { taskId: preReg.taskId, startedAt: ts, thinkingStepId: null, thinkingBuffer: '', toolNames: [], taskTitle: preReg.title, hasError: false })
              this.preRegisteredTasks.delete(runId)
            } else {
              // 独立 agent 运行 (非 chat.send 触发)，创建新 TaskItem
              const taskId = `oc-agent-${runId}`
              this.agentRunTasks.set(runId, { taskId, startedAt: ts, thinkingStepId: null, thinkingBuffer: '', toolNames: [], taskTitle: String(d.task || d.label || d.sessionKey || '').slice(0, 80) || 'Agent 任务', hasError: false })
              this.storeActions?.addActiveExecution({
                id: taskId,
                title: String(d.task || d.label || d.sessionKey || '').slice(0, 80) || 'Agent 任务',
                description: String(d.task || d.prompt || ''),
                status: 'executing',
                priority: 'medium',
                timestamp: new Date(ts).toISOString(),
                executionSteps: [],
                startedAt: ts,
              })
            }
          } else if (d.phase === 'end' || d.status === 'completed') {
            const tracked = this.agentRunTasks.get(runId)
            if (tracked) {
              this.storeActions?.updateActiveExecution(tracked.taskId, {
                status: 'done',
                executionOutput: String(d.result || d.output || '').slice(0, 5000),
                executionDuration: ts - tracked.startedAt,
                completedAt: ts,
              })
              // Nexus 经验记录 + XP 同步
              this.recordNexusExperience(tracked, !tracked.hasError, String(d.result || d.output || ''))
              this.agentRunTasks.delete(runId)
            }
          } else if (d.phase === 'error' || d.status === 'failed') {
            const tracked = this.agentRunTasks.get(runId)
            if (tracked) {
              this.storeActions?.updateActiveExecution(tracked.taskId, {
                status: 'terminated',
                executionError: String(d.error || d.message || d.reason || 'Agent 执行错误'),
                executionDuration: ts - tracked.startedAt,
                completedAt: ts,
              })
              // Nexus 经验记录 (失败)
              this.recordNexusExperience(tracked, false, String(d.error || d.message || ''))
              this.agentRunTasks.delete(runId)
            }
          }
        } else {
          // assistant / tool / error 等非 lifecycle 事件 → ExecutionStep
          const tracked = this.agentRunTasks.get(runId)
          if (tracked) {
            if (agentStream === 'assistant') {
              // assistant delta: 累积到单个 thinking step，避免每个 token 碎片化
              const deltaText = String(d.delta || d.text || '')
              if (deltaText) {
                tracked.thinkingBuffer += deltaText
                if (!tracked.thinkingStepId) {
                  // 首次 assistant delta → 创建 thinking step
                  const stepId = `${runId}-think-${ts}`
                  tracked.thinkingStepId = stepId
                  this.storeActions?.appendExecutionStep(tracked.taskId, {
                    id: stepId,
                    type: 'thinking',
                    content: tracked.thinkingBuffer,
                    timestamp: ts,
                  })
                } else {
                  // 后续 delta → 更新同一个 thinking step 的 content
                  this.storeActions?.updateExecutionStep(
                    tracked.taskId,
                    tracked.thinkingStepId,
                    { content: tracked.thinkingBuffer }
                  )
                }
              }
            } else {
              // tool / error 等 → 结束当前 thinking 累积，创建新 step
              if (tracked.thinkingStepId) {
                tracked.thinkingStepId = null
                tracked.thinkingBuffer = ''
              }
              // 收集工具名称 (用于 Nexus 经验记录)
              if (agentStream === 'tool' && d.phase === 'start' && d.name) {
                tracked.toolNames.push(String(d.name))
              }
              if (agentStream === 'error' || (agentStream === 'tool' && d.isError)) {
                tracked.hasError = true
              }
              const step = this.agentEventToStep(agentPayload)
              if (step) {
                this.storeActions?.appendExecutionStep(tracked.taskId, step)
              }
            }
          }
        }

        // --- 保留: AI 聊天消息状态 ---
        if (agentStream === 'result' || agentStream === 'error') {
          const output = JSON.stringify(d).slice(0, 500)
          this.storeActions?.updateExecutionStatus(runId, {
            status: agentStream === 'error' ? 'error' : 'success',
            output,
          })
        }

        // --- 桥接: agent 事件 → chatListener (解决 chat.send 触发 agent 执行时的超时) ---
        // Gateway 的 chat.send 可能触发 agent 执行，响应走 agent 通道而非 chat 通道
        // 此时 chatListener 注册的 idempotencyKey === agent event 的 runId
        // 但如果 Gateway 同时也通过 chat 通道发送了事件，则跳过桥接避免内容重复
        if (!this.chatChannelActiveRunIds.has(runId)) {
          const chatListener = this.chatListeners.get(runId)
          if (chatListener) {
            if (agentStream === 'assistant') {
              const deltaText = String(d.delta || d.text || '')
              if (deltaText) {
                chatListener.onDelta(deltaText, agentPayload.seq ?? 0)
              }
            } else if (agentStream === 'lifecycle' && (d.phase === 'start' || d.status === 'started')) {
              // Agent 已启动 — 发送空 delta 作为 keep-alive 重置活动超时
              chatListener.onDelta('', 0)
            } else if (agentStream === 'tool') {
              // 工具调用事件 — 发送空 delta 作为 keep-alive 重置活动超时
              chatListener.onDelta('', 0)
            } else if (agentStream === 'lifecycle' && (d.phase === 'end' || d.status === 'completed')) {
              const finalText = String(d.result || d.output || '')
              chatListener.onFinal(finalText)
              this.removeChatListener(runId)
            } else if (agentStream === 'lifecycle' && (d.phase === 'error' || d.status === 'failed')) {
              chatListener.onError(String(d.error || d.message || d.reason || 'Agent 执行错误'))
              this.removeChatListener(runId)
            } else if (agentStream === 'error') {
              chatListener.onError(String(d.error || d.message || 'Agent error'))
              this.removeChatListener(runId)
            }
          }
        } else {
          // Fallback: chat 通道已激活，但如果 listener 仍存在（说明 chat 还没发 final），
          // 则 agent lifecycle 终止事件仍需传递，防止 chat 通道丢失 final 导致 300s 超时
          const fallbackKey = this.runIdToListenerKey.get(runId) || runId
          const chatListener = this.chatListeners.get(fallbackKey)
          if (chatListener) {
            console.log('[OpenClawService] Agent event for chat-active runId:', runId, 'stream:', agentStream, 'phase:', d.phase || d.status)
            if (agentStream === 'lifecycle' && (d.phase === 'end' || d.status === 'completed')) {
              const finalText = String(d.result || d.output || '')
              chatListener.onFinal(finalText)
              this.removeChatListener(fallbackKey)
              this.chatChannelActiveRunIds.delete(runId)
            } else if (agentStream === 'lifecycle' && (d.phase === 'error' || d.status === 'failed')) {
              chatListener.onError(String(d.error || d.message || d.reason || 'Agent 执行错误'))
              this.removeChatListener(fallbackKey)
              this.chatChannelActiveRunIds.delete(runId)
            }
          }
        }

        break
      }

      // 聊天消息事件 (标准协议: ChatEventPayload)
      case 'chat': {
        const chatPayload = event.payload as ChatEventPayload

        // === 会话级 listener 处理 (流式响应) ===
        // 四层 listener 查找:
        // P1: runId 直接匹配 (runId = 客户端 idempotencyKey，不会被修改)
        // P2: sessionKey 直接匹配
        // P3: runIdToListenerKey 反向映射 (Gateway 可能返回不同 runId)
        // P4: sessionKey 子串匹配 (Gateway 规范化 ddos-xxx → agent:main:main:ddos-xxx)
        let listenerKey: string | undefined

        if (chatPayload.runId && this.chatListeners.has(chatPayload.runId)) {
          listenerKey = chatPayload.runId
        } else if (chatPayload.sessionKey && this.chatListeners.has(chatPayload.sessionKey)) {
          listenerKey = chatPayload.sessionKey
        } else if (chatPayload.runId && this.runIdToListenerKey.has(chatPayload.runId)) {
          const mappedKey = this.runIdToListenerKey.get(chatPayload.runId)!
          if (this.chatListeners.has(mappedKey)) {
            listenerKey = mappedKey
          }
        } else if (chatPayload.sessionKey) {
          for (const registeredKey of this.chatListeners.keys()) {
            if (chatPayload.sessionKey.includes(registeredKey) || registeredKey.includes(chatPayload.sessionKey)) {
              listenerKey = registeredKey
              break
            }
          }
        }

        // 首次匹配成功时建立 runId→listenerKey 映射，加速后续事件查找
        if (listenerKey && chatPayload.runId && chatPayload.runId !== listenerKey) {
          this.runIdToListenerKey.set(chatPayload.runId, listenerKey)
        }

        // 诊断日志: listener 查找失败
        if (!listenerKey) {
          console.warn('[OpenClawService] Chat event received but no listener found:', {
            runId: chatPayload.runId,
            sessionKey: chatPayload.sessionKey,
            state: chatPayload.state,
            registeredKeys: [...this.chatListeners.keys()],
            runIdMappings: [...this.runIdToListenerKey.entries()],
          })
        }

        const listener = listenerKey ? this.chatListeners.get(listenerKey) : undefined

        if (listener && listenerKey) {
          switch (chatPayload.state) {
            case 'delta': {
              const text = this.extractTextFromMessage(chatPayload.message)
              if (text) {
                // 只有 chat 通道真正产出文本内容时，才标记为激活
                // 避免仅收到 init/metadata 就阻断 agent 桥接导致超时
                if (chatPayload.runId) {
                  this.chatChannelActiveRunIds.add(chatPayload.runId)
                }
                listener.onDelta(text, chatPayload.seq ?? 0)
              }
              break
            }
            case 'final': {
              const text = this.extractTextFromMessage(chatPayload.message)
              listener.onFinal(text)
              this.removeChatListener(listenerKey)
              if (chatPayload.runId) this.chatChannelActiveRunIds.delete(chatPayload.runId)
              break
            }
            case 'error': {
              listener.onError(chatPayload.errorMessage || 'Unknown error')
              this.removeChatListener(listenerKey)
              if (chatPayload.runId) this.chatChannelActiveRunIds.delete(chatPayload.runId)
              break
            }
            case 'aborted': {
              listener.onAborted()
              this.removeChatListener(listenerKey)
              if (chatPayload.runId) this.chatChannelActiveRunIds.delete(chatPayload.runId)
              break
            }
          }
        }

        // === 保留全局 store 更新逻辑 ===
        if (chatPayload.sessionKey) {
          this.storeActions?.updateSession(chatPayload.sessionKey, {
            updatedAt: Date.now(),
            lastMessage: chatPayload.message as Session['lastMessage'],
          })
          if (chatPayload.state === 'final' || chatPayload.state === 'error') {
            this.storeActions?.updateExecutionStatus(chatPayload.sessionKey, {
              status: chatPayload.state === 'final' ? 'success' : 'error',
            })
          }
        }
        break
      }

      // 执行审批请求
      case 'exec.approval.requested': {
        this.storeActions?.addToast({
          type: 'warning',
          title: '执行审批',
          message: '有操作需要您的批准',
        })
        this.storeActions?.setAgentStatus('pending')
        break
      }

      // DD-OS Extension: Agent 自动激活 Nexus
      case 'ddos.nexus.activated': {
        const activatePayload = event.payload as {
          nexusId?: string
          nexusName?: string
          activatedBy?: string
        }
        if (activatePayload?.nexusId) {
          this.storeActions?.setActiveNexus?.(activatePayload.nexusId)
          console.log(`[OpenClawService] Nexus activated by ${activatePayload.activatedBy || 'extension'}: ${activatePayload.nexusId}`)
          this.storeActions?.addToast({
            type: 'info',
            title: 'Nexus 激活',
            message: `Agent 激活了 ${activatePayload.nexusName || activatePayload.nexusId}`,
          })
        }
        break
      }

      // DD-OS Extension: SOP 被 Agent 重写
      case 'ddos.nexus.sopUpdated': {
        const sopPayload = event.payload as {
          nexusId?: string
          updatedBy?: string
        }
        if (sopPayload?.nexusId) {
          console.log(`[OpenClawService] SOP updated by ${sopPayload.updatedBy || 'extension'} for Nexus: ${sopPayload.nexusId}`)
          this.storeActions?.addToast({
            type: 'info',
            title: 'SOP 已更新',
            message: `Nexus ${sopPayload.nexusId} 的 SOP 已由 Agent 优化`,
          })
        }
        break
      }

      // DD-OS Extension: Agent 绑定技能到 Nexus
      case 'ddos.nexus.skillBound': {
        const bindPayload = event.payload as {
          nexusId?: string
          skillName?: string
          boundBy?: string
        }
        if (bindPayload?.nexusId && bindPayload?.skillName) {
          this.storeActions?.bindSkillToNexus?.(bindPayload.nexusId, bindPayload.skillName)
          console.log(`[OpenClawService] Skill "${bindPayload.skillName}" bound to Nexus ${bindPayload.nexusId} by ${bindPayload.boundBy || 'extension'}`)
          this.storeActions?.addToast({
            type: 'success',
            title: '技能已绑定',
            message: `${bindPayload.skillName} 已绑定到 Nexus`,
          })
        }
        break
      }

      // DD-OS Extension: Nexus Scoring 更新广播
      case 'ddos.nexus.xpUpdate': {
        // V2: 兼容旧 xpUpdate 事件，转换为 scoring 更新
        const payload = event.payload as {
          nexusId?: string
          scoring?: import('@/types').NexusScoring
          xpDelta?: number
          reason?: string
        }
        if (payload?.nexusId && payload.scoring) {
          this.storeActions?.updateNexusScoring?.(payload.nexusId, payload.scoring)
          console.log(`[OpenClawService] Nexus scoring updated via Extension: ${payload.nexusId} score=${payload.scoring.score}`)
        }
        break
      }

      // 系统关闭通知
      case 'shutdown': {
        const shutdownPayload = event.payload as { reason?: string; restartExpectedMs?: number } | undefined
        const restartMs = shutdownPayload?.restartExpectedMs
        if (restartMs && restartMs > 0) {
          this.pendingRestartHint = { expectedMs: restartMs, receivedAt: Date.now() }
        }
        this.storeActions?.addToast({
          type: 'warning',
          title: '系统重启',
          message: restartMs ? `Gateway 正在重启，预计 ${Math.ceil(restartMs / 1000)}s 后恢复...` : 'Gateway 正在关闭...',
        })
        break
      }

      default:
        console.log('[OpenClawService] Unhandled event:', event.event)
    }
  }

  // ============================================
  // 私有方法 - 心跳机制
  // ============================================

  /**
   * 从 chat 事件的 message 字段中提取可显示文本
   * 兼容多种格式: string, { content }, { text }, { delta }, content blocks
   */
  private extractTextFromMessage(message: unknown): string {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message === 'object' && message !== null) {
      const msg = message as Record<string, unknown>
      // 优先 content 字段 (OpenAI 格式)
      if (typeof msg.content === 'string') return msg.content
      // content 数组 (content blocks)
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((b: unknown) => {
            if (typeof b === 'string') return true
            return typeof b === 'object' && b !== null && (b as Record<string, unknown>).type === 'text'
          })
          .map((b: unknown) => typeof b === 'string' ? b : ((b as Record<string, unknown>).text || '') as string)
          .join('')
      }
      // text 字段
      if (typeof msg.text === 'string') return msg.text
      // delta 字段 (流式增量)
      if (typeof msg.delta === 'string') return msg.delta
    }
    return ''
  }

  /**
   * 将 Gateway agent event 转换为 ExecutionStep (用于 TaskHouse 展示)
   */
  private agentEventToStep(event: AgentEvent): ExecutionStep | null {
    const { stream, data, runId, seq, ts } = event
    const d = data as Record<string, any>

    switch (stream) {
      case 'assistant':
        if (d.delta || d.text) {
          return {
            id: `${runId}-${seq}`,
            type: 'thinking',
            content: String(d.delta || d.text || ''),
            timestamp: ts,
          }
        }
        return null

      case 'tool': {
        if (d.phase === 'start') {
          // 包含参数摘要到 content 中
          let content = `调用 ${d.name || 'unknown'}`
          if (d.args && typeof d.args === 'object') {
            const argsSummary = this.summarizeToolArgs(d.name, d.args)
            if (argsSummary) content += `\n${argsSummary}`
          }
          return {
            id: `${runId}-${seq}`,
            type: 'tool_call',
            content,
            toolName: String(d.name || ''),
            toolArgs: (d.args && typeof d.args === 'object') ? d.args as Record<string, unknown> : undefined,
            timestamp: ts,
          }
        }
        // tool result / update — 解析 OpenClaw 嵌套 result 结构
        const resultText = this.extractToolResultText(d)
        const isError = d.isError === true
        return {
          id: `${runId}-${seq}`,
          type: isError ? 'error' : 'tool_result',
          content: resultText.slice(0, 3000) || (isError ? '工具执行出错' : '(无输出)'),
          toolName: String(d.name || ''),
          duration: typeof d.durationMs === 'number' ? d.durationMs : undefined,
          timestamp: ts,
        }
      }

      case 'error':
        return {
          id: `${runId}-${seq}`,
          type: 'error',
          content: String(d.error || d.message || d.reason || 'Unknown error'),
          timestamp: ts,
        }

      default:
        return null
    }
  }

  /**
   * 从 OpenClaw 工具结果中提取文本
   * 格式: { result: { content: [{ type: "text", text: "..." }] } } 或简单字符串
   */
  private extractToolResultText(d: Record<string, any>): string {
    const raw = d.result ?? d.partialResult ?? d.output
    if (!raw) return ''
    if (typeof raw === 'string') return raw
    if (typeof raw === 'object' && raw !== null) {
      // OpenClaw 标准格式: { content: [{ type: "text", text: "..." }] }
      if (Array.isArray(raw.content)) {
        const texts = raw.content
          .filter((b: any) => typeof b === 'string' || (b && b.type === 'text'))
          .map((b: any) => typeof b === 'string' ? b : (b.text || ''))
        if (texts.length > 0) return texts.join('\n')
      }
      // 尝试 text 字段
      if (typeof raw.text === 'string') return raw.text
      // fallback: JSON 序列化
      try { return JSON.stringify(raw, null, 2) } catch { return String(raw) }
    }
    return String(raw)
  }

  /**
   * Nexus 经验记录 + XP 同步
   * 在 agent lifecycle/end 或 lifecycle/error 时调用
   * 
   * OpenClaw 模式: DD-OS Extension 的 agent_end hook 已通过 broadcast 推送 XP 更新，
   * 前端通过 ddos.nexus.xpUpdate 事件接收。此处仅尝试写经验记录到本地后端（如可用）。
   */
  private async recordNexusExperience(
    tracked: { taskTitle: string; toolNames: string[] },
    success: boolean,
    finalOutput: string
  ): Promise<void> {
    const nexusId = this.storeActions?.activeNexusId
    if (!nexusId) return

    const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'

    // 写入经验记录到本地后端（如可用，静默失败）
    try {
      const toolSeq = tracked.toolNames.length > 0 ? tracked.toolNames.join(' → ') : 'No tools'
      const summary = finalOutput.slice(0, 100).replace(/\n/g, ' ')
      await fetch(`${serverUrl}/nexuses/${encodeURIComponent(nexusId)}/experience`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: tracked.taskTitle.slice(0, 200),
          tools_used: tracked.toolNames,
          outcome: success ? 'success' : 'failure',
          key_insight: `Tool sequence: ${toolSeq}. Result: ${summary}...`,
        }),
      })
      console.log(`[OpenClaw] Recorded ${success ? 'success' : 'failure'} experience for Nexus: ${nexusId}`)
    } catch {
      // 本地后端不在线时静默失败（OpenClaw 模式下正常）
    }

    // Scoring 同步: Extension 已通过 ddos.nexus.xpUpdate 广播处理
  }

  /**
   * 生成工具参数的可读摘要
   */
  private summarizeToolArgs(toolName: string, args: Record<string, any>): string {
    if (!args || Object.keys(args).length === 0) return ''
    // 常见工具的关键参数提取
    const name = String(toolName || '').toLowerCase()
    if (name === 'exec' || name === 'bash' || name === 'run_command') {
      return args.command || args.cmd || args.script || ''
    }
    if (name === 'read' || name === 'read_file') {
      return args.path || args.file || args.filePath || ''
    }
    if (name === 'write' || name === 'write_file') {
      return `写入 ${args.path || args.file || args.filePath || '?'}`
    }
    if (name === 'web_search' || name === 'search') {
      return `搜索: ${args.query || args.q || ''}`
    }
    if (name === 'fetch' || name === 'web_fetch') {
      return args.url || ''
    }
    // 通用: 列出所有参数的 key=value 摘要
    const pairs = Object.entries(args)
      .map(([k, v]) => {
        const val = typeof v === 'string' ? v : JSON.stringify(v)
        return `${k}: ${String(val).slice(0, 80)}`
      })
      .slice(0, 4)
    return pairs.join(', ')
  }

  private startHeartbeat(): void {
    // 先清理所有旧定时器（不触发 resetHeartbeatTimeout 的重建逻辑）
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }

    // 不主动发送 ping 请求 (Gateway 不支持 ping 方法)
    // 依赖 Gateway 的 tick 事件和其他消息来重置超时
    // 如果超时时间内没有收到任何消息，视为连接断开
    this.heartbeatTimeoutTimer = window.setTimeout(() => {
      console.warn('[OpenClawService] Heartbeat timeout (no messages received), closing connection')
      this.ws?.close(4000, 'Heartbeat timeout')
    }, CONFIG.HEARTBEAT_TIMEOUT)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    // 仅清理，不重建定时器
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
  }

  private resetHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) {
      clearTimeout(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
    // 重新设置超时：收到任何消息后重置倒计时
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.heartbeatTimeoutTimer = window.setTimeout(() => {
        console.warn('[OpenClawService] Heartbeat timeout (no messages received), closing connection')
        this.ws?.close(4000, 'Heartbeat timeout')
      }, CONFIG.HEARTBEAT_TIMEOUT)
    }
  }

  // ============================================
  // 私有方法 - 重连机制
  // ============================================

  /**
   * Optimized reconnect for Gateway-announced restarts.
   * Waits the expected restart time, then tries with short intervals
   * instead of exponential backoff.
   */
  private scheduleRestartReconnect(initialWaitMs: number): void {
    this.reconnectAttempt = 0
    this.storeActions?.setConnectionStatus('reconnecting')

    let countdown = Math.ceil(initialWaitMs / 1000)
    this.storeActions?.setReconnectCountdown(countdown)

    this.countdownTimer = window.setInterval(() => {
      countdown--
      if (countdown > 0) {
        this.storeActions?.setReconnectCountdown(countdown)
      } else {
        if (this.countdownTimer) {
          clearInterval(this.countdownTimer)
          this.countdownTimer = null
        }
        this.storeActions?.setReconnectCountdown(null)
      }
    }, 1000)

    this.reconnectTimer = window.setTimeout(() => {
      // After initial wait, try reconnecting with short fixed intervals (2s)
      // instead of exponential backoff, since we know a restart is expected
      const RESTART_RETRY_INTERVAL = 2000
      const RESTART_MAX_RETRIES = 15  // Up to 30s of retries after initial wait
      let retryCount = 0

      const tryReconnect = () => {
        retryCount++
        console.log(`[OpenClawService] Restart reconnect attempt ${retryCount}/${RESTART_MAX_RETRIES}`)
        this.storeActions?.setReconnectAttempt(retryCount)

        this.connect().then(() => {
          // Success - connection handled by connect()
        }).catch(() => {
          if (retryCount < RESTART_MAX_RETRIES) {
            this.reconnectTimer = window.setTimeout(tryReconnect, RESTART_RETRY_INTERVAL)
          } else {
            console.warn('[OpenClawService] Restart reconnect exhausted, falling back to normal reconnect')
            this.reconnectAttempt = 0
            this.scheduleReconnect()
          }
        })
      }

      tryReconnect()
    }, initialWaitMs)
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempt >= CONFIG.RECONNECT_MAX_ATTEMPTS) {
      console.error('[OpenClawService] Max reconnect attempts reached')
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError('无法连接到服务器，已达到最大重试次数')
      this.storeActions?.addToast({
        type: 'error',
        title: '连接失败',
        message: '无法连接到服务器，请检查网络后手动重试',
      })
      return
    }

    const delay = Math.min(
      CONFIG.RECONNECT_BASE_DELAY * Math.pow(2, this.reconnectAttempt),
      CONFIG.RECONNECT_MAX_DELAY
    )

    console.log(`[OpenClawService] Scheduling reconnect in ${delay}ms (attempt ${this.reconnectAttempt + 1}/${CONFIG.RECONNECT_MAX_ATTEMPTS})`)

    this.storeActions?.setConnectionStatus('reconnecting')
    this.storeActions?.setReconnectAttempt(this.reconnectAttempt + 1)

    let countdown = Math.ceil(delay / 1000)
    this.storeActions?.setReconnectCountdown(countdown)

    this.countdownTimer = window.setInterval(() => {
      countdown--
      if (countdown > 0) {
        this.storeActions?.setReconnectCountdown(countdown)
      } else {
        if (this.countdownTimer) {
          clearInterval(this.countdownTimer)
          this.countdownTimer = null
        }
        this.storeActions?.setReconnectCountdown(null)
      }
    }, 1000)

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectAttempt++
      this.connect().catch(console.error)
    }, delay)
  }

  // ============================================
  // 私有方法 - 清理
  // ============================================

  private cleanup(): void {
    this.stopHeartbeat()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer)
      this.countdownTimer = null
    }

    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Connection closed'))
    })
    this.pendingRequests.clear()
    this.chatListeners.clear()
    this.agentRunTasks.clear()
    this.preRegisteredTasks.clear()
    this.chatChannelActiveRunIds.clear()
    this.runIdToListenerKey.clear()
  }

  // ============================================
  // 公开方法 - 聊天会话管理
  // ============================================

  /**
   * 生成客户端侧 sessionKey（不调用 Gateway）
   * chat.send 接受可选 sessionKey，Gateway 会自动创建/复用会话
   */
  createChatSession(_label?: string): string {
    // 客户端生成唯一 key，Gateway 会自动关联
    return `ddos-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 在会话中发送消息（核心方法）
   * Gateway chat.send 同时处理会话创建和消息发送
   * 调用前应先通过 subscribeChatSession 注册事件回调
   */
  async sendToSession(sessionKey: string, message: string, idempotencyKey: string): Promise<void> {
    await this.send('chat.send', {
      sessionKey,
      message,
      idempotencyKey,
    })
  }

  /**
   * 中止正在进行的聊天会话
   */
  async abortChatSession(sessionKey: string): Promise<void> {
    try {
      await this.send('chat.send', { sessionKey, message: '/stop' })
    } catch (err) {
      console.warn('[OpenClawService] Failed to abort chat session:', err)
    }
  }

  // ============================================
  // 公开方法 - 任务执行 (保留向后兼容)
  // ============================================

  /**
   * 通过 WebSocket 发送任务命令给 OpenClaw
   * chat.send 会自动创建/复用会话
   */
  async sendTaskCommand(prompt: string, context?: Record<string, unknown>): Promise<{ sessionKey: string }> {
    const sessionKey = this.createChatSession(prompt.slice(0, 50))

    await this.send('chat.send', {
      sessionKey,
      message: prompt,
      ...(context ? { context } : {}),
    })

    return { sessionKey }
  }
}

// 导出单例
export const openClawService = new OpenClawService()
