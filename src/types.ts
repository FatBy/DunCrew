import type { LucideIcon } from 'lucide-react'
import type { ComponentType } from 'react'

// ============================================
// UI 配置类型
// ============================================

export type ViewType = 'world' | 'task' | 'skill' | 'memory' | 'soul' | 'settings'

export interface HouseConfig {
  id: ViewType
  name: string
  icon: LucideIcon
  component: ComponentType
  themeColor: string
  description?: string
}

// ============================================
// UI 展示类型 (游戏化概念)
// ============================================

// 执行步骤 (用于任务屋详情展示)
export interface ExecutionStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'output' | 'error'
  content: string
  timestamp: number
  toolName?: string
  toolArgs?: Record<string, unknown>
  duration?: number
}

// 任务状态类型
export type TaskStatus = 
  | 'pending'      // 等待执行
  | 'queued'       // 已入队列
  | 'executing'    // 执行中
  | 'done'         // 完成
  | 'terminated'   // 用户终止
  | 'interrupted'  // 系统中断
  | 'retrying'     // 重试中
  | 'paused'       // 用户暂停

// 任务检查点 (断点续作支持)
export interface TaskCheckpoint {
  stepIndex: number                           // 当前步骤索引 (traceTools.length)
  subTaskId?: string                          // 当前子任务 ID (Quest 模式)
  savedAt: number                             // 保存时间
  // 恢复执行所需的完整上下文
  userPrompt: string                          // 原始用户输入
  nexusId?: string                            // 关联的 Nexus ID
  turnCount: number                           // 当前执行轮次
  messages: Array<{                           // LLM 对话历史 (精简版)
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | null
    tool_call_id?: string
    tool_calls?: Array<{
      id: string
      type: 'function'
      function: { name: string; arguments: string }
    }>
  }>
  traceTools: Array<{                         // 已执行的工具追踪
    name: string
    args: Record<string, unknown>
    status: 'success' | 'error'
    result: string
    latency: number
    order: number
  }>
}

// 任务项 (映射自 Session)
export interface TaskItem {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: 'high' | 'medium' | 'low'
  timestamp: string
  // 原始数据引用
  sessionKey?: string
  messageCount?: number
  // 执行详情 (用于任务屋展示)
  executionSteps?: ExecutionStep[]
  executionOutput?: string
  executionError?: string
  executionDuration?: number
  // Quest 风格复杂任务支持
  taskPlan?: TaskPlan           // 复杂任务的执行计划
  executionMode?: 'simple' | 'complex' | 'quest'
  // 任务监管字段
  retryCount?: number           // 已重试次数
  maxRetries?: number           // 最大重试次数 (默认 2)
  pausedAt?: number             // 暂停时间戳
  checkpoint?: TaskCheckpoint   // 断点信息
  startedAt?: number            // 开始执行时间
  completedAt?: number          // 完成时间
}

// ============================================
// Quest 风格任务执行系统
// ============================================

// 子任务状态
export type SubTaskStatus = 
  | 'pending'           // 等待执行
  | 'ready'             // 依赖已满足，可执行
  | 'executing'         // 执行中
  | 'done'              // 完成
  | 'failed'            // 失败
  | 'blocked'           // 被依赖阻塞
  | 'skipped'           // 用户跳过
  | 'paused_for_approval' // 等待用户确认

// 子任务定义（原子级任务单元）
export interface SubTask {
  id: string
  description: string           // 任务描述
  toolHint?: string             // 建议的工具名
  status: SubTaskStatus
  dependsOn: string[]           // 依赖的子任务 ID 列表（空 = 无依赖，可并行）
  result?: string               // 执行结果
  error?: string                // 错误信息
  startTime?: number
  endTime?: number
  retryCount?: number           // 已重试次数
  maxRetries?: number           // 最大重试次数（默认 2）
  approvalRequired?: boolean    // 需要用户确认
  approvalReason?: string       // 确认原因
  blockReason?: string          // 阻塞原因（依赖失败详情）
  // 执行追踪
  executionSteps?: ExecutionStep[]
}

// 任务计划状态
export type TaskPlanStatus = 'planning' | 'executing' | 'paused' | 'done' | 'failed' | 'cancelled'

// 任务计划（DAG 结构）
export interface TaskPlan {
  id: string
  title: string                 // AI 生成的任务标题
  userPrompt: string            // 用户原始需求
  subTasks: SubTask[]           // 子任务列表（构成 DAG）
  status: TaskPlanStatus
  nexusId?: string              // 关联的 Nexus ID（如果通过 Nexus 执行）
  createdAt: number
  startedAt?: number
  completedAt?: number
  progress: number              // 0-100 完成百分比
  // 执行配置
  maxParallel?: number          // 最大并行度（默认 3）
  autoApprove?: boolean         // 自动批准低风险操作
}


// 符号查询结果
export interface SymbolResult {
  symbol: string
  relation: 'calls' | 'called_by' | 'references' | 'referenced_by' | 'extends' | 'implements'
  filePath: string
  lineNumber: number
  codeSnippet: string
  symbolType: string
}

// 技能节点 (映射自 OpenClaw Skill)
export interface SkillNode {
  id: string
  name: string
  x: number
  y: number
  level: number
  unlocked: boolean
  dependencies: string[]
  // 原始数据引用
  skillName?: string
  category?: string  // 动态分类，由 API 返回决定 (如 global/local/extension)
  version?: string
  status?: 'active' | 'inactive' | 'error'
  description?: string
  // 兼容 Channel 映射
  channelId?: string
  connected?: boolean
  accountCount?: number
}

// 记忆条目 (映射自 Session Message)
export interface MemoryEntry {
  id: string
  title: string
  content: string
  type: 'long-term' | 'short-term'
  timestamp: string
  tags: string[]
  // 原始数据引用
  sessionKey?: string
  role?: 'user' | 'assistant'
}

// 冒险日志条目 (AI 生成的每日叙事摘要)
export type JournalMood = 'productive' | 'learning' | 'casual' | 'challenging'

export interface JournalEntry {
  id: string
  date: string                    // YYYY-MM-DD
  title: string                   // AI 生成的标题 (如 "第一次成功debug")
  narrative: string               // AI 生成的第一人称叙事 (~150字)
  mood: JournalMood               // 当日氛围
  keyFacts: string[]              // 从叙事中提取的关键事实
  memoryCount: number             // 当日原始记忆数量
  generatedAt: number             // 生成时间戳
}

// 灵魂维度 (用于雷达图可视化)
export interface SoulDimension {
  name: string
  value: number
}

// OpenClaw 灵魂 (基于 SOUL.md/IDENTITY.md)
export interface SoulIdentity {
  name: string           // 名字 (如 dreaming_donkey)
  essence: string        // 本质 (如 "被梦见的电子驴 AI 助手")
  vibe: string           // 氛围 (如 "温暖、聪明、有趣")
  symbol: string         // 符号 (如 🐴)
}

export interface SoulTruth {
  id: string
  title: string          // 标题 (如 "真诚帮助，不敷衍")
  principle: string      // 原则 (如 "Be genuinely helpful...")
  description: string    // 描述
}

export interface SoulBoundary {
  id: string
  rule: string           // 规则描述
}

export interface SoulConfig {
  identity: SoulIdentity
  coreTruths: SoulTruth[]
  boundaries: SoulBoundary[]
  vibeStatement: string  // 氛围宣言
  continuityNote: string // 连续性说明
  // 旧版兼容
  dimensions: SoulDimension[]
  prompts: {
    identity: string
    constraints: string
    goals: string
  }
}

// ============================================
// Soul Evolution (双轨制灵魂演化)
// ============================================

/** 用户偏好修正案 (Layer 2 灵魂) */
export interface SoulAmendment {
  id: string                          // amend-{timestamp}-{random}
  content: string                     // 自然语言偏好 (如 "偏好简洁回答")
  source: {
    nexusIds: string[]                // 观测到此行为的 Nexus
    evidence: string[]                // trace 摘要片段 (<=3条, 每条<=100字)
    detectedAt: number
  }
  status: 'draft' | 'approved' | 'rejected' | 'archived'
  weight: number                      // 0~1, 时间衰减
  hitCount: number                    // 被注入上下文次数
  createdAt: number
  confirmedAt?: number                // 用户批准时间
  lastHitAt?: number                  // 最后注入时间
}

/** MBTI 四轴原始分数 (-1~+1) */
export interface MBTIAxisScores {
  ei: number    // -1=I极端, +1=E极端
  sn: number    // -1=N极端, +1=S极端
  tf: number    // -1=F极端, +1=T极端
  jp: number    // -1=P极端, +1=J极端
}

/** Soul Evolution 配置常量 */
export const SOUL_EVOLUTION_CONFIG = {
  DECAY_HALF_LIFE_DAYS: 30,
  MIN_WEIGHT_THRESHOLD: 0.1,
  INJECTION_MIN_WEIGHT: 0.3,
  MAX_INJECTION_CHARS: 500,
  CHECK_INTERVAL_TASKS: 3,
  MIN_NEXUS_COUNT: 1,
  INITIAL_DRAFT_WEIGHT: 0.6,
  MBTI_MAX_MODIFIER: 0.4,
  DECAY_INTERVAL_MS: 6 * 60 * 60 * 1000,
  /** 工具偏好信号：最少总调用数 */
  TOOL_PREF_MIN_TOTAL_CALLS: 5,
  /** 工具偏好信号：最少跨 Nexus 数 */
  TOOL_PREF_MIN_NEXUS_SPREAD: 1,
  /** 成功模式信号：最少 Nexus 数 */
  SUCCESS_PATTERN_MIN_SCORINGS: 1,
  /** 风格偏移信号：最少历史总调用数 */
  STYLE_SHIFT_MIN_TOTAL_CALLS: 12,
} as const

// ============================================
// OpenClaw 原始 API 类型
// ============================================

// Session
export interface Session {
  key: string
  sessionId: string
  label?: string
  agentId?: string
  updatedAt: number
  createdAt?: number
  messageCount?: number
  lastMessage?: {
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }
}

// Channel (保留用于通道集成技能)
export type ChannelType = 
  | 'whatsapp' | 'telegram' | 'discord' | 'slack' 
  | 'irc' | 'signal' | 'webchat' | 'matrix'
  | 'teams' | 'feishu' | 'line' | 'nostr'

export interface ChannelAccount {
  accountId: string
  name?: string
  enabled: boolean
  connected: boolean
  connectedAt?: number
  error?: string
}

export interface Channel {
  id: ChannelType
  label: string
  enabled: boolean
  accounts: ChannelAccount[]
}

export interface ChannelsSnapshot {
  channelOrder: ChannelType[]
  channelLabels: Record<string, string>
  channels: Record<string, Channel>
}

// 技能来源
export type SkillSource = 'builtin' | 'community' | 'user'

// OpenClaw Skill (SKILL.md 文件系统)
export interface OpenClawSkill {
  name: string
  version?: string
  status: 'active' | 'inactive' | 'error'
  enabled: boolean
  description?: string
  location?: 'global' | 'local' | 'extension'
  path?: string
  // P1: 可执行技能扩展
  toolName?: string            // 注册的工具名 (如 "weather")
  toolNames?: string[]         // 多工具名列表 (如 ["search_codebase", "search_symbol"])
  toolType?: 'executable' | 'instruction'  // 工具类型: 可执行 / 指令型
  executable?: boolean         // 是否有 execute.py/.js
  inputs?: Record<string, any> // 输入参数 schema
  dangerLevel?: string         // safe | high | critical
  keywords?: string[]          // 语义触发关键词
  // OpenClaw 生态字段
  emoji?: string
  author?: string
  primaryEnv?: 'shell' | 'node' | 'python' | 'go' | 'rust' | 'browser'
  requires?: {
    bins?: string[]
    env?: string[]
    config?: string[]
    anyBins?: string[]
  }
  install?: OpenClawInstallSpec[]
  tags?: string[]
  source?: SkillSource           // 技能来源: builtin(系统内置) | community(社区下载) | user(用户自建)
  clawHub?: {
    slug?: string
    version?: string
    publishedAt?: string
    source?: 'local' | 'clawhub'
  }
}

// OpenClaw 安装规格 (brew/apt/node/go/uv/download)
export interface OpenClawInstallSpec {
  id: string
  kind: 'brew' | 'apt' | 'node' | 'go' | 'uv' | 'download'
  formula?: string        // brew
  package?: string        // apt
  module?: string         // node/go/uv
  url?: string            // download
  bins?: string[]
  label?: string
}

// ============================================
// ClawHub 市场类型
// ============================================

export interface ClawHubSearchResult {
  skills: ClawHubSkillSummary[]
  total: number
  page: number
  pageSize: number
}

export interface ClawHubSkillSummary {
  slug: string
  name: string
  description: string
  emoji?: string
  author: string
  version: string
  tags: string[]
  downloads: number
  updatedAt: string
}

export interface ClawHubSkillDetail extends ClawHubSkillSummary {
  readme: string
  requires?: { bins?: string[]; env?: string[]; anyBins?: string[] }
  install?: OpenClawInstallSpec[]
  fileList: string[]
}

export interface SkillPublishPayload {
  name: string
  slug: string
  description: string
  version: string
  skillArchive: Blob
  tags?: string[]
}

export interface ClawHubPublishResult {
  success: boolean
  slug: string
  version: string
  url: string
}

export interface ClawHubUser {
  username: string
  email: string
  avatar?: string
}

export interface ClawHubSuggestion {
  id: string
  type: 'skill-discovery'
  query: string
  matches: ClawHubSkillSummary[]
  triggerTool: string
  triggerTask: string
  dismissed?: boolean
}

export interface SkillsSnapshot {
  skills: OpenClawSkill[]
}

// Agent
export type AgentRunStatus = 'pending' | 'accepted' | 'running' | 'ok' | 'error' | 'denied' | 'thinking' | 'executing' | 'idle'

export interface AgentIdentity {
  agentId: string
  name?: string
  avatar?: string
  emoji?: string
}

export interface AgentEvent {
  runId: string
  seq: number
  stream: string
  ts: number
  data: Record<string, unknown>
}

// Devices/Presence
export type DeviceRole = 'operator' | 'node'

export interface Device {
  id: string
  role: DeviceRole
  name?: string
  platform?: string
  version?: string
  connectedAt: number
  lastSeenAt: number
  capabilities?: string[]
}

export interface PresenceSnapshot {
  devices: Record<string, Device>
  operators: string[]
  nodes: string[]
}

// Health
export interface HealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number
  version?: string
  channels?: Record<string, { connected: boolean; error?: string }>
}

// ============================================
// WebSocket 连接层类型
// ============================================

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface RequestMessage {
  type: 'req'
  id: string
  method: string
  params?: Record<string, unknown>
}

export interface ResponseMessage {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: { code: string; message: string }
}

export interface EventMessage {
  type: 'event'
  event: string
  payload: unknown
  seq?: number
  stateVersion?: number
}

export interface HelloOkPayload {
  protocol: number
  policy: { tickIntervalMs: number }
  auth?: { deviceToken: string; role: DeviceRole; scopes: string[] }
  presence?: PresenceSnapshot
  health?: HealthSnapshot
}

export type ServerMessage = ResponseMessage | EventMessage

// ============================================
// UI 辅助类型
// ============================================

export interface LogEntry {
  id: string
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  metadata?: Record<string, unknown>
}

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
  duration?: number
  onClick?: () => void
  persistent?: boolean // 当 true 时忽略 duration，直到手动关闭
}

// ============================================
// LLM / AI 类型
// ============================================

export interface LLMConfig {
  apiKey: string
  baseUrl: string
  model: string
  // API 协议格式: 'auto' 自动检测 | 'openai' OpenAI 兼容 | 'anthropic' Anthropic 原生
  apiFormat?: 'auto' | 'openai' | 'anthropic'
  // 独立的 Embedding API 配置（可选）
  embedApiKey?: string
  embedBaseUrl?: string
  embedModel?: string
}

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  timestamp: number
  error?: boolean
  execution?: ExecutionStatus
  /** 执行过程中创建的文件列表，用于在聊天中显示可点击的文件卡片 */
  createdFiles?: { filePath: string; fileName: string; message: string; fileSize?: number }[]
}

// ============================================
// 会话管理类型
// ============================================

export type ConversationType = 'general' | 'nexus'

export interface Conversation {
  id: string
  type: ConversationType
  title: string
  nexusId?: string          // 仅 'nexus' 类型使用
  messages: ChatMessage[]
  createdAt: number
  updatedAt: number
  pinned?: boolean
  autoTitled?: boolean      // 标记是否已自动生成标题
  messagesLoaded?: boolean  // 标记消息是否已从后端懒加载
  openClawSessionKey?: string  // OpenClaw Gateway 会话 key (同一对话复用，保持上下文连贯)
}

export interface ConversationMeta {
  id: string
  type: ConversationType
  title: string
  nexusId?: string
  messageCount: number
  createdAt: number
  updatedAt: number
  pinned?: boolean
  autoTitled?: boolean
}

export interface AISummary {
  content: string
  loading: boolean
  error: string | null
  timestamp: number
}

export interface TaskExecRequest {
  prompt: string
  context?: Record<string, unknown>
}

export interface TaskExecResponse {
  taskId: string
  status: 'pending' | 'running' | 'done' | 'error'
  output?: string
  error?: string
}

// ============================================
// AI 执行类型
// ============================================

export interface ExecutionCommand {
  action: 'sendTask'
  prompt: string
  context?: Record<string, unknown>
}

export interface ExecutionStatus {
  id: string
  status: 'pending' | 'running' | 'success' | 'error' | 'suggestion'
  sessionKey?: string
  output?: string           // 累积的输出文本
  outputLines?: string[]    // 按行分割，供虚拟化渲染
  currentOffset?: number    // 当前读取位置
  error?: string
  timestamp: number
}

// P3: 危险操作审批请求
export interface ApprovalRequest {
  id: string
  toolName: string
  args: Record<string, unknown>
  dangerLevel: 'high' | 'critical'
  reason: string
  timestamp: number
}

// P2: 执行追踪
export interface ExecTrace {
  id: string
  task: string
  tools: ExecTraceToolCall[]
  success: boolean
  failureReason?: string
  duration: number
  timestamp: number
  tags: string[]
  // Observer 元数据 (用于模式分析)
  turnCount?: number           // ReAct 循环轮次
  errorCount?: number          // 失败的工具调用次数
  retryCount?: number          // 重试次数
  skillIds?: string[]          // 触发的技能 ID
  activeNexusId?: string       // 执行时的活跃 Nexus
  /** V2: 碱基序列字符串，如 "X-P-E-V-E" */
  baseSequence?: string
  /** V2: 碱基分布统计 */
  baseDistribution?: { E: number; P: number; V: number; X: number }
}

export interface ExecTraceToolCall {
  name: string
  args: Record<string, unknown>
  status: 'success' | 'error'
  result?: string
  latency: number
  order: number
  /** V2: 碱基类型标注 — E(Execute)/P(Plan)/V(Verify)/X(Explore) */
  baseType?: 'E' | 'P' | 'V' | 'X'
  /** V2: P 碱基的推理文本摘要（仅 baseType='P' 时有值） */
  reasoningSummary?: string
}

// P0: 动态工具信息
export interface ToolInfo {
  name: string
  type: 'builtin' | 'plugin' | 'instruction' | 'mcp'
  description?: string
  inputs?: Record<string, any>
  dangerLevel?: string
  version?: string
  server?: string  // MCP 服务器名称
}

// ============================================
// World Genesis 类型
// ============================================

// [已废弃] 固定类型限制已移除，改为基于 ID 动态生成视觉样式

export interface VisualDNA {
  primaryHue: number        // 0-360
  primarySaturation: number // 40-100
  primaryLightness: number  // 30-70
  accentHue: number         // 0-360
  textureMode: 'solid' | 'wireframe' | 'gradient'
  glowIntensity: number     // 0-1
  geometryVariant: number   // 0-3 (sub-variant within archetype)
  // AI 生图：自定义图片 URL (高级用户)
  customImageUrl?: string
}

export interface GridPosition {
  gridX: number
  gridY: number
}

export interface NexusEntity {
  id: string
  position: GridPosition
  // V2: 评分系统 (替代旧 xp/level)
  scoring: NexusScoring
  visualDNA: VisualDNA
  label?: string            // LLM-generated name
  constructionProgress: number // 0-1 (1 = fully built)
  createdAt: number
  // Phase 2: 涌现式 Nexus
  boundSkillIds?: string[]  // 绑定的 Skill ID 列表
  flavorText?: string       // LLM 生成的描述
  lastUsedAt?: number       // 最后使用时间（用于 XP 计算）
  // Phase 3: 模型绑定
  customModel?: {           // 自定义模型 (null = 使用全局配置)
    baseUrl: string
    model: string
    apiKey?: string         // 空则用全局 key
  }
  // Phase 4: File-based Nexus (NEXUS.md)
  sopContent?: string             // NEXUS.md Markdown 正文 (Mission + SOP)
  triggers?: string[]             // 自动激活关键词
  version?: string                // Nexus 版本
  location?: 'local' | 'bundled'  // 来源
  path?: string                   // 本地路径
  projectPath?: string            // 关联的项目根目录 (绝对路径)
  skillsConfirmed?: boolean       // 技能配置是否已经过用户确认
  // Phase 5: 目标函数驱动 (Objective-Driven Execution)
  objective?: string              // 核心目标函数 (任务终点定义)
  metrics?: string[]              // 验收标准 (布尔型检查点)
  strategy?: string               // 动态调整策略 (失败时的重试方案)
  // 元数据
  updatedAt?: number              // 最后更新时间
  source?: string                 // 来源标识 (e.g., 'openclaw:agent-id')
  agentIdentity?: {               // OpenClaw Agent identity
    name?: string
    emoji?: string
  }
  // Phase 6: SOP 自进化
  sopRewriteInfo?: {              // SOP 最近一次自动改写信息
    rewrittenAt: number           // 改写时间戳
    previousVersion?: string      // 改写前版本号
    triggerLevel?: string         // 触发级别 (EMERGENCY/STANDARD/GRADUAL)
    basedOnExecutions?: number    // 基于多少次执行数据
  }
  sopEvolutionData?: {            // SOP 进化运行时数据
    isGolden: boolean             // 是否达到 Golden 状态
    ema: number                   // EMA fitness (0-1)
    totalExecutions: number       // 总执行次数
    goldenPathSummary?: {         // LLM 蒸馏的 Golden Path 总结
      taskCategories: Array<{
        name: string
        typicalToolChain: string[]
        estimatedDurationMs: number
        tips: string
      }>
      phaseInsights: Array<{
        phaseName: string
        status: 'golden' | 'stable' | 'bottleneck'
        insight: string
      }>
      commonPitfalls: string[]
      lastSummarizedAt: number
      basedOnExecutions: number
    }
  }
}

// Nexus 经验记录
export interface NexusExperience {
  title: string
  outcome: 'success' | 'failure'
  content: string
}

export interface CameraState {
  x: number
  y: number
  zoom: number              // 0.5-2.0
}

export interface RenderSettings {
  showGrid: boolean
  showParticles: boolean
  showLabels: boolean
  enableGlow: boolean
}

// ============================================
// Observer / 涌现式 Nexus 类型
// ============================================

export type TriggerType = 'frequency' | 'complexity' | 'dependency' | 'periodic' | 'cross-skill'

export interface TriggerPattern {
  type: TriggerType
  confidence: number           // 0-1 置信度
  evidence: string[]           // 证据摘要（相关消息片段）
  detectedAt: number
  // 新增：技能和SOP推荐
  suggestedSkills?: string[]   // 建议绑定的工具/技能名列表
  suggestedSOP?: string        // 建议的系统提示词/作业程序
}

export interface BuildProposal {
  id: string
  triggerPattern: TriggerPattern
  suggestedName: string        // 建议的 Nexus 名称
  previewVisualDNA: VisualDNA
  boundSkillIds?: string[]     // 多技能绑定列表
  sopContent?: string          // 新增：系统提示词/SOP
  purposeSummary: string       // 一句话概括此 Nexus 的功能目标
  status: 'pending' | 'accepted' | 'rejected'
  createdAt: number
}

export interface BehaviorRecord {
  id: string
  type: 'chat' | 'task' | 'skill_use'
  content: string              // 消息内容或任务描述
  keywords: string[]           // 提取的关键词
  timestamp: number
  metadata?: Record<string, unknown>
}

// ============================================
// UI 设置类型
// ============================================

export interface UISettings {
  fontScale: number            // 0.8 - 1.5
  logExpanded: boolean         // 执行日志是否默认展开
}

// ============================================
// 技能统计类型 (能力仪表盘)
// ============================================

// 单个技能的统计数据
export interface SkillStats {
  skillId: string              // 技能 ID
  callCount: number            // 被 Agent 调用次数
  activationCount: number      // 被用户主动激活次数
  successCount: number         // 执行成功次数
  failureCount: number         // 执行失败次数
  lastUsedAt: number           // 最后使用时间戳
  firstUsedAt: number          // 首次使用时间戳
}

// 能力域定义
export type AbilityDomain = 'development' | 'creative' | 'system' | 'knowledge' | 'social' | 'security' | 'utility'

// 能力域配置
export interface AbilityDomainConfig {
  id: AbilityDomain
  name: string                 // 中文名
  color: string                // 主题色
  keywords: string[]           // 分类关键词
}

// 能力域统计
export interface DomainStats {
  domain: AbilityDomain
  skillCount: number           // 该域技能数量
  totalCalls: number           // 总调用次数
  totalSuccess: number         // 总成功次数
  successRate: number          // 成功率 (0-100)
  abilityScore: number         // 能力评分
  trend: 'up' | 'down' | 'stable'  // 趋势
  trendPercent: number         // 趋势变化百分比
}

// 全局统计快照
export interface AbilitySnapshot {
  totalSkills: number          // 总技能数
  totalScore: number           // 总能力分
  domains: DomainStats[]       // 各域统计
  recentActive: string[]       // 最近活跃技能 ID
  weeklyGrowth: {
    newSkills: number          // 新增技能数
    scoreChange: number        // 分数变化
    successRateChange: number  // 成功率变化
  }
  milestones: string[]         // 已达成里程碑
  updatedAt: number            // 更新时间
}

// ============================================
// MBTI 灵魂形象类型
// ============================================

export type MBTIType = 'intj' | 'intp' | 'entj' | 'entp'
  | 'infj' | 'infp' | 'enfj' | 'enfp'
  | 'istj' | 'isfj' | 'estj' | 'esfj'
  | 'istp' | 'isfp' | 'estp' | 'esfp'

export interface MBTIResult {
  type: MBTIType
  animal: string       // "octopus", "cat", etc.
  animalZh: string     // "章鱼", "猫", etc.
  group: string        // "分析家", "外交官", etc.
  trait: string        // 一句话特质描述
  confidence: number   // 0-1
  source: 'rule' | 'llm'
}

// ============================================
// Gene Pool 自愈基因库类型
// ============================================

// 基因类别
export type GeneCategory = 
  | 'repair'      // 修复基因 (error→success 模式)
  | 'optimize'    // 优化基因
  | 'pattern'     // 通用模式

// Nexus 能力信息
export interface NexusCapabilityInfo {
  nexusId: string           // nexus 唯一标识
  nexusName: string         // 显示名称
  description: string       // 能力描述
  capabilities: string[]    // 能力标签 ['漫画', '剧情', '角色设计']
  dirPath: string           // nexuses/xxx/
}

// Nexus 产出物信息
export interface NexusArtifactInfo {
  nexusId: string           // 产出此文件的 Nexus
  path: string              // 文件路径
  name: string              // 文件名/产出物名称
  type: string              // 类型 (story-outline, character-design, ppt, code...)
  size: number              // 文件大小
  description?: string      // 产出物描述
  linkedArtifacts?: string[] // 关联的其他产出物 ID
}

// 基因: 一条可复用的修复/优化模式
export interface Gene {
  id: string                      // gene-{timestamp} 或 seed-{name}
  category: GeneCategory
  signals_match: string[]         // 触发信号 (支持 /regex/flags 和子串匹配)
  strategy: string[]              // 修复策略步骤 (自然语言，V2: 抽象模式而非具体参数值)
  preconditions?: string[]        // V2: 前置条件 — 什么情况下该激活此基因
  antiPatterns?: string[]         // V2: 反模式 — 什么情况下不该使用此基因
  source: {
    traceId?: string              // 来源 trace ID
    nexusId?: string              // 产生此基因的 Nexus
    createdAt: number
    isSeed?: boolean              // V2: 是否为内置种子基因
  }
  metadata: {
    confidence: number            // 0-1 置信度
    useCount: number              // 被使用次数
    successCount: number          // 使用后成功次数
    lastUsedAt?: number
  }
}

// 基因匹配结果
export interface GeneMatch {
  gene: Gene
  score: number                   // 匹配分数 (匹配的信号数量)
  matchedSignals: string[]        // 命中的信号列表
}

// 胶囊: 基因被使用一次的完整上下文快照
export interface Capsule {
  id: string
  geneId: string
  trigger: string[]               // 触发时的错误信号
  outcome: 'success' | 'failure'
  nexusId?: string
  timestamp: number
}

// ============================================
// V2: Agent 事件状态机
// ============================================

// Agent 执行阶段
export type AgentPhase =
  | 'idle'               // 空闲
  | 'planning'           // 任务规划
  | 'executing'          // 工具执行中
  | 'reflecting'         // Reflexion 反思中
  | 'compacting'         // 上下文压缩中
  | 'waiting_approval'   // 等待用户审批
  | 'recovering'         // 错误恢复中（模型切换/重试）
  | 'done'               // 正常完成
  | 'error'              // 异常终止
  | 'aborted'            // 用户终止

// 工具调用摘要 (已完成的工具执行记录)
export interface ToolCallSummary {
  callId: string
  toolName: string
  args: Record<string, unknown>
  status: 'success' | 'error'
  result?: string                   // 成功时的结果（截断）
  error?: string                    // 失败时的错误信息
  durationMs: number
  isMutating: boolean               // 是否修改类操作
  timestamp: number
}

// 工具执行结果 (按 callId 索引)
export interface ToolResult {
  callId: string
  toolName: string
  success: boolean
  output: string
  durationMs: number
  timestamp: number
}

// 故障原因分类
export type FailoverReason =
  | 'auth'               // API Key 无效或过期
  | 'rate_limit'         // 速率限制
  | 'context_overflow'   // 上下文超出模型窗口
  | 'timeout'            // 请求超时
  | 'model_error'        // 模型返回错误
  | 'network'            // 网络连接失败
  | 'billing'            // 账户余额不足

// Agent 运行状态 (有状态事件转换器核心)
export interface AgentRunState {
  // ── 生命周期 ──
  runId: string
  seq: number                       // 单调递增事件序号
  phase: AgentPhase
  aborted: boolean
  timedOut: boolean

  // ── 消息流 ──
  assistantTexts: string[]
  deltaBuffer: string
  blockState: {
    thinking: boolean
    codeBlock: boolean
  }
  assistantMessageIndex: number
  lastStreamedText: string | undefined
  suppressLateChunks: boolean

  // ── 推理流 ──
  reasoningMode: 'off' | 'on' | 'stream'
  reasoningBuffer: string
  reasoningStreamOpen: boolean

  // ── 工具执行 ──
  currentTool: {
    name: string
    callId: string
    startTime: number
    args: Record<string, unknown>
  } | null
  toolHistory: ToolCallSummary[]
  toolResultById: Map<string, ToolResult>
  lastToolError: {
    toolName: string
    error: string
    isMutating: boolean
  } | undefined

  // ── 上下文压缩 ──
  compactionInFlight: boolean
  compactionCount: number
  tokensBefore: number
  tokensAfter: number

  // ── 错误恢复 ──
  failoverReason: FailoverReason | null
  attemptIndex: number
  modelChain: string[]
  currentModel: string

  // ── Nexus 上下文 ──
  activeNexusId: string | null
  nexusSopInjected: boolean
  nexusScore: number
  planProgress: {
    total: number
    completed: number
    currentStep: string
  } | null

  // ── Critic/Reflexion ──
  reflexionCount: number
  criticPending: boolean
  approvalPending: boolean
  approvalRequest: ApprovalRequest | null

  // ── 子智能体追踪 ──
  activeChildren: string[]
  childrenCompleted: number
  childrenFailed: number

  // ── Token 预算 ──
  tokenBudget: number
  tokenUsed: number
  tokenPercentage: number
}

// AgentRunState 工厂函数参数
export function createInitialRunState(runId: string, model: string, nexusId?: string): AgentRunState {
  return {
    runId,
    seq: 0,
    phase: 'idle',
    aborted: false,
    timedOut: false,
    assistantTexts: [],
    deltaBuffer: '',
    blockState: { thinking: false, codeBlock: false },
    assistantMessageIndex: 0,
    lastStreamedText: undefined,
    suppressLateChunks: false,
    reasoningMode: 'off',
    reasoningBuffer: '',
    reasoningStreamOpen: false,
    currentTool: null,
    toolHistory: [],
    toolResultById: new Map(),
    lastToolError: undefined,
    compactionInFlight: false,
    compactionCount: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    failoverReason: null,
    attemptIndex: 0,
    modelChain: [model],
    currentModel: model,
    activeNexusId: nexusId ?? null,
    nexusSopInjected: false,
    nexusScore: 50,
    planProgress: null,
    reflexionCount: 0,
    criticPending: false,
    approvalPending: false,
    approvalRequest: null,
    activeChildren: [],
    childrenCompleted: 0,
    childrenFailed: 0,
    tokenBudget: 0,
    tokenUsed: 0,
    tokenPercentage: 0,
  }
}

// ============================================
// V2: Agent 事件系统
// ============================================

// 事件流分类
export type AgentEventStream =
  | 'lifecycle'     // 生命周期
  | 'assistant'     // 助手消息流
  | 'tool'          // 工具执行
  | 'context'       // 上下文管理
  | 'recovery'      // 错误恢复
  | 'reflexion'     // 反思/Critic
  | 'approval'      // 审批
  | 'plan'          // 计划追踪
  | 'child'         // 子智能体

// 事件信封 (所有事件的通用包装)
export interface AgentEventEnvelope {
  runId: string
  seq: number
  ts: number
  stream: AgentEventStream
  type: string
  data: Record<string, unknown>
  sessionId?: string
  nexusId?: string
}

// ── lifecycle 事件 payload ──
export interface RunStartData {
  runId: string
  nexusId: string | null
  model: string
  nexusScore: number
  tokenBudget: number
}

export interface PhaseChangeData {
  from: AgentPhase
  to: AgentPhase
  reason?: string
}

export interface RunEndData {
  success: boolean
  turns: number
  tokensUsed: number
  toolsCalled: number
  reflexionCount: number
  compactionCount: number
  durationMs: number
  scoreChange: number
  childrenSpawned: number
  childrenCompleted: number
}

// ── tool 事件 payload ──
export interface ToolStartData {
  toolName: string
  callId: string
  args: Record<string, unknown>
  isMutating: boolean
}

export interface ToolEndData {
  callId: string
  toolName: string
  success: boolean
  result: string
  durationMs: number
  dimensionScoreChange?: number
}

export interface ToolErrorData {
  callId: string
  toolName: string
  error: string
  isMutating: boolean
}

// ── context 事件 payload ──
export interface CompactionStartData {
  tokensBefore: number
  trigger: 'overflow' | 'budget' | 'proactive'
}

export interface CompactionEndData {
  tokensAfter: number
  tokensBefore: number
  success: boolean
  summary?: string
}

export interface TokenWarningData {
  used: number
  budget: number
  percentage: number
}

// ── recovery 事件 payload ──
export interface FailoverStartData {
  reason: FailoverReason
  fromModel: string
  toModel: string
  attemptIndex: number
}

export interface RetryData {
  attemptIndex: number
  backoffMs: number
  reason: FailoverReason
}

// ── reflexion 事件 payload ──
export interface ReflexionStartData {
  failedTool: string
  error: string
  reflexionIndex: number
  nexusScore: number
}

export interface ReflexionEndData {
  insight: string
  strategy: string
  reflexionIndex: number
}

// ── approval 事件 payload ──
export interface ApprovalRequiredData {
  requestId: string
  command: string
  toolName: string
  risk: 'high' | 'critical'
  reason: string
}

export interface ApprovalResolvedData {
  requestId: string
  approved: boolean
  resolvedBy: 'user' | 'auto'
}

// ── plan 事件 payload ──
export interface StepStartData {
  stepIndex: number
  totalSteps: number
  description: string
  dependsOn: string[]
}

export interface StepCompleteData {
  stepIndex: number
  success: boolean
  result?: string
  error?: string
  durationMs: number
}

// ── child 事件 payload ──
export interface ChildSpawnedData {
  childRunId: string
  childSessionId: string
  nexusId: string
  task: string
  depth: number
  model: string
}

export interface ChildProgressData {
  childRunId: string
  phase: AgentPhase
  turns: number
  currentTool?: string
}

export interface ChildCompletedData {
  childRunId: string
  nexusId: string
  success: boolean
  result?: string
  error?: string
  durationMs: number
  scoreChange: number
  genesHarvested: number
}

// ============================================
// V2: Nexus 评分系统 (替代 XP/Level)
// ============================================

// 分数等级
export type ScoreTier = 'Expert' | 'Capable' | 'Learning' | 'Weak'

// 工具维度分数
export interface ToolDimensionScore {
  toolName: string
  score: number                     // 0-100
  calls: number
  successes: number
  failures: number
  avgDurationMs: number
  lastUsedAt: number
}

// 最近执行记录
export interface RecentRunEntry {
  runId: string
  task: string                      // 截断 80 字
  success: boolean
  scoreChange: number               // +5, -8 等
  turns: number
  toolsCalled: string[]
  durationMs: number
  timestamp: number
  genesHarvested?: number
}

// Nexus 评分
export interface NexusScoring {
  score: number                     // 0-100, 初始 50
  streak: number                    // 正=连胜, 负=连败
  totalRuns: number
  successCount: number
  failureCount: number
  successRate: number               // 0-1
  dimensions: Record<string, ToolDimensionScore>
  recentRuns: RecentRunEntry[]      // 最多 20 条
  lastUpdated: number
}

// 计分规则常量
export const SCORING_RULES = {
  SUCCESS_BASE: 5,
  SUCCESS_STREAK_BONUS: 1,
  SUCCESS_STREAK_MAX_BONUS: 5,
  SUCCESS_COMPLEXITY_BONUS: 3,
  SCORE_MAX: 100,
  FAILURE_BASE: -8,
  FAILURE_STREAK_PENALTY: -2,
  FAILURE_STREAK_MAX_PENALTY: -10,
  SCORE_MIN: 0,
  TOOL_SUCCESS_DELTA: 2,
  TOOL_FAILURE_DELTA: -3,
  EXPERT_THRESHOLD: 80,
  CAPABLE_THRESHOLD: 60,
  LEARNING_THRESHOLD: 40,
  INITIAL_SCORE: 0,
  MAX_RECENT_RUNS: 20,
} as const

// 分数等级计算
export function getScoreTier(score: number): ScoreTier {
  if (score >= SCORING_RULES.EXPERT_THRESHOLD) return 'Expert'
  if (score >= SCORING_RULES.CAPABLE_THRESHOLD) return 'Capable'
  if (score >= SCORING_RULES.LEARNING_THRESHOLD) return 'Learning'
  return 'Weak'
}

// 分数等级颜色
export const SCORE_TIER_COLORS: Record<ScoreTier, string> = {
  Expert:   '#22c55e',
  Capable:  '#3b82f6',
  Learning: '#f59e0b',
  Weak:     '#ef4444',
}

// 分数驱动行为配置
export interface ScoreDrivenBehavior {
  criticFrequency: 'all_mutating' | 'standard' | 'reduced'
  reflexionDepth: 'deep' | 'standard' | 'shallow'
  sopBudgetRatio: number
  memoryBudgetRatio: number
  geneInjection: boolean
  fewShotInjection: boolean
  autoApproveThreshold: 'high' | 'critical' | 'none'
}

export const SCORE_BEHAVIORS: Record<ScoreTier, ScoreDrivenBehavior> = {
  Expert: {
    criticFrequency: 'reduced',
    reflexionDepth: 'shallow',
    sopBudgetRatio: 0.08,
    memoryBudgetRatio: 0.10,
    geneInjection: false,
    fewShotInjection: false,
    autoApproveThreshold: 'high',
  },
  Capable: {
    criticFrequency: 'standard',
    reflexionDepth: 'standard',
    sopBudgetRatio: 0.15,
    memoryBudgetRatio: 0.20,
    geneInjection: true,
    fewShotInjection: false,
    autoApproveThreshold: 'none',
  },
  Learning: {
    criticFrequency: 'standard',
    reflexionDepth: 'deep',
    sopBudgetRatio: 0.15,
    memoryBudgetRatio: 0.25,
    geneInjection: true,
    fewShotInjection: false,
    autoApproveThreshold: 'none',
  },
  Weak: {
    criticFrequency: 'all_mutating',
    reflexionDepth: 'deep',
    sopBudgetRatio: 0.20,
    memoryBudgetRatio: 0.25,
    geneInjection: true,
    fewShotInjection: true,
    autoApproveThreshold: 'none',
  },
}

// 创建初始评分
export function createInitialScoring(): NexusScoring {
  return {
    score: SCORING_RULES.INITIAL_SCORE,
    streak: 0,
    totalRuns: 0,
    successCount: 0,
    failureCount: 0,
    successRate: 0,
    dimensions: {},
    recentRuns: [],
    lastUpdated: Date.now(),
  }
}

/** 从 NexusScoring 映射到视觉等级 (1-5)，供渲染器使用 */
export function scoringToVisualLevel(scoring?: NexusScoring): number {
  const score = scoring?.score ?? 0
  if (score >= 80) return 5   // Expert
  if (score >= 60) return 4   // Capable
  if (score >= 40) return 3   // Learning
  if (score >= 20) return 2   // Weak
  return 1                    // New
}

// ============================================
// V2: NexusContextEngine 接口
// ============================================

// assemble 参数和结果
export interface AssembleParams {
  sessionId: string
  messages: ChatMessage[]
  tokenBudget: number
  taskDescription?: string
}

export interface AssembleResult {
  messages: ChatMessage[]
  estimatedTokens: number
  systemPromptAddition?: string
  budgetBreakdown: {
    system: number
    sop: number
    memory: number
    genes: number
    skills: number
    history: number
  }
}

// compact 参数和结果
export interface CompactParams {
  sessionId: string
  tokenBudget: number
  trigger: 'overflow' | 'budget' | 'proactive'
  currentTokenCount: number
  /** 需要压缩的消息历史（compact 必须看到实际内容才能生成有效摘要） */
  messages?: Array<{ role: string; content: string }>
}

export interface CompactResult {
  ok: boolean
  compacted: boolean
  tokensBefore: number
  tokensAfter?: number
  summary?: string
  reason?: string
}

// ingest 参数和结果
export interface IngestParams {
  sessionId: string
  message: ChatMessage
}

export interface IngestResult {
  ingested: boolean
}

// afterTurn 参数
export interface AfterTurnParams {
  sessionId: string
  messages: ChatMessage[]
  prePromptMessageCount: number
  tokenBudget: number
  toolResults: ToolCallSummary[]
  runState: AgentRunState
}

// bootstrap 参数和结果
export interface BootstrapParams {
  sessionId: string
}

export interface BootstrapResult {
  bootstrapped: boolean
  importedMessages?: number
  memoriesLoaded?: number
  reason?: string
}

// prepareChildSpawn 参数和结果
export interface PrepareChildSpawnParams {
  parentSessionId: string
  childSessionId: string
  childNexusId: string
  inheritContext: boolean
}

export interface ChildSpawnPreparation {
  contextSummary?: string
  sharedGenes?: Gene[]
  rollback: () => Promise<void>
}

// onChildEnded 参数
export interface OnChildEndedParams {
  childSessionId: string
  childNexusId: string
  reason: 'completed' | 'error' | 'timeout' | 'killed'
  outcome?: {
    success: boolean
    result?: string
    error?: string
    tokensUsed?: number
    toolsCalled?: string[]
    scoreChange?: number
    genesHarvested?: Gene[]
  }
}

// NexusContextEngine 接口
export interface NexusContextEngine {
  readonly info: {
    id: string
    nexusId: string
    name: string
  }

  // 必需方法
  assemble(params: AssembleParams): AssembleResult
  compact(params: CompactParams): Promise<CompactResult>
  ingest(params: IngestParams): IngestResult

  // 可选方法
  afterTurn?(params: AfterTurnParams): Promise<void>
  bootstrap?(params: BootstrapParams): Promise<BootstrapResult>
  prepareChildSpawn?(params: PrepareChildSpawnParams): Promise<ChildSpawnPreparation>
  onChildEnded?(params: OnChildEndedParams): Promise<void>
  dispose?(): Promise<void>

  /** Memory Flush: ReAct 循环结束后提炼本轮认知（可选，由 LocalClawService 调用） */
  flushMemory?(toolHistory: ToolCallSummary[]): Promise<void>
}

// ============================================
// V2: 子智能体系统
// ============================================

// 子智能体生成参数
export interface SpawnChildParams {
  task: string
  nexusId?: string
  model?: string
  mode: 'run' | 'session'
  cleanup: 'delete' | 'keep'
  timeout?: number
  inheritContext?: boolean
  shareGenes?: boolean
  priority?: 'high' | 'normal' | 'background'
}

// 子智能体运行记录
export interface ChildRunRecord {
  runId: string
  childSessionId: string
  parentSessionId: string
  nexusId: string
  nexusLabel: string
  task: string
  status: 'pending' | 'running' | 'completed' | 'error' | 'timeout' | 'killed'
  outcome?: ChildOutcome
  depth: number
  model: string
  createdAt: number
  startedAt?: number
  endedAt?: number
  turns: number
  toolsCalled: string[]
  currentPhase: AgentPhase
}

// 子智能体执行结果
export interface ChildOutcome {
  success: boolean
  result?: string
  error?: string
  tokensUsed: number
  durationMs: number
  scoreChange: number
  genesHarvested: number
}

// 子智能体生成结果
export interface SpawnChildResult {
  status: 'accepted' | 'forbidden' | 'error'
  childSessionId?: string
  runId?: string
  error?: string
  nexusId?: string
}

// 子智能体限制常量
export const CHILD_LIMITS = {
  maxSpawnDepth: 2,
  maxChildrenPerSession: 5,
  defaultTimeoutSeconds: 300,
} as const

// ============================================
// V2: MemoryStore 搜索结果
// ============================================

export interface MemorySearchResult {
  id: string
  score: number                     // 0-1
  snippet: string
  content?: string                  // 完整内容 (后端返回)
  source: string                    // 'memory' | 'exec_trace' | 'gene' | 'nexus_xp' | 'session' | 'l1_memory'
  nexusId?: string
  createdAt?: number                // Unix 毫秒时间戳
  confidence?: number               // 后端返回的置信度 (0-1)
  tags?: string[]
  metadata?: Record<string, unknown>
}

// 搜索算法配置
export const SEARCH_CONFIG = {
  FTS_WEIGHT: 0.3,
  VECTOR_WEIGHT: 0.7,
  TEMPORAL_DECAY_HALF_LIFE_DAYS: 30,
  MMR_LAMBDA: 0.7,
  SNIPPET_MAX_CHARS: 700,
  DEFAULT_MAX_RESULTS: 10,
  DEFAULT_MIN_SCORE: 0.3,
  DEDUP_SIMILARITY_THRESHOLD: 0.85,
} as const

// ============================================
// V2: 会话持久化
// ============================================

export interface SessionMeta {
  id: string
  title: string
  type: 'general' | 'nexus'
  nexusId?: string
  messageCount: number
  createdAt: number
  updatedAt: number
  lastMessagePreview?: string
  hasCheckpoint: boolean
}

// ============================================
// V2: 错误恢复配置
// ============================================

export const FAILOVER_STRATEGIES: Record<FailoverReason, string[]> = {
  auth:              ['rotate_api_key', 'prompt_user'],
  rate_limit:        ['exponential_backoff', 'switch_model'],
  context_overflow:  ['compact_context', 'truncate_tool_results'],
  timeout:           ['retry_with_backoff', 'switch_model'],
  model_error:       ['switch_model', 'simplify_prompt'],
  network:           ['retry_with_backoff', 'prompt_user'],
  billing:           ['switch_model', 'prompt_user'],
}

export const BACKOFF_CONFIG = {
  initialMs: 250,
  maxMs: 1500,
  factor: 2,
  maxAttempts: 3,
} as const

// ============================================
// V2: AgentEventBus 接口
// ============================================

export interface AgentEventBus {
  emit(event: Omit<AgentEventEnvelope, 'seq' | 'ts'>): void
  subscribe(listener: (event: AgentEventEnvelope) => void): () => void
  subscribeStream(stream: AgentEventStream, listener: (event: AgentEventEnvelope) => void): () => void
  getState(): AgentRunState
  getEvents(runId: string): AgentEventEnvelope[]
  reset(): void
}

// 终止操作粒度
export type AbortTarget =
  | { level: 'run' }
  | { level: 'tool'; callId: string }
  | { level: 'child'; childRunId: string }
  | { level: 'step'; stepIndex: number }
  | { level: 'compact' }

// ============================================
// V3: File Registry + L1 Memory
// ============================================

// 文件注册表条目
export interface FileRegistryEntry {
  path: string              // 归一化路径 (/ 分隔)
  mtime: number             // 最后修改时间戳(ms), 写操作更新
  lastAccessed: number      // 最后访问时间戳
  accessCount: number       // 累计访问次数
  nexusId: string | null    // 首次访问时关联的 Nexus ID
  registeredAt: number      // 首次注册时间
}

// L1 热记忆快照 (只存元数据，不存原始工具输出)
export interface L1ActionSnapshot {
  turn: number              // ReAct 循环轮次
  action: string            // 工具名 (toolName)
  target: string            // 操作目标 (路径或参数摘要, max 100 字符)
  status: 'success' | 'error'
  resultSize: number        // 原始结果字节数
  resultPreview: string     // 结果前 200 字符
  nexusId: string           // 所属 Nexus
  timestamp: number
}

// File Registry 配置
export const FILE_REGISTRY_CONFIG = {
  MAX_ENTRIES: 500,
  STALE_THRESHOLD_MS: 7 * 24 * 60 * 60 * 1000, // 7 天未访问视为过期
  PERSIST_DEBOUNCE_MS: 5000,
  LOCALSTORAGE_KEY: 'duncrew_file_registry',
  FILE_OPS: ['readFile', 'writeFile', 'appendFile', 'listDir'] as const,
} as const

// L1 Memory 配置
export const L1_MEMORY_CONFIG = {
  HOT_MAX_SNAPSHOTS: 5,          // L1-Hot 保留最近 5 轮
  SNAPSHOT_PREVIEW_CHARS: 200,   // resultPreview 截取长度
  SNAPSHOT_TARGET_CHARS: 100,    // target 截取长度
} as const

// ============================================
// V3: Confidence Scoring + L1→L0 Promotion
// ============================================

// 置信度信号
export interface ConfidenceSignal {
  type: 'environment' | 'human_feedback' | 'system_failure' | 'decay'
  delta: number             // 分值变化量 (归一化到 0-1 范围)
  source: string            // 来源描述
  timestamp: number
}

// L1 记忆条目 (带置信度追踪)
export interface L1MemoryEntry {
  id: string
  nexusId: string
  content: string
  confidence: number        // 0.0 ~ 1.0
  signals: ConfidenceSignal[]
  promotedToL0: boolean
  createdAt: number
  updatedAt: number
}

// 置信度信号分值
export const CONFIDENCE_SIGNALS = {
  ENVIRONMENT_ASSERTION: 0.15,   // Critic 验证通过
  HUMAN_POSITIVE: 0.20,          // 用户正面反馈 (提高权重)
  HUMAN_NEGATIVE: -0.20,         // 用户负面反馈
  SYSTEM_FAILURE: -0.15,         // 系统/工具执行失败 (降低惩罚)
  GENE_MATCH: 0.05,              // 与高置信基因匹配
  REPEATED_SUCCESS: 0.10,        // 同类工具重复成功 (新增)
} as const

// L0 晋升配置
export const L0_PROMOTION_CONFIG = {
  PROMOTION_THRESHOLD: 0.50,     // 置信度 >= 0.50 (从 0.65 降低，实际路径: 0.35+0.15+0.10=0.60>0.50)
  MIN_SIGNALS_FOR_PROMOTION: 2,  // 至少 2 个信号
  DECAY_HALF_LIFE_DAYS: 30,      // L0 记忆半衰期
  INITIAL_CONFIDENCE: 0.35,      // 新条目初始置信度
} as const
