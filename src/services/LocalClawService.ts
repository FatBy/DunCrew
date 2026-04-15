/**
 * DunCrew Native Local AI Engine
 * 
 * 独立运行的本地 AI 引擎，包含：
 * - ReAct 循环执行器
 * - 任务规划器 (Planner)
 * - 工具调用能力
 * - 本地记忆持久化
 */

import { chat, streamChat, isLLMConfigured, embed, cosineSimilarity, convertToolInfoToFunctions, getLLMConfig, saveLLMConfig, clearEmbedUnsupportedCache, searchChat, isChannelConfigured, generateImage, visionChat } from './llmService'
import { backgroundQueue } from './backgroundQueue'
import type { SimpleChatMessage, LLMStreamResult, VisionChatMessage } from './llmService'
import type { ExecutionStatus, OpenClawSkill, MemoryEntry, ToolInfo, ExecTrace, ExecTraceToolCall, ApprovalRequest, ExecutionStep, DunEntity, DunScoring, TaskCheckpoint, GeneMatch } from '@/types'
import { parseSoulMd, type ParsedSoul } from '@/utils/soulParser'
import { classifyBaseType, updateBaseClassifierCtx, createBaseClassifierCtx, buildBaseSequence, buildBaseDistribution, buildBaseSequenceFromEntries, buildBaseDistributionFromEntries, detectPBase } from '@/utils/baseClassifier'
import { classifyTaskComplexity } from '@/utils/taskClassifier'
import { skillStatsService } from './skillStatsService'
import { immuneService } from './capsuleService'
import { dunManager } from './dunManager'
import { genePoolService } from './genePoolService'
import { clawHubService } from './clawHubService'
import { agentEventBus } from './agentEventBus'
import { estimateTokens, DefaultDunContextEngine, contextEngineRegistry } from './dunContextEngine'
import { dunScoringService } from './dunScoringService'
import { handleRecovery } from './errorRecovery'
import { memoryStore } from './memoryStore'
import { sessionPersistence } from './sessionPersistence'
import { fileRegistry } from './fileRegistry'
import { FILE_REGISTRY_CONFIG, SOUL_EVOLUTION_CONFIG } from '@/types'
import { confidenceTracker } from './confidenceTracker'
import { soulEvolutionService } from './soulEvolutionService'
import { sopEvolutionService } from './sopEvolutionService'
import { baseSequenceGovernor, deriveStrategies } from './baseSequenceGovernor'
import type { InterventionRecord } from './baseSequenceGovernor'
import { baseLedgerService } from './baseLedgerService'
import { transcriptaseEngine } from './transcriptaseEngine'
import { childAgentManager } from './childAgentManager'
import { transcriptaseGovernor } from './transcriptaseGovernor'
import { parseIndex, rankIndexEntries } from './knowledgeCompiler'
import { knowledgeIngestService } from './knowledgeIngestService'
import { warmupSkillEmbeddings, rankSkills } from './skillRankingService'
import { getSystemPromptFC, getPlannerPrompt, getPlanReviewPrompt, getTaskCompletionPrompt } from './prompts'
import { getCurrentLocale } from '@/i18n/core'

// ============================================
// 类型定义
// ============================================

interface ToolCall {
  name: string
  args: Record<string, unknown>
}

interface ToolResult {
  tool: string
  status: 'success' | 'error'
  result: string
  timestamp?: string
  /** Layer 3: 代码验证结果 */
  verification?: {
    verified: boolean
    checks: { name: string; passed: boolean; details: string }[]
    confidence: number
  }
  /** Layer 2: 错误类型分类 */
  error_type?: string
  /** Layer 2: 执行耗时 (ms) */
  execution_time_ms?: number
}

interface PlanStep {
  id: number
  description: string
  tool?: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  result?: string
}

// Dun 性能统计类型 (已迁移到 dunManager.ts)

/**
 * 任务完成度验证结果
 * 用于判断任务是否真正完成，而不仅仅是执行了工具
 */
interface TaskCompletionResult {
  /** 任务是否完成 */
  completed: boolean
  /** 完成度百分比 (0-100) */
  completionRate: number
  /** 用户看到的摘要 */
  summary: string
  /** 已完成的步骤 */
  completedSteps: string[]
  /** 未完成的步骤 */
  pendingSteps: string[]
  /** 失败原因 (如果有) */
  failureReason?: string
  /** 建议的下一步操作 */
  nextSteps?: string[]
}

interface StoreActions {
  setConnectionStatus: (status: string) => void
  setConnectionError: (error: string | null) => void
  setReconnectAttempt: (attempt: number) => void
  setReconnectCountdown: (countdown: number | null) => void
  setAgentStatus: (status: string) => void
  setCurrentTask: (id: string | null, description: string | null) => void
  addToast: (toast: { type: string; title: string; message?: string }) => void
  addSession: (session: any) => void
  updateSession: (key: string, updates: any) => void
  updateExecutionStatus: (id: string, updates: Partial<ExecutionStatus>) => void
  addLog: (log: any) => void
  addRunEvent: (event: any) => void
  // Native 模式需要的 loading 状态控制
  setSessionsLoading: (loading: boolean) => void
  setChannelsLoading: (loading: boolean) => void
  setDevicesLoading: (loading: boolean) => void
  // 数据注入 (Soul/Skills/Memories)
  setSoulFromParsed: (parsed: ParsedSoul, agentIdentity: any) => void
  setOpenClawSkills: (skills: OpenClawSkill[]) => void
  setMemories: (memories: MemoryEntry[]) => void
  // Native 模式: 实时执行任务管理
  addActiveExecution: (task: any) => void
  updateActiveExecution: (id: string, updates: any) => void
  removeActiveExecution: (id: string) => void
  // P3: 危险操作审批
  requestApproval: (req: Omit<ApprovalRequest, 'id' | 'timestamp'>) => Promise<boolean>
  // P4: Dun 数据注入
  setDunsFromServer: (duns: Array<Partial<DunEntity> & { id: string }>) => void
  activeDunId: string | null
  setActiveDun: (id: string | null) => void
  updateDunScoring: (id: string, scoring: DunScoring) => void
  updateDun: (id: string, updates: Partial<DunEntity>) => void
  duns: Map<string, DunEntity>
  // P5: Dun 技能绑定即时同步
  bindSkillToDun?: (dunId: string, skillName: string) => void
  unbindSkillFromDun?: (dunId: string, skillName: string) => void
}

// ============================================
// 配置
// ============================================

// 检测运行环境
import { getServerUrl } from '@/utils/env'

const CONFIG = {
  // 开发模式使用 localhost:3001，生产模式使用相对路径（Python 托管）
  LOCAL_SERVER_URL: getServerUrl(),
  MAX_REACT_TURNS: 999,    // 无限制：让任务持续执行直到完成
  DEFAULT_TURNS: 999,      // 无限制
  SIMPLE_TURNS: 10,        // 简单任务仍有轻微限制避免死循环
  MAX_PLAN_STEPS: 20,      // 计划步骤增加到 20
  TOOL_TIMEOUT: 60000,
  // 上下文预算
  TOKEN_BUDGET: 128000,
  CONTEXT_CHAR_BUDGET: 10000,
  MAX_HISTORY_TURNS: 6,        // 最近3轮 user+assistant = 6条
  CACHE_TTL: 60000,            // 文件缓存有效期 (ms)
  // 弹性分区预算上限 (各分区互不侵占，未用满的空间可被后续分区利用)
  BUDGET_CAPS: {
    identity: 2500,    // Soul + SOP + 规则 + 性能洞察
    memory: 3500,      // L0 记忆
    traces: 1500,      // exec_trace + 历史成功案例 (合并)
    skills: 2400,      // 技能清单 (名称+描述，不注入全文)
    misc: 1300,        // 文件注册表 + 通讯提示 + 修正案 + 用户偏好
  },
  // 提取摘要行数限制
  SOUL_SUMMARY_MAX_LINES: 25,
  // 技能清单：每条描述最多字符数
  SKILL_LISTING_MAX_DESC_CHARS: 200,
  // 工具执行
  MAX_TOOL_RETRIES: 2,
  MAX_HEALING_DEPTH: 3,
  // 任务升级机制配置
  ESCALATION: {
    ENABLED: true,                    // 是否启用升级机制
    EXTRA_TURNS: 20,                  // 每次升级增加的轮次
    MAX_ESCALATIONS: 3,               // 最大升级次数
    MIN_COMPLETION_FOR_SKIP: 80,      // 完成度达到此值则不升级
  },
  // Reflexion 机制配置
  CRITIC_TOOLS: ['writeFile', 'runCmd', 'appendFile'], // 修改类工具需要 Critic 验证
  HIGH_RISK_TOOLS: ['runCmd'], // 高风险工具需要执行前检查
  // P1: Reflexion/Critic 提示分隔符（零宽空格标记，避免与工具结果内容混淆）
  HINT_SEPARATOR: '\n\n\u200B\u2500\u2500\u2500\u2500 SYSTEM_HINT \u2500\u2500\u2500\u2500\u200B\n',
  // P3: 危险命令模式 (触发用户审批) - 仅保留真正破坏性操作
  DANGER_PATTERNS: [
    { pattern: 'rm -rf', level: 'critical' as const, reason: '递归强制删除' },
    { pattern: 'del /f /s', level: 'critical' as const, reason: '递归强制删除' },
    { pattern: 'format', level: 'critical' as const, reason: '格式化磁盘' },
    { pattern: 'mkfs', level: 'critical' as const, reason: '创建文件系统' },
    { pattern: 'dd if=/dev', level: 'critical' as const, reason: '低级磁盘写入' },
    { pattern: 'reg delete HKLM', level: 'critical' as const, reason: '删除系统注册表' },
  ],
}

// ============================================
// JIT 上下文注入配置
// ============================================

// ============================================
// P1: 工具结果分级截断
// ============================================

/** 按工具类型智能截断结果，防止上下文膨胀 */
function truncateToolResult(toolName: string, result: string): string {
  const TOOL_RESULT_LIMITS: Record<string, number> = {
    readFile:      2500,
    webFetch:      2000,
    runCmd:        2000,
    webSearch:     1500,
    searchFiles:   1500,
    listDir:       1500,
    searchMemory:  1500,
  }
  const DEFAULT_LIMIT = 2500
  const limit = TOOL_RESULT_LIMITS[toolName] || DEFAULT_LIMIT

  if (result.length <= limit) return result

  if (toolName === 'readFile') {
    const half = Math.floor(limit / 2)
    return result.slice(0, half) +
      `\n\n... [已截断 ${result.length - limit} 字符，原始 ${result.length} 字符] ...\n\n` +
      result.slice(-half)
  }

  if (toolName === 'runCmd') {
    return `[输出已截断，仅保留最后 ${limit} 字符]\n` + result.slice(-limit)
  }

  return result.slice(0, limit) + `\n... [已截断，原始 ${result.length} 字符]`
}

// ============================================
// P2/P4: 安全切割点查找（保证 tool_call/tool_result 配对完整）
// ============================================

/**
 * 从 messages 数组中找到一个安全的切割索引。
 * 安全边界 = user 消息 或 无 tool_calls 的 assistant 消息。
 * 返回 -1 表示找不到安全切割点。
 */
function findSafeCutIndex(messages: Array<{ role: string; tool_calls?: unknown[] }>, keepRecent: number): number {
  let idx = Math.max(1, messages.length - keepRecent)
  while (idx > 1) {
    const msg = messages[idx]
    if (msg.role === 'user') return idx
    if (msg.role === 'assistant' && !msg.tool_calls?.length) return idx
    idx--
  }
  return -1 // 找不到安全切割点
}

/**
 * 技能关键词映射表 (P1: 动态填充，不再硬编码)
 * 启动时从 /skills 返回的 manifest.keywords 自动构建
 * 保留少量默认映射作为 fallback
 */
const DEFAULT_SKILL_TRIGGERS: Record<string, { keywords: string[]; path: string }> = {
  'web-search': {
    keywords: ['搜索', '查找', '查询', '查一下', '帮我找', 'search', 'find', 'look up'],
    path: 'skills/web-search/SKILL.md',
  },
  'weather': {
    keywords: ['天气', '气温', '下雨', '晴天', 'weather', 'temperature'],
    path: 'skills/weather/SKILL.md',
  },
  'file-ops': {
    keywords: ['文件', '读取', '写入', '保存', '创建', '删除', 'file', 'read', 'write', 'save'],
    path: 'skills/file-operations/SKILL.md',
  },
  'code': {
    keywords: ['代码', '编程', '运行', '执行', '脚本', 'code', 'run', 'execute', 'script'],
    path: 'skills/code-runner/SKILL.md',
  },
  'dd-os-data': {
    keywords: ['状态', 'soul', '技能列表', '记忆', 'status', 'skills', 'memory'],
    path: 'skills/dd-os-data/SKILL.md',
  },
  'skill-generator': {
    keywords: ['创建技能', '新技能', '生成技能', '添加技能', '技能生成', 
               'create skill', 'new skill', 'generate skill', 'add skill', '自定义技能'],
    path: 'skills/skill-generator/SKILL.md',
  },
  'skill-scout': {
    keywords: ['发现技能', '推荐技能', '安装技能', '加载技能', '下载技能', '热门技能', 
               '技能市场', '技能商店', '升级能力', '技能发现', 'install skill', 'discover skill',
               'recommend skill', 'skill store', 'skill market', 'OpenClaw', '社区技能'],
    path: 'skills/skill-scout/SKILL.md',
  },
}

// ============================================
// 系统提示词已抽离到 ./prompts.ts
// ============================================

// ============================================
// Quest 风格任务规划提示词
// ============================================

// ============================================
// LocalClawService 主类
// ============================================

class LocalClawService {
  private storeActions: StoreActions | null = null
  private serverUrl = CONFIG.LOCAL_SERVER_URL
  private soulContent: string = ''

  // ── 连接管理 ──
  /** 是否已完成首次完整初始化 (Soul/Skills/Memories/Tools 等) */
  private _initialized = false
  /** 心跳轮询 timer */
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null
  /** 自动重连 timer */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** 重连倒计时 timer */
  private _countdownTimer: ReturnType<typeof setInterval> | null = null
  /** 当前重连次数 */
  private _reconnectAttempt = 0
  /** 连续心跳失败计数 */
  private _heartbeatFailCount = 0
  /** autoConnect 是否已启动 */
  private _autoConnectRunning = false
  /** autoConnect 取消函数 */
  private _cancelAutoConnect: (() => void) | null = null

  // 连接生命周期回调
  private _onConnectedCallbacks: Array<(isReconnect: boolean) => void> = []
  private _onDisconnectedCallbacks: Array<(reason: 'heartbeat' | 'manual' | 'error') => void> = []

  // ── 连接常量 ──
  private static readonly HEARTBEAT_INTERVAL = 15_000       // 心跳轮询间隔 15s
  private static readonly HEARTBEAT_FAIL_THRESHOLD = 3       // 连续 3 次失败进入重连
  private static readonly RECONNECT_BASE_DELAY = 1_000       // 重连基础延迟 1s
  private static readonly RECONNECT_MAX_DELAY = 30_000       // 重连最大延迟 30s
  private static readonly RECONNECT_MAX_ATTEMPTS = 10        // 常规重连最大次数
  private static readonly RECONNECT_MAX_ATTEMPTS_FIRST = 60  // 首次启动宽容重连次数
  /** Soul #6: 当前 session 已计数 hitCount 的修正案 ID 集合 (节流) */
  private countedAmendmentIds: Set<string> = new Set()
  /** 当前正在使用的 LLM 模型名称（供 EventBus 和 ErrorRecovery 使用） */
  private _currentModel: string = 'unknown'

  // P0-PERF: loadAllDataToStore 防抖 —— 5 秒内最多执行一次
  private _loadAllDataPromise: Promise<void> | null = null

  // P0: 动态工具列表 (从 /tools 端点获取)
  private availableTools: ToolInfo[] = []

  /** 上一轮 ReAct 执行涉及的 L1 记忆 ID 列表（用于隐式反馈信号） */
  private lastRunL1Ids: string[] = []
  /** 上一轮执行完成时间戳（隐式反馈时间衰减用） */
  private lastRunTimestamp = 0

  /**
   * 隐式反馈信号检测：分析用户新输入的开头关键词，
   * 对上一轮涉及的 L1 条目发送正面/负面反馈信号。
   * 添加时间衰减：距上次执行超过 5 分钟则跳过（关联性太弱）。
   */
  private checkImplicitFeedback(userPrompt: string): void {
    if (this.lastRunL1Ids.length === 0) return

    // 时间衰减：间隔过长则隐式反馈不可靠，跳过
    const gapMs = Date.now() - this.lastRunTimestamp
    if (this.lastRunTimestamp > 0 && gapMs > 5 * 60 * 1000) {
      console.log(`[ImplicitFeedback] Skipped: gap ${(gapMs / 1000).toFixed(0)}s > 300s`)
      this.lastRunL1Ids = []
      return
    }

    const POSITIVE_PATTERN = /^(谢谢|可以了|没问题|好的|完美|不错|很好|感谢|太好了|ok|great|thanks|perfect|lgtm|nice)/i
    const NEGATIVE_PATTERN = /^(不对|重做|改一下|错了|不是这样|有问题|再试|不行|wrong|redo|fix|no)/i

    const trimmed = userPrompt.trim()

    if (POSITIVE_PATTERN.test(trimmed)) {
      for (const memId of this.lastRunL1Ids) {
        confidenceTracker.addHumanFeedback(memId, true)
      }
      console.log(`[ImplicitFeedback] Positive signal → ${this.lastRunL1Ids.length} L1 entries`)
    } else if (NEGATIVE_PATTERN.test(trimmed)) {
      for (const memId of this.lastRunL1Ids) {
        confidenceTracker.addHumanFeedback(memId, false)
      }
      console.log(`[ImplicitFeedback] Negative signal → ${this.lastRunL1Ids.length} L1 entries`)
    }

    this.lastRunL1Ids = []
  }

  /**
   * 获取有效工具列表：后端工具 + 通道条件工具
   *
   * 每次调用时动态合并，确保用户修改通道绑定后下一轮对话自动生效。
   */
  private getEffectiveTools(): ToolInfo[] {
    const conditional = this.getConditionalTools()
    // 条件工具覆盖同功能的指令技能，避免 Agent 选错工具
    // 例如：generateImage 存在时，隐藏后端的 openai_image_gen 指令技能
    const supersededSkills = new Set<string>()
    if (conditional.some(t => t.name === 'generateImage')) {
      supersededSkills.add('openai_image_gen')
    }
    const filtered = supersededSkills.size > 0
      ? this.availableTools.filter(t => !supersededSkills.has(t.name))
      : this.availableTools
    return [...filtered, ...conditional]
  }

  /**
   * 根据通道配置动态生成条件工具
   *
   * 通道已配置 → 工具出现在列表中 → Agent 自然感知到能力可用。
   * 通道未配置 → 工具不出现 → Agent 不会尝试调用。
   */
  private getConditionalTools(): ToolInfo[] {
    const conditionalTools: ToolInfo[] = []

    if (isChannelConfigured('search')) {
      conditionalTools.push({
        name: 'searchEnhancedQuery',
        description: '使用搜索增强模型查询最新信息。适用于需要联网搜索、实时数据、最新新闻等场景。与 webSearch 不同，这个工具使用专门的搜索增强 AI 模型（如 Perplexity），能理解复杂查询并给出综合分析。',
        type: 'builtin',
        inputs: {
          query: { type: 'string', description: '搜索查询内容', required: true },
          context: { type: 'string', description: '可选的背景上下文，帮助模型理解搜索意图', required: false },
        },
      })
    }

    if (isChannelConfigured('imageGen')) {
      conditionalTools.push({
        name: 'generateImage',
        description: '使用文生图模型根据文字描述生成图片。支持 DALL-E、通义万象、MiniMax 等 OpenAI 兼容的图片生成 API。返回生成图片的 URL。',
        type: 'builtin',
        inputs: {
          prompt: { type: 'string', description: '图片描述提示词（建议使用英文以获得更好效果）', required: true },
          size: { type: 'string', description: '图片尺寸，如 "1024x1024"、"1024x1792"、"1792x1024"，默认 "1024x1024"', required: false },
          quality: { type: 'string', description: '图片质量，"standard" 或 "hd"，默认 "standard"', required: false },
          n: { type: 'number', description: '生成图片数量，默认 1', required: false },
        },
      })
    }

    // imageUnderstand: 使用主 chat 通道的多模态能力，只要 LLM 已配置即可
    if (isLLMConfigured()) {
      conditionalTools.push({
        name: 'imageUnderstand',
        description: '使用多模态 AI 理解图片内容。可以分析截图、设计稿、图表、报错信息等，给出详细的视觉描述和语义理解。需要 chat 模型支持 vision（如 GPT-4o、Claude 3.5 Sonnet 等）',
        type: 'builtin',
        inputs: {
          imagePath: { type: 'string', description: '图片文件路径（本地绝对路径）', required: true },
          prompt: { type: 'string', description: '分析指令/问题，默认为"请详细描述这张图片的内容"', required: false },
          detail: { type: 'string', description: '视觉精度: low / high / auto，默认 auto', required: false },
        },
      })
    }

    return conditionalTools
  }

  // P1: 动态技能触发器 (从 /skills manifest.keywords 构建)
  private skillTriggers: Record<string, { keywords: string[]; path: string }> = { ...DEFAULT_SKILL_TRIGGERS }
  /** 缓存的 OpenClawSkill 列表，供融合排序使用 */
  private cachedSkills: OpenClawSkill[] = []

  /** V4: 最近一次 buildDynamicContext 的注入元数据（由 trace 写入时消费） */
  private _lastInjectionMeta: import('@/types').ContextInjectionMeta | null = null


  // 追踪执行过程中创建的文件 (用于在聊天中显示文件卡片)
  private _lastCreatedFiles: { filePath: string; fileName: string; message: string; fileSize?: number }[] = []
  get lastCreatedFiles() { return this._lastCreatedFiles }

  // 追踪最近一次执行的 trace ID (用于消息关联)
  private _lastTraceId: string | null = null
  get lastTraceId() { return this._lastTraceId }

  // 后台任务取消控制器（新任务开始时取消旧的后台 LLM 调用）
  private _backgroundAbortController: AbortController | null = null

  // JIT 缓存 - 避免重复读取
  private contextCache: Map<string, { content: string; timestamp: number }> = new Map()
  private readonly CACHE_TTL = CONFIG.CACHE_TTL

  // P5: 指代消解 - 跟踪最近操作的实体 (用于解决 "这个"、"那个" 等代词)
  private recentEntities: {
    files: string[]        // 最近操作的文件路径
    commands: string[]     // 最近执行的命令
    queries: string[]      // 最近的搜索查询
    lastToolName: string | null  // 最后调用的工具名
    timestamp: number      // 最后更新时间
  } = {
    files: [],
    commands: [],
    queries: [],
    lastToolName: null,
    timestamp: 0,
  }

  // 能力缺失记忆：记录因缺少工具导致的失败
  private capabilityGapHistory: Array<{ label: string; task: string; timestamp: number }> = []
  /** Layer 4: 验证结果缓存 (key: "toolName:order") */
  private _verificationCache: Map<string, { verified: boolean; confidence: number; checks: { name: string; passed: boolean; details: string }[] }> = new Map()

  /**
   * 解析 AI 输出中的 <BIND_SKILL> 标签，执行技能绑定操作
   * 
   * 系统提示词告诉 AI 通过 <BIND_SKILL>skillName</BIND_SKILL> 标签绑定技能，
   * 此方法负责解析标签并调用后端 dunBindSkill 工具完成实际绑定，
   * 然后刷新前端状态以确保 UI 同步显示。
   */
  private async _handleBindSkillTags(text: string, dunId?: string | null): Promise<void> {
    const activeDunId = dunId || this.getActiveDunId()
    if (!activeDunId) {
      console.warn('[LocalClaw] BIND_SKILL tag found but no active Dun')
      return
    }

    const bindSkillPattern = /<BIND_SKILL>([^<]+)<\/BIND_SKILL>/g
    const skillNames: string[] = []
    let match: RegExpExecArray | null
    while ((match = bindSkillPattern.exec(text)) !== null) {
      const skillName = match[1].trim()
      if (skillName) {
        skillNames.push(skillName)
      }
    }

    if (skillNames.length === 0) return

    console.log(`[LocalClaw] BIND_SKILL tags detected: ${skillNames.join(', ')} → Dun ${activeDunId}`)

    for (const skillName of skillNames) {
      try {
        const result = await this.executeTool({
          name: 'dunBindSkill',
          args: { dunId: activeDunId, skillId: skillName },
        })
        if (result.status === 'success') {
          console.log(`[LocalClaw] Skill "${skillName}" bound to Dun "${activeDunId}" via tag`)
          // P5: 即时更新 store，确保 UI 立即响应
          this.storeActions?.bindSkillToDun?.(activeDunId, skillName)
        } else {
          console.warn(`[LocalClaw] Failed to bind skill "${skillName}": ${result.result}`)
        }
      } catch (err) {
        console.warn(`[LocalClaw] Error binding skill "${skillName}":`, err)
      }
    }

    // 刷新前端 Dun 数据以同步 UI
    try {
      // 技能绑定是关键操作，清除防抖锁以确保立即刷新最新数据
      this._loadAllDataPromise = null
      await this.loadAllDataToStoreDebounced()
      console.log('[LocalClaw] Dun data refreshed after BIND_SKILL tag processing')
    } catch {
      console.warn('[LocalClaw] Failed to refresh dun data after BIND_SKILL')
    }
  }

  /**
   * 检测工具错误是否属于能力缺失，并记录到记忆
   */
  /**
   * 获取通道配置提示：当工具缺失但可通过通道配置解锁时，附带引导信息
   */
  private getCapabilityHint(toolName: string): string | null {
    const channelToolMap: Record<string, { channel: keyof import('@/types').ChannelBindings; label: string }> = {
      generateImage: { channel: 'imageGen', label: '文生图' },
      generateVideo: { channel: 'videoGen', label: '文生视频' },
      searchEnhancedQuery: { channel: 'search', label: '搜索增强' },
    }
    const mapping = channelToolMap[toolName]
    if (!mapping) return null
    if (isChannelConfigured(mapping.channel)) return null
    return `提示：用户可以在联络屋绑定「${mapping.label}」通道来启用此能力。`
  }

  private async detectAndRecordCapabilityGap(toolName: string, errorMsg: string, taskHint: string): Promise<void> {
    // 能力缺失特征词
    const gapPatterns = [
      /unknown tool/i, /tool not found/i, /不支持/,
      /no such tool/i, /未找到工具/, /not available/i,
      /没有.*能力/, /无法.*执行/, /unsupported/i,
    ]
    const isGap = gapPatterns.some(p => p.test(errorMsg))
    if (!isGap) return

    // P2: 附带通道配置提示
    const capabilityHint = this.getCapabilityHint(toolName)

    const entry = {
      label: toolName,
      task: taskHint.slice(0, 80),
      timestamp: Date.now(),
    }

    // 去重：同一工具 24 小时内只记一次
    const exists = this.capabilityGapHistory.some(
      g => g.label === toolName && Date.now() - g.timestamp < 86400000
    )
    if (exists) return

    this.capabilityGapHistory.push(entry)

    // 持久化到记忆文件（含通道配置提示）
    const hintSuffix = capabilityHint ? ` | ${capabilityHint}` : ''
    const logLine = `[${new Date().toISOString().split('T')[0]}] 缺失能力: ${toolName} | 场景: ${entry.task}${hintSuffix}\n`
    this.executeTool({
      name: 'appendFile',
      args: { path: 'memory/capability_gaps.md', content: logLine },
    }).catch(() => {})

    console.log(`[LocalClaw] Capability gap detected: ${toolName}${capabilityHint ? ` (${capabilityHint})` : ''}`)

    // ClawHub 自动发现
    this.autoDiscoverFromClawHub(toolName, taskHint).catch(err => {
      console.warn('[LocalClaw] ClawHub auto-discover failed:', err)
    })
  }

  /**
   * 自动从 ClawHub 搜索匹配技能并推送建议
   */
  private async autoDiscoverFromClawHub(toolName: string, taskHint: string): Promise<void> {
    // 构建搜索词：优先用 toolName (去掉下划线变为连字符)，fallback 到 taskHint 关键词
    const searchQuery = toolName.replace(/_/g, '-').replace(/\s+/g, ' ').trim()
    if (!searchQuery) return

    try {
      const results = await clawHubService.searchSkills(searchQuery)
      if (!results.skills || results.skills.length === 0) return

      const topMatches = results.skills.slice(0, 3)

      // 动态导入 store 避免循环依赖
      const { useStore } = await import('@/store')
      useStore.getState().addClawHubSuggestion({
        id: `discovery-${toolName}-${Date.now()}`,
        type: 'skill-discovery',
        query: searchQuery,
        matches: topMatches,
        triggerTool: toolName,
        triggerTask: taskHint.slice(0, 100),
      })

      console.log(`[LocalClaw] ClawHub auto-discovery: found ${topMatches.length} matches for "${searchQuery}"`)
    } catch (error) {
      // 网络不可用等情况，静默失败
      console.warn('[LocalClaw] ClawHub search failed:', error)
    }
  }

  /**
   * 启动时加载历史能力缺失记忆
   */
  private async loadCapabilityGapHistory(): Promise<void> {
    try {
      const result = await this.executeTool({
        name: 'readFile',
        args: { path: 'memory/capability_gaps.md' },
      })
      if (result.status === 'success' && result.result) {
        const lines = result.result.split('\n').filter((l: string) => l.includes('缺失能力:'))
        this.capabilityGapHistory = lines.slice(-10).map((line: string) => {
          const labelMatch = line.match(/缺失能力:\s*(\S+)/)
          const taskMatch = line.match(/场景:\s*(.+)$/)
          return {
            label: labelMatch?.[1] || 'unknown',
            task: taskMatch?.[1] || '',
            timestamp: Date.now(),
          }
        })
      }
    } catch {
      // 文件不存在，忽略
    }
  }

  /**
   * 注入 Store Actions
   */
  injectStore(actions: StoreActions) {
    this.storeActions = actions

    // V2: 同步 serverUrl 到 memoryStore 和 sessionPersistence
    memoryStore.setServerUrl(this.serverUrl)
    sessionPersistence.setServerUrl(this.serverUrl)
    sopEvolutionService.setServerUrl(this.serverUrl)
    baseSequenceGovernor.initialize(this.serverUrl)
    // Phase 3: TranscriptaseGovernor 初始化 + 注入到 Engine（休眠态）
    transcriptaseGovernor.initialize(this.serverUrl)
    transcriptaseEngine.setGovernor(transcriptaseGovernor)

    // 接线提取出的服务
    dunManager.setIO({
      executeTool: (call: { name: string; args: Record<string, unknown> }) => this.executeTool(call),
      readFileWithCache: (path: string) => this.readFileWithCache(path),
      getActiveDunId: () => this.getActiveDunId(),
      getDuns: () => this.storeActions?.duns,
      getAvailableTools: () => this.getEffectiveTools(),
      getServerUrl: () => this.serverUrl,
      addToast: (toast: { type: string; title: string; message: string }) =>
        this.storeActions?.addToast(toast),
      // 优化5: 注入语义匹配能力
      embedText: (text: string) => embed(text),
      cosineSimilarity: (a: number[], b: number[]) => cosineSimilarity(a, b),
    })
  }

  /**
   * 任务复杂度分类 - 判断是否需要走 Quest 流程
   * 参考 Qoder 的分类逻辑：
   * - 简单任务：问答、解释、确认、闲聊 → 直接 LLM 响应
   * - 复杂任务：需要工具执行、多步骤操作 → Quest ReAct 循环
   */
  classifyTaskComplexity(prompt: string): 'simple' | 'complex' {
    const lowerPrompt = prompt.toLowerCase()
    
    // 简单任务关键词（问答/解释/确认类）
    const simplePatterns = [
      /^(你好|hi|hello|hey|嗨)/,
      /^(谢谢|感谢|thanks|thank you)/,
      /^(好的|ok|okay|明白|了解|知道了)/,
      /(是什么|什么是|解释一下|介绍一下|告诉我|请问)/,
      /(为什么|怎么理解|如何理解|什么意思)/,
      /(有哪些|有什么|列举|举例)/,
      /(区别|区别是|不同|差异)/,
      /(建议|推荐|怎么选|选哪个)/,
      /(总结|概括|归纳|回顾)/,
      /^(继续|接着|然后呢)/,
    ]
    
    // 复杂任务关键词（需要工具执行类）
    const complexPatterns = [
      /(创建|新建|生成|写入|保存|输出到)/,
      /(修改|编辑|更新|改|替换|重命名)/,
      /(删除|移除|清空|清理)/,
      /(搜索|查找|查询|检索|grep|find)/,
      /(运行|执行|启动|停止|重启|npm|python|node)/,
      /(安装|卸载|install|uninstall)/,
      /(读取|打开|查看|cat|读|看看)/,
      /(分析|调试|debug|排查|检查)/,
      /(部署|发布|提交|commit|push|pull)/,
      /(下载|上传|fetch|curl)/,
      /(文件|目录|文件夹|folder|directory)/,
      /(代码|函数|类|组件|模块|接口)/,
      /(帮我|请帮|麻烦|能不能|可以.*吗)/,  // 请求执行类
    ]
    
    // 检查是否匹配简单任务模式
    const isSimple = simplePatterns.some(pattern => pattern.test(lowerPrompt))
    
    // 检查是否匹配复杂任务模式
    const isComplex = complexPatterns.some(pattern => pattern.test(lowerPrompt))
    
    // 如果同时匹配，优先复杂（因为可能是"帮我解释一下这个文件"这种）
    if (isComplex) return 'complex'
    if (isSimple) return 'simple'
    
    // 默认：短消息视为简单，长消息视为复杂
    return prompt.length < 30 ? 'simple' : 'complex'
  }

  /**
   * 简单对话 - 直接 LLM 流式响应，不走 Quest 流程
   */
  async sendSimpleChat(
    prompt: string,
    dunId?: string,
    onStream?: (chunk: string) => void
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置')
    }

    // 构建包含 Dun 设定的系统提示词
    let systemPrompt = '你是一个友好、专业的 AI 助手。请简洁、直接地回答用户问题。'

    if (dunId) {
      try {
        // 从 store 获取 Dun 实体
        const { useStore } = await import('@/store')
        const state = useStore.getState()
        const dun = state.duns?.get?.(dunId)

        if (dun) {
          const identity = dun.label || dun.id
          const description = dun.flavorText || dun.sopContent?.split('\n')[0] || ''
          const sop = dun.sopContent || ''

          systemPrompt = `你是 "${identity}"，DunCrew 中的一个专业 Agent。
${description ? `角色描述: ${description}` : ''}
${sop ? `\n行为准则:\n${sop.slice(0, 800)}` : ''}

请以该角色身份简洁、直接地回答用户问题。保持角色一致性。`
        }
      } catch {
        // store 访问失败，使用默认提示词
      }
    }

    const messages: SimpleChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt }
    ]

    let fullResponse = ''
    
    try {
      await streamChat(
        messages,
        (chunk) => {
          fullResponse += chunk
          onStream?.(chunk)
        }
      )
      return fullResponse
    } catch (error: any) {
      throw new Error(`对话失败: ${error.message}`)
    }
  }

  /**
   * P5: 更新最近操作的实体 (用于指代消解)
   * 从工具调用中提取关键实体，供后续代词解析使用
   */
  private updateRecentEntities(toolName: string, args: Record<string, unknown>, result: string) {
    const now = Date.now()
    
    // 提取文件路径
    const path = args.path as string | undefined
    const file = args.file as string | undefined
    const filePath = path || file
    if (filePath) {
      this.recentEntities.files = [filePath, ...this.recentEntities.files.slice(0, 4)]
    }
    
    // 提取命令
    const command = args.command as string | undefined
    const cmd = args.cmd as string | undefined
    const cmdStr = command || cmd
    if (cmdStr) {
      this.recentEntities.commands = [cmdStr, ...this.recentEntities.commands.slice(0, 4)]
    }
    
    // 提取搜索查询
    const query = args.query as string | undefined
    const search = args.search as string | undefined
    const queryStr = query || search
    if (queryStr) {
      this.recentEntities.queries = [queryStr, ...this.recentEntities.queries.slice(0, 4)]
    }
    
    // 从结果中提取文件路径 (如 writeFile 返回的路径)
    const pathMatch = result.match(/(?:Written to|Created|Saved|写入|创建|保存).*?([\/\\][\w\-\.\/\\]+\.\w+)/i)
    if (pathMatch) {
      this.recentEntities.files = [pathMatch[1], ...this.recentEntities.files.slice(0, 4)]
    }
    
    this.recentEntities.lastToolName = toolName
    this.recentEntities.timestamp = now
  }

  /**
   * P5: 构建指代消解提示
   * 检测用户输入中的代词，并从最近实体中生成上下文提示
   */
  private buildAnaphoraHint(userQuery: string): string {
    // 常见代词模式
    const pronounPatterns = [
      /这个|这|这里|这边|这些/,
      /那个|那|那里|那边|那些/,
      /它|它们|他|她|他们|她们/,
      /上面|上述|前面|刚才|之前/,
      /this|that|it|them|these|those/i,
    ]
    
    const hasPronouns = pronounPatterns.some(p => p.test(userQuery))
    
    // 如果没有代词或最近实体太旧 (超过5分钟)，不需要提示
    if (!hasPronouns) return ''
    if (Date.now() - this.recentEntities.timestamp > 5 * 60 * 1000) return ''
    
    const hints: string[] = []
    
    // 根据最近操作类型生成提示
    if (this.recentEntities.files.length > 0) {
      const recentFile = this.recentEntities.files[0]
      hints.push(`最近操作的文件: "${recentFile}"`)
    }
    
    if (this.recentEntities.commands.length > 0) {
      const recentCmd = this.recentEntities.commands[0]
      hints.push(`最近执行的命令: "${recentCmd.slice(0, 50)}${recentCmd.length > 50 ? '...' : ''}"`)
    }
    
    if (this.recentEntities.queries.length > 0) {
      const recentQuery = this.recentEntities.queries[0]
      hints.push(`最近的搜索: "${recentQuery}"`)
    }
    
    if (this.recentEntities.lastToolName) {
      hints.push(`最后使用的工具: ${this.recentEntities.lastToolName}`)
    }
    
    if (hints.length === 0) return ''
    
    return `\n[指代消解提示] 用户输入中可能包含代词。上下文参考:\n${hints.join('\n')}\n`
  }

  /**
   * 设置服务器地址
   */
  setServerUrl(url: string) {
    this.serverUrl = url || CONFIG.LOCAL_SERVER_URL
  }

  // ════════════════════════════════════════════
  // 连接生命周期回调
  // ════════════════════════════════════════════

  /** 注册连接成功回调，返回取消函数 */
  onConnected(cb: (isReconnect: boolean) => void): () => void {
    this._onConnectedCallbacks.push(cb)
    return () => { this._onConnectedCallbacks = this._onConnectedCallbacks.filter(fn => fn !== cb) }
  }

  /** 注册断连回调，返回取消函数 */
  onDisconnected(cb: (reason: 'heartbeat' | 'manual' | 'error') => void): () => void {
    this._onDisconnectedCallbacks.push(cb)
    return () => { this._onDisconnectedCallbacks = this._onDisconnectedCallbacks.filter(fn => fn !== cb) }
  }

  private _fireConnected(isReconnect: boolean): void {
    for (const cb of this._onConnectedCallbacks) {
      try { cb(isReconnect) } catch (e) { console.error('[LocalClaw] onConnected callback error:', e) }
    }
  }

  private _fireDisconnected(reason: 'heartbeat' | 'manual' | 'error'): void {
    for (const cb of this._onDisconnectedCallbacks) {
      try { cb(reason) } catch (e) { console.error('[LocalClaw] onDisconnected callback error:', e) }
    }
  }

  // ════════════════════════════════════════════
  // 连接核心: checkConnection + fullInitialize
  // ════════════════════════════════════════════

  /**
   * 轻量连接检查 — autoConnect / 心跳重连 / 手动重试用这个
   * 仅 fetch /status，不加载任何业务数据
   */
  async checkConnection(): Promise<{ ok: boolean; data?: any }> {
    try {
      const response = await fetch(`${this.serverUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) {
        return { ok: false }
      }
      const data = await response.json()
      return { ok: true, data }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 完整初始化 — 只在首次连接成功时调用
   * 加载 Soul / Skills / Memories / Tools / Dun 统计等全部业务数据
   */
  private async fullInitialize(serverData: any): Promise<void> {
    // 自动配置本地 embedding（如果后端支持 bge-large-zh-v1.5）
    if (serverData.embedding?.available) {
      const cfg = getLLMConfig()
      if (!cfg.embedBaseUrl) {
        saveLLMConfig({
          embedBaseUrl: this.serverUrl,
          embedModel: serverData.embedding.model_name || 'bge-large-zh-v1.5',
          embedApiKey: 'local',
        })
        console.log('[LocalClaw] Auto-configured local embedding:', serverData.embedding.model_name)
      }
      clearEmbedUnsupportedCache(this.serverUrl)
    }

    // 加载 SOUL
    await this.loadSoul()

    // 加载所有数据到 store (Soul/Skills/Memories)
    await this.loadAllDataToStore()

    // P0: 加载动态工具列表
    await this.loadTools()
    const conditionalOnConnect = this.getConditionalTools()
    console.log(`[LocalClaw] Initial load: Backend ${this.availableTools.length}, Conditional: ${conditionalOnConnect.length}`, conditionalOnConnect.map(t => t.name))

    // MCP 工具延迟同步：后端 MCP 服务器可能还在初始化中，
    // 3 秒后再刷新一次工具列表，确保 MCP 工具不会因启动时序而丢失。
    setTimeout(async () => {
      const prevCount = this.availableTools.length
      await this.loadTools()
      if (this.availableTools.length !== prevCount) {
        console.log(`[LocalClaw] Deferred tool sync: ${prevCount} → ${this.availableTools.length} (+${this.availableTools.length - prevCount} tools)`)
      }
    }, 3000)

    // 加载能力缺失记忆
    await this.loadCapabilityGapHistory()

    // 加载 Dun 性能统计
    await dunManager.loadStats()

    // 🧬 Phase 4: 注册所有 Dun 的能力基因 (让 Dun 间可以互相发现)
    await dunManager.registerAllDunCapabilities()

    this._initialized = true
  }

  // ════════════════════════════════════════════
  // 公开方法: connect / disconnect / autoConnect
  // ════════════════════════════════════════════

  /**
   * 连接到本地服务器 (单次尝试)
   * 首次连接执行 fullInitialize，重连仅做轻量恢复
   */
  async connect(): Promise<boolean> {
    try {
      const { ok, data } = await this.checkConnection()
      if (!ok) {
        throw new Error('Server unreachable')
      }

      console.log('[LocalClaw] Connected to Native Server:', data)

      const isReconnect = this._initialized

      // 首次连接: 完整初始化
      if (!isReconnect) {
        await this.fullInitialize(data)

        this.storeActions?.addToast({
          type: 'success',
          title: 'DunCrew Native 已就绪',
          message: `v${data.version} | ${data.skillCount} skills`,
        })
      } else {
        // 重连: 仅刷新工具列表 (可能有 MCP 变化)
        await this.loadTools()
        console.log('[LocalClaw] Reconnected, tools refreshed')
      }

      this.storeActions?.setConnectionStatus('connected')
      this.storeActions?.setConnectionError(null)
      this.storeActions?.setReconnectAttempt(0)
      this.storeActions?.setReconnectCountdown(null)

      // Native 模式下，设置所有 loading 状态为 false
      this.storeActions?.setSessionsLoading(false)
      this.storeActions?.setChannelsLoading(false)
      this.storeActions?.setDevicesLoading(false)

      // 重置心跳状态并启动心跳
      this._heartbeatFailCount = 0
      this.cancelReconnect()          // 清理任何残留的重连定时器
      this._reconnectAttempt = 0
      this.startHeartbeat()

      // 通知回调
      this._fireConnected(isReconnect)

      return true
    } catch (error: any) {
      console.error('[LocalClaw] Connection failed:', error)
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError(
        '无法连接本地服务器。请确保 duncrew-server.py 正在运行。'
      )
      return false
    }
  }

  /**
   * 断开连接 (完整清理所有服务状态)
   */
  disconnect() {
    this.stopHeartbeat()
    this.cancelReconnect()
    this.storeActions?.setConnectionStatus('disconnected')
    this.storeActions?.setConnectionError(null)
    this.storeActions?.setReconnectAttempt(0)
    this.storeActions?.setReconnectCountdown(null)
    soulEvolutionService.destroy()
    // P1-26: 清理验证缓存
    this._verificationCache.clear()
    this._fireDisconnected('manual')
  }

  /**
   * 自动连接 — 启动后自动尝试连接，失败走指数退避重连
   * @param firstLaunch 首次启动模式，使用更宽容的重试次数
   */
  autoConnect(firstLaunch = false): () => void {
    if (this._autoConnectRunning) {
      console.warn('[LocalClaw] autoConnect already running, ignoring')
      return this._cancelAutoConnect || (() => {})
    }

    this._autoConnectRunning = true
    this._reconnectAttempt = 0
    let cancelled = false
    const maxAttempts = firstLaunch
      ? LocalClawService.RECONNECT_MAX_ATTEMPTS_FIRST
      : LocalClawService.RECONNECT_MAX_ATTEMPTS

    const cancel = () => {
      cancelled = true
      this._autoConnectRunning = false
      this.cancelReconnect()
    }
    this._cancelAutoConnect = cancel

    const tryConnect = async () => {
      if (cancelled) return
      this._reconnectAttempt++
      console.log(`[LocalClaw] autoConnect attempt ${this._reconnectAttempt}/${maxAttempts}`)
      this.storeActions?.setConnectionStatus('connecting')

      const success = await this.connect()
      if (cancelled) return

      if (success) {
        this._autoConnectRunning = false
        return
      }

      if (this._reconnectAttempt < maxAttempts && !cancelled) {
        // 指数退避
        const delay = Math.min(
          LocalClawService.RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempt - 1),
          LocalClawService.RECONNECT_MAX_DELAY
        )
        console.log(`[LocalClaw] autoConnect retry in ${delay}ms`)
        this.storeActions?.setConnectionStatus('reconnecting')
        this.storeActions?.setReconnectAttempt(this._reconnectAttempt)

        // 倒计时显示
        this.startCountdown(delay)

        this._reconnectTimer = setTimeout(() => {
          if (!cancelled) tryConnect()
        }, delay)
      } else if (!cancelled) {
        console.log('[LocalClaw] autoConnect exhausted, giving up')
        this._autoConnectRunning = false
        this.storeActions?.setConnectionStatus('error')
        this.storeActions?.setConnectionError(
          '无法连接本地服务器。请确保 duncrew-server.py 正在运行。'
        )
        this.storeActions?.setSessionsLoading(false)
        this.storeActions?.setChannelsLoading(false)
        this.storeActions?.setDevicesLoading(false)
      }
    }

    tryConnect()
    return cancel
  }

  /**
   * 手动重试 — 重置计数后重新自动连接
   */
  retry(): void {
    this.cancelReconnect()
    this._autoConnectRunning = false
    this._reconnectAttempt = 0
    this.autoConnect(false)
  }

  /**
   * 检查连接状态 (兼容旧调用)
   */
  async checkStatus(): Promise<boolean> {
    const { ok } = await this.checkConnection()
    return ok
  }

  // ════════════════════════════════════════════
  // 心跳轮询
  // ════════════════════════════════════════════

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this._heartbeatFailCount = 0

    this._heartbeatTimer = setInterval(async () => {
      const { ok } = await this.checkConnection()

      if (ok) {
        if (this._heartbeatFailCount > 0) {
          console.log('[LocalClaw] Heartbeat recovered')
        }
        this._heartbeatFailCount = 0
        return
      }

      this._heartbeatFailCount++
      console.warn(`[LocalClaw] Heartbeat fail ${this._heartbeatFailCount}/${LocalClawService.HEARTBEAT_FAIL_THRESHOLD}`)

      if (this._heartbeatFailCount >= LocalClawService.HEARTBEAT_FAIL_THRESHOLD) {
        // 进入重连流程 — 统一通过 autoConnect 处理，避免多循环冲突
        console.warn('[LocalClaw] Heartbeat threshold reached, starting reconnect')
        this.stopHeartbeat()
        this.storeActions?.setConnectionStatus('reconnecting')
        this._fireDisconnected('heartbeat')
        this.autoConnect()
      }
    }, LocalClawService.HEARTBEAT_INTERVAL)
  }

  private stopHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = null
    }
  }

  // ════════════════════════════════════════════
  // 指数退避重连
  // ════════════════════════════════════════════

  private scheduleReconnect(): void {
    // autoConnect 运行中时，由 autoConnect 统一管理重连
    if (this._autoConnectRunning) return

    if (this._reconnectAttempt >= LocalClawService.RECONNECT_MAX_ATTEMPTS) {
      console.error('[LocalClaw] Max reconnect attempts reached')
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError(
        '无法连接本地服务器。请确保 duncrew-server.py 正在运行。'
      )
      return
    }

    const delay = Math.min(
      LocalClawService.RECONNECT_BASE_DELAY * Math.pow(2, this._reconnectAttempt),
      LocalClawService.RECONNECT_MAX_DELAY
    )
    this._reconnectAttempt++

    console.log(`[LocalClaw] Reconnect in ${delay}ms (attempt ${this._reconnectAttempt}/${LocalClawService.RECONNECT_MAX_ATTEMPTS})`)
    this.storeActions?.setReconnectAttempt(this._reconnectAttempt)

    // 倒计时显示
    this.startCountdown(delay)

    this._reconnectTimer = setTimeout(async () => {
      if (this._autoConnectRunning) return   // 二次检查
      const success = await this.connect()
      if (!success) {
        this.scheduleReconnect()
      }
    }, delay)
  }

  private cancelReconnect(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this.stopCountdown()
  }

  private startCountdown(delayMs: number): void {
    this.stopCountdown()
    let remaining = Math.ceil(delayMs / 1000)
    this.storeActions?.setReconnectCountdown(remaining)

    this._countdownTimer = setInterval(() => {
      remaining--
      if (remaining <= 0) {
        this.stopCountdown()
      } else {
        this.storeActions?.setReconnectCountdown(remaining)
      }
    }, 1000)
  }

  private stopCountdown(): void {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer)
      this._countdownTimer = null
    }
    this.storeActions?.setReconnectCountdown(null)
  }

  /**
   * 加载 SOUL.md
   */
  private async loadSoul(): Promise<void> {
    // 如果用户已通过 LLM 生成了自定义 Soul，优先使用 localStorage 中的内容
    const userGenerated = localStorage.getItem('duncrew_soul_generated_at')
    if (userGenerated) {
      const cached = localStorage.getItem('duncrew_soul_md')
      if (cached) {
        this.soulContent = cached
        console.log('[LocalClaw] Using user-generated Soul content from localStorage')
        return
      }
    }

    try {
      const response = await fetch(`${this.serverUrl}/file/SOUL.md`)
      if (response.ok) {
        this.soulContent = await response.text()
      } else {
        console.warn(`[LocalClaw] SOUL.md not found on server (${response.status}), using localStorage cache`)
        // 回退: 尝试从 localStorage 恢复
        const cached = localStorage.getItem('duncrew_soul_md')
        if (cached) {
          this.soulContent = cached
        }
      }
    } catch (error) {
      console.warn('[LocalClaw] Failed to load SOUL.md:', error)
      const cached = localStorage.getItem('duncrew_soul_md')
      if (cached) {
        this.soulContent = cached
      }
    }
  }

  /**
   * 重新加载 SOUL.md (Soul #5: 支持 SOUL.md 编辑后热更新)
   */
  async reloadSoulContent(): Promise<void> {
    // 如果用户已通过 LLM 生成了自定义 Soul，不从服务器覆盖
    const userGenerated = localStorage.getItem('duncrew_soul_generated_at')
    if (userGenerated) {
      console.log('[LocalClaw] Skipping SOUL.md reload: user-generated Soul content takes priority')
      return
    }

    const previousContent = this.soulContent
    await this.loadSoul()

    // 如果内容有变化，同步更新 store
    if (this.soulContent && this.soulContent !== previousContent) {
      try {
        const parsed = parseSoulMd(this.soulContent)
        this.storeActions?.setSoulFromParsed(parsed, null)
        localStorage.setItem('duncrew_soul_md', this.soulContent)
        console.log('[LocalClaw] SOUL.md reloaded and store updated')
      } catch (e) {
        console.warn('[LocalClaw] Failed to parse reloaded SOUL.md:', e)
      }
    }
  }

  /**
   * P0: 加载动态工具列表
   */
  private async loadTools(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/tools`)
      if (response.ok) {
        this.availableTools = await response.json()
        const plugins = this.availableTools.filter(t => t.type === 'plugin').length
        const instructions = this.availableTools.filter(t => t.type === 'instruction').length
        const mcpTools = this.availableTools.filter(t => t.type === 'mcp').length
        console.log(`[LocalClaw] ${this.availableTools.length} tools loaded (${plugins} plugins, ${instructions} instruction skills, ${mcpTools} mcp)`)
      }
    } catch (error) {
      console.warn('[LocalClaw] Failed to load tools, using defaults:', error)
    }
  }


  /**
   * 连接成功后，自动加载所有数据到 UI Store
   * Soul → 解析并注入 store (驱动 SoulHouse)
   * Skills → 注入 store (驱动 SkillTree + SoulOrb 粒子)
   * Memories → 注入 store (驱动 MemoryHouse)
   */
  /** P0-PERF: 防抖版 loadAllDataToStore —— 5 秒内最多执行一次，避免 ReAct 循环中的重复全量刷新 */
  private async loadAllDataToStoreDebounced(): Promise<void> {
    if (this._loadAllDataPromise) return this._loadAllDataPromise

    this._loadAllDataPromise = this.loadAllDataToStore()
    try {
      await this._loadAllDataPromise
    } finally {
      setTimeout(() => {
        this._loadAllDataPromise = null
      }, 5000)
    }
  }

  private async loadAllDataToStore(): Promise<void> {
    // 1. Soul: 解析已加载的 SOUL.md 并更新 store
    if (this.soulContent) {
      try {
        // 如果用户已通过 LLM 生成了自定义 Soul，优先使用 localStorage 中的内容
        const userGenerated = localStorage.getItem('duncrew_soul_generated_at')
        if (userGenerated) {
          const userSoul = localStorage.getItem('duncrew_soul_md')
          if (userSoul) {
            this.soulContent = userSoul
            console.log('[LocalClaw] Using user-generated Soul content (priority over server)')
          }
        }

        const parsed = parseSoulMd(this.soulContent)
        this.storeActions?.setSoulFromParsed(parsed, null)
        // 缓存到 localStorage
        localStorage.setItem('duncrew_soul_md', this.soulContent)
        console.log('[LocalClaw] Soul loaded to store')
      } catch (e) {
        console.warn('[LocalClaw] Failed to parse SOUL.md:', e)
      }

      // 尝试加载 IDENTITY.md
      try {
        const identityRes = await fetch(`${this.serverUrl}/file/IDENTITY.md`)
        if (identityRes.ok) {
          const identityContent = await identityRes.text()
          localStorage.setItem('duncrew_identity_md', identityContent)
        }
      } catch { /* optional file */ }
    }

    // 2. Skills: 从服务器获取技能列表
    try {
      const skillsRes = await fetch(`${this.serverUrl}/skills`)
      if (skillsRes.ok) {
        const skills: OpenClawSkill[] = await skillsRes.json()
        // 始终调用 setOpenClawSkills (即使空数组)，确保 channelsLoading 变为 false
        this.storeActions?.setOpenClawSkills(skills)
        if (skills.length > 0) {
          localStorage.setItem('duncrew_skills_json', JSON.stringify(skills))
          console.log(`[LocalClaw] ${skills.length} skills loaded to store`)

          // P1: 从 manifest.keywords 动态构建技能触发器
          this.buildSkillTriggersFromManifest(skills)
          
        } else {
          console.log('[LocalClaw] No skills found (empty array)')
        }
      } else {
        // API 失败也要设置空数组，解除 loading 状态
        this.storeActions?.setOpenClawSkills([])
        console.warn('[LocalClaw] Skills API returned non-OK status')
      }
    } catch (e) {
      // 失败也要设置空数组，解除 loading 状态
      this.storeActions?.setOpenClawSkills([])
      console.warn('[LocalClaw] Failed to load skills:', e)
    }

    // 3. Memories: 从服务器获取记忆
    try {
      const memoriesRes = await fetch(`${this.serverUrl}/memories`)
      if (memoriesRes.ok) {
        const memories: MemoryEntry[] = await memoriesRes.json()
        if (memories.length > 0) {
          this.storeActions?.setMemories(memories)
          localStorage.setItem('duncrew_memories_json', JSON.stringify(memories))
          console.log(`[LocalClaw] ${memories.length} memories loaded to store`)
        }
      }
    } catch (e) {
      console.warn('[LocalClaw] Failed to load memories:', e)
    }

    // 4. Duns: 从服务器获取 Dun 列表 (Phase 4)
    try {
      const dunsRes = await fetch(`${this.serverUrl}/duns`)
      if (dunsRes.ok) {
        const duns = await dunsRes.json()
        if (duns.length > 0) {
          this.storeActions?.setDunsFromServer(duns)
          // 注意: 不直接写 localStorage，由 setDunsFromServer 内部的
          // saveDunsToStorage 统一处理，避免无 scoring 的原始数据覆盖本地缓存
          console.log(`[LocalClaw] ${duns.length} duns loaded to store`)
        }
      }
    } catch (e) {
      console.warn('[LocalClaw] Failed to load duns:', e)
    }
  }

  /**
   * P1: 从 /skills 返回的 manifest.keywords 动态构建触发器
   * P4: 同时构建语义嵌入索引
   * 有 keywords 的技能会覆盖 DEFAULT_SKILL_TRIGGERS 中的同名条目
   * P5: 支持多工具技能 (toolNames 数组)
   */
  private buildSkillTriggersFromManifest(skills: OpenClawSkill[]): void {
    // 缓存 skill 对象列表，供融合排序使用
    this.cachedSkills = skills.filter(s => s.enabled && s.status === 'active')

    // 从 DEFAULT_SKILL_TRIGGERS 开始
    this.skillTriggers = { ...DEFAULT_SKILL_TRIGGERS }

    for (const skill of skills) {
      if (skill.keywords && skill.keywords.length > 0) {
        const skillMdPath = `skills/${skill.name}/SKILL.md`

        // 为每个 toolName 创建触发器映射
        const names = skill.toolNames
          || (skill.toolName ? [skill.toolName] : [skill.name])
        
        for (const name of names) {
          this.skillTriggers[name] = {
            keywords: skill.keywords,
            path: skillMdPath,
          }
        }

        // 也保留 skill.name 作为触发器 (向后兼容)
        if (!this.skillTriggers[skill.name]) {
          this.skillTriggers[skill.name] = {
            keywords: skill.keywords,
            path: skillMdPath,
          }
        }
      }
    }

    const dynamicCount = skills.filter(s => s.keywords && s.keywords.length > 0).length
    if (dynamicCount > 0) {
      console.log(`[LocalClaw] Skill triggers: ${Object.keys(this.skillTriggers).length} total (${dynamicCount} from manifests)`)
    }

    // 后台预热技能 embedding（延迟 5 秒，等 embedding 模型加载完成）
    if (this.cachedSkills.length > 0) {
      const skills = this.cachedSkills
      setTimeout(() => {
        warmupSkillEmbeddings(skills).catch(e =>
          console.warn('[LocalClaw] Skill embedding warmup failed (non-blocking):', e)
        )
      }, 5000)
    }

  }

  // ============================================
  // 🎯 JIT 动态上下文构建
  // ============================================

  /**
   * 构建动态上下文 (Just-In-Time Loading)
   * 根据用户查询动态注入相关上下文，避免上下文窗口膨胀
   * 返回构建好的上下文字符串，直接注入到系统提示词的 {context} 占位符
   * @param overrideDunId 可选的 Dun ID，优先于全局 activeDunId
   */
  private async buildDynamicContext(userQuery: string, overrideDunId?: string | null): Promise<string> {
    const contextParts: string[] = []
    const queryLower = userQuery.toLowerCase()

    // 弹性分区预算：各分区独立上限，总预算兜底
    const budgetCaps = CONFIG.BUDGET_CAPS as Record<string, number>
    const partitionUsed: Record<string, number> = {
      identity: 0, memory: 0, traces: 0, skills: 0, misc: 0,
    }
    const totalBudget = CONFIG.CONTEXT_CHAR_BUDGET
    let totalUsed = 0

    // V4: 注入元数据收集器
    let _metaL0Count = 0
    let _metaL0Chars = 0
    const _metaL0Scores: number[] = []
    const _metaL0Confidences: number[] = []
    const _metaCategoryCounts: Record<string, number> = {}
    let _metaTraceExecCount = 0
    let _metaTraceSuccessCount = 0
    let _metaSkillsInjected: Array<{ name: string; totalScore: number; semanticScore: number }> = []

    /** 带分区预算检查的 push */
    const pushContext = (text: string, partition = 'misc'): boolean => {
      if (!text || typeof text !== 'string') return false
      const cap = budgetCaps[partition] ?? totalBudget
      const used = partitionUsed[partition] ?? 0
      if (used + text.length > cap || totalUsed + text.length > totalBudget) {
        console.log(`[LocalClaw/DynCtx] Budget exceeded [${partition}], skipping ${text.slice(0, 40)}...`)
        return false
      }
      contextParts.push(text)
      partitionUsed[partition] = used + text.length
      totalUsed += text.length
      return true
    }

    // 0. P5: 指代消解提示 (优先注入，让模型理解代词指向)
    const anaphoraHint = this.buildAnaphoraHint(userQuery)
    if (anaphoraHint) {
      pushContext(anaphoraHint, 'identity')
    }

    // 1. 核心人格 (SOUL.md) - 始终加载但精简
    if (this.soulContent) {
      const soulSummary = this.extractSoulSummary(this.soulContent)
      if (soulSummary) {
        pushContext(`## 核心人格\n${soulSummary}`, 'identity')
      }
    }

    // ===== 分区 1: identity =====
    // 1.5 激活的 Dun SOP 注入 (Phase 4)
    const activeDunId = overrideDunId ?? this.getActiveDunId()
    if (activeDunId) {
      const dunCtx = await dunManager.buildContext(activeDunId, queryLower)
      if (dunCtx) {
        pushContext(dunCtx, 'identity')
      }

      // 1.5.1 SOP Evolution: 初始化 SOPTracker + 注入 hints/rewrite/golden-path
      if (!sopEvolutionService.getSOPTracker(activeDunId)) {
        const duns = this.storeActions?.duns
        const dun = duns?.get(activeDunId)
        let sopContent = dun?.sopContent
        if (!sopContent) {
          try {
            const res = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(activeDunId)}`)
            if (res.ok) {
              const detail = await res.json()
              sopContent = detail.sopContent
            }
          } catch { /* 静默 */ }
        }
        if (sopContent) {
          sopEvolutionService.createSOPTracker(activeDunId, dun?.label || activeDunId, sopContent)
        }
      }

      const sopHints = await sopEvolutionService.getContextHints(activeDunId)
      if (sopHints) {
        pushContext(sopHints, 'identity')
      }
    }

    // 1.6 📊 Dun 性能洞察注入
    const performanceInsight = dunManager.buildInsight(activeDunId)
    if (performanceInsight) {
      pushContext(performanceInsight, 'identity')
    }

    // ===== 分区 2: memory =====
    const isContinuation = /^(继续|接着|上次|还有|然后|go on|continue|last time|resume)/i.test(userQuery.trim())
    const effectiveDunId = activeDunId || undefined

    /** 按句子边界截断 */
    const truncateAtSentence = (text: string, maxLen: number): string => {
      if (text.length <= maxLen) return text
      const cut = text.lastIndexOf('。', maxLen)
      if (cut > maxLen * 0.6) return text.slice(0, cut + 1)
      const cut2 = text.lastIndexOf('\n', maxLen)
      if (cut2 > maxLen * 0.6) return text.slice(0, cut2)
      return text.slice(0, maxLen) + '…'
    }

    // ── Path A0_wiki: 全局 Wiki 知识（跨 Dun 共享）──
    let globalWikiInjected = false
    if (!isContinuation) {
      try {
        const res = await fetch(`${this.serverUrl}/api/wiki/render-text`)
        if (res.ok) {
          const globalWikiText = await res.text()
          if (globalWikiText.trim()) {
            pushContext(`## 全局知识\n${truncateAtSentence(globalWikiText, 800)}`, 'memory')
            globalWikiInjected = true
          }
        }
      } catch { /* wiki 不可用时静默降级 */ }
    }

    // ── Path A1_wiki: Per-Dun Wiki 知识（高优先级）──
    let dunWikiInjected = false
    if (effectiveDunId && !isContinuation) {
      try {
        const res = await fetch(
          `${this.serverUrl}/api/wiki/render-text?dun_id=${encodeURIComponent(effectiveDunId)}`
        )
        if (res.ok) {
          const dunWikiText = await res.text()
          if (dunWikiText.trim()) {
            pushContext(`## Dun 知识库\n${truncateAtSentence(dunWikiText, 2000)}`, 'memory')
            dunWikiInjected = true
          }
        }
      } catch { /* wiki 不可用时静默降级 */ }
    }

    // ── Path A0_legacy: 全局 knowledge/ 文件检索（wiki 无内容时的回退）──
    if (!isContinuation && !globalWikiInjected) {
      try {
        const globalIndexContent = await this.readFileWithCache('knowledge/_index.md')
        if (globalIndexContent) {
          const globalEntries = parseIndex(globalIndexContent)
          const globalRanked = rankIndexEntries(userQuery, globalEntries)
          const globalTopHit = globalRanked.slice(0, 1)

          for (const hit of globalTopHit) {
            const content = await this.readFileWithCache(`knowledge/${hit.entry.filename}`)
            if (content) {
              const truncated = truncateAtSentence(content, 600)
              pushContext(`## 全局知识\n### ${hit.entry.filename.replace(/\.md$/, '')}\n${truncated}`, 'memory')
            }
          }
        }
      } catch {
        // 全局知识检索失败时静默降级
      }
    }

    // ── Path A1_legacy: Per-Dun knowledge/ 文件检索（wiki 无内容时的回退）──
    if (effectiveDunId && !isContinuation && !dunWikiInjected) {
      try {
        const indexContent = await this.readFileWithCache(`duns/${effectiveDunId}/knowledge/_index.md`)
        if (indexContent) {
          const entries = parseIndex(indexContent)
          const ranked = rankIndexEntries(userQuery, entries)
          const topHits = ranked.slice(0, 2)
          const knowledgeSections: string[] = []

          for (const hit of topHits) {
            const filePath = `duns/${effectiveDunId}/knowledge/${hit.entry.filename}`
            const content = await this.readFileWithCache(filePath)
            if (content) {
              const truncated = truncateAtSentence(content, 1200)
              knowledgeSections.push(`### ${hit.entry.filename.replace(/\.md$/, '')}\n${truncated}`)
            }
          }

          if (knowledgeSections.length > 0) {
            pushContext(`## Dun 知识库\n${knowledgeSections.join('\n\n')}`, 'memory')
            // 异步更新 last_hit（fire-and-forget，不阻塞主流程）
            const today = new Date().toISOString().split('T')[0]
            const updatedIndex = entries.map(e => {
              const wasHit = topHits.some(h => h.entry.filename === e.filename)
              if (!wasHit) return `${e.filename} | ${e.summary} | ${e.lastHit}`
              return `${e.filename} | ${e.summary} | ${today}`
            })
            const newIndexContent = '<!-- Knowledge Index - Auto-generated -->\n' + updatedIndex.join('\n') + '\n'
            fetch(`${this.serverUrl}/duns/${encodeURIComponent(effectiveDunId)}/knowledge/index`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: newIndexContent }),
            }).catch(() => { /* 静默 */ })
          }
        }
      } catch {
        // knowledge/ 检索失败时静默降级到 Path B
      }
    }

    // ── Path B: memoryStore 兜底检索 ──
    try {
      /** 按 category 决定截断长度 */
      const truncateByCategory = (text: string, category: string): string => {
        if (category === 'discovery' || category === 'preference') return truncateAtSentence(text, 400)
        if (category === 'project_context') return truncateAtSentence(text, 300)
        return truncateAtSentence(text, 200)
      }

      // 动态 maxResults：短查询少拉，长查询多拉
      const dynamicMax = userQuery.length < 15 ? 3 : 6

      // L0 核心记忆 (高质量、已提炼)
      let l0Results: import('@/types').MemorySearchResult[]
      if (isContinuation && effectiveDunId) {
        l0Results = await memoryStore.getByDun(effectiveDunId, 10)
        l0Results = l0Results.filter(r => r.source === 'memory').slice(0, dynamicMax)
      } else {
        l0Results = await memoryStore.search({
          query: userQuery,
          sources: ['memory'],
          maxResults: dynamicMax,
          dunId: effectiveDunId,
          useMmr: true,
        })
      }

      // V4: 收集 L0 注入元数据
      _metaL0Count = l0Results.length
      for (const r of l0Results) {
        _metaL0Scores.push(r.score)
        if (r.confidence != null) _metaL0Confidences.push(r.confidence)
        const cat = (r.metadata?.category as string) || 'uncategorized'
        _metaCategoryCounts[cat] = (_metaCategoryCounts[cat] || 0) + 1
      }

      if (l0Results.length > 0) {
        const ruleLines: string[] = []
        const prefLines: string[] = []
        const ctxLines: string[] = []
        const otherLines: string[] = []

        for (const r of l0Results) {
          const category = (r.metadata?.category as string) || 'uncategorized'
          const rawText = r.snippet || r.content || ''
          const text = truncateByCategory(rawText, category)
          _metaL0Chars += rawText.length  // V4: 统计 L0 原始字符量
          const isRule = text.includes('→')

          if (isRule || category === 'discovery') {
            ruleLines.push(`- ${text}`)
          } else if (category === 'preference') {
            prefLines.push(`- ${text}`)
          } else if (category === 'project_context') {
            ctxLines.push(`- ${text}`)
          } else {
            otherLines.push(`- ${text}`)
          }
        }

        const memorySections: string[] = []
        if (ruleLines.length > 0) memorySections.push(`## 核心行为准则（必须遵循）\n${ruleLines.join('\n')}`)
        if (prefLines.length > 0) memorySections.push(`## 用户偏好（尊重执行）\n${prefLines.join('\n')}`)
        if (ctxLines.length > 0) memorySections.push(`## 环境上下文（供参考）\n${ctxLines.join('\n')}`)
        if (otherLines.length > 0) memorySections.push(`## 历史观察（低优先级）\n${otherLines.join('\n')}`)

        if (memorySections.length > 0) {
          pushContext(memorySections.join('\n\n'), 'memory')
        }
      }

      // 按 Dun 最近记忆 (保底补充)
      const seen = new Set<string>(l0Results.map(r => r.id))
      if (effectiveDunId && !isContinuation) {
        const recentByDun = await memoryStore.getByDun(effectiveDunId, 5)
        const recentNew = recentByDun.filter(r => !seen.has(r.id)).slice(0, 3)
        if (recentNew.length > 0) {
          const recentHints = recentNew.map(r => `- ${truncateAtSentence(r.snippet || r.content || '', 200)}`).join('\n')
          pushContext(`## Dun 最近记忆\n${recentHints}`, 'memory')
        }
      }
    } catch {
      const today = new Date().toISOString().split('T')[0]
      const dailyLog = await this.readFileWithCache(`memory/${today}.md`)
      if (dailyLog) {
        const recentLogs = this.extractRecentLogs(dailyLog, 10)
        if (recentLogs) {
          pushContext(`## 今日活动\n${recentLogs}`, 'memory')
        }
      }
    }

    // ===== 分区 3: traces (合并 exec_trace + 历史成功案例) =====

    // Phase 0: 碱基策略自动提炼（纯统计，零 LLM 开销）
    try {
      const governorStats = baseSequenceGovernor.getFullStats()
      const strategies = deriveStrategies(governorStats)
      if (strategies.length > 0) {
        const strategyBlock = `## 执行策略（基于历史数据）\n${strategies.map(s => `- ${s}`).join('\n')}`
        pushContext(strategyBlock, 'traces')
      }
    } catch {
      // 策略提炼失败时静默降级
    }

    try {
      const traceLines: string[] = []

      // 源 1: exec_trace (from memoryStore)
      const traceResults = await memoryStore.search({
        query: isContinuation && effectiveDunId ? '*' : userQuery,
        sources: ['exec_trace'],
        maxResults: 4,
        dunId: effectiveDunId,
        useMmr: true,
      })
      for (const r of traceResults) {
        traceLines.push(`- ${truncateAtSentence(r.snippet || r.content || '', 200)}`)
      }

      // 源 2: 历史成功案例 (searchExecTraces)
      const relatedTraces = await this.searchExecTraces(queryLower, 3)
      const successfulTraces = relatedTraces.filter(t => t.success)
      for (const t of successfulTraces) {
        const toolSeq = t.tools.map(tool => `${tool.name}()`).join(' → ')
        traceLines.push(`- 任务: "${t.task.slice(0, 50)}..." → ${toolSeq}`)
      }

      // V4: 收集 traces 注入元数据
      _metaTraceExecCount = traceResults.length
      _metaTraceSuccessCount = successfulTraces.length

      if (traceLines.length > 0) {
        pushContext(`## 历史执行参考\n${traceLines.join('\n')}`, 'traces')
      }
    } catch {
      // traces 不可用时静默降级
    }

    // ===== 分区 4: skills (V4: 融合排序，只注入 top-K 相关技能) =====
    if (this.cachedSkills.length > 0) {
      const maxDescChars = CONFIG.SKILL_LISTING_MAX_DESC_CHARS
      const skillLines: string[] = []

      try {
        // 融合排序：语义相关度 50% + 使用信号 25% + 新鲜度 15% + 质量先验 10%
        const ranked = await rankSkills(userQuery, this.cachedSkills, 15, 0.25)

        for (const r of ranked) {
          const skill = r.skill
          const desc = skill.description
            ? skill.description.slice(0, maxDescChars) + (skill.description.length > maxDescChars ? '…' : '')
            : ''
          const whenHint = skill.whenToUse ? ` [适用: ${skill.whenToUse}]` : ''
          skillLines.push(`- **${skill.name}**: ${desc}${whenHint}`)
        }

        // V4: 收集 skills 注入元数据
        _metaSkillsInjected = ranked.map(r => ({
          name: r.skill.name,
          totalScore: r.totalScore,
          semanticScore: r.breakdown.semanticScore,
        }))
      } catch {
        // rankSkills 失败时降级为全量注入（与原逻辑一致）
        console.warn('[LocalClaw/DynCtx] rankSkills failed, falling back to full list')
        for (const skill of this.cachedSkills) {
          const desc = skill.description
            ? skill.description.slice(0, maxDescChars) + (skill.description.length > maxDescChars ? '…' : '')
            : ''
          const whenHint = skill.whenToUse ? ` [适用: ${skill.whenToUse}]` : ''
          skillLines.push(`- **${skill.name}**: ${desc}${whenHint}`)
        }
      }

      if (skillLines.length > 0) {
        pushContext(`## 可用技能清单\n${skillLines.join('\n')}`, 'skills')
      }
    }

    // ===== 分区 5: misc =====
    // 文件注册表
    const knownFilesSection = fileRegistry.buildContextSection(activeDunId || undefined, 15)
    if (knownFilesSection) {
      pushContext(knownFilesSection, 'misc')
    }

    // 用户偏好 (按需)
    if (queryLower.includes('偏好') || queryLower.includes('设置') || queryLower.includes('preference')) {
      const userPrefs = await this.readFileWithCache('USER.md')
      if (userPrefs) {
        pushContext(`## 用户偏好\n${userPrefs}`, 'misc')
      }
    }

    // Dun 通讯提示
    const dunCommunicationHint = dunManager.buildDunCommunicationHint(userQuery, activeDunId || undefined)
    if (dunCommunicationHint) {
      pushContext(dunCommunicationHint, 'misc')
    }

    // Soul Evolution: 用户偏好修正案
    try {
      const storeModule = await import('@/store')
      const storeState = storeModule.useStore.getState()
      const activeAmendments = storeState.amendments.filter(
        (a) => a.status === 'approved' && a.weight >= SOUL_EVOLUTION_CONFIG.INJECTION_MIN_WEIGHT,
      )
      if (activeAmendments.length > 0) {
        const sorted = [...activeAmendments].sort((a, b) => b.weight - a.weight)
        let charBudget = SOUL_EVOLUTION_CONFIG.MAX_INJECTION_CHARS
        const lines: string[] = []
        for (const a of sorted) {
          if (charBudget <= 0) break
          const line = `- ${a.content} (权重: ${a.weight.toFixed(2)})`
          lines.push(line)
          charBudget -= line.length
          if (!this.countedAmendmentIds.has(a.id)) {
            storeState.incrementHitCount(a.id)
            this.countedAmendmentIds.add(a.id)
          }
        }
        pushContext(`## 用户偏好观测\n以下是从历史行为中观测到的用户偏好，请适当参考:\n${lines.join('\n')}`, 'misc')
      }
    } catch {
      // Soul amendment store 不可用时静默降级
    }

    // 组合上下文
    const now = new Date()
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false })
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const weekday = `星期${weekdays[now.getDay()]}`
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const yesterdayStr = `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日`
    const header = `当前日期: ${dateStr} ${weekday}\n当前时间: ${timeStr}\n\n⚠️ 重要：用户说"今天"指的就是 ${dateStr}，"昨天"指 ${yesterdayStr}。请务必使用上述日期，不要猜测或使用其他日期。\n\n用户意图: ${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}`
    
    const context = contextParts.length > 0 
      ? `${header}\n\n${contextParts.join('\n\n')}`
      : header

    // V4: 组装注入元数据（供 trace 写入时消费）
    const avgScore = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
    this._lastInjectionMeta = {
      memory: {
        l0Count: _metaL0Count,
        l0Chars: _metaL0Chars,
        l0AvgScore: avgScore(_metaL0Scores),
        l0AvgConfidence: avgScore(_metaL0Confidences),
        l0ScoreRange: _metaL0Scores.length > 0
          ? [Math.min(..._metaL0Scores), Math.max(..._metaL0Scores)]
          : [0, 0],
        categoryCounts: _metaCategoryCounts,
        budgetUsed: partitionUsed['memory'] ?? 0,
        budgetCap: budgetCaps['memory'] ?? totalBudget,
      },
      skills: {
        availableCount: this.cachedSkills.length,
        injectedCount: _metaSkillsInjected.length,
        injectedChars: partitionUsed['skills'] ?? 0,
        avgSemanticScore: avgScore(_metaSkillsInjected.map(s => s.semanticScore)),
        avgTotalScore: avgScore(_metaSkillsInjected.map(s => s.totalScore)),
        minTotalScore: _metaSkillsInjected.length > 0
          ? Math.min(..._metaSkillsInjected.map(s => s.totalScore))
          : 0,
        injectedSkills: _metaSkillsInjected,
      },
      traces: {
        execTraceCount: _metaTraceExecCount,
        successCaseCount: _metaTraceSuccessCount,
        budgetUsed: partitionUsed['traces'] ?? 0,
      },
      totalChars: totalUsed,
      totalBudget,
    }

    return context
  }

  // ============================================
  // 🌌 Dun 上下文 (委托给提取的服务)
  // ============================================

  /**
   * 获取当前激活的 Dun ID
   */
  private getActiveDunId(): string | null {
    // 从 storeActions 中读取 (Zustand 状态)
    return this.storeActions?.activeDunId ?? null
  }

  /**
   * 带缓存的文件读取
   */
  private async readFileWithCache(path: string): Promise<string | null> {
    const cached = this.contextCache.get(path)
    const now = Date.now()

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.content
    }

    const content = await this.readFile(path)
    if (content) {
      this.contextCache.set(path, { content, timestamp: now })
    }
    return content
  }

  /**
   * 提取 SOUL.md 摘要 (精简版)
   * Soul #8: 扩展支持 Core/Boundaries/Vibe 等多个 section
   */
  private extractSoulSummary(soulContent: string): string {
    const lines = soulContent.split('\n')
    const summaryLines: string[] = []
    let inTargetSection = false
    let lineCount = 0
    const maxLines = CONFIG.SOUL_SUMMARY_MAX_LINES

    // Soul #8: 判断是否为目标 section
    const isTargetSection = (line: string): boolean => {
      return line.startsWith('# ') || // 主标题
             line.startsWith('## Core') || line.startsWith('## 核心') ||
             line.startsWith('## Boundaries') || line.startsWith('## 边界') ||
             line.startsWith('## Vibe') || line.startsWith('## 风格') || line.startsWith('## 个性')
    }

    for (const line of lines) {
      if (lineCount >= maxLines) break

      // 匹配目标 section
      if (isTargetSection(line)) {
        inTargetSection = true
        summaryLines.push(line)
        lineCount++
      } else if (inTargetSection && line.trim()) {
        // 遇到其他 ## 开头的 section 时退出当前 section
        if (line.startsWith('## ') && !isTargetSection(line)) {
          inTargetSection = false
        } else {
          summaryLines.push(line)
          lineCount++
        }
      }
    }

    return summaryLines.join('\n').trim()
  }

  /**
   * 提取最近的日志条目
   */
  private extractRecentLogs(logContent: string, count: number): string {
    const entries = logContent.split(/\n(?=\[|\d{2}:)/).filter(e => e.trim())
    return entries.slice(-count).join('\n')
  }

  // ============================================
  // 📦 远程技能安装
  // ============================================

  /**
   * 从 Git URL 安装新技能
   * @param source Git URL (https://... 或 git@...)
   * @param name 可选，指定安装目录名
   * @returns 安装的技能名称
   */
  async installSkill(source: string, name?: string): Promise<string> {
    const res = await fetch(`${this.serverUrl}/skills/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, name }),
    })

    const result = await res.json()

    if (!res.ok) {
      throw new Error(result.error || `Install failed: ${res.status}`)
    }

    // P0-05: 只刷新技能相关数据，不全量重载
    await this.loadTools()
    await this.refreshSkillsOnly()

    return result.name
  }

  /**
   * 卸载技能
   * @param skillName 技能名称
   */
  async uninstallSkill(skillName: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/skills/uninstall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: skillName }),
    })

    const result = await res.json()

    if (!res.ok) {
      throw new Error(result.error || `Uninstall failed: ${res.status}`)
    }

    // P0-05: 只刷新技能相关数据，不全量重载
    await this.loadTools()
    await this.refreshSkillsOnly()
  }

  /**
   * P0-05: 仅刷新技能列表，避免 loadAllDataToStore 覆盖运行中数据
   */
  private async refreshSkillsOnly(): Promise<void> {
    try {
      const skillsRes = await fetch(`${this.serverUrl}/skills`)
      if (skillsRes.ok) {
        const skills: OpenClawSkill[] = await skillsRes.json()
        this.storeActions?.setOpenClawSkills(skills)
        if (skills.length > 0) {
          localStorage.setItem('duncrew_skills_json', JSON.stringify(skills))
          this.buildSkillTriggersFromManifest(skills)
        }
      }
    } catch (e) {
      console.warn('[LocalClaw] Failed to refresh skills:', e)
    }
  }

  // ============================================
  // 🌟 入口方法
  // ============================================

  /**
   * 发送简单消息 (ReAct 模式)
   * @param dunId 可选的 Dun ID，用于注入 SOP 上下文
   */
  async sendMessage(
    prompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    dunId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置。请在设置中配置 API Key。')
    }

    // 清空上次执行的文件创建记录
    this._lastCreatedFiles = []
    this._lastTraceId = null

    // 取消上一次的后台任务（flush、ingest 等），避免与新任务竞争 API 额度
    this._backgroundAbortController?.abort()
    backgroundQueue.cancelAll()
    this._backgroundAbortController = new AbortController()

    // P4: Dun 触发器匹配 - 自动激活匹配的 Dun (仅当未指定 dunId 时)
    const effectiveDunId = dunId ?? this.getActiveDunId()
    if (!effectiveDunId) {
      const matchedDun = dunManager.matchForTask(prompt)
      if (matchedDun) {
        this.storeActions?.setActiveDun?.(matchedDun.id)
        console.log(`[LocalClaw] Auto-activated Dun by trigger: ${matchedDun.id}`)
      }
    }

    const execId = `native-${Date.now()}`
    
    this.storeActions?.updateExecutionStatus(execId, {
      id: execId,
      status: 'running',
      timestamp: Date.now(),
    })

    // 设置当前任务上下文 (驱动 UI 全局状态指示)
    this.storeActions?.setCurrentTask(execId, prompt.slice(0, 80))

    // 确定最终使用的 dunId
    const finalDunId = dunId ?? this.getActiveDunId()

    try {
      const result = await this.runReActLoop(prompt, onUpdate, onStep, finalDunId, onCheckpoint, signal, conversationHistory)
      
      this.storeActions?.updateExecutionStatus(execId, {
        status: 'success',
        output: result,
      })

      return result
    } catch (error: any) {
      this.storeActions?.updateExecutionStatus(execId, {
        status: 'error',
        error: error.message,
      })
      throw error
    } finally {
      // 清除当前任务上下文
      this.storeActions?.setCurrentTask(null, null)
    }
  }

  /**
   * 从检查点恢复执行
   * 将之前执行的历史作为上下文注入，让 LLM 从断点继续
   */
  async resumeFromCheckpoint(
    checkpoint: TaskCheckpoint,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置。请在设置中配置 API Key。')
    }

    // 清空上次执行的文件创建记录
    this._lastCreatedFiles = []
    this._lastTraceId = null

    const execId = `resume-${Date.now()}`
    
    this.storeActions?.updateExecutionStatus(execId, {
      id: execId,
      status: 'running',
      timestamp: Date.now(),
    })

    // 构建已完成步骤的摘要
    const completedStepsSummary = checkpoint.traceTools
      .filter(t => t.status === 'success')
      .map((t, i) => `${i + 1}. ${t.name}(${JSON.stringify(t.args).slice(0, 100)}) → 成功`)
      .join('\n')

    const failedStepsSummary = checkpoint.traceTools
      .filter(t => t.status === 'error')
      .map(t => `- ${t.name}: ${t.result.slice(0, 100)}`)
      .join('\n')

    // 构建恢复提示
    const resumePrompt = `[断点恢复] 请继续完成以下任务：

原始任务: ${checkpoint.userPrompt}

已完成的步骤 (${checkpoint.traceTools.filter(t => t.status === 'success').length}个):
${completedStepsSummary || '无'}

${failedStepsSummary ? `之前失败的步骤:\n${failedStepsSummary}\n请避免重复相同的错误。` : ''}

请从断点继续执行，完成剩余的任务。不要重复已完成的步骤。`

    console.log(`[LocalClaw] Resuming from checkpoint: ${checkpoint.stepIndex} steps completed`)

    // S1: 从 checkpoint.messages 中提取 user/assistant 对话历史
    // 让 LLM 恢复断点前的完整上下文，而非仅依赖文本摘要
    const checkpointHistory: Array<{ role: 'user' | 'assistant'; content: string }> = checkpoint.messages
      .filter((m): m is typeof m & { role: 'user' | 'assistant'; content: string } =>
        (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0
      )
      .slice(-10) // 保留最近 10 条，避免上下文过长

    console.log(`[LocalClaw] Checkpoint history: ${checkpointHistory.length} messages restored from ${checkpoint.messages.length} total`)

    // 设置当前任务上下文
    this.storeActions?.setCurrentTask(execId, `恢复: ${checkpoint.userPrompt.slice(0, 50)}`)

    try {
      const result = await this.runReActLoop(
        resumePrompt,
        onUpdate,
        onStep,
        checkpoint.dunId,
        onCheckpoint,
        undefined, // signal
        checkpointHistory
      )
      
      this.storeActions?.updateExecutionStatus(execId, {
        status: 'success',
        output: result,
      })

      return result
    } catch (error: any) {
      this.storeActions?.updateExecutionStatus(execId, {
        status: 'error',
        error: error.message,
      })
      throw error
    } finally {
      this.storeActions?.setCurrentTask(null, null)
    }
  }



  /**
   * 发送复杂任务 (带规划)
   */
  async sendComplexTask(
    prompt: string,
    onProgress?: (step: PlanStep, total: number) => void
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置')
    }

    const execId = `plan-${Date.now()}`
    
    this.storeActions?.setAgentStatus('planning')
    this.storeActions?.updateExecutionStatus(execId, {
      id: execId,
      status: 'running',
      timestamp: Date.now(),
    })

    try {
      // 1. 生成计划
      const plan = await this.generatePlan(prompt)
      console.log('[LocalClaw] Generated plan:', plan)

      // 2. 执行每个步骤 (支持失败重新规划)
      let failCount = 0
      let replanCount = 0
      const MAX_REPLAN = 1  // 最多重新规划1次

      for (let i = 0; i < plan.length; i++) {
        const step = plan[i]
        step.status = 'running'
        onProgress?.(step, plan.length)

        try {
          const stepResult = await this.executeStep(step, plan)
          step.status = 'completed'
          step.result = stepResult
          failCount = 0  // 成功时重置连续失败计数
        } catch (error: any) {
          step.status = 'failed'
          step.result = error.message
          failCount++

          // 连续失败 2 次 → 触发重新规划剩余步骤
          if (failCount >= 2 && replanCount < MAX_REPLAN) {
            replanCount++
            const remainingSteps = plan.slice(i + 1)
            if (remainingSteps.length > 0) {
              console.log(`[LocalClaw] Re-planning after ${failCount} consecutive failures...`)
              const completedContext = plan
                .filter(s => s.status === 'completed')
                .map(s => `[completed] ${s.description}: ${s.result?.slice(0, 100)}`)
                .join('\n')
              const failedContext = plan
                .filter(s => s.status === 'failed')
                .map(s => `[failed] ${s.description}: ${s.result?.slice(0, 100)}`)
                .join('\n')

              const replanPrompt = `原始任务: ${prompt}\n\n已完成:\n${completedContext}\n\n失败:\n${failedContext}\n\n请根据已有进展和失败原因，重新规划剩余步骤。`
              try {
                const newPlan = await this.generatePlan(replanPrompt)
                plan.splice(i + 1, plan.length - i - 1, ...newPlan)
                console.log(`[LocalClaw] Re-planned: ${newPlan.length} new steps`)
              } catch {
                console.warn('[LocalClaw] Re-planning failed, continuing with original plan')
              }
            }
          }
        }

        onProgress?.(step, plan.length)
      }

      // 3. 生成总结报告
      const report = await this.synthesizeReport(prompt, plan)

      this.storeActions?.updateExecutionStatus(execId, {
        status: 'success',
        output: report,
      })

      return report
    } catch (error: any) {
      this.storeActions?.updateExecutionStatus(execId, {
        status: 'error',
        error: error.message,
      })
      throw error
    } finally {
      this.storeActions?.setAgentStatus('idle')
    }
  }

  // ============================================
  // 🧠 ReAct 循环
  // ============================================

  /**
   * ReAct 循环 - 直接调用 Function Calling 模式
   * @param dunId 可选的 Dun ID，用于注入 Dun 上下文
   */
  private async runReActLoop(
    userPrompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    dunId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    return this.runReActLoopFC(userPrompt, onUpdate, onStep, dunId, onCheckpoint, signal, conversationHistory)
  }

  // ============================================
  // 🚀 ReAct 循环 - Function Calling 模式
  // ============================================

  /**
   * ReAct 循环 - 原生 Function Calling 模式
   * 使用 OpenAI-compatible tools API 实现工具调用
   * @param dunId 可选的 Dun ID，用于注入 SOP 上下文
   *
   * 内部结构导航:
   * - SECTION A: 初始化 (上下文、提示词、工具、历史消息)
   * - SECTION B: 主循环 (while loop)
   *   - B1: 中止检查 & Token 预算管理
   *   - B2: LLM 调用 & 响应解析
   *   - B3: 工具执行循环
   *   - B4: Reflexion/Critic 机制
   *   - B5: SOP/Entity 更新 & 规则评估
   *   - B6: 无工具调用 → 最终回复
   *   - B7: 错误恢复
   * - SECTION C: 任务完成验证 & 升级
   * - SECTION D: Trace 保存 & 统计更新
   * - SECTION E: 记忆刷写 & 最终返回
   */
  private async runReActLoopFC(
    userPrompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    dunId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    this.checkImplicitFeedback(userPrompt)
    this.storeActions?.setAgentStatus('thinking')
    this._verificationCache.clear()

    // 初始化当前模型（从 LLM 配置读取，作为 ErrorRecovery 模型切换的基准）
    this._currentModel = getLLMConfig().model || 'unknown'

    // V5: 捕获 LLM Provider 标签（用于 trace 按 Provider 对比分析）
    let llmProviderLabel = 'unknown'
    try {
      const { useStore } = await import('@/store')
      const { providers, channelBindings } = useStore.getState().linkStation
      const binding = channelBindings.chat
      if (binding) {
        const provider = providers.find(p => p.id === binding.providerId)
        if (provider) llmProviderLabel = provider.label
      }
    } catch { /* store 未就绪时 fallback */ }

    // V2: 初始化 EventBus run
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const runStartTime = Date.now()
    const currentLLMModel = this._currentModel || 'unknown'
    agentEventBus.startRun(runId, currentLLMModel, dunId || undefined)

    // 🎯 Dun 驱动：为当前任务准备精准工具集
    const { tools: taskTools, matchedDun, isFiltered } = dunManager.prepareToolsForTask(userPrompt, dunId)
    let currentTaskTools = taskTools

    // 多维复杂度分类（替代旧的字符串长度 + 正则判断）
    const activeDunId = dunId || this.getActiveDunId()
    const taskClassification = classifyTaskComplexity(
      userPrompt,
      matchedDun,
      activeDunId,
      conversationHistory,
    )
    const maxTurns = taskClassification.level === 'chat' ? CONFIG.SIMPLE_TURNS : CONFIG.DEFAULT_TURNS
    console.log(`[LocalClaw/FC] Task complexity: ${taskClassification.level}, maxTurns: ${maxTurns}`)

    // V2: Phase 1 - 初始化 ContextEngine (可插拔的上下文管理器)
    const engineDunId = activeDunId || 'default'
    const contextEngine = contextEngineRegistry.getOrCreate(engineDunId, () =>
      new DefaultDunContextEngine({
        dunId: engineDunId,
        dunLabel: matchedDun?.label || engineDunId,
        getContext: async (query: string) => await this.buildDynamicContext(query, dunId),
        getSystemPrompt: () => getSystemPromptFC(getCurrentLocale()),
      })
    )

    // Bootstrap - 轻量会话初始化（仅清理状态，不加载记忆）
    await contextEngine.bootstrap?.({ sessionId: runId }).catch(e =>
      console.warn('[LocalClaw/FC] Bootstrap failed (non-blocking):', e)
    )

    // JIT: 动态构建上下文 (传入 dunId 注入 SOP)
    const dynamicContext = await this.buildDynamicContext(userPrompt, dunId)

    // 构建精简系统提示词 (FC 模式无需工具文档)
    const soulSummary = this.soulContent ? this.extractSoulSummary(this.soulContent) : ''
    const locale = getCurrentLocale()
    let systemPrompt = getSystemPromptFC(locale)
      .replace('{soul_summary}', soulSummary || (locale === 'en' ? 'A friendly, professional AI assistant' : '一个友好、专业的 AI 助手'))
      .replace('{context}', dynamicContext)

    // V2: 估算系统提示 token 数并上报
    const systemTokens = estimateTokens(systemPrompt)
    console.log(`[LocalClaw/FC] System prompt tokens: ~${systemTokens}`)

    // 转换工具为 OpenAI Function Calling 格式
    let tools = convertToolInfoToFunctions(currentTaskTools)
    console.log(`[LocalClaw/FC] Registered ${tools.length} functions${isFiltered ? ` (filtered for Dun: ${matchedDun?.label})` : ''}`)

    // 消息历史 (使用标准 OpenAI 格式)
    // 注入最近对话历史，让模型了解前几轮的上下文
    const messages: SimpleChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ]

    // 注入会话历史 (最近几轮对话摘要，让模型理解上下文)
    if (conversationHistory && conversationHistory.length > 0) {
      // 取最近 MAX_HISTORY_TURNS 轮对话，避免上下文膨胀
      const MAX_HISTORY_TURNS = CONFIG.MAX_HISTORY_TURNS
      const recentHistory = conversationHistory.slice(-MAX_HISTORY_TURNS)
      for (const msg of recentHistory) {
        // 截断过长的历史消息 (保留摘要级别)
        const truncated = msg.content.length > 800
          ? msg.content.slice(0, 800) + '\n...(内容已截断)'
          : msg.content
        messages.push({ role: msg.role, content: truncated })
      }
      console.log(`[LocalClaw/FC] Injected ${recentHistory.length} conversation history messages`)
    }

    messages.push({ role: 'user', content: userPrompt })

    let turnCount = 0
    let finalResponse = ''
    let lastToolResult = ''
    let consecutiveFailures = 0  // 连续失败计数 (用于触发重规划)
    const MAX_CONSECUTIVE_FAILURES = 2  // 连续失败阈值
    const errorSignatureHistory: string[] = []  // 错误签名追踪 (防 Reflexion 死循环)
    let pendingGeneMatches: GeneMatch[] = []  // 🧬 Gene Pool: 待反馈的基因匹配（Reflexion 注入后等待下一轮结果）
    let wasAborted = false  // P1-29/M1: 标记是否被用户中止
    let completionPath: 'natural' | 'aborted' | 'truncation_fail' | 'unrecoverable_error' | 'max_turns' | 'escalation' | 'agent_abort' = 'natural'  // V3: 循环终止路径
    let taskValidation: TaskCompletionResult | null = null  // V3: 保留 validation 结果用于 success 判定
    let truncationRetries = 0  // 输出截断重试计数器
    
    // 🔄 升级机制状态
    let currentMaxTurns = maxTurns
    let escalationCount = 0
    let needEscalation = false

    // P2: 执行追踪收集
    const traceTools: ExecTraceToolCall[] = []
    const traceStartTime = Date.now()
    const TOKEN_BUDGET = CONFIG.TOKEN_BUDGET
    const baseCtx = createBaseClassifierCtx()  // V2: 碱基分类器上下文

    // V2: 碱基序列独立数组（P 碱基 + 工具碱基统一记录）
    const baseSequenceEntries: import('@/types').BaseSequenceEntry[] = []
    let baseSequenceOrder = 0  // 全局碱基序号
    // V2: 每轮 ReAct 元数据
    const turnMetas: import('@/types').ReActTurnMeta[] = []
    // V2: Reflexion 标志位 — 上一轮是否触发了 Reflexion（服务于 turnMetas.isReflexion）
    let lastTurnHadReflexion = false
    // V3: Governor 干预记录
    const governorInterventions: InterventionRecord[] = []
    let governorPromptInjection = ''
    // V7: Context Refresh 事件记录
    const contextRefreshEvents: import('@/types').ContextRefreshEvent[] = []
    // V8: 碱基 Ledger 服务集成
    baseLedgerService.createLedger(runId, activeDunId || 'default')
    baseLedgerService.setObjective(runId, userPrompt.slice(0, 200))
    let factsUpdateCounter = 0  // Facts 更新计数器（每 5 轮更新一次）
    // Phase 3: Transcriptase spawn 决策记录（供 Governor 统计用）
    const transcriptaseSpawnRecords: import('@/types').TranscriptaseSpawnRecord[] = []
    let hadTranscriptaseSpawn = false

    // 🧬 Gene Pool: 懒加载基因库
    await genePoolService.ensureLoaded()

    // 外层升级循环
    do {
      needEscalation = false
      
      // 主循环
      while (turnCount < currentMaxTurns) {
        // 每轮刷新当前模型名（Provider 可能已切换）
        this._currentModel = getLLMConfig().model || 'unknown'

        // 🛑 终止检查: 每轮开始前检查是否已被用户终止
        if (signal?.aborted) {
          console.log(`[LocalClaw/FC] Aborted by user at turn ${turnCount}`)
          finalResponse = finalResponse || lastToolResult || '任务已被用户终止。'
          wasAborted = true
          completionPath = 'aborted'
          // P1-29/M1: 中止时清理中间状态
          this._verificationCache.clear()
          pendingGeneMatches = []
          break
        }

        turnCount++
        console.log(`[LocalClaw/FC] Turn ${turnCount}`)

        // V2: 每轮开始 — 记录碱基起始位置 & 消费 Reflexion 标志位
        const turnBaseStartIndex = baseSequenceEntries.length
        const isReflexionTurn = lastTurnHadReflexion
        lastTurnHadReflexion = false

        // SOP Evolution: 每隔 N 轮注入 SOP 进度提醒
        {
          const sopDunId = dunId || this.getActiveDunId()
          if (sopDunId && turnCount > 1 && turnCount % sopEvolutionService.reminderInterval === 0) {
            const usedToolNames = traceTools.map(t => t.name)
            const reminder = sopEvolutionService.buildSOPReminder(sopDunId, usedToolNames, lastToolResult)
            if (reminder) {
              messages.push({
                role: 'user',
                content: CONFIG.HINT_SEPARATOR + reminder,
              })
            }
          }
        }

        try {
          // Fix2: 推送 thinking step，让 TaskHouse 实时显示"正在思考"
          onStep?.({
            id: `thinking-${Date.now()}`,
            type: 'thinking',
            content: `Turn ${turnCount}: 正在思考...`,
            timestamp: Date.now(),
          })
          agentEventBus.changePhase('planning', `Turn ${turnCount}`)

          // V2: 每轮开始时估算上下文 token 使用 + ContextEngine 压缩
          const turnContextTokens = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : '') + 4, 0)
          if (turnContextTokens > TOKEN_BUDGET * 0.75) {
            agentEventBus.tokenWarning(turnContextTokens, TOKEN_BUDGET)
            console.log(`[LocalClaw/FC] Token warning: ~${turnContextTokens} tokens in context (${Math.round(turnContextTokens / TOKEN_BUDGET * 100)}%)`)

            // Phase 1: 使用 ContextEngine.compact() 主动压缩上下文
            if (turnContextTokens > TOKEN_BUDGET * 0.85) {
              agentEventBus.compactionStart(turnContextTokens, 'overflow')
              try {
                const compactResult = await contextEngine.compact({
                  sessionId: runId,
                  tokenBudget: TOKEN_BUDGET,
                  trigger: 'overflow',
                  currentTokenCount: turnContextTokens,
                })
                if (compactResult.compacted && compactResult.summary) {
                  // 压缩成功: 用摘要替换早期的非系统消息
                  const systemMsg = messages[0] // 保留系统消息
                  const recentMessages = messages.slice(-8) // 保留最近 8 条消息
                  messages.length = 0
                  messages.push(systemMsg)
                  messages.push({
                    role: 'user',
                    content: `[上下文摘要] 以下是之前对话的压缩摘要:\n${compactResult.summary}`,
                  })
                  messages.push(...recentMessages)
                  console.log(`[LocalClaw/FC] Context compacted: ${compactResult.tokensBefore} → ~${compactResult.tokensAfter} tokens`)
                }
                agentEventBus.compactionEnd(
                  turnContextTokens,
                  compactResult.tokensAfter || turnContextTokens,
                  compactResult.compacted,
                  compactResult.summary,
                )
              } catch (compactErr) {
                console.warn('[LocalClaw/FC] Context compaction failed:', compactErr)
                agentEventBus.compactionEnd(turnContextTokens, turnContextTokens, false)
              }
            }
          }

          // 硬性裁剪 fallback：压缩失败或消息数量过多时强制截断
          if (messages.length > 100) {
            const systemMsg = messages[0]
            const recentMessages = messages.slice(-30)
            messages.length = 0
            messages.push(systemMsg, ...recentMessages)
            console.warn(`[LocalClaw] Hard message trim: kept system + last 30 messages`)
          }

          // 调用 LLM (带 tools 参数)
          let streamedContent = ''
          agentEventBus.messageStart()
          // V2: LLM 调用计时开始
          const llmCallStart = Date.now()
          const result: LLMStreamResult = await streamChat(
            messages,
            (chunk) => {
              streamedContent += chunk
              onUpdate?.(streamedContent)
              agentEventBus.textDelta(chunk, streamedContent)
            },
            signal, // 传入 AbortSignal，终止时中断 fetch
            undefined, // config
            tools,
            (reasoningChunk) => {
              agentEventBus.thinkingDelta(reasoningChunk)
            },
          )

          // V2: 计算 LLM 响应耗时
          const llmResponseTime = Date.now() - llmCallStart

          let { content, toolCalls, finishReason, reasoningContent, usage: turnUsage } = result
        agentEventBus.messageEnd(content || '')
        console.log(`[LocalClaw/FC] finish_reason: ${finishReason}, toolCalls: ${toolCalls.length}${turnUsage ? `, tokens: ${turnUsage.prompt_tokens}+${turnUsage.completion_tokens}` : ''}`)

        // 🛡️ 输出截断检测: finish_reason 非正常完成 + tool_call 参数 JSON 不完整
        if (finishReason !== 'stop' && finishReason !== 'tool_calls' && toolCalls.length > 0) {
          const hasCorruptedArgs = toolCalls.some(tc => {
            try {
              JSON.parse(tc.function.arguments || '{}')
              return false
            } catch {
              return true
            }
          })

          if (hasCorruptedArgs) {
            truncationRetries++
            console.warn(`[LocalClaw/FC] OUTPUT TRUNCATION detected at turn ${turnCount}, finishReason=${finishReason}, truncationRetries=${truncationRetries}`)

            onStep?.({
              id: `truncation-${Date.now()}`,
              type: 'error',
              content: `检测到输出截断（第 ${truncationRetries} 次），正在指导模型分段重试...`,
              timestamp: Date.now(),
            })

            if (truncationRetries >= 3) {
              finalResponse = '输出多次截断，无法完成当前操作。请尝试将任务拆分为更小的步骤，或减少单次写入的内容量。'
              completionPath = 'truncation_fail'
              break
            }

            // 不推 assistant 消息（损坏的 tool_calls 会导致 API 400）
            // 推入 user 恢复指令，要求模型分段重试
            const recoveryMessage = truncationRetries >= 2
              ? `[系统提示 - 输出截断恢复（第${truncationRetries}次）]
你的回复再次因为过长被截断，工具调用参数不完整无法执行。
你必须极大地缩减每次写入的内容量：
1. 每次 writeFile/appendFile 的 content 不超过 1500 字符
2. 将内容分成 5 段以上分别写入
3. 第一段用 writeFile 创建文件，后续全部用 appendFile 追加
请立即用这种方式重试你上一步的操作。`
              : `[系统提示 - 输出截断恢复]
你上一次的回复因为过长被截断，工具调用参数不完整无法执行。
请使用以下策略重试：
1. 将要写入的内容分成多段（每段不超过 3000 字符）
2. 第一段用 writeFile 创建文件
3. 后续段用 appendFile 逐段追加
4. 如果不是文件写入操作，请缩减参数长度后重试
请立即重试你上一步的操作。`

            messages.push({ role: 'user', content: recoveryMessage })
            continue // 回到 while 循环顶部，让模型重新生成
          }
        }

        // 🔄 文本工具调用回退解析
        // 部分模型 (如 step-3.5-flash) 不支持 OpenAI tools API，
        // 会将工具调用以文本形式输出在 content 中。检测并解析这些文本工具调用。
        if (toolCalls.length === 0 && content) {
          const parsed = this._parseTextToolCalls(content, tools)
          if (parsed.calls.length > 0) {
            toolCalls = parsed.calls
            content = parsed.cleanContent
            console.log(`[LocalClaw/FC] Text fallback parsed ${toolCalls.length} tool call(s)`)
          }
        }

        // 判断是否有工具调用
        if (toolCalls.length > 0) {
          // 构建 assistant 消息 (包含 tool_calls)
          // DeepSeek 思维模式: 必须传递 reasoning_content
          const assistantMsg: SimpleChatMessage = {
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: tc.function,
            })),
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          }
          messages.push(assistantMsg)

          // SOP Evolution: 检测工具调用轮次中 LLM 文本回复里夹带的 <SOP_REWRITE> 标签
          // （Rewrite 请求注入后，LLM 可能在工具调用轮次中输出改写内容，而非最终回复）
          if (content && content.includes('<SOP_REWRITE>')) {
            const sopDunId = dunId || this.getActiveDunId()
            if (sopDunId) {
              sopEvolutionService.detectAndApplyRewrite(content, sopDunId)
                .catch(err => console.warn('[LocalClaw/FC] Mid-loop SOP rewrite detection failed:', err))
            }
          }

          // 🔗 Skill Binding: 检测 LLM 文本中的 <BIND_SKILL> 标签并执行绑定
          if (content && content.includes('<BIND_SKILL>')) {
            this._handleBindSkillTags(content, dunId)
              .catch(err => console.warn('[LocalClaw/FC] Mid-loop BIND_SKILL handling failed:', err))
          }

          // 发送思考步骤 (优先用 reasoningContent，其次用 content)
          // 移到工具循环外部，避免多个 tool_calls 时重复追加
          const thinkingText = reasoningContent || content
          if (thinkingText) {
            onStep?.({
              id: `think-${Date.now()}`,
              type: 'thinking',
              content: thinkingText,
              timestamp: Date.now(),
            })
          }

          // 逐个执行工具并收集结果
          let needReplanHint = false
          for (const tc of toolCalls) {
            const toolName = tc.function.name
            let toolArgs: Record<string, unknown> = {}
            
            try {
              toolArgs = JSON.parse(tc.function.arguments || '{}')
            } catch {
              console.warn(`[LocalClaw/FC] Failed to parse args for ${toolName}:`, tc.function.arguments)
            }

            // 安全保护: 确保每个 tool_call 都有对应的 tool response
            // 防止异常导致后续 tool_calls 缺少响应引发 API 400 错误
            try {

            // 🛡️ P3: 危险操作检测 + 用户审批 (与 Legacy 保持一致)
            if (CONFIG.HIGH_RISK_TOOLS.includes(toolName)) {
              const argsStr = JSON.stringify(toolArgs)
              const argsLower = argsStr.toLowerCase()
              const matchedDanger = CONFIG.DANGER_PATTERNS.find(p =>
                argsLower.includes(p.pattern.toLowerCase())
              )

              if (matchedDanger) {
                this.storeActions?.addLog({
                  id: `precheck-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'warn',
                  message: `[PreCheck] 检测到危险操作 (${matchedDanger.reason}): ${argsStr.slice(0, 100)}`,
                })

                // V2: 审批请求事件
                const approvalReqId = `approval-${Date.now()}`
                agentEventBus.approvalRequired(
                  approvalReqId,
                  argsStr.slice(0, 200),
                  toolName,
                  matchedDanger.level === 'critical' ? 'critical' : 'high',
                  matchedDanger.reason,
                )

                let approved = false
                if (this.storeActions?.requestApproval) {
                  try {
                    approved = await this.storeActions.requestApproval({
                      toolName,
                      args: toolArgs,
                      dangerLevel: matchedDanger.level,
                      reason: matchedDanger.reason,
                    })
                  } catch {
                    approved = false
                  }
                }

                // V2: 审批结果事件
                agentEventBus.approvalResolved(approvalReqId, approved, 'user')

                if (!approved) {
                  // 用户拒绝：返回错误消息让 LLM 重新思考
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    content: `操作被用户拒绝。原因: ${matchedDanger.reason} (风险等级: ${matchedDanger.level})。请使用更安全的替代方案。`,
                    name: toolName,
                  })

                  // V3: 审批拒绝 → 人类负面反馈信号
                  const rejectDunId = activeDunId || ''
                  const rejectMemoryId = `l1-${rejectDunId}-${toolName}`
                  if (await confidenceTracker.getEntry(rejectMemoryId)) {
                    confidenceTracker.addHumanFeedback(rejectMemoryId, false)
                  }

                  continue
                }

                // V3: 审批通过 → 人类正面反馈信号
                const approveDunId = activeDunId || ''
                const approveMemoryId = `l1-${approveDunId}-${toolName}`
                if (await confidenceTracker.getEntry(approveMemoryId)) {
                  confidenceTracker.addHumanFeedback(approveMemoryId, true)
                }
              }
            }

            // 执行工具
            this.storeActions?.setAgentStatus('executing')
            this.storeActions?.addLog({
              id: `tool-${Date.now()}`,
              timestamp: Date.now(),
              level: 'info',
              message: `调用工具: ${toolName}`,
            })

            onStep?.({
              id: `call-${Date.now()}`,
              type: 'tool_call',
              content: JSON.stringify(toolArgs, null, 2),
              toolName,
              toolArgs,
              timestamp: Date.now(),
            })

            // V2: 工具开始事件
            const isMutatingTool = CONFIG.CRITIC_TOOLS.includes(toolName)
            agentEventBus.toolStart(toolName, tc.id, toolArgs, isMutatingTool)

            const toolStartTime = Date.now()
            const toolResult = await this.executeTool({ name: toolName, args: toolArgs }, 0, signal)
            const toolLatency = Date.now() - toolStartTime

            // V2: 工具结束事件
            agentEventBus.toolEnd(
              tc.id,
              toolName,
              toolResult.status !== 'error',
              toolResult.result.slice(0, 2000),
              toolLatency,
            )

            onStep?.({
              id: `result-${Date.now()}`,
              type: toolResult.status === 'error' ? 'error' : 'tool_result',
              content: toolResult.result.slice(0, 2000),
              toolName,
              duration: toolLatency,
              timestamp: Date.now(),
            })

            // P2: 记录到执行追踪
            const toolStatus: 'success' | 'error' = toolResult.status === 'error' ? 'error' : 'success'
            const toolOrder = traceTools.length + 1
            const baseType = classifyBaseType(toolName, toolArgs, toolStatus, baseCtx)
            traceTools.push({
              name: toolName,
              args: toolArgs,
              status: toolStatus,
              result: toolResult.result,
              latency: toolLatency,
              order: toolOrder,
              baseType,
              // V2: Layer 1 Token 采集 — 仅第一个工具记录本轮 usage（避免重复）
              tokenCost: (turnUsage && toolCalls.indexOf(tc) === 0)
                ? { prompt: turnUsage.prompt_tokens, completion: turnUsage.completion_tokens }
                : undefined,
              // V2: 思维链摘要
              thinkingTextSummary: (reasoningContent && toolCalls.indexOf(tc) === 0)
                ? reasoningContent.slice(0, 200)
                : undefined,
              // V2: 上下文消息数
              contextMessageCount: toolCalls.indexOf(tc) === 0 ? messages.length : undefined,
              // V2: 本轮所有工具调用名称
              turnToolCalls: toolCalls.indexOf(tc) === 0
                ? toolCalls.map(t => t.function.name)
                : undefined,
              // V2: 本轮是否为 Reflexion 轮
              isReflexionTurn: toolCalls.indexOf(tc) === 0 ? isReflexionTurn : undefined,
              // V2: LLM 本轮响应耗时 (ms) — 仅第一个工具记录
              llmResponseTime: toolCalls.indexOf(tc) === 0 ? llmResponseTime : undefined,
            })
            updateBaseClassifierCtx(baseCtx, toolName, toolArgs, toolStatus, toolOrder)

            // Phase 3: P 碱基自动检测 — 在工具碱基之前插入 P 碱基
            const pDetection = detectPBase(toolArgs, reasoningContent)
            if (pDetection && toolCalls.indexOf(tc) === 0) {
              // 仅在本轮第一个工具前插入一次 P（避免多工具时重复）
              const pEntry: import('@/types').BaseSequenceEntry = {
                base: 'P',
                order: baseSequenceOrder++,
                reasoningSummary: reasoningContent ? reasoningContent.slice(0, 200) : undefined,
                pDetectionSource: pDetection,
              }
              baseSequenceEntries.push(pEntry)
              baseLedgerService.appendEntry(runId, pEntry)
            }

            // V2: 写入碱基序列独立数组
            const baseEntry: import('@/types').BaseSequenceEntry = {
              base: baseType,
              order: baseSequenceOrder++,
              toolOrder,
            }
            baseSequenceEntries.push(baseEntry)
            // V8: 同步写入 Ledger
            baseLedgerService.appendEntry(runId, baseEntry)

            // V3: Governor Layer 1 — 碱基序列实时评估
            {
              const govSignal = baseSequenceGovernor.evaluate(baseSequenceEntries, baseLedgerService.getLedger(runId))
              if (govSignal.triggered) {
                for (const ruleName of govSignal.triggeredRules) {
                  governorInterventions.push({
                    rule: ruleName,
                    stepIndex: baseSequenceEntries.length,
                    features: govSignal._features,
                    counterfactualSuccessRate: govSignal.estimatedSuccessRate,
                  })
                }
                governorPromptInjection = govSignal.promptInjection
                // V8: 记录 Governor 干预里程碑
                baseLedgerService.addMilestone(runId, 'governor_intervention', baseSequenceEntries.length - 1, {
                  rules: govSignal.triggeredRules,
                  estimatedSuccessRate: govSignal.estimatedSuccessRate,
                })
              }
            }

            // Layer 4: 缓存验证结果
            if (toolResult.verification) {
              this._verificationCache.set(`${toolName}:${traceTools.length}`, toolResult.verification)
            }

            lastToolResult = toolResult.result

            // SOP Evolution: Phase 追踪 — 每次工具执行后推断 Phase 进度
            {
              const sopDunId = dunId || this.getActiveDunId()
              if (sopDunId) {
                sopEvolutionService.inferSOPProgress(sopDunId, toolName, toolResult.result.slice(0, 500))
              }
            }

            // 💾 保存 checkpoint（每次工具执行后，无论成功失败）
            if (onCheckpoint) {
              const checkpoint: TaskCheckpoint = {
                stepIndex: traceTools.length,
                savedAt: Date.now(),
                userPrompt,
                dunId: dunId || undefined,
                turnCount,
                messages: messages.map(m => ({
                  role: m.role as 'system' | 'user' | 'assistant' | 'tool',
                  content: m.content,
                  tool_call_id: m.tool_call_id,
                  tool_calls: m.tool_calls,
                })),
                traceTools: traceTools.map(t => ({
                  name: t.name,
                  args: t.args,
                  status: t.status,
                  result: (t.result || '').slice(0, 500), // 限制结果大小
                  latency: t.latency,
                  order: t.order,
                })),
              }
              onCheckpoint(checkpoint)
            }

            // 🧠 FC 模式增强: Reflexion + Critic 机制
            if (toolResult.status === 'error') {
              consecutiveFailures++
              
              // 🧬 Gene Pool 闭环: 上一轮 Reflexion 注入了基因但本轮仍失败 → 记录失败反馈
              if (pendingGeneMatches.length > 0) {
                for (const match of pendingGeneMatches) {
                  genePoolService.recordCapsule(
                    match.gene.id,
                    match.matchedSignals,
                    'failure',
                    activeDunId || undefined
                  )
                }
                console.log(`[GenePool/Diag] Capsule failure: ${pendingGeneMatches.length} genes did not help recover ${toolName}`)
                pendingGeneMatches = []
              }
              
              // 🧬 能力缺失检测
              this.detectAndRecordCapabilityGap(toolName, toolResult.result, userPrompt)

              // V2: Reflexion 开始事件
              agentEventBus.reflexionStart(toolName, toolResult.result.slice(0, 500))

              // 🎯 Layer 3: 运行时动态扩展 - 工具不足时自动补充
              if (isFiltered) {
                const expanded = dunManager.expandToolsForReflexion(currentTaskTools, toolName, toolResult.result)
                if (expanded) {
                  currentTaskTools = expanded
                  tools = convertToolInfoToFunctions(currentTaskTools)
                  console.log(`[DunRouter/FC] Expanded toolset to ${tools.length} after "${toolName}" missing`)
                }
                // 连续失败 2+ 次且仍在过滤模式 → 解锁全量工具
                if (consecutiveFailures >= 2 && currentTaskTools.length < this.getEffectiveTools().length) {
                  currentTaskTools = this.getEffectiveTools()
                  tools = convertToolInfoToFunctions(currentTaskTools)
                  console.log(`[DunRouter/FC] Safety unlock: full toolset (${tools.length}) after ${consecutiveFailures} failures`)
                }
              }
              
              // 🛡️ 错误签名追踪: 检测重复错误防止死循环
              const errorSig = `${toolName}:${toolResult.result.slice(0, 100)}`
              errorSignatureHistory.push(errorSig)
              const repeatCount = errorSignatureHistory.filter(e => e === errorSig).length
              
              if (repeatCount >= 2) {
                // 🚨 危机干预: 相同错误已出现2+次, 强制策略变更
                // 🧬 Gene Pool: 查找历史修复经验
                const crisisGeneMatches = genePoolService.findCrossNexusGenes(toolName, toolResult.result, activeDunId || undefined)
                const crisisGeneHint = genePoolService.buildGeneHint(crisisGeneMatches)
                console.log(`[GenePool/Diag] Crisis path triggered: tool=${toolName}, geneMatches=${crisisGeneMatches.length}, poolSize=${genePoolService.geneCount}`)
                // 🧬 记录待反馈基因，等下一轮工具成功后闭环
                if (crisisGeneMatches.length > 0) {
                  pendingGeneMatches = crisisGeneMatches
                }

                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: truncateToolResult(toolName, toolResult.result) + CONFIG.HINT_SEPARATOR + `[CRITICAL - 重复错误检测]
工具 ${toolName} 已连续 ${repeatCount} 次产生相同错误。禁止再次使用相同参数调用此工具。
你必须选择以下策略之一:
1. 使用完全不同的工具或方法达成目标
2. 彻底修改参数后重试（不能与之前相同）
3. 跳过此步骤，继续执行后续任务
不要重复之前的失败操作。` + crisisGeneHint,
                  name: toolName,
                })
                
                this.storeActions?.addLog({
                  id: `reflexion-crisis-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'error',
                  message: `[Reflexion] 检测到重复错误(${repeatCount}次)，强制策略变更: ${toolName}`,
                })
              } else {
                // 🔄 Reflexion: 结构化反思提示 - 让 LLM 分析失败原因
                const dunSkillCtxFC = dunManager.buildSkillContext(activeDunId)
                // 🧬 Gene Pool: 查找历史修复经验
                const reflexionGeneMatches = genePoolService.findCrossNexusGenes(toolName, toolResult.result, activeDunId || undefined)
                const reflexionGeneHint = genePoolService.buildGeneHint(reflexionGeneMatches)
                console.log(`[GenePool/Diag] Reflexion path triggered: tool=${toolName}, geneMatches=${reflexionGeneMatches.length}, poolSize=${genePoolService.geneCount}`)
                // 🧬 记录待反馈基因，等下一轮工具成功后闭环
                if (reflexionGeneMatches.length > 0) {
                  pendingGeneMatches = reflexionGeneMatches
                }

                const reflexionHint = `

[系统提示 - Reflexion 反思机制]
工具执行失败。在下一步操作前，请先进行结构化反思：
1. **根本原因**: 是路径错误？参数错误？权限问题？工具不支持？
2. **修正方案**: 如何调整参数或换用其他工具/方法？
3. **预防措施**: 如何避免再次出错？${toolResult.result.includes('Instruction skill error') ? `
**注意**: 此错误为"指令型技能注册错误"，说明该技能可能被错误注册为 instruction 类型而非 plugin 类型。该技能本身可能是可用的，请尝试通过 runCmd 直接执行对应的 Python/Node 脚本作为替代方案（查看技能目录下的 .py 或 .js 文件）。` : ''}${dunSkillCtxFC ? `
4. **技能充足性**: 当前 Dun 的技能是否足以完成任务？如果缺少必要技能，可使用 dunBindSkill 添加；如果某技能不适用，可使用 dunUnbindSkill 移除。${dunSkillCtxFC}` : ''}

请根据反思结果调整你的下一步操作。` + reflexionGeneHint
              
                // 将反思提示追加到工具结果中
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: truncateToolResult(toolName, toolResult.result) + CONFIG.HINT_SEPARATOR + reflexionHint,
                  name: toolName,
                })
                
                this.storeActions?.addLog({
                  id: `reflexion-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'warn',
                  message: `[Reflexion] 触发反思机制，分析 ${toolName} 失败原因`,
                })
              }
              
              // V2: Reflexion 结束事件
              agentEventBus.reflexionEnd(
                toolResult.result.slice(0, 200),
                repeatCount >= 2 ? 'crisis_intervention' : 'structured_reflection',
              )

              // V2: P.2 碱基发射 — Reflexion 触发策略转变
              const reflexionBaseEntry: import('@/types').BaseSequenceEntry = {
                base: 'P',
                order: baseSequenceOrder++,
                reasoningSummary: `Reflexion: ${toolName} failed — ${toolResult.result.slice(0, 150)}`,
                isReflexion: true,
              }
              baseSequenceEntries.push(reflexionBaseEntry)
              // V8: 同步写入 Ledger + Reflexion 里程碑
              baseLedgerService.appendEntry(runId, reflexionBaseEntry)
              baseLedgerService.addMilestone(runId, 'reflexion', baseSequenceEntries.length - 1, {
                toolName,
                failureSnippet: toolResult.result.slice(0, 100),
              })
              // V2: 标记下一轮为 Reflexion 轮（服务于 turnMetas.isReflexion）
              lastTurnHadReflexion = true

              // V3: 工具失败 → 系统失败信号
              const failDunId = dunId || this.getActiveDunId()
              if (failDunId) {
                const targetMemoryId = `l1-${failDunId}-${toolName}`
                if (await confidenceTracker.getEntry(targetMemoryId)) {
                  confidenceTracker.addFailureSignal(targetMemoryId)
                }
              }

              // 🔄 连续失败过多 → 标记需要重规划提示 (延迟到所有 tool 响应之后)
              // 注意: 不能在 tool 响应中间插入 user 消息，否则违反 API 协议导致 400 错误
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                needReplanHint = true
              }
            } else {
              // 成功时重置连续失败计数
              consecutiveFailures = 0
              truncationRetries = 0
              
              // 🧬 Gene Pool 闭环: Reflexion 注入了基因提示后，下一轮工具成功 → 记录 Capsule
              if (pendingGeneMatches.length > 0) {
                for (const match of pendingGeneMatches) {
                  genePoolService.recordCapsule(
                    match.gene.id,
                    match.matchedSignals,
                    'success',
                    activeDunId || undefined
                  )
                }
                console.log(`[GenePool/Diag] Capsule recorded: ${pendingGeneMatches.length} genes contributed to recovery of ${toolName}`)
                pendingGeneMatches = []
              }
              
              // 🔍 Critic 自检: 修改类工具成功后触发验证
              const needsCritic = CONFIG.CRITIC_TOOLS.includes(toolName)
              
              if (needsCritic) {
                const dunSkillCtxFCCritic = dunManager.buildSkillContext(activeDunId)
                const recentToolNamesFC = traceTools.slice(-5).map(t => t.name).join(', ')

                // 构建 Dun 验收标准上下文
                let fcAcceptanceCriteria = ''
                const fcCriticDunId = dunId || this.getActiveDunId()
                if (fcCriticDunId) {
                  const duns = this.storeActions?.duns
                  const dun = duns?.get(fcCriticDunId)
                  if (dun?.objective) {
                    fcAcceptanceCriteria += `\n目标: ${dun.objective}`
                  }
                  if (dun?.metrics?.length) {
                    fcAcceptanceCriteria += `\n验收检查点:\n${dun.metrics.map((m: string, i: number) => `${i + 1}. ${m}`).join('\n')}`
                  }
                }

                const criticHint = `

[系统提示 - Critic 自检机制]
${toolName} 执行成功。${this._buildVerificationHint(toolResult)}
用户原始需求: "${userPrompt.slice(0, 200)}"
${fcAcceptanceCriteria ? `\n验收标准:${fcAcceptanceCriteria}\n` : ''}
请验证：
1. 操作结果是否真正满足用户的原始需求？（工具执行成功 ≠ 任务完成）
2. 是否有遗漏的步骤或潜在问题？
${fcAcceptanceCriteria ? '3. 逐条检查验收标准是否已满足\n' : ''}${dunSkillCtxFCCritic ? `${fcAcceptanceCriteria ? '4' : '3'}. **技能优化**: 本次使用了 [${recentToolNamesFC}]。当前 Dun 是否有未使用的冗余技能？是否需要新技能？${dunSkillCtxFCCritic}\n` : ''}
如果满足需求，继续下一步或给出最终回复。如果发现问题，自行修正。`
                
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: truncateToolResult(toolName, toolResult.result) + CONFIG.HINT_SEPARATOR + criticHint,
                  name: toolName,
                })
                
                this.storeActions?.addLog({
                  id: `critic-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'info',
                  message: `[Critic] 验证 ${toolName} 执行结果`,
                })

                // V3: Critic 验证通过 → 环境正面信号 (修改类工具执行成功)
                const criticDunId = dunId || this.getActiveDunId()
                if (criticDunId) {
                  const targetMemoryId = `l1-${criticDunId}-${toolName}`
                  if (await confidenceTracker.getEntry(targetMemoryId)) {
                    confidenceTracker.addEnvironmentSignal(targetMemoryId, true)
                  }
                }
              } else {
                // 非修改类工具：直接添加结果（截断防膨胀）
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: truncateToolResult(toolName, toolResult.result),
                  name: toolName,
                })
              }
            }

            // P5: 更新最近操作的实体 (用于指代消解) - FC 模式
            if (toolResult.status === 'success') {
              this.updateRecentEntities(toolName, toolArgs, toolResult.result)

              // 追踪文件创建事件 + 注册产出物基因 - FC 模式
              if (toolName === 'writeFile') {
                try {
                  const parsed = JSON.parse(toolResult.result)
                  if (parsed.action === 'file_created' && parsed.filePath) {
                    this._lastCreatedFiles.push({
                      filePath: parsed.filePath,
                      fileName: parsed.fileName || '',
                      message: parsed.message || '',
                      fileSize: parsed.fileSize,
                    })
                    
                    // 🧬 Phase 4: 注册产出物基因 (让其他 Dun 能发现)
                    const currentDunId = dunId || this.getActiveDunId()
                    if (currentDunId) {
                      const pathStr = typeof toolArgs.path === 'string' ? toolArgs.path : String(toolArgs.path ?? '')
                      const ext = pathStr.split('.').pop()?.toLowerCase() || ''
                      const typeMap: Record<string, string> = {
                        md: 'document', txt: 'text', json: 'data',
                        ts: 'code', js: 'code', py: 'code',
                        pptx: 'presentation', docx: 'document', pdf: 'document',
                        png: 'image', jpg: 'image', svg: 'image',
                      }
                      dunManager.registerArtifact({
                        dunId: currentDunId,
                        path: parsed.filePath,
                        name: parsed.fileName || pathStr.split('/').pop() || 'unnamed',
                        type: typeMap[ext] || 'file',
                        size: parsed.fileSize || 0,
                        description: userPrompt.slice(0, 100),
                      }, userPrompt.split(/[,，、\s]+/).filter(s => s.length > 1).slice(0, 10))
                    }
                  }
                } catch { /* 非 JSON 结果，忽略 */ }
              }
            }

            // 🔄 技能变更检测
            if ((toolName === 'runCmd' && (
              toolResult.result.includes('Skill installed') ||
              toolResult.result.includes('tools registered') ||
              toolResult.result.includes('git clone')
            )) ||
            // writeFile 写入 skills/ 目录也触发刷新
            (toolName === 'writeFile' && toolResult.status !== 'error' && 
              (typeof toolArgs.path === 'string' ? toolArgs.path : String(toolArgs.path ?? '')).replace(/\\/g, '/').includes('skills/'))) {
              try {
                await this.loadTools()
                await this.loadAllDataToStoreDebounced()
                console.log('[LocalClaw/FC] Tools & skills refreshed mid-loop')
              } catch {
                console.warn('[LocalClaw/FC] Failed to refresh tools mid-loop')
              }
            }

            // 🌌 Dun 目录写入检测 — Agent 通过 writeFile 创建 Dun 时刷新前端列表
            if (toolName === 'writeFile' && toolResult.status !== 'error' &&
                (typeof toolArgs.path === 'string' ? toolArgs.path : String(toolArgs.path ?? '')).replace(/\\/g, '/').includes('duns/')) {
              try {
                await this.loadAllDataToStoreDebounced()
                console.log('[LocalClaw/FC] Dunes refreshed after writeFile to duns/')
              } catch {
                console.warn('[LocalClaw/FC] Failed to refresh duns after writeFile')
              }
            }

            // 🌌 Dun 技能绑定变更检测 (FC 模式)
            if ((toolName === 'dunBindSkill' || toolName === 'dunUnbindSkill') &&
                toolResult.status === 'success') {
              // P5: 即时更新 store，确保 UI 立即响应
              const bindDunId = (toolArgs.dunId as string) || this.getActiveDunId()
              const bindSkillId = toolArgs.skillId as string
              if (bindDunId && bindSkillId) {
                if (toolName === 'dunBindSkill') {
                  this.storeActions?.bindSkillToDun?.(bindDunId, bindSkillId)
                  console.log(`[LocalClaw/FC] Immediate store update: bound "${bindSkillId}" to Dun "${bindDunId}"`)
                } else {
                  this.storeActions?.unbindSkillFromDun?.(bindDunId, bindSkillId)
                  console.log(`[LocalClaw/FC] Immediate store update: unbound "${bindSkillId}" from Dun "${bindDunId}"`)
                }
              }
              try {
                // 技能绑定是关键操作，清除防抖锁以确保立即刷新最新数据
                this._loadAllDataPromise = null
                await this.loadAllDataToStoreDebounced()
                console.log('[LocalClaw/FC] Dun skills refreshed after self-adaptation')

                // 标记 skillsConfirmed（用户已通过 Agent 对话确认了技能）
                const confirmDunId = activeDunId || dunId
                if (confirmDunId) {
                  fetch(`${this.serverUrl}/duns/${encodeURIComponent(confirmDunId)}/meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ skills_confirmed: true }),
                  }).catch(() => {})
                }
              } catch {
                console.warn('[LocalClaw/FC] Failed to refresh duns after skill adaptation')
              }
            }

            // 🛑 工具执行后立即检查 abort（不等到下一轮循环开头）
            if (signal?.aborted) {
              finalResponse = lastToolResult || toolResult.result || '任务已被用户终止。'
              wasAborted = true
              completionPath = 'aborted'
              this._verificationCache.clear()
              pendingGeneMatches = []
              break  // 跳出 for...of toolCalls 循环
            }
            } catch (toolLoopError: any) {
              // 安全保护: 确保异常时也为此 tool_call 添加响应
              // 避免 "tool_call_ids did not have response messages" 400 错误
              console.error(`[LocalClaw/FC] Tool loop error for ${toolName}:`, toolLoopError)
              
              // V2: 工具异常事件
              agentEventBus.toolError(tc.id, toolName, toolLoopError?.message || '未知错误', CONFIG.CRITIC_TOOLS.includes(toolName))

              // 检查是否已经为这个 tool_call 添加了响应
              const hasResponse = messages.some(m => m.role === 'tool' && m.tool_call_id === tc.id)
              if (!hasResponse) {
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: `工具执行异常: ${toolLoopError?.message || '未知错误'}`,
                  name: toolName,
                })
              }
            }
          }

          // 🛑 abort 后跳出 while 循环（工具 for 循环内 break 后到达此处）
          if (wasAborted) break

          // 🛡️ 最终安全校验: 确保所有 tool_call 都有对应的 tool 响应
          // 防止任何遗漏路径导致 "tool_call_ids did not have response messages" 400 错误
          for (const tc of toolCalls) {
            const hasResp = messages.some(
              m => m.role === 'tool' && m.tool_call_id === tc.id
            )
            if (!hasResp) {
              console.error(`[LocalClaw/FC] SAFETY: Missing tool response for ${tc.function.name} (${tc.id}), injecting fallback`)
              messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: `[系统] 工具 ${tc.function.name} 的执行结果丢失，请重试或换用其他方法。`,
                name: tc.function.name,
              })
            }
          }

          // 🔄 延迟的重规划提示: 在所有 tool 响应之后再插入 user 消息
          // 避免在 tool 响应中间插入 user 消息违反 API 协议
          if (needReplanHint) {
            messages.push({
              role: 'user',
              content: `[系统提示 - 连续失败警告]\n已连续失败 ${consecutiveFailures} 次。建议：\n- 重新评估任务可行性\n- 考虑完全不同的实现方案\n- 如果无法解决，向用户说明困难并请求指导`,
            })
            this.storeActions?.addLog({
              id: `replan-hint-${Date.now()}`,
              timestamp: Date.now(),
              level: 'warn',
              message: `[ReAct] 连续失败 ${consecutiveFailures} 次，提示重新规划`,
            })
          }

          // V3: Governor 干预注入（在所有 tool 响应之后安全注入 user 消息）
          if (governorPromptInjection) {
            messages.push({
              role: 'user',
              content: CONFIG.HINT_SEPARATOR + governorPromptInjection,
            })
            this.storeActions?.addLog({
              id: `governor-${Date.now()}`,
              timestamp: Date.now(),
              level: 'info',
              message: `[Governor] 干预触发: ${governorInterventions.slice(-1).map(i => i.rule).join(', ')}`,
            })
            governorPromptInjection = ''
          }

          this.storeActions?.setAgentStatus('thinking')
          agentEventBus.changePhase('planning', `Turn ${turnCount} tools complete, re-thinking`)

          // V2: 轮次元数据收集 — 每轮工具执行完成后 push
          {
            const turnBases = baseSequenceEntries
              .slice(turnBaseStartIndex)
              .filter(e => e.base !== 'P')
              .map(e => e.base) as Array<'E' | 'V' | 'X'>
            turnMetas.push({
              turnIndex: turnCount,
              hasPlan: !!(reasoningContent || content),
              planLength: reasoningContent ? reasoningContent.length : (content ? content.length : 0),
              isReflexion: isReflexionTurn,
              emittedPlanBase: baseSequenceEntries.slice(turnBaseStartIndex).some(e => e.base === 'P'),
              toolCount: toolCalls.length,
              toolBases: turnBases,
            })
          }

          // V8: 每 5 轮更新 Ledger Facts（纯规则提取，不调用 LLM）
          factsUpdateCounter++
          if (factsUpdateCounter % 5 === 0 && traceTools.length > 0) {
            const recentBatch = traceTools.slice(-Math.min(traceTools.length, 10))
            baseLedgerService.updateFactsFromTools(runId, recentBatch)
          }

          // V8: Transcriptase 编排检查点 — 每轮结束后评估是否需要 spawn 子 Agent
          {
            const currentLedger = baseLedgerService.getLedger(runId)
            if (currentLedger) {
              const activeChildCount = childAgentManager.getActiveCount()
              const tDecision = transcriptaseEngine.evaluate(currentLedger, activeChildCount)

              if (tDecision.type !== 'continue') {
                console.log(`[Transcriptase] Decision: ${tDecision.type} (confidence: ${tDecision.confidence}, pattern: ${tDecision.triggeredPatternId || 'N/A'})`)

                // Phase 3: 记录 spawn 决策（供 TranscriptaseGovernor 统计）
                if (tDecision.type === 'spawn_child') {
                  hadTranscriptaseSpawn = true
                  transcriptaseSpawnRecords.push({
                    stepCount: (currentLedger.features.stepCount as number) || 0,
                    subObjectiveCount: currentLedger.facts.subObjectives.length,
                    xeRatio: (currentLedger.features.xeRatio as number) || 0,
                    childrenSpawned: activeChildCount,
                    patternId: tDecision.triggeredPatternId || 'unknown',
                    confidence: tDecision.confidence,
                    success: false,       // 稍后在 trace 保存时回填
                    childCompleted: false, // 稍后由 agentEventBus 回填
                  })
                }

                // 发出事件
                agentEventBus.transcriptaseDecision({
                  decisionType: tDecision.type,
                  confidence: tDecision.confidence,
                  reasoning: tDecision.reasoning,
                  patternId: tDecision.triggeredPatternId,
                  childTask: tDecision.childTask,
                })

                // 记录 Ledger 里程碑
                baseLedgerService.addMilestone(runId, 'child_spawn', baseSequenceEntries.length - 1, {
                  decision: tDecision.type,
                  patternId: tDecision.triggeredPatternId,
                  childTask: tDecision.childTask,
                })

                if (tDecision.type === 'spawn_child' && tDecision.childTask) {
                  // 构建上下文信封并 spawn 子 Agent（异步，不 await）
                  const ledgerSnapshot = baseLedgerService.snapshot(runId)
                  if (ledgerSnapshot) {
                    const envelope = transcriptaseEngine.buildContextEnvelope(
                      ledgerSnapshot,
                      tDecision.childTask,
                      runId,
                    )
                    const sessionId = `session-${runId}`
                    childAgentManager.spawnWithEnvelope(
                      runId,
                      sessionId,
                      {
                        task: tDecision.childTask,
                        dunId: tDecision.childDunId || activeDunId || undefined,
                        mode: 'run',
                        cleanup: 'keep',
                        priority: tDecision.childPriority || 'normal',
                      },
                      envelope,
                      0,  // depth
                    ).then(result => {
                      if (result.status === 'accepted') {
                        console.log(`[Transcriptase] Child spawned: ${result.runId}, task: "${tDecision.childTask?.slice(0, 60)}"`)
                      } else {
                        console.warn(`[Transcriptase] Spawn rejected: ${result.error}`)
                      }
                    }).catch(err => {
                      console.error('[Transcriptase] Spawn failed:', err)
                    })
                  }
                }

                this.storeActions?.addLog({
                  id: `transcriptase-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'info',
                  message: `[Transcriptase] ${tDecision.type}: ${tDecision.reasoning}`,
                })
              }
            }
          }

          // Phase 1: ContextEngine.afterTurn() - 每轮工具执行后的 bookkeeping
          const turnToolSummaries: import('@/types').ToolCallSummary[] = toolCalls.map(tc => {
            const matched = traceTools.find(t => t.order === traceTools.length - toolCalls.length + toolCalls.indexOf(tc) + 1)
            const isMutating = CONFIG.CRITIC_TOOLS.includes(tc.function.name)
            let parsedArgs: Record<string, unknown> = {}
            try {
              parsedArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
            } catch {
              console.warn(`[LocalClaw/FC] Failed to parse tool args for afterTurn summary: ${tc.function.name}`)
            }
            return {
              callId: tc.id,
              toolName: tc.function.name,
              args: parsedArgs,
              status: (matched?.status === 'success' ? 'success' : 'error') as 'success' | 'error',
              result: matched?.status === 'success' ? matched?.result?.slice(0, 500) : undefined,
              error: matched?.status === 'error' ? matched?.result?.slice(0, 500) : undefined,
              durationMs: matched?.latency || 0,
              isMutating,
              timestamp: Date.now(),
            }
          })
          contextEngine.afterTurn?.({
            sessionId: runId,
            messages: messages.map((m, idx) => ({
              id: `msg-${idx}`,
              role: (m.role === 'tool' ? 'system' : m.role) as 'system' | 'user' | 'assistant',
              content: typeof m.content === 'string' ? m.content : '',
              timestamp: Date.now(),
            })),
            prePromptMessageCount: 1,
            tokenBudget: TOKEN_BUDGET,
            toolResults: turnToolSummaries,
            runState: agentEventBus.getState(),
          }).catch(err => console.warn('[LocalClaw/FC] afterTurn failed:', err))
        } else {
          // 无工具调用 - LLM 直接回复用户
          finalResponse = content || ''

          // 🔗 Skill Binding: 检测最终回复中的 <BIND_SKILL> 标签并执行绑定
          if (finalResponse.includes('<BIND_SKILL>')) {
            await this._handleBindSkillTags(finalResponse, dunId)
            // 从用户可见的回复中移除 <BIND_SKILL> 标签
            finalResponse = finalResponse.replace(/<BIND_SKILL>[^<]*<\/BIND_SKILL>/g, '').trim()
          }

          // V3: 检测 Agent 自主中止信号 <TASK_ABORT reason="..."/>
          if (finalResponse.includes('<TASK_ABORT')) {
            completionPath = 'agent_abort'
            finalResponse = finalResponse.replace(/<TASK_ABORT[^/]*\/>/g, '').trim()
          }
          
          // V2: 切换到完成阶段
          agentEventBus.changePhase('done', 'Final response generated')

          onStep?.({
            id: `output-${Date.now()}`,
            type: 'output',
            content: finalResponse.slice(0, 2000),
            timestamp: Date.now(),
          })

          break
        }
      } catch (error: any) {
        console.error('[LocalClaw/FC] ReAct error:', error)

        // Phase 6: ErrorRecovery - 自动重试/模型降级/上下文压缩
        const recoveryResult = await handleRecovery(error, {
          currentModel: currentLLMModel,
          attemptIndex: turnCount - 1,
          runId,
          onModelSwitch: (newModel) => {
            this._currentModel = newModel
            console.log(`[LocalClaw/FC] Model switched to: ${newModel}`)
          },
          onCompactNeeded: async () => {
            const tokenCount = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : '') + 4, 0)
            const result = await contextEngine.compact({
              sessionId: runId,
              tokenBudget: TOKEN_BUDGET,
              trigger: 'overflow',
              currentTokenCount: tokenCount,
              messages: messages.map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : '',
              })),
            })
            // compact 成功后必须替换 messages，否则返回 false 防止死循环
            if (result.compacted && result.summary) {
              const systemMsg = messages[0]
              const safeCutIdx = findSafeCutIndex(messages, 8)
              if (safeCutIdx > 0) {
                const recentMessages = messages.slice(safeCutIdx)
                messages.length = 0
                messages.push(systemMsg)
                messages.push({
                  role: 'user',
                  content: `[上下文摘要] 以下是之前对话的压缩摘要:\n${result.summary}`,
                })
                messages.push(...recentMessages)
                console.log(`[LocalClaw/FC] ErrorRecovery compact: ${tokenCount} → ~${result.tokensAfter} tokens`)
                return true
              }
              // 找不到安全切割点，压缩失败
              console.warn('[LocalClaw/FC] ErrorRecovery: no safe cut point, compact aborted')
              return false
            }
            return false
          },
        })

        if (recoveryResult.shouldRetry) {
          console.log(`[LocalClaw/FC] Recovery: ${recoveryResult.strategy}, retrying...`)
          agentEventBus.changePhase('executing', `Recovery: ${recoveryResult.strategy}`)
          continue // 继续 while 循环重试
        }

        // 不可恢复的错误
        agentEventBus.changePhase('error', error.message)
        completionPath = 'unrecoverable_error'
        if (recoveryResult.needsUserAction && recoveryResult.userMessage) {
          finalResponse = `${recoveryResult.userMessage}`
        } else {
          finalResponse = `执行出错: ${error.message}`
        }
        break
      }
    }

    // 🔍 升级判断：主循环结束后检查任务完成度（在后处理之前，避免后处理重复执行）
    if (!finalResponse && traceTools.length > 0) {
      completionPath = 'max_turns'
      console.log('[LocalClaw/FC] No final response, validating task completion...')

      try {
        const validation = await this.validateTaskCompletion(userPrompt, traceTools, lastToolResult)

        // 🔄 V7 Context Refresh：任务未完成且未达升级上限时，重建上下文继续执行
        if (CONFIG.ESCALATION.ENABLED &&
            !validation.completed &&
            validation.completionRate < CONFIG.ESCALATION.MIN_COMPLETION_FOR_SKIP &&
            escalationCount < CONFIG.ESCALATION.MAX_ESCALATIONS) {

          escalationCount++
          currentMaxTurns += CONFIG.ESCALATION.EXTRA_TURNS
          completionPath = 'escalation'

          console.log(`[LocalClaw/FC] 🔄 Context Refresh #${escalationCount}: rebuilding context, extending to ${currentMaxTurns} turns`)

          // 1. 生成已完成工作摘要
          const completedWorkSummary = this.summarizeCompletedWork(traceTools, validation)

          // 2. 记录 pre-refresh 状态
          const msgCountBefore = messages.length
          const tokensBefore = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0) / 4

          // 3. V8: 记录 Ledger 里程碑 — escalation + context_refresh
          baseLedgerService.addMilestone(runId, 'escalation', baseSequenceEntries.length - 1, {
            escalationIndex: escalationCount,
            completionRate: validation.completionRate,
          })
          // 发射 P 碱基标记刷新断点
          const refreshBaseEntry: import('@/types').BaseSequenceEntry = {
            base: 'P',
            order: baseSequenceOrder++,
            reasoningSummary: `Context Refresh #${escalationCount}: ${Math.round(validation.completionRate)}% done`,
          }
          baseSequenceEntries.push(refreshBaseEntry)
          baseLedgerService.appendEntry(runId, refreshBaseEntry)
          baseLedgerService.addMilestone(runId, 'context_refresh', baseSequenceEntries.length - 1, {
            escalationIndex: escalationCount,
            messageCountBefore: msgCountBefore,
          })

          // 4. 重建 system prompt（刷新动态上下文）
          const freshDynamicContext = await this.buildDynamicContext(userPrompt, dunId)
          systemPrompt = getSystemPromptFC(locale)
            .replace('{soul_summary}', soulSummary || (locale === 'en' ? 'A friendly, professional AI assistant' : '一个友好、专业的 AI 助手'))
            .replace('{context}', freshDynamicContext)

          // 5. 构建继续执行指令
          const pendingList = validation.pendingSteps.length > 0
            ? validation.pendingSteps.map(s => `- ${s}`).join('\n')
            : '- 继续完成用户的原始请求'
          const continuationDirective = `任务尚未完成（完成度: ${Math.round(validation.completionRate)}%）。\n\n待完成:\n${pendingList}\n\n${validation.failureReason ? `上次失败原因: ${validation.failureReason}\n\n` : ''}请继续执行，不要重复已完成的工作。`

          // 6. MagenticOne 式上下文重建：messages → 4 条精简消息
          messages.length = 0
          messages.push({ role: 'system', content: systemPrompt })
          messages.push({ role: 'user', content: userPrompt })
          messages.push({ role: 'assistant', content: `## 已完成的工作摘要\n\n${completedWorkSummary}` })
          messages.push({ role: 'user', content: continuationDirective })

          // 7. 记录 ContextRefreshEvent
          const tokensAfter = messages.reduce((sum, m) => sum + (m.content ? m.content.length : 0), 0) / 4
          contextRefreshEvents.push({
            escalationIndex: escalationCount,
            timestamp: Date.now(),
            turnCountAtRefresh: turnCount,
            messageCountBefore: msgCountBefore,
            messageCountAfter: messages.length,
            tokensBefore,
            tokensAfter,
            completionRate: validation.completionRate,
            carryOverSummaryLength: completedWorkSummary.length,
            preRefreshBaseSequence: baseSequenceEntries.map(e => e.base).join('-'),
            baseSequenceIndex: baseSequenceEntries.length,
          })

          // 8. 重置 stale state
          traceTools.length = 0
          truncationRetries = 0
          governorPromptInjection = ''

          // 9. V8: 强制更新 Ledger Facts（escalation 时全量更新）
          baseLedgerService.updateFactsFromTools(runId, traceTools)

          this.storeActions?.addLog({
            id: `context-refresh-${Date.now()}`,
            timestamp: Date.now(),
            level: 'warn',
            message: `[Context Refresh #${escalationCount}] 上下文重建: ${msgCountBefore} msgs → ${messages.length} msgs, tokens ${Math.round(tokensBefore)} → ${Math.round(tokensAfter)}`,
          })

          agentEventBus.emit({
            runId,
            stream: 'context',
            type: 'context_refresh',
            data: {
              escalationIndex: escalationCount,
              messageCountBefore: msgCountBefore,
              messageCountAfter: messages.length,
              tokensBefore: Math.round(tokensBefore),
              tokensAfter: Math.round(tokensAfter),
              completionRate: validation.completionRate,
            },
          })

          needEscalation = true
          continue  // 进入下一轮 do-while
        }

        if (!needEscalation) {
          // 验证完成：将格式化结果写入 finalResponse，后处理后统一返回
          taskValidation = validation  // V3: 保留 validation 用于 trace.success
          finalResponse = this.formatTaskResult(validation, userPrompt, turnCount, currentMaxTurns)
        }
      } catch (validationError) {
        console.warn('[LocalClaw/FC] Task validation failed, using fallback:', validationError)

        // 降级：简单的工具调用总结
        const toolNames = traceTools.map(t => t.name).join('、')
        const successCount = traceTools.filter(t => t.status === 'success').length
        const failCount = traceTools.filter(t => t.status === 'error').length

        if (failCount > 0 || /Exit Code: (?!0)\d+/.test(lastToolResult)) {
          finalResponse = `❌ **任务未能成功完成**\n\n**执行概要:**\n- 调用工具: ${toolNames}\n- 成功: ${successCount} / 失败: ${failCount}\n- 执行轮次: ${turnCount}/${currentMaxTurns}\n\n**说明:** 部分操作失败。请检查错误信息并重试，或提供更具体的指令。`
        } else {
          finalResponse = `⚠️ **任务执行中断**\n\n**执行概要:**\n- 调用工具: ${toolNames}\n- 执行轮次: ${turnCount}/${currentMaxTurns}\n\n**说明:** AI 在工具调用后未能继续完成任务。请尝试更具体地描述你想要完成的目标。`
        }
      }
    }

    } while (needEscalation && !signal?.aborted)

    this.storeActions?.setAgentStatus('idle')

    // V2: 发出 run_end 事件 (在 trace 保存前，计算最终统计)
    const runDurationMs = Date.now() - runStartTime
    const totalToolsCalled = traceTools.length
    // V6: runSuccess 收紧判定 — natural 不再无条件 true
    // 核心原则：LLM 说"完成了"不等于真的完成了，需要过程信号佐证
    const traceErrorCount = traceTools.filter(t => t.status === 'error').length
    const traceErrorRatio = totalToolsCalled > 0 ? traceErrorCount / totalToolsCalled : -1
    const lastTraceTool = traceTools.length > 0 ? traceTools[traceTools.length - 1] : null

    let successReason = ''
    const runSuccess = (() => {
      if (wasAborted) { successReason = 'user_aborted'; return false }
      if (completionPath === 'truncation_fail' || completionPath === 'unrecoverable_error') {
        successReason = completionPath; return false
      }
      if (completionPath === 'agent_abort') { successReason = 'agent_abort'; return false }

      if (completionPath === 'natural') {
        // 无工具调用（纯对话）→ 保持 true（Agent 可能确实不需要工具）
        if (totalToolsCalled === 0) { successReason = 'natural_no_tools'; return true }
        // V6: 最后一个工具调用失败 → false（Agent 在失败后放弃并编了个回复交差）
        if (lastTraceTool && lastTraceTool.status === 'error') {
          successReason = 'natural_last_tool_failed'; return false
        }
        // V6: 错误率 > 50% → false（超过一半工具调用失败，过程不健康）
        if (traceErrorRatio > 0.5) {
          successReason = 'natural_high_error_ratio'; return false
        }
        successReason = 'natural_tools_ok'; return true
      }

      // V6: max_turns 阈值从 60% 提高到 80%（65% 不应该算成功）
      if (taskValidation) {
        const passed = taskValidation.completed && taskValidation.completionRate >= 80
        successReason = passed
          ? `validation_passed_${Math.round(taskValidation.completionRate)}pct`
          : `validation_failed_${Math.round(taskValidation.completionRate)}pct`
        return passed
      }
      // fallback: 无 validation 结果时，有 finalResponse 且未被中止视为成功
      successReason = finalResponse ? 'fallback_has_response' : 'fallback_no_response'
      return !!finalResponse && !wasAborted
    })()
    let finalScoreChange = 0

    // P2: 保存执行追踪 (含 Observer 元数据)
    // 优先使用传入的 dunId (来自 Dun 会话)，fallback 到全局 activeDunId（复用函数顶部声明的 activeDunId）
    if (traceTools.length > 0) {
      const errorCount = traceTools.filter(t => t.status === 'error').length
      
      const trace: ExecTrace = {
        id: `trace-${traceStartTime}`,
        task: userPrompt.slice(0, 200),
        tools: traceTools,
        success: runSuccess,  // V6: 收紧判定，natural 路径检查最后工具状态和错误率
        completionPath,       // V3: 终止路径
        duration: Date.now() - traceStartTime,
        timestamp: traceStartTime,
        tags: userPrompt.split(/\s+/).filter(w => w.length > 2 && w.length < 15).slice(0, 5),
        // Observer 元数据
        turnCount,
        errorCount,
        // V4: 从注入元数据提取实际注入的 skill 名称（替代硬编码空数组）
        skillIds: this._lastInjectionMeta?.skills.injectedSkills.map(s => s.name) ?? [],
        activeDunId: activeDunId || undefined,
        // V2: 碱基序列与分布（优先使用独立 entries 数组，包含 P 碱基）
        baseSequence: baseSequenceEntries.length > 0
          ? buildBaseSequenceFromEntries(baseSequenceEntries)
          : buildBaseSequence(traceTools),
        baseDistribution: baseSequenceEntries.length > 0
          ? buildBaseDistributionFromEntries(baseSequenceEntries)
          : buildBaseDistribution(traceTools),
        // V2: 每轮 ReAct 元数据
        turnMetas,
        // V3: Governor 干预记录
        governorInterventions: governorInterventions.length > 0 ? governorInterventions : undefined,
        // V4: 上下文注入元数据
        contextInjectionMeta: this._lastInjectionMeta ?? undefined,
        // V5: LLM 执行环境（用于按模型/Provider 对比分析）
        llmModel: this._currentModel || 'unknown',
        llmProvider: llmProviderLabel,
        // V6: 多维结果信号（原始信号，不压缩为单一置信度）
        outcomeSignals: {
          completionPath,
          errorRatio: traceErrorRatio,
          hasVerificationBase: baseSequenceEntries.some(e => e.base === 'V'),
          hasCriticToolSuccess: traceTools.some(t =>
            CONFIG.CRITIC_TOOLS.includes(t.name) && t.status === 'success'
          ),
          lastToolSucceeded: lastTraceTool ? lastTraceTool.status === 'success' : true,
          toolCount: totalToolsCalled,
          hadReflexion: turnMetas.some(m => m.isReflexion),
          dunHasMetrics: !!(() => {
            const dId = dunId || this.getActiveDunId()
            if (!dId) return false
            const dun = this.storeActions?.duns?.get(dId)
            return dun?.metrics && dun.metrics.length > 0
          })(),
          successReason,
        },
        // V7: Context Refresh 事件记录
        contextRefreshEvents: contextRefreshEvents.length > 0 ? contextRefreshEvents : undefined,
        // V8: Ledger 里程碑和 Facts
        ledgerMilestones: (() => {
          const ledger = baseLedgerService.getLedger(runId)
          return ledger && ledger.milestones.length > 0 ? ledger.milestones : undefined
        })(),
        ledgerFacts: (() => {
          const ledger = baseLedgerService.getLedger(runId)
          return ledger?.facts
        })(),
      }

      // 先保存 trace，成功后再更新 stats，保证两者一致
      let traceSaved = false
      try {
        await this.saveExecTrace(trace)
        traceSaved = true
        this._lastTraceId = trace.id
      } catch (err) {
        console.warn('[LocalClaw/FC] Failed to save exec trace:', err)
      }

      // 📊 记录 Dun 性能统计 (仅在 trace 保存成功时更新，保持一致性)
      if (traceSaved) {
        dunManager.recordPerformance(trace)
        // V3: Governor Layer 2/3 — 异步统计更新（fire-and-forget，不阻塞用户响应）
        baseSequenceGovernor.recordTrace(
          trace.baseSequence || '',
          runSuccess,
          governorInterventions,
        ).catch(err => console.warn('[Governor] recordTrace failed:', err))

        // Phase 3: TranscriptaseGovernor — spawn 效果统计（fire-and-forget）
        // 回填 success 字段后提交给 Governor（无论是否激活都累加数据）
        for (const record of transcriptaseSpawnRecords) {
          record.success = runSuccess
        }
        transcriptaseGovernor.recordOutcome(
          hadTranscriptaseSpawn,
          runSuccess,
          transcriptaseSpawnRecords,
        )
      }

      // V8: 清理 Ledger（trace 已保存，Ledger 数据不再需要）
      baseLedgerService.dispose(runId)

      // 🧬 Gene Pool: 自动收割基因 (Phase 2 - 检测 error→success 修复模式)
      genePoolService.harvestGene(traceTools, userPrompt, activeDunId || undefined)

      console.log(`[LocalClaw/FC] afterTurn: ${traceTools.length} tools, ${errorCount} errors, duration ${Date.now() - traceStartTime}ms`)

      // P4: Dun 经验记录 (有工具调用时)
      if (activeDunId) {
        dunManager.recordExperience(
          activeDunId,
          userPrompt,
          traceTools.map(t => t.name),
          runSuccess,  // V3: 使用统一的 success 定义
          finalResponse || ''
        ).catch(err => {
          console.warn('[LocalClaw/FC] Failed to record Dun experience:', err)
        })

        // Phase 3: DunScoring - 使用 ExecTrace 驱动评分更新
        try {
          const { scoring, scoreChange } = dunScoringService.updateFromTrace(activeDunId, trace, finalResponse)
          finalScoreChange = scoreChange
          console.log(`[LocalClaw/FC] DunScoring updated: ${activeDunId} scoreChange=${scoreChange > 0 ? '+' : ''}${scoreChange}`)

          // 写回 Zustand Store，让 Dashboard / HoverCard 等组件即时反映
          this.storeActions?.updateDunScoring?.(activeDunId, scoring)

          // 持久化评分到后端
          dunScoringService.saveToServer(activeDunId, this.serverUrl).catch(err => {
            console.warn('[LocalClaw/FC] Failed to persist scoring:', err)
          })
        } catch (scoringErr) {
          console.warn('[LocalClaw/FC] DunScoring update failed:', scoringErr)
        }

        // Phase 5: 将执行追踪写入 memoryStore (持久化到 SQLite)
        memoryStore.write({
          source: 'exec_trace',
          content: `Task: ${userPrompt.slice(0, 200)}\nTools: ${traceTools.map(t => `${t.name}(${t.status})`).join(', ')}\nDuration: ${trace.duration}ms\nSuccess: ${trace.success}`,
          dunId: activeDunId,
          tags: Array.isArray(trace.tags) ? trace.tags : [],
          metadata: { traceId: trace.id, turnCount, toolCount: traceTools.length, success: trace.success },
        }).then(() => {
          // exec_trace 写入成功后也通知 ingest 管道
          if (activeDunId) knowledgeIngestService.recordFlush(activeDunId)
        }).catch(err => console.warn('[LocalClaw/FC] memoryStore.write trace failed:', err))

        // V3: ConfidenceTracker - 批量追踪工具结果 + 评估 L1→L0 晋升
        if (activeDunId) {
          // 1. 为本次执行的工具结果创建追踪条目并添加初始信号
          const trackedToolResults = traceTools.map((t, idx) => ({
            callId: `${trace.id}-${idx}`,
            toolName: t.name,
            status: t.status as 'success' | 'error',
            result: t.result,
          }))
          confidenceTracker.trackToolResults(activeDunId, trackedToolResults, userPrompt)

          // 记录本轮 L1 IDs 用于下一轮隐式反馈检测
          const dunIdForL1 = activeDunId || ''
          this.lastRunL1Ids = trackedToolResults.map(tr => `l1-${dunIdForL1}-${tr.toolName}`)
          this.lastRunTimestamp = Date.now()

          // 2. 评估是否有可晋升到 L0 的记忆（使用 Safe 版本，等待 readyPromise）
          confidenceTracker.evaluatePromotionsSafe(activeDunId).then(promotable => {
            if (promotable.length > 0) {
              return confidenceTracker.promoteToL0Safe(promotable).then(count => {
                if (count > 0) {
                  console.log(`[LocalClaw/FC] Promoted ${count} L1 memories to L0 for Dun ${activeDunId}`)
                }
              })
            }
          }).catch(err => {
            console.warn('[LocalClaw/FC] L1→L0 promotion failed:', err)
          })
        }

        // SOP Evolution: fitness 计算 + 持久化 + rewrite 检测 + Golden Path 蒸馏
        if (activeDunId) {
          const sopTraceTools = traceTools.map(t => ({
            name: t.name,
            status: t.status as 'success' | 'error',
            result: t.result,
            duration: t.latency,
          }))
          const sopSuccess = runSuccess  // V3: 使用统一的 success 定义

          // 获取 sopContent 用于 LLM 蒸馏
          const duns = this.storeActions?.duns
          const activeDun = duns?.get(activeDunId)
          const activeSopContent = activeDun?.sopContent || undefined

          sopEvolutionService.afterTaskCompletion(
            activeDunId,
            sopTraceTools,
            sopSuccess,
            finalResponse,
            userPrompt,
            activeSopContent,
            // 回调：同步更新 DunEntity.sopEvolutionData + sopRewriteInfo + sopContent 到 Zustand Store
            (evolutionData, rewriteInfo, newSopContent) => {
              this.storeActions?.updateDun(activeDunId, {
                sopEvolutionData: evolutionData,
                ...(rewriteInfo ? { sopRewriteInfo: rewriteInfo } : {}),
                ...(newSopContent ? { sopContent: newSopContent } : {}),
              })
              // SOP 改写时发送全局 toast 通知
              if (rewriteInfo) {
                this.storeActions?.addToast({
                  type: 'warning',
                  title: 'SOP 已自动改写',
                  message: `Dun "${activeDun?.label || activeDunId}" 的 SOP 已根据执行数据自动优化 (${rewriteInfo.triggerLevel || 'AUTO'})`,
                })
              }
            },
          ).catch(err => {
            console.warn('[LocalClaw/FC] SOP Evolution afterTaskCompletion failed:', err)
          })
        }
      }
    }

    // Memory Flush + Response Knowledge Flush: 通过后台队列串行执行
    // 后台队列自动管控并发和限流，不再需要手工 2s 冷却
    {
      const doFlushMemory = traceTools.length > 0 && contextEngine.flushMemory
      const doFlushResponse = finalResponse && contextEngine.flushResponseKnowledge
      const bgSignal = this._backgroundAbortController?.signal

      if (doFlushMemory || doFlushResponse) {
        // 包装成一个串行后台链（不阻塞主流程）
        ;(async () => {
          // Step 1: Memory Flush（工具执行认知提炼）
          if (doFlushMemory) {
            const OUTPUT_TOOLS = ['writeFile', 'appendFile']
            const PER_FILE_CONTENT_LIMIT = 2000

            const flushToolSummaries: import('@/types').ToolCallSummary[] = traceTools.map((t, idx) => {
              const isOutputTool = OUTPUT_TOOLS.includes(t.name) && t.status === 'success'
              const preservedArgs: Record<string, unknown> = isOutputTool
                ? { path: t.args?.path, contentPreview: String(t.args?.content || '').slice(0, PER_FILE_CONTENT_LIMIT) }
                : {}

              return {
                callId: `flush-${idx}`,
                toolName: t.name,
                args: preservedArgs,
                status: (t.status === 'success' ? 'success' : 'error') as 'success' | 'error',
                result: t.status === 'success' ? t.result?.slice(0, 500) : undefined,
                error: t.status === 'error' ? t.result?.slice(0, 500) : undefined,
                durationMs: t.latency || 0,
                isMutating: CONFIG.CRITIC_TOOLS.includes(t.name),
                timestamp: Date.now(),
              }
            })

            try {
              await contextEngine.flushMemory!(flushToolSummaries, bgSignal)
            } catch (err) {
              console.warn('[LocalClaw/FC] Memory Flush failed:', err)
            }
          }

          // Step 2: Response Knowledge Flush（响应知识提取）
          if (doFlushResponse) {
            try {
              await contextEngine.flushResponseKnowledge!(userPrompt, finalResponse, bgSignal)
            } catch (err) {
              console.warn('[LocalClaw/FC] Response Knowledge Flush failed:', err)
            }
          }
        })().catch(() => {/* 串行链顶层兜底 */})
      }
    }

    // P4: Dun 经验记录 (无工具调用时也记录 — 纯文字交互也是 Dun 使用)
    if (activeDunId && traceTools.length === 0 && finalResponse) {
      dunManager.recordExperience(
        activeDunId,
        userPrompt,
        [],
        true,
        finalResponse
      ).catch(err => {
        console.warn('[LocalClaw/FC] Failed to record Dun text experience:', err)
      })
    }

    // P5: 对话级记忆写入 — 无工具调用的有意义对话也值得记忆
    if (traceTools.length === 0 && finalResponse && userPrompt.length > 10) {
      const isSubstantive = userPrompt.length > 20 ||
        /[？?]/.test(userPrompt) ||
        /如何|怎么|什么|为什么|能不能|帮我/.test(userPrompt)

      if (isSubstantive) {
        memoryStore.write({
          source: 'session',
          content: `[对话] ${userPrompt.slice(0, 200)}`,
          dunId: activeDunId || undefined,
          tags: ['conversation'],
          metadata: {
            responsePreview: finalResponse.slice(0, 500),
            timestamp: Date.now(),
          },
        }).catch(err => console.warn('[LocalClaw/FC] Conversation memory write failed:', err))
      }
    }

    // V2: 发出 run_end 事件 (在所有后处理完成后，包含真实 scoreChange)
    agentEventBus.endRun({
      success: runSuccess,
      turns: turnCount,
      tokensUsed: 0,
      toolsCalled: totalToolsCalled,
      durationMs: runDurationMs,
      scoreChange: finalScoreChange,
    })

    return finalResponse || '任务执行完成，但未生成总结。'
  }

  // ============================================
  // 📋 任务规划器
  // ============================================

  private async generatePlan(prompt: string): Promise<PlanStep[]> {
    const plannerPrompt = getPlannerPrompt(getCurrentLocale()).replace('{prompt}', prompt)

    try {
      const response = await chat([{ role: 'user', content: plannerPrompt }])

      // 提取 JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        let plan = JSON.parse(jsonMatch[0]) as PlanStep[]
        plan = plan.slice(0, CONFIG.MAX_PLAN_STEPS).map((step, i) => ({
          ...step,
          id: i + 1,
          status: 'pending' as const,
        }))

        // 🔍 Plan Review: 批评者机制
        console.log('[LocalClaw] Initial plan generated, running review...')
        const reviewedPlan = await this.reviewPlan(prompt, plan)
        return reviewedPlan
      }
    } catch (error) {
      console.error('[LocalClaw] Plan generation failed:', error)
    }

    // 降级：单步计划
    return [{ id: 1, description: prompt, status: 'pending' }]
  }

  /**
   * 计划审查 (Critic/Refine)
   * 通过 LLM 二次检查计划的完整性和逻辑性
   */
  private async reviewPlan(prompt: string, plan: PlanStep[]): Promise<PlanStep[]> {
    try {
      const planJson = JSON.stringify(plan.map(s => ({
        id: s.id,
        description: s.description,
        tool: s.tool,
      })), null, 2)

      const reviewPrompt = getPlanReviewPrompt(getCurrentLocale())
        .replace('{prompt}', prompt)
        .replace('{plan}', planJson)

      const response = await chat([{ role: 'user', content: reviewPrompt }])

      const jsonMatch = response.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const reviewed = JSON.parse(jsonMatch[0]) as PlanStep[]
        const refinedPlan = reviewed.slice(0, CONFIG.MAX_PLAN_STEPS).map((step, i) => ({
          ...step,
          id: i + 1,
          status: 'pending' as const,
        }))

        console.log(`[LocalClaw] Plan reviewed: ${plan.length} -> ${refinedPlan.length} steps`)
        return refinedPlan
      }
    } catch (error) {
      console.warn('[LocalClaw] Plan review failed, using original:', error)
    }

    // Review 失败则使用原计划
    return plan
  }

  private async executeStep(step: PlanStep, fullPlan: PlanStep[]): Promise<string> {
    // 构建上下文
    const completedSteps = fullPlan
      .filter((s) => s.status === 'completed')
      .map((s) => `步骤 ${s.id}: ${s.description}\n结果: ${s.result}`)
      .join('\n\n')

    const context = completedSteps
      ? `已完成的步骤:\n${completedSteps}\n\n当前任务: ${step.description}`
      : `当前任务: ${step.description}`

    return await this.runReActLoop(context)
  }

  private async synthesizeReport(originalPrompt: string, plan: PlanStep[]): Promise<string> {
    const stepsReport = plan
      .map((s) => `${s.id}. ${s.description}\n   状态: ${s.status}\n   结果: ${s.result || '无'}`)
      .join('\n\n')

    const summaryPrompt = `请根据以下执行结果，为用户总结任务完成情况。

原始请求: ${originalPrompt}

执行步骤:
${stepsReport}

请用简洁的语言总结：`

    try {
      return await chat([{ role: 'user', content: summaryPrompt }])
    } catch {
      return `任务执行完成。\n\n${stepsReport}`
    }
  }

  // ============================================
  // 🔄 文本工具调用解析 (Text Tool Call Fallback)
  // ============================================

  /**
   * 从 LLM 文本响应中解析工具调用 (用于不支持 OpenAI tools API 的模型)
   * 
   * 支持的格式:
   * 1. Meta/Llama 风格: <tool_call> <function=NAME> <parameter=KEY> VALUE </parameter> </function> </tool_call>
   * 2. JSON 代码块: ```json\n{"name":"...", "arguments":{...}}\n```
   * 3. 自定义XML: <tool_call>{"name":"...", "arguments":{...}}</tool_call>
   */
  private _parseTextToolCalls(
    content: string,
    registeredTools: Array<{ type: 'function'; function: import('./llmService').FunctionDefinition }>
  ): { calls: import('./llmService').FCToolCall[]; cleanContent: string } {
    const calls: import('./llmService').FCToolCall[] = []
    let cleanContent = content

    const knownToolNames = new Set(registeredTools.map(t => t.function.name))

    // --- 格式1: Meta/Llama 风格 ---
    // <tool_call> <function=webSearch> <parameter=query> 港股行情 </parameter> </function> </tool_call>
    const metaRegex = /<tool_call>\s*<function=(\w+)>([\s\S]*?)<\/function>\s*<\/tool_call>/gi
    let metaMatch: RegExpExecArray | null
    while ((metaMatch = metaRegex.exec(content)) !== null) {
      const funcName = metaMatch[1]
      const paramBlock = metaMatch[2]

      if (!knownToolNames.has(funcName)) continue

      // 解析 <parameter=key> value </parameter>
      const args: Record<string, string> = {}
      const paramRegex = /<parameter=(\w+)>([\s\S]*?)<\/parameter>/gi
      let paramMatch: RegExpExecArray | null
      while ((paramMatch = paramRegex.exec(paramBlock)) !== null) {
        args[paramMatch[1]] = paramMatch[2].trim()
      }

      // 如果没解析到 parameter 标签，尝试把整个内容当作单一参数
      if (Object.keys(args).length === 0) {
        const trimmed = paramBlock.trim()
        if (trimmed) {
          // 猜测第一个参数名
          const tool = registeredTools.find(t => t.function.name === funcName)
          if (tool && tool.function.parameters?.properties) {
            const firstParam = Object.keys(tool.function.parameters.properties)[0]
            if (firstParam) args[firstParam] = trimmed
          } else {
            args['input'] = trimmed
          }
        }
      }

      calls.push({
        id: `text-tc-${Date.now()}-${calls.length}`,
        function: {
          name: funcName,
          arguments: JSON.stringify(args),
        },
      })

      cleanContent = cleanContent.replace(metaMatch[0], '').trim()
    }

    if (calls.length > 0) return { calls, cleanContent }

    // --- 格式2: JSON 代码块 ---
    // ```json\n{"name":"webSearch","arguments":{"query":"..."}}\n```
    const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*```/gi
    let jsonMatch: RegExpExecArray | null
    while ((jsonMatch = jsonBlockRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(jsonMatch[1])
        const funcName = parsed.name || parsed.function
        if (funcName && knownToolNames.has(funcName)) {
          const args = parsed.arguments || parsed.params || parsed.parameters || {}
          calls.push({
            id: `text-tc-${Date.now()}-${calls.length}`,
            function: {
              name: funcName,
              arguments: typeof args === 'string' ? args : JSON.stringify(args),
            },
          })
          cleanContent = cleanContent.replace(jsonMatch[0], '').trim()
        }
      } catch { /* 非工具调用 JSON */ }
    }

    if (calls.length > 0) return { calls, cleanContent }

    // --- 格式3: 自定义 XML 包裹 JSON ---
    // <tool_call>{"name":"webSearch","arguments":{"query":"..."}}</tool_call>
    const xmlJsonRegex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi
    let xmlMatch: RegExpExecArray | null
    while ((xmlMatch = xmlJsonRegex.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(xmlMatch[1])
        const funcName = parsed.name || parsed.function
        if (funcName && knownToolNames.has(funcName)) {
          const args = parsed.arguments || parsed.params || {}
          calls.push({
            id: `text-tc-${Date.now()}-${calls.length}`,
            function: {
              name: funcName,
              arguments: typeof args === 'string' ? args : JSON.stringify(args),
            },
          })
          cleanContent = cleanContent.replace(xmlMatch[0], '').trim()
        }
      } catch { /* 解析失败 */ }
    }

    return { calls, cleanContent }
  }

  // ============================================
  // 🔍 验收辅助方法 (Acceptance Helpers)
  // ============================================

  /**
   * 从 ToolResult 的 verification 字段构建 Critic 提示片段
   */
  private _buildVerificationHint(toolResult: ToolResult): string {
    if (!toolResult.verification || toolResult.verification.checks.length === 0) return ''
    const v = toolResult.verification
    const checksText = v.checks
      .map(c => `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.details}`)
      .join('\n')
    return `\n[代码验证] (置信度: ${(v.confidence * 100).toFixed(0)}%):\n${checksText}${
      v.confidence < 0.7 ? '\n  ⚠️ 验证置信度较低，请确认实际效果' : ''
    }`
  }

  /**
   * 汇总执行轨迹中所有工具的验证结果，供 validateTaskCompletion 使用
   */
  private _buildVerificationSummary(traceTools: ExecTraceToolCall[]): string {
    // traceTools 中的 verification 数据保存在 result 字段中无法直接访问
    // 这里使用 _lastVerifications 缓存 (在 executeTool 后更新)
    const cache = this._verificationCache
    if (!cache || cache.size === 0) return ''

    const entries: { name: string; verified: boolean; confidence: number; failedChecks: string[] }[] = []
    for (const t of traceTools) {
      const key = `${t.name}:${t.order}`
      const v = cache.get(key)
      if (v) {
        entries.push({
          name: t.name,
          verified: v.verified,
          confidence: v.confidence,
          failedChecks: v.checks.filter((c: { passed: boolean; name: string }) => !c.passed).map((c: { name: string }) => c.name),
        })
      }
    }

    if (entries.length === 0) return ''

    const lowConfidence = entries.filter(e => e.confidence < 0.7)
    const allFailed = entries.flatMap(e => e.failedChecks)

    return `\n\n[代码验证汇总] (基于代码验证，非 LLM 推测):
- 已验证: ${entries.length}/${traceTools.length} 个工具
- 低置信度: ${lowConfidence.length > 0 ? lowConfidence.map(e => e.name).join(', ') : '无'}
- 失败检查: ${allFailed.length > 0 ? allFailed.join(', ') : '无'}`
  }

  // ============================================
  // 🔍 任务完成度验证 (Task Completion Validation)
  // ============================================

  /**
   * 验证任务是否真正完成
   * 在 ReAct 循环结束后调用，评估是否满足用户意图
   */
  private async validateTaskCompletion(
    userPrompt: string,
    traceTools: ExecTraceToolCall[],
    lastToolResult: string
  ): Promise<TaskCompletionResult> {
    // 构建执行日志
    const executionLog = traceTools.map((t, i) => {
      const statusEmoji = t.status === 'success' ? '✓' : '✗'
      const argsStr = JSON.stringify(t.args).slice(0, 100)
      return `${i + 1}. [${statusEmoji}] ${t.name}(${argsStr})`
    }).join('\n')

    const successCount = traceTools.filter(t => t.status === 'success').length
    const failCount = traceTools.filter(t => t.status === 'error').length

    // 包含最后的工具结果以便更准确判断
    const lastResultSummary = lastToolResult 
      ? `\n\n**最后工具返回 (摘要):**\n${lastToolResult.slice(0, 500)}`
      : ''

    // 🔍 Layer 4: 构建代码验证汇总
    const verificationSummary = this._buildVerificationSummary(traceTools)

    // 🎯 获取 Dun 目标函数验收标准 (如果有)
    let dunMetricsSection = ''
    const activeDunId = this.getActiveDunId()
    if (activeDunId) {
      const duns: Map<string, DunEntity> | undefined = this.storeActions?.duns
      const dun = duns?.get(activeDunId)
      if (dun?.objective && dun.metrics && dun.metrics.length > 0) {
        dunMetricsSection = `
**Dun 目标函数验收标准:**
目标: ${dun.objective}
验收检查点:
${dun.metrics.map((m, i) => `${i + 1}. ${m}`).join('\n')}

请逐一评估每个检查点是否满足，并在输出的 metricsStatus 字段中说明。
`
      }
    }
    // 无 Dun 时补充通用验收提示
    if (!dunMetricsSection) {
      dunMetricsSection = `
**通用验收标准:**
- 工具调用成功 ≠ 任务完成，需要有证据证明操作的实际效果
- 如文件操作后需确认文件存在/内容正确，命令执行后需确认输出符合预期
`
    }

    const completionLocale = getCurrentLocale()
    const prompt = getTaskCompletionPrompt(completionLocale)
      .replace('{user_prompt}', userPrompt)
      .replace('{execution_log}', (executionLog || (completionLocale === 'en' ? 'No tool calls' : '无工具调用')) + lastResultSummary + verificationSummary)
      .replace('{tool_count}', String(traceTools.length))
      .replace('{success_count}', String(successCount))
      .replace('{fail_count}', String(failCount))
      .replace('{dun_metrics_section}', dunMetricsSection)

    try {
      const response = await chat([{ role: 'user', content: prompt }])
      
      // 提取 JSON
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]) as TaskCompletionResult
        console.log(`[LocalClaw] Task completion validated: ${result.completed} (${result.completionRate}%)`)
        return result
      }
    } catch (error) {
      console.warn('[LocalClaw] Task completion validation failed:', error)
    }

    // 降级：基于工具调用结果判断
    const allSuccess = traceTools.length > 0 && traceTools.every(t => t.status === 'success')
    return {
      completed: allSuccess,
      completionRate: allSuccess ? 100 : (successCount / Math.max(traceTools.length, 1)) * 100,
      summary: allSuccess ? '工具调用成功完成' : '部分操作未能成功',
      completedSteps: traceTools.filter(t => t.status === 'success').map(t => t.name),
      pendingSteps: [],
      failureReason: allSuccess ? undefined : '存在失败的工具调用',
      nextSteps: allSuccess ? undefined : ['请检查错误信息并重试'],
    }
  }

  /**
   * V7: 生成已完成工作的结构化摘要（用于 Context Refresh）
   *
   * 纯规则提取，不调用 LLM。最大 2500 字符。
   */
  private summarizeCompletedWork(
    traceTools: ExecTraceToolCall[],
    validation: TaskCompletionResult,
  ): string {
    const sections: string[] = []

    // Section 1: 任务状态
    sections.push(`## 任务状态\n完成度: ${Math.round(validation.completionRate)}%\n${validation.summary}`)

    // Section 2: 已完成步骤
    if (validation.completedSteps.length > 0) {
      const steps = validation.completedSteps.map(s => `- [x] ${s}`).join('\n')
      sections.push(`## 已完成步骤\n${steps}`)
    }

    // Section 3: 关键产出（成功的修改类工具调用）
    const mutatingTools = traceTools.filter(t =>
      t.status === 'success' && CONFIG.CRITIC_TOOLS.includes(t.name)
    )
    if (mutatingTools.length > 0) {
      const MAX_OUTPUTS = 10
      const outputs = mutatingTools.slice(0, MAX_OUTPUTS).map(t => {
        const keyArg = t.name === 'writeFile' || t.name === 'appendFile'
          ? (t.args?.filePath || t.args?.path || '')
          : t.name === 'runCmd' ? (t.args?.command || '') : JSON.stringify(t.args).slice(0, 80)
        const resultSnippet = t.result ? t.result.slice(0, 100).replace(/\n/g, ' ') : 'ok'
        return `- ${t.name}(${String(keyArg).slice(0, 80)}) -> ${resultSnippet}`
      }).join('\n')
      sections.push(`## 关键产出\n${outputs}`)
    }

    // Section 4: 待完成步骤
    if (validation.pendingSteps.length > 0) {
      const pending = validation.pendingSteps.map(s => `- [ ] ${s}`).join('\n')
      sections.push(`## 待完成步骤\n${pending}`)
    }

    // Section 5: 失败原因（如有）
    if (validation.failureReason) {
      sections.push(`## 失败原因\n${validation.failureReason}`)
    }

    // Section 6: 执行统计
    const successCount = traceTools.filter(t => t.status === 'success').length
    const failCount = traceTools.filter(t => t.status === 'error').length
    sections.push(`## 执行统计\n- 总工具调用: ${traceTools.length}\n- 成功: ${successCount} / 失败: ${failCount}`)

    let result = sections.join('\n\n')
    if (result.length > 2500) result = result.slice(0, 2497) + '...'
    return result
  }

  /**
   * 生成结构化的任务结果反馈
   * 当任务未完成或达到最大轮次时，提供有意义的反馈
   */
  private formatTaskResult(
    validation: TaskCompletionResult,
    userPrompt: string,
    turnCount: number,
    maxTurns: number
  ): string {
    if (validation.completed && validation.completionRate >= 80) {
      // 任务完成
      return `✅ **任务完成**\n\n${validation.summary}\n\n**执行步骤:**\n${validation.completedSteps.map(s => `- ${s}`).join('\n')}`
    }

    // 任务未完成
    const sections: string[] = []

    sections.push(`⚠️ **任务未能完全完成** (完成度: ${Math.round(validation.completionRate)}%)`)
    sections.push(`\n**原始请求:** ${userPrompt.slice(0, 100)}${userPrompt.length > 100 ? '...' : ''}`)
    sections.push(`\n**执行概要:** ${validation.summary}`)

    if (validation.completedSteps.length > 0) {
      sections.push(`\n**已完成:**\n${validation.completedSteps.map(s => `✓ ${s}`).join('\n')}`)
    }

    if (validation.pendingSteps.length > 0) {
      sections.push(`\n**待完成:**\n${validation.pendingSteps.map(s => `○ ${s}`).join('\n')}`)
    }

    if (validation.failureReason) {
      sections.push(`\n**未完成原因:** ${validation.failureReason}`)
    }

    if (turnCount >= maxTurns) {
      sections.push(`\n**注意:** 已达到最大执行轮次 (${maxTurns})，任务被中断。`)
    }

    if (validation.nextSteps && validation.nextSteps.length > 0) {
      sections.push(`\n**建议下一步:**\n${validation.nextSteps.map(s => `→ ${s}`).join('\n')}`)
    }

    return sections.join('\n')
  }

  // ============================================
  // 📊 P2: 执行追踪管理
  // ============================================

  /**
   * 保存执行追踪到后端
   */
  /**
   * 截断 trace 中的大字段，控制持久化体积
   * 运行时 traceTools 保持完整（ReAct 循环需要），仅在写入时瘦身
   */
  private slimTraceForPersistence(trace: ExecTrace): ExecTrace {
    const RESULT_MAX_LENGTH = 500
    const ARG_VALUE_MAX_LENGTH = 300
    const LARGE_ARG_KEYS = ['content', 'code', 'text', 'body', 'data', 'script', 'html', 'markdown', 'prompt']

    const slimTools = trace.tools.map(tool => {
      const slimResult = tool.result && tool.result.length > RESULT_MAX_LENGTH
        ? tool.result.slice(0, RESULT_MAX_LENGTH) + `...[truncated, original ${tool.result.length} chars]`
        : tool.result

      const slimArgs: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(tool.args)) {
        if (typeof value === 'string' && value.length > ARG_VALUE_MAX_LENGTH && LARGE_ARG_KEYS.includes(key.toLowerCase())) {
          slimArgs[key] = value.slice(0, ARG_VALUE_MAX_LENGTH) + `...[truncated, original ${value.length} chars]`
        } else {
          slimArgs[key] = value
        }
      }

      return { ...tool, result: slimResult, args: slimArgs }
    })

    return { ...trace, tools: slimTools }
  }

  private async saveExecTrace(trace: ExecTrace): Promise<void> {
    try {
      const slimTrace = this.slimTraceForPersistence(trace)
      const res = await fetch(`${this.serverUrl}/api/traces/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slimTrace),
      })
      if (res.ok) {
        console.log(`[LocalClaw] Exec trace saved: ${trace.id} (${trace.tools.length} tools)`)
      }
    } catch (err) {
      console.warn('[LocalClaw] Failed to save exec trace:', err)
    }
  }

  /**
   * 搜索相关执行追踪 (用于上下文注入)
   */
  private async searchExecTraces(query: string, limit = 3): Promise<ExecTrace[]> {
    try {
      const url = `${this.serverUrl}/api/traces/search?query=${encodeURIComponent(query)}&limit=${limit}`
      const res = await fetch(url)
      if (res.ok) {
        return await res.json()
      }
    } catch (err) {
      console.warn('[LocalClaw] Failed to search traces:', err)
    }
    return []
  }

  // ============================================
  // 🛠️ 工具执行
  // ============================================

  async executeTool(tool: ToolCall, _retryCount = 0, signal?: AbortSignal): Promise<ToolResult> {
    // 🛑 abort 前置检查：若已被用户终止，直接返回
    if (signal?.aborted) {
      return { tool: tool.name, status: 'error', result: '任务已被用户终止' }
    }

    // P0-09: 只在首次调用时记录统计，避免重试导致 callCount 虚增
    if (_retryCount === 0) {
      skillStatsService.recordCall(tool.name)
    }

    // ── 前端拦截：imageGen 通道工具（不走后端） ──
    if (tool.name === 'generateImage') {
      const prompt = tool.args.prompt as string
      const size = (tool.args.size as string) || '1024x1024'
      const quality = (tool.args.quality as string) || 'standard'
      const imageCount = (tool.args.n as number) || 1
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TIMEOUT * 2)
      const onExternalAbort = () => controller.abort()
      signal?.addEventListener('abort', onExternalAbort, { once: true })
      try {
        const result = await generateImage(prompt, { size, quality, n: imageCount })
        skillStatsService.recordResult('generateImage', true)
        return { tool: 'generateImage', status: 'success', result: JSON.stringify(result) }
      } catch (error: any) {
        skillStatsService.recordResult('generateImage', false)
        if (signal?.aborted) {
          return { tool: 'generateImage', status: 'error', result: '任务已被用户终止' }
        }
        return { tool: 'generateImage', status: 'error', result: `图片生成失败: ${error.message}` }
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onExternalAbort)
      }
    }

    // ── 前端拦截：search 通道工具（不走后端） ──
    if (tool.name === 'searchEnhancedQuery') {
      const query = tool.args.query as string
      const context = tool.args.context as string | undefined
      const messages: SimpleChatMessage[] = [
        { role: 'system', content: '你是一个搜索增强助手。请基于你的联网搜索能力，为用户查找最新、最准确的信息。返回结构化的搜索结果。' },
        { role: 'user', content: context ? `背景：${context}\n\n搜索：${query}` : query },
      ]
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TIMEOUT)
      const onExternalAbort = () => controller.abort()
      signal?.addEventListener('abort', onExternalAbort, { once: true })
      try {
        const result = await searchChat(messages, undefined)
        skillStatsService.recordResult('searchEnhancedQuery', true)
        return { tool: 'searchEnhancedQuery', status: 'success', result }
      } catch (error: any) {
        skillStatsService.recordResult('searchEnhancedQuery', false)
        if (signal?.aborted) {
          return { tool: 'searchEnhancedQuery', status: 'error', result: '任务已被用户终止' }
        }
        return { tool: 'searchEnhancedQuery', status: 'error', result: `搜索增强查询失败: ${error.message}` }
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onExternalAbort)
      }
    }

    // ── 前端拦截：imageUnderstand（多模态视觉理解，不走后端） ──
    if (tool.name === 'imageUnderstand') {
      const imagePath = tool.args.imagePath as string
      const prompt = (tool.args.prompt as string) || '请详细描述这张图片的内容'
      const detail = (tool.args.detail as string) || 'auto'
      if (!imagePath) {
        return { tool: 'imageUnderstand', status: 'error', result: 'imagePath is required' }
      }
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.TOOL_TIMEOUT * 2)
      const onExternalAbort = () => controller.abort()
      signal?.addEventListener('abort', onExternalAbort, { once: true })
      try {
        // 1. 从后端获取图片 base64
        const base64Res = await fetch(
          `${this.serverUrl}/api/files/read-base64?path=${encodeURIComponent(imagePath)}`,
          { signal: controller.signal },
        )
        if (!base64Res.ok) {
          const errData = await base64Res.json().catch(() => ({ error: base64Res.statusText }))
          skillStatsService.recordResult('imageUnderstand', false)
          return { tool: 'imageUnderstand', status: 'error', result: `读取图片失败: ${errData.error || base64Res.statusText}` }
        }
        const base64Data = await base64Res.json()
        const dataUri = base64Data.base64 as string

        // 2. 构建多模态消息
        const visionMessages: VisionChatMessage[] = [
          { role: 'system', content: '你是一个视觉分析助手。请仔细观察图片，根据用户的问题给出详细、准确的描述。如果图片中包含文字，请一并提取。如果是代码截图或报错信息，请分析具体内容。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUri, detail: detail as 'low' | 'high' | 'auto' } },
            ],
          },
        ]

        // 3. 调用视觉 LLM
        const result = await visionChat(visionMessages)
        skillStatsService.recordResult('imageUnderstand', true)
        return { tool: 'imageUnderstand', status: 'success', result }
      } catch (error: unknown) {
        skillStatsService.recordResult('imageUnderstand', false)
        if (signal?.aborted) {
          return { tool: 'imageUnderstand', status: 'error', result: '任务已被用户终止' }
        }
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          tool: 'imageUnderstand',
          status: 'error',
          result: `图片理解失败: ${errMsg}。当前 chat 模型可能不支持图片理解，建议切换到支持 vision 的模型（如 GPT-4o、Claude 3.5 Sonnet）。也可以尝试使用 ocrExtract 工具提取图片中的文字。`,
        }
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onExternalAbort)
      }
    }
    
    // 可重试的网络错误模式
    const RETRYABLE_PATTERNS = ['timeout', 'ECONNREFUSED', 'fetch failed', 'ECONNRESET', 'aborted']
    const MAX_TOOL_RETRIES = CONFIG.MAX_TOOL_RETRIES
    
    // 数字免疫系统自愈上下文
    const executeWithHealing = async (healingDepth = 0): Promise<ToolResult> => {
      // 链接外部 AbortSignal + 超时，手动合并（tsconfig lib=ES2020 不支持 AbortSignal.any）
      const linkedController = new AbortController()
      const timeoutId = setTimeout(() => linkedController.abort(), CONFIG.TOOL_TIMEOUT)
      const onExternalAbort = () => linkedController.abort()
      signal?.addEventListener('abort', onExternalAbort, { once: true })

      try {
        // Dun 上下文路由：为 writeFile/appendFile/saveMemory 注入 activeDunId
        const DUN_ROUTED_TOOLS = ['writeFile', 'appendFile', 'saveMemory']
        const activeDunId = DUN_ROUTED_TOOLS.includes(tool.name) ? this.getActiveDunId() : null
        const finalArgs = activeDunId 
          ? { ...tool.args, dunId: activeDunId }
          : tool.args

        const response = await fetch(`${this.serverUrl}/api/tools/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tool.name, args: finalArgs }),
          signal: linkedController.signal,
        })

        if (!response.ok) {
          throw new Error(`Server returned ${response.status}`)
        }

        const result: ToolResult = await response.json()
        
        // 旁路统计：记录结果
        skillStatsService.recordResult(tool.name, result.status === 'success')
        
        // 成功时重置免疫状态
        if (result.status === 'success') {
          immuneService.resetState(tool.name)
        }

        // Knowledge Capture: writeFile/appendFile 文档产出 → 写入 memoryStore → 触发知识摄入管道
        if (result.status === 'success' && (tool.name === 'writeFile' || tool.name === 'appendFile')) {
          const fileContent = typeof tool.args.content === 'string' ? tool.args.content : ''
          const pathStr = typeof tool.args.path === 'string' ? tool.args.path : String(tool.args.path ?? '')
          const isDocFile = /\.(md|txt|html|csv)$/i.test(pathStr)
          const captureDunId = activeDunId || this.getActiveDunId()
          if (fileContent.length > 200 && isDocFile && captureDunId) {
            const preview = fileContent.slice(0, 3000)
            memoryStore.write({
              source: 'memory',
              content: `[文件产出] ${pathStr}\n${preview}`,
              dunId: captureDunId,
              tags: ['file_output', 'knowledge_capture'],
              metadata: { filePath: pathStr, fileSize: fileContent.length, capturedAt: Date.now() },
            }).then(written => {
              if (written) {
                knowledgeIngestService.recordFlush(captureDunId)
                console.log(`[LocalClaw/FC] Knowledge captured from ${tool.name}: ${pathStr} (${fileContent.length} chars)`)
              }
            }).catch(err => console.warn('[LocalClaw/FC] Knowledge capture failed:', err))
          }
        }
        
        return result
      } catch (error: any) {
        const errorMessage = error.message || String(error)
        
        // 🛑 用户终止检查：signal abort 不走重试/自愈，直接返回
        if (signal?.aborted) {
          return { tool: tool.name, status: 'error', result: '任务已被用户终止' }
        }

        // 数字免疫系统：匹配失败签名
        const matchResult = immuneService.matchFailure(errorMessage)
        
        if (matchResult && matchResult.healingScript && healingDepth < CONFIG.MAX_HEALING_DEPTH) {
          const healingResult = immuneService.executeHealing(
            tool.name,
            matchResult.signature,
            matchResult.healingScript
          )
          
          console.log(`[LocalClaw] Immune healing: ${healingResult.message}`)
          
          if (healingResult.shouldRetry) {
            // 根据自愈参数调整等待时间
            const backoffMs = (healingResult.params?.backoffMultiplier as number || 1) * 1000
            await new Promise(resolve => setTimeout(resolve, backoffMs))
            
            return executeWithHealing(healingDepth + 1)
          }
          
          return {
            tool: tool.name,
            status: 'error',
            result: `${healingResult.message}\n原始错误: ${errorMessage}`,
          }
        }
        
        // 旁路统计：记录失败
        skillStatsService.recordResult(tool.name, false)
        
        // 🔄 网络错误自动重试（指数退避）— 用户终止时跳过重试
        if (!signal?.aborted && _retryCount < MAX_TOOL_RETRIES && RETRYABLE_PATTERNS.some(p => errorMessage.toLowerCase().includes(p))) {
          const backoffMs = 1000 * Math.pow(2, _retryCount)
          console.log(`[LocalClaw] Tool ${tool.name} failed with retryable error, retry ${_retryCount + 1}/${MAX_TOOL_RETRIES} after ${backoffMs}ms`)
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          return this.executeTool(tool, _retryCount + 1, signal)
        }
        
        return {
          tool: tool.name,
          status: 'error',
          result: `工具执行失败: ${errorMessage}`,
        }
      } finally {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onExternalAbort)
      }
    }
    
    const result = await executeWithHealing()

    // V3: FileRegistry 自动注册/清理
    const FILE_OPS = FILE_REGISTRY_CONFIG.FILE_OPS as readonly string[]
    if (FILE_OPS.includes(tool.name)) {
      const toolPath = tool.args.path as string | undefined
      if (toolPath) {
        if (result.status === 'success') {
          fileRegistry.register(toolPath, tool.name, this.getActiveDunId())
        } else {
          fileRegistry.handleToolError(toolPath, result.result)
        }
      }
    }

    // Soul #5: SOUL.md 写入后自动重载
    if (tool.name === 'writeFile' && result.status === 'success') {
      const toolPath = tool.args.path as string | undefined
      if (toolPath && toolPath.includes('SOUL.md')) {
        await this.reloadSoulContent()
      }
    }

    return result
  }

  // ============================================
  // 🔧 辅助方法
  // ============================================

  async listFiles(path = '.'): Promise<any[]> {
    const result = await this.executeTool({
      name: 'listDir',
      args: { path },
    })

    if (result.status === 'success') {
      try {
        return JSON.parse(result.result)
      } catch {
        return []
      }
    }
    return []
  }

  async readFile(path: string): Promise<string | null> {
    const result = await this.executeTool({
      name: 'readFile',
      args: { path },
    })

    return result.status === 'success' ? result.result : null
  }

  async writeFile(path: string, content: string): Promise<boolean> {
    const result = await this.executeTool({
      name: 'writeFile',
      args: { path, content },
    })

    return result.status === 'success'
  }

  async runCommand(command: string): Promise<string> {
    const result = await this.executeTool({
      name: 'runCmd',
      args: { command },
    })

    return result.result
  }

  /**
   * 刷新工具列表（公开方法）
   *
   * 供外部调用（如 MCP reload 后），重新从后端加载工具列表。
   * 条件工具（imageGen、search 等）通过 getEffectiveTools() 动态合并，无需额外处理。
   */
  async refreshTools(): Promise<void> {
    await this.loadTools()
    const conditional = this.getConditionalTools()
    console.log(`[LocalClaw] Tools refreshed: ${this.availableTools.length} backend + ${conditional.length} conditional (${conditional.map(t => t.name).join(', ')})`)
  }

  /**
   * 过滤 MCP 工具：移除不在活跃服务器列表中的 MCP 工具
   */
  filterOutMCPTools(activeServerNames: Set<string>): void {
    this.availableTools = this.availableTools.filter(t => {
      if (t.type !== 'mcp') return true  // 非 MCP 工具保留
      // MCP 工具：检查其 server 是否仍在活跃列表中
      const serverName = (t as unknown as { server?: string; serverName?: string }).server
        || (t as unknown as { server?: string; serverName?: string }).serverName
        || ''
      return activeServerNames.has(serverName)
    })
  }

}

// 导出单例
export const localClawService = new LocalClawService()
