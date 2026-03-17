/**
 * DD-OS Native Local AI Engine
 * 
 * 独立运行的本地 AI 引擎，包含：
 * - ReAct 循环执行器
 * - 任务规划器 (Planner)
 * - 工具调用能力
 * - 本地记忆持久化
 */

import { chat, streamChat, isLLMConfigured, embed, cosineSimilarity, convertToolInfoToFunctions } from './llmService'
import type { SimpleChatMessage, LLMStreamResult } from './llmService'
import type { ExecutionStatus, OpenClawSkill, MemoryEntry, ToolInfo, ExecTrace, ExecTraceToolCall, ApprovalRequest, ExecutionStep, NexusEntity, TaskCheckpoint } from '@/types'
import { parseSoulMd, type ParsedSoul } from '@/utils/soulParser'
import { skillStatsService } from './skillStatsService'
import { immuneService } from './capsuleService'
import { nexusRuleEngine } from './nexusRuleEngine'
import { nexusManager } from './nexusManager'
import { genePoolService } from './genePoolService'
import { clawHubService } from './clawHubService'
import { agentEventBus } from './agentEventBus'
import { estimateTokens, DefaultNexusContextEngine, contextEngineRegistry } from './nexusContextEngine'
import { nexusScoringService } from './nexusScoringService'
import { handleRecovery } from './errorRecovery'
import { memoryStore } from './memoryStore'
import { sessionPersistence } from './sessionPersistence'
import { fileRegistry } from './fileRegistry'
import { FILE_REGISTRY_CONFIG } from '@/types'
import { confidenceTracker } from './confidenceTracker'

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

// Nexus 性能统计类型 (已迁移到 nexusRuleEngine.ts / nexusManager.ts)

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
  // P4: Nexus 数据注入
  setNexusesFromServer: (nexuses: Array<Partial<NexusEntity> & { id: string }>) => void
  activeNexusId?: string | null
  setActiveNexus?: (id: string | null) => void
  updateNexusScoring?: (id: string, scoring: import('@/types').NexusScoring) => void
  getNexuses?: () => Map<string, NexusEntity> | undefined
}

// ============================================
// 配置
// ============================================

// 检测运行环境
const isDevMode = import.meta.env?.DEV ?? false
const isTauriMode = typeof window !== 'undefined' && '__TAURI__' in window

const CONFIG = {
  // 开发模式使用 localhost:3001，生产模式使用相对路径（Python 托管）
  LOCAL_SERVER_URL: isDevMode ? 'http://localhost:3001' : (isTauriMode ? 'http://127.0.0.1:3001' : ''),
  MAX_REACT_TURNS: 999,    // 无限制：让任务持续执行直到完成
  DEFAULT_TURNS: 999,      // 无限制
  SIMPLE_TURNS: 10,        // 简单任务仍有轻微限制避免死循环
  MAX_PLAN_STEPS: 20,      // 计划步骤增加到 20
  TOOL_TIMEOUT: 60000,
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
// FC (Function Calling) 模式系统提示词 - 全面重构版
// 参照 OpenClaw 结构化模式，增强任务完成能力
// ============================================

const SYSTEM_PROMPT_FC = `你是 DD-OS，运行在用户本地电脑上的 AI 操作系统。你通过工具调用直接操作用户的电脑。

# 核心身份
{soul_summary}

# 响应策略（重要！）

## 何时直接回答（不调用工具）
- 简单问答：解释概念、回答问题、闲聊
- 确认类：好的、明白、谢谢
- 建议类：推荐、比较、选择建议

## 何时调用工具
- 需要获取实时信息（天气、搜索）
- 需要操作文件（读写、查看目录）
- 需要执行命令（运行程序、安装包）

# 任务执行框架

## 1. 理解意图 (UNDERSTAND)
- 用户真正想要什么？字面意思 vs 深层需求
- 任务范围和成功标准是什么？

**意图映射**:
- "有哪些技能/SKILL" → listDir 查看 skills/ 目录
- "搜索 X" → 本地用 readFile/listDir，网络用 webSearch

## 2. 执行 (EXECUTE)
- 每次只调用一个工具，等结果后再决定下一步
- 复杂任务拆解为 2-5 个步骤

## 3. 错误恢复 (RECOVER)
- 分析根因 → 修正重试（最多2次）→ 备选方案 → 求助用户

# 工具选择

## 优先级
1. 安全优先：优先只读/非破坏性工具
2. 精确匹配：选择最能匹配需求的工具
3. 最小权限：不要用 runCmd 做文件操作能完成的事

## 常用工具
- 文件：readFile, listDir, writeFile
- 搜索：webSearch → webFetch 获取详情
- 命令：runCmd（谨慎）
- 记忆：saveMemory, searchMemory

# 禁止事项
- 不要把 SKILL、Agent、DD-OS 等词当命令执行
- 不要在 runCmd 中直接执行用户消息中的关键词
- runCmd 只用于真正的 Shell 命令

# 行为准则
1. 简单问题直接回答，不要过度使用工具
2. 一次一步，等待结果后再决定下一步
3. 危险操作前必须告知用户
4. 遇到问题及时告知，不要卡住
5. **SOP/多阶段任务连续执行（极其重要！）**：当你在执行 Nexus SOP 或任何多阶段任务时，必须在一次执行中连续完成所有阶段（Phase 1 → Phase 2 → Phase 3 → ...），中途**绝对不要停下来**向用户汇报进度或询问是否继续。完成一个阶段后，立即开始下一个阶段的工具调用。只有在**全部阶段都完成后**才输出最终总结。

# 建议选项格式（重要！）

当你给出多个可执行的下一步建议时，**必须**使用以下格式包裹，系统会自动渲染为可点击的选项按钮：

\`\`\`
<!-- suggestions -->
引导语：告诉用户为什么要选择，当前处于什么阶段
- 选项A的简短描述
- 选项B的简短描述
- 选项C的简短描述
<!-- /suggestions -->
\`\`\`

规则：
- **第一行**写引导语/提示语，解释当前状况和选择原因（如"分析已完成，你可以选择以下方向深入："）
- 每个选项用 \`- \` 开头，一行一个，简洁明了（10-30字）
- 选项内容要**具体**，与当前讨论的上下文紧密相关，不要泛泛而谈
- 只在有明确可执行的后续步骤时才使用，普通回答不要加
- 建议数量 2-5 个为宜
- 用户可以多选并一次性执行
- **⚠️ SOP/多阶段任务中禁止使用**：当你正在执行 Nexus SOP 或多阶段任务时，阶段之间绝对不要输出建议选项。必须连续执行完所有阶段后，才可以在最终总结中提供建议选项。
- **✅ 任务完成后必须附带建议**：当你完成了用户的任务（包括工具执行结束、分析完成、问题回答完毕等），在最终回复的末尾**必须**附带一个 \`<!-- suggestions -->\` 块，给出 2-3 个与当前上下文相关的后续操作建议。这是强制要求，不要省略。

# 能力边界自检
- 此任务是否需要你没有的工具？→ 优先使用 generateSkill 创建新能力
- 你是在"描述步骤"还是"实际执行"？→ 区分清楚，不要假装已执行
- 没有对应工具时，禁止用纯文本模拟工具执行结果

# 动态能力扩展（重要！）

当遇到以下情况时，**主动使用 generateSkill 工具**创建新的 Python 技能：

## 触发条件
1. **工具缺失**: 当前工具无法完成用户任务（如：制作PPT、生成PDF、处理特定文件格式）
2. **重复任务**: 同类任务反复出现，值得抽象为可复用技能
3. **执行失败**: 使用现有工具多次失败，需要自定义解决方案
4. **复杂流程**: 任务涉及多步骤串联，适合封装为独立技能

## generateSkill 参数
- name: 技能名称 (kebab-case，如 "ppt-maker")
- description: 技能功能描述
- pythonCode: Python 代码（必须包含 main() 函数）
- nexusId: 可选，关联到特定 Nexus
- triggers: 可选，触发关键词列表

## 示例场景
- 用户要求"制作PPT" → 生成 ppt-maker 技能，使用 python-pptx 库
- 用户要求"合并PDF" → 生成 pdf-merger 技能，使用 PyPDF2 库
- 用户要求"批量重命名文件" → 生成 batch-renamer 技能

## 生成原则
1. Python 代码必须包含 main() 函数作为入口
2. 使用标准库或常见第三方库（pip 可安装）
3. 生成后技能会自动热加载，立即可用
4. 如果是 Nexus 相关任务，指定 nexusId 保存到对应目录

# Nexus 创建规范（重要！）

当需要创建新的 Nexus（执行节点/专家角色）时，**必须遵循以下规范**：

## 核心规则
- Nexus 通过 \`nexuses/{nexus-id}/NEXUS.md\` 文件定义
- **必须创建 NEXUS.md 文件**，否则系统无法识别！
- 不要创建 .json 文件，那不是有效的 Nexus 格式

## NEXUS.md 文件格式
\`\`\`markdown
---
name: Nexus 名称（2-6个中文字）
description: 一句话描述功能和适用场景
version: 1.0.0
skill_dependencies:
  - 绑定的技能ID列表
tags:
  - 分类标签
triggers:
  - 触发词1
  - 触发词2
visual_dna:
  primaryHue: 0-360（色相，如 210 为蓝色）
  primarySaturation: 60-80
  primaryLightness: 40-50
  glowIntensity: 0.5-0.8
objective: 核心目标（一句话）
metrics:
  - 质量指标1
  - 质量指标2
strategy: 执行策略概述
---

# Nexus 名称 SOP

## 一、流程概览
（详细的标准作业程序）

## 二、执行步骤
1. 步骤一...
2. 步骤二...

## 三、质量检查
- [ ] 检查项...

## 四、执行指令
当用户请求相关任务时，应该如何响应...
\`\`\`

## 创建步骤
1. 使用 writeFile 创建 \`nexuses/{nexus-id}/NEXUS.md\`
2. 文件必须包含 YAML frontmatter（用 --- 包围）
3. Markdown 正文是详细的 SOP

## 示例
创建一个 PPT 优化 Nexus:
\`\`\`json
{
  "tool": "writeFile",
  "args": {
    "path": "nexuses/ppt-optimizer/NEXUS.md",
    "content": "---\\nname: PPT智能优化\\ndescription: ...\\n---\\n\\n# PPT智能优化 SOP\\n..."
  }
}
\`\`\`

# 当前上下文
{context}
`

const PLANNER_PROMPT = `你是一个任务规划器。请将用户的复杂请求拆解为可执行的步骤。

输出格式：纯 JSON 数组，每个步骤包含：
- id: 步骤序号
- description: 步骤描述
- tool: 可能需要的工具名 (可选)
- depends_on: 依赖的步骤 id 数组 (可选)

示例输出：
[
  {"id": 1, "description": "读取项目配置文件", "tool": "readFile"},
  {"id": 2, "description": "分析依赖关系", "depends_on": [1]},
  {"id": 3, "description": "生成报告并保存", "tool": "writeFile", "depends_on": [2]}
]

用户请求: {prompt}

请输出 JSON 数组 (不要包含其他文字)：`

const PLAN_REVIEW_PROMPT = `你是一个计划审查员。请检查以下任务计划，评估是否存在问题：

用户原始请求: {prompt}

当前计划:
{plan}

请检查：
1. 步骤是否遗漏？是否有必要步骤被忽略？
2. 步骤顺序是否正确？依赖关系是否合理？
3. 是否有可以合并或省略的冗余步骤？
4. 每个步骤使用的工具是否正确？

如果计划没有问题，原样输出 JSON 数组。
如果有改进，输出优化后的 JSON 数组。
只输出 JSON 数组，不要包含其他文字。`

/**
 * 任务完成度验证提示词
 * 用于评估任务执行是否真正满足用户意图
 */
const TASK_COMPLETION_PROMPT = `你是任务完成度评估器。请分析以下任务执行情况，判断用户的原始意图是否被满足。

**用户原始请求:**
{user_prompt}

**执行记录:**
{execution_log}

**工具调用统计:**
- 总调用次数: {tool_count}
- 成功次数: {success_count}
- 失败次数: {fail_count}
{nexus_metrics_section}
请严格按照以下标准评估：

**意图完成判断规则:**
1. "搜索/查找 X" → 成功标准: 找到并展示了相关信息
2. "安装/加载/下载技能" → 成功标准: 技能文件已保存到 skills/ 目录并验证存在
3. "创建/编写文件" → 成功标准: 文件已创建并内容正确
4. "执行命令" → 成功标准: 命令执行成功且返回预期结果
5. "分析/解释 X" → 成功标准: 给出了有意义的分析结论

**严格评分规则:**
- 工具调用成功 ≠ 任务完成，必须有证据证明用户意图被满足
- 如果写入文件后未确认文件存在或内容正确，completionRate 不应超过 85%
- 如果存在 Nexus 验收标准但未逐条验证，completionRate 不应超过 80%
- 如果所有工具都失败，completionRate 应为 0

**输出格式 (仅输出 JSON):**
{
  "completed": true/false,
  "completionRate": 0-100,
  "summary": "一句话描述完成情况",
  "completedSteps": ["已完成的步骤1", "已完成的步骤2"],
  "pendingSteps": ["未完成的步骤1"],
  "failureReason": "如果未完成，说明原因",
  "nextSteps": ["建议的下一步操作"],
  "metricsStatus": ["metric1: true/false", "metric2: true/false"]
}

重要: 仅输出 JSON，不要包含任何其他文字。`

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

  // P0: 动态工具列表 (从 /tools 端点获取)
  private availableTools: ToolInfo[] = []

  // P1: 动态技能触发器 (从 /skills manifest.keywords 构建)
  private skillTriggers: Record<string, { keywords: string[]; path: string }> = { ...DEFAULT_SKILL_TRIGGERS }


  // 追踪执行过程中创建的文件 (用于在聊天中显示文件卡片)
  private _lastCreatedFiles: { filePath: string; fileName: string; message: string; fileSize?: number }[] = []
  get lastCreatedFiles() { return this._lastCreatedFiles }

  // JIT 缓存 - 避免重复读取
  private contextCache: Map<string, { content: string; timestamp: number }> = new Map()
  private readonly CACHE_TTL = 60000 // 1分钟缓存有效期

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
   * 检测工具错误是否属于能力缺失，并记录到记忆
   */
  private async detectAndRecordCapabilityGap(toolName: string, errorMsg: string, taskHint: string): Promise<void> {
    // 能力缺失特征词
    const gapPatterns = [
      /unknown tool/i, /tool not found/i, /不支持/,
      /no such tool/i, /未找到工具/, /not available/i,
      /没有.*能力/, /无法.*执行/, /unsupported/i,
    ]
    const isGap = gapPatterns.some(p => p.test(errorMsg))
    if (!isGap) return

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

    // 持久化到记忆文件
    const logLine = `[${new Date().toISOString().split('T')[0]}] 缺失能力: ${toolName} | 场景: ${entry.task}\n`
    this.executeTool({
      name: 'appendFile',
      args: { path: 'memory/capability_gaps.md', content: logLine },
    }).catch(() => {})

    console.log(`[LocalClaw] Capability gap detected: ${toolName}`)

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

    // 接线提取出的服务
    nexusRuleEngine.setIO({
      readFile: (path: string) => this.executeTool({ name: 'readFile', args: { path } }),
      writeFile: (path: string, content: string) =>
        this.executeTool({ name: 'writeFile', args: { path, content } }).then(() => {}),
      addToast: (toast: { type: string; title: string; message: string }) =>
        this.storeActions?.addToast(toast),
    })

    nexusManager.setIO({
      executeTool: (call: { name: string; args: Record<string, unknown> }) => this.executeTool(call),
      readFileWithCache: (path: string) => this.readFileWithCache(path),
      getActiveNexusId: () => this.getActiveNexusId(),
      getNexuses: () => (this.storeActions as any)?.nexuses as Map<string, NexusEntity> | undefined,
      getAvailableTools: () => this.availableTools,
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
    nexusId?: string,
    onStream?: (chunk: string) => void
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置')
    }

    // 构建包含 Nexus 设定的系统提示词
    let systemPrompt = '你是一个友好、专业的 AI 助手。请简洁、直接地回答用户问题。'

    if (nexusId) {
      try {
        // 从 store 获取 Nexus 实体
        const { useStore } = await import('@/store')
        const state = useStore.getState() as any
        const nexus = state.nexuses?.get?.(nexusId)

        if (nexus) {
          const identity = nexus.label || nexus.id
          const description = nexus.flavorText || nexus.sopContent?.split('\n')[0] || ''
          const sop = nexus.sopContent || ''

          systemPrompt = `你是 "${identity}"，DD-OS 中的一个专业 Agent。
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

  /**
   * 连接到本地服务器
   */
  async connect(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`)
      }

      const data = await response.json()
      console.log('[LocalClaw] Connected to Native Server:', data)

      this.storeActions?.setConnectionStatus('connected')
      this.storeActions?.setConnectionError(null)
      
      // Native 模式下，设置所有 loading 状态为 false
      this.storeActions?.setSessionsLoading(false)
      this.storeActions?.setChannelsLoading(false)
      this.storeActions?.setDevicesLoading(false)
      
      this.storeActions?.addToast({
        type: 'success',
        title: 'DD-OS Native 已就绪',
        message: `v${data.version} | ${data.skillCount} skills`,
      })

      // 加载 SOUL
      await this.loadSoul()

      // 加载所有数据到 store (Soul/Skills/Memories)
      await this.loadAllDataToStore()

      // P0: 加载动态工具列表
      await this.loadTools()

      // 加载能力缺失记忆
      await this.loadCapabilityGapHistory()

      // 加载 Nexus 性能统计
      await nexusManager.loadStats()
      
      // 🧬 Phase 4: 注册所有 Nexus 的能力基因 (让 Nexus 间可以互相发现)
      await nexusManager.registerAllNexusCapabilities()

      // 加载自适应规则
      await nexusRuleEngine.load()

      return true
    } catch (error: any) {
      console.error('[LocalClaw] Connection failed:', error)
      this.storeActions?.setConnectionStatus('error')
      this.storeActions?.setConnectionError(
        '无法连接本地服务器。请确保 ddos-local-server.py 正在运行。'
      )
      return false
    }
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.storeActions?.setConnectionStatus('disconnected')
  }

  /**
   * 检查连接状态
   */
  async checkStatus(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/status`, {
        signal: AbortSignal.timeout(3000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * 加载 SOUL.md
   */
  private async loadSoul(): Promise<void> {
    try {
      const response = await fetch(`${this.serverUrl}/file/SOUL.md`)
      if (response.ok) {
        this.soulContent = await response.text()
      }
    } catch (error) {
      console.warn('[LocalClaw] Failed to load SOUL.md:', error)
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
  private async loadAllDataToStore(): Promise<void> {
    // 1. Soul: 解析已加载的 SOUL.md 并更新 store
    if (this.soulContent) {
      try {
        const parsed = parseSoulMd(this.soulContent)
        this.storeActions?.setSoulFromParsed(parsed, null)
        // 缓存到 localStorage
        localStorage.setItem('ddos_soul_md', this.soulContent)
        console.log('[LocalClaw] Soul loaded to store')
      } catch (e) {
        console.warn('[LocalClaw] Failed to parse SOUL.md:', e)
      }

      // 尝试加载 IDENTITY.md
      try {
        const identityRes = await fetch(`${this.serverUrl}/file/IDENTITY.md`)
        if (identityRes.ok) {
          const identityContent = await identityRes.text()
          localStorage.setItem('ddos_identity_md', identityContent)
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
          localStorage.setItem('ddos_skills_json', JSON.stringify(skills))
          console.log(`[LocalClaw] ${skills.length} skills loaded to store`)

          // P1: 从 manifest.keywords 动态构建技能触发器
          this.buildSkillTriggersFromManifest(skills)
          
          // P6: EvoMap 已移除 (死代码清理)
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
          localStorage.setItem('ddos_memories_json', JSON.stringify(memories))
          console.log(`[LocalClaw] ${memories.length} memories loaded to store`)
        }
      }
    } catch (e) {
      console.warn('[LocalClaw] Failed to load memories:', e)
    }

    // 4. Nexuses: 从服务器获取 Nexus 列表 (Phase 4)
    try {
      const nexusesRes = await fetch(`${this.serverUrl}/nexuses`)
      if (nexusesRes.ok) {
        const nexuses = await nexusesRes.json()
        if (nexuses.length > 0) {
          this.storeActions?.setNexusesFromServer(nexuses)
          localStorage.setItem('ddos_nexuses', JSON.stringify(nexuses))
          console.log(`[LocalClaw] ${nexuses.length} nexuses loaded to store`)
        }
      }
    } catch (e) {
      console.warn('[LocalClaw] Failed to load nexuses:', e)
    }
  }

  /**
   * P1: 从 /skills 返回的 manifest.keywords 动态构建触发器
   * P4: 同时构建语义嵌入索引
   * 有 keywords 的技能会覆盖 DEFAULT_SKILL_TRIGGERS 中的同名条目
   * P5: 支持多工具技能 (toolNames 数组)
   */
  private buildSkillTriggersFromManifest(skills: OpenClawSkill[]): void {
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

  }

  // ============================================
  // 🎯 JIT 动态上下文构建
  // ============================================

  /**
   * 构建动态上下文 (Just-In-Time Loading)
   * 根据用户查询动态注入相关上下文，避免上下文窗口膨胀
   * 返回 { context, dynamicExamples } 分别注入模板的两个占位符
   * @param overrideNexusId 可选的 Nexus ID，优先于全局 activeNexusId
   */
  private async buildDynamicContext(userQuery: string, overrideNexusId?: string | null): Promise<{ context: string; dynamicExamples: string }> {
    const contextParts: string[] = []
    const exampleParts: string[] = []
    const queryLower = userQuery.toLowerCase()

    // 0. P5: 指代消解提示 (优先注入，让模型理解代词指向)
    const anaphoraHint = this.buildAnaphoraHint(userQuery)
    if (anaphoraHint) {
      contextParts.push(anaphoraHint)
    }

    // 1. 核心人格 (SOUL.md) - 始终加载但精简
    if (this.soulContent) {
      const soulSummary = this.extractSoulSummary(this.soulContent)
      if (soulSummary) {
        contextParts.push(`## 核心人格\n${soulSummary}`)
      }
    }

    // 1.5 激活的 Nexus SOP 注入 (Phase 4)
    // 优先使用传入的 nexusId，fallback 到全局 activeNexusId
    const activeNexusId = overrideNexusId ?? this.getActiveNexusId()
    if (activeNexusId) {
      const nexusCtx = await nexusManager.buildContext(activeNexusId, queryLower)
      if (nexusCtx) {
        contextParts.push(nexusCtx)
      }
    }

    // 1.6 📊 Nexus 性能洞察注入
    const performanceInsight = nexusManager.buildInsight(activeNexusId)
    if (performanceInsight) {
      contextParts.push(performanceInsight)
    }

    // 1.7 🤖 自适应规则引擎注入
    const activeRules = nexusRuleEngine.getActiveRulesForNexus(activeNexusId)
    if (activeRules.length > 0) {
      const ruleTexts = activeRules.map(r => `- ${r.injectedPrompt}`).join('\n')
      contextParts.push(`## 🤖 自适应约束\n${ruleTexts}`)
    }

    // 2. V2: 记忆检索 - 使用 memoryStore 混合搜索替代文件读取
    try {
      const memoryResults = await memoryStore.search({
        query: userQuery,
        maxResults: 8,
        nexusId: activeNexusId || undefined,
        useMmr: true,
      })
      if (memoryResults.length > 0) {
        const memoryHints = memoryResults.map(r => `- ${r.snippet.slice(0, 200)}`).join('\n')
        contextParts.push(`## 相关记忆\n${memoryHints}`)
      }
    } catch {
      // memoryStore 不可用时降级到文件读取
      const today = new Date().toISOString().split('T')[0]
      const dailyLog = await this.readFileWithCache(`memory/${today}.md`)
      if (dailyLog) {
        const recentLogs = this.extractRecentLogs(dailyLog, 10)
        if (recentLogs) {
          contextParts.push(`## 今日活动\n${recentLogs}`)
        }
      }
    }

    // 3.3 V3: 文件注册表 - 注入已知文件路径，减少重复探索
    const knownFilesSection = fileRegistry.buildContextSection(activeNexusId || undefined, 15)
    if (knownFilesSection) {
      contextParts.push(knownFilesSection)
    }

    // 3.5 P2: 执行追踪检索 - 查找相似任务的成功工具序列
    const relatedTraces = await this.searchExecTraces(queryLower, 3)
    const successfulTraces = relatedTraces.filter(t => t.success)
    if (successfulTraces.length > 0) {
      const traceHints = successfulTraces.map(t => {
        const toolSeq = t.tools.map(tool => `${tool.name}()`).join(' → ')
        return `- 任务: "${t.task.slice(0, 50)}..." → ${toolSeq}`
      }).join('\n')
      contextParts.push(`## 历史成功案例\n${traceHints}`)
    }

    // 4. 动态技能注入 - 优先语义检索，fallback 关键词匹配
    const matchedSkills = await this.matchSkillsAsync(queryLower)
    for (const skillPath of matchedSkills) {
      const skillContent = await this.readFileWithCache(skillPath)
      if (skillContent) {
        const skillUsage = this.extractSkillUsage(skillContent)
        if (skillUsage) {
          exampleParts.push(skillUsage)
        }
      }
    }

    // 5. 用户偏好 (如果存在)
    if (queryLower.includes('偏好') || queryLower.includes('设置') || queryLower.includes('preference')) {
      const userPrefs = await this.readFileWithCache('USER.md')
      if (userPrefs) {
        contextParts.push(`## 用户偏好\n${userPrefs}`)
      }
    }

    // 🧬 Phase 4: Nexus 通讯提示 (让 AI 知道可以协作的其他 Nexus)
    const nexusCommunicationHint = genePoolService.buildNexusCommunicationHint(userQuery, activeNexusId || undefined)
    if (nexusCommunicationHint) {
      contextParts.push(nexusCommunicationHint)
    }

    // 组合上下文
    const now = new Date()
    const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
    const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false })
    const weekdays = ['日', '一', '二', '三', '四', '五', '六']
    const weekday = `星期${weekdays[now.getDay()]}`
    const header = `当前日期: ${dateStr} ${weekday}\n当前时间: ${timeStr}\n\n⚠️ 重要：用户说"今天"指的就是 ${dateStr}，"昨天"指 ${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate() - 1}日。请务必使用上述日期，不要猜测或使用其他日期。\n\n用户意图: ${userQuery.slice(0, 100)}${userQuery.length > 100 ? '...' : ''}`
    
    const context = contextParts.length > 0 
      ? `${header}\n\n${contextParts.join('\n\n')}`
      : header

    const dynamicExamples = exampleParts.length > 0
      ? `## 相关技能参考\n以下是与当前任务相关的工具用法和思维示例：\n\n${exampleParts.join('\n\n---\n\n')}`
      : `## 基础示例\n查询天气：\n\`\`\`json\n{"thought": "用户想查天气，使用 weather 工具", "tool": "weather", "args": {"location": "惠州"}}\n\`\`\`\n\n网页搜索：\n\`\`\`json\n{"thought": "用户需要搜索信息", "tool": "webSearch", "args": {"query": "关键词"}}\n\`\`\``

    return { context, dynamicExamples }
  }

  // ============================================
  // 🌌 Nexus 上下文 (委托给提取的服务)
  // ============================================

  /**
   * 获取当前激活的 Nexus ID
   */
  private getActiveNexusId(): string | null {
    // 从 storeActions 中读取 (Zustand 状态)
    return (this.storeActions as any)?.activeNexusId ?? null
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
   * 匹配用户查询与技能 (P1: 使用动态 skillTriggers, P4: 优先语义检索)
   */
  private async matchSkillsAsync(queryLower: string): Promise<string[]> {
    return this.matchSkillsByKeyword(queryLower)
  }

  /**
   * 关键词匹配 (fallback 方法)
   */
  private matchSkillsByKeyword(queryLower: string): string[] {
    const matched: string[] = []
    
    for (const [skillName, config] of Object.entries(this.skillTriggers)) {
      const hasMatch = config.keywords.some(keyword => 
        queryLower.includes(keyword.toLowerCase())
      )
      if (hasMatch) {
        matched.push(config.path)
        console.log(`[LocalClaw] JIT: 关键词匹配技能 ${skillName}`)
      }
    }
    
    return matched
  }

  /**
   * 提取 SOUL.md 摘要 (精简版)
   */
  private extractSoulSummary(soulContent: string): string {
    const lines = soulContent.split('\n')
    const summaryLines: string[] = []
    let inCoreSection = false
    let lineCount = 0
    const maxLines = 15 // 最多15行

    for (const line of lines) {
      if (lineCount >= maxLines) break
      
      // 提取标题和核心原则
      if (line.startsWith('# ') || line.startsWith('## Core') || line.startsWith('## 核心')) {
        inCoreSection = true
        summaryLines.push(line)
        lineCount++
      } else if (inCoreSection && line.trim()) {
        if (line.startsWith('## ')) {
          inCoreSection = false
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

  /**
   * 提取技能的核心用法和示例部分
   */
  private extractSkillUsage(skillContent: string): string {
    const lines = skillContent.split('\n')
    const resultLines: string[] = []
    let inRelevantSection = false
    let lineCount = 0
    const maxLines = 40 // 增大以容纳思维链示例

    for (const line of lines) {
      if (lineCount >= maxLines) break

      // 捕获 Usage 和 Examples 两个关键部分
      if (line.includes('## Usage') || line.includes('## 用法') || 
          line.includes('## Examples') || line.includes('## 示例')) {
        inRelevantSection = true
        resultLines.push(line)
        lineCount++
        continue
      }
      
      if (inRelevantSection) {
        // 遇到 Notes/Safety/其他无关节时停止
        if (line.startsWith('## ') && 
            !line.includes('Usage') && !line.includes('Examples') && 
            !line.includes('用法') && !line.includes('示例')) {
          inRelevantSection = false
          continue
        }
        resultLines.push(line)
        lineCount++
      }
    }

    // 如果没找到相关部分，取前30行
    if (resultLines.length === 0) {
      return lines.slice(0, 30).join('\n')
    }

    return resultLines.join('\n').trim()
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

    // 重新加载工具和技能列表
    await this.loadTools()
    await this.loadAllDataToStore()

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

    // 重新加载工具和技能列表
    await this.loadTools()
    await this.loadAllDataToStore()
  }

  // ============================================
  // 🌟 入口方法
  // ============================================

  /**
   * 发送简单消息 (ReAct 模式)
   * @param nexusId 可选的 Nexus ID，用于注入 SOP 上下文
   */
  async sendMessage(
    prompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    nexusId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    if (!isLLMConfigured()) {
      throw new Error('LLM 未配置。请在设置中配置 API Key。')
    }

    // 清空上次执行的文件创建记录
    this._lastCreatedFiles = []

    // P4: Nexus 触发器匹配 - 自动激活匹配的 Nexus (仅当未指定 nexusId 时)
    const effectiveNexusId = nexusId ?? this.getActiveNexusId()
    if (!effectiveNexusId) {
      const matchedNexus = nexusManager.matchForTask(prompt)
      if (matchedNexus) {
        this.storeActions?.setActiveNexus?.(matchedNexus.id)
        console.log(`[LocalClaw] Auto-activated Nexus by trigger: ${matchedNexus.id}`)
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

    // 确定最终使用的 nexusId
    const finalNexusId = nexusId ?? this.getActiveNexusId()

    try {
      const result = await this.runReActLoop(prompt, onUpdate, onStep, finalNexusId, onCheckpoint, signal, conversationHistory)
      
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

    // 设置当前任务上下文
    this.storeActions?.setCurrentTask(execId, `恢复: ${checkpoint.userPrompt.slice(0, 50)}`)

    try {
      const result = await this.runReActLoop(
        resumePrompt,
        onUpdate,
        onStep,
        checkpoint.nexusId,
        onCheckpoint
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
   * @param nexusId 可选的 Nexus ID，用于注入 Nexus 上下文
   */
  private async runReActLoop(
    userPrompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    nexusId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    return this.runReActLoopFC(userPrompt, onUpdate, onStep, nexusId, onCheckpoint, signal, conversationHistory)
  }

  // ============================================
  // 🚀 ReAct 循环 - Function Calling 模式
  // ============================================

  /**
   * ReAct 循环 - 原生 Function Calling 模式
   * 使用 OpenAI-compatible tools API 实现工具调用
   * @param nexusId 可选的 Nexus ID，用于注入 SOP 上下文
   */
  private async runReActLoopFC(
    userPrompt: string,
    onUpdate?: (content: string) => void,
    onStep?: (step: ExecutionStep) => void,
    nexusId?: string | null,
    onCheckpoint?: (checkpoint: TaskCheckpoint) => void,
    signal?: AbortSignal,
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
  ): Promise<string> {
    this.storeActions?.setAgentStatus('thinking')
    this._verificationCache.clear()

    // V2: 初始化 EventBus run
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const runStartTime = Date.now()
    const currentLLMModel = (window as any).__ddos_llm_model || 'unknown'
    agentEventBus.startRun(runId, currentLLMModel, nexusId || undefined)

    // 复杂度感知轮次分配
    const isSimpleTask = userPrompt.length < 20 && 
      !userPrompt.match(/代码|编写|创建|修复|分析|部署|配置|脚本|搜索|安装|下载|code|create|fix|analyze|search|install/)
    const isHeavyTask = userPrompt.length > 80 ||
      !!userPrompt.match(/并且|然后|之后|同时|自动|批量|全部|and then|also|batch/)
    const maxTurns = isSimpleTask ? CONFIG.SIMPLE_TURNS : isHeavyTask ? CONFIG.MAX_REACT_TURNS : CONFIG.DEFAULT_TURNS
    console.log(`[LocalClaw/FC] Task complexity: ${isSimpleTask ? 'simple' : isHeavyTask ? 'heavy' : 'normal'}, maxTurns: ${maxTurns}`)

    // 🎯 Nexus 驱动：为当前任务准备精准工具集
    const { tools: taskTools, matchedNexus, isFiltered } = nexusManager.prepareToolsForTask(userPrompt)
    let currentTaskTools = taskTools

    // V2: Phase 1 - 初始化 ContextEngine (可插拔的上下文管理器)
    const engineNexusId = nexusId || this.getActiveNexusId() || 'default'
    const contextEngine = contextEngineRegistry.getOrCreate(engineNexusId, () =>
      new DefaultNexusContextEngine({
        nexusId: engineNexusId,
        nexusLabel: matchedNexus?.label || engineNexusId,
        getContext: async (query: string) => (await this.buildDynamicContext(query, nexusId)).context,
        getSystemPrompt: () => SYSTEM_PROMPT_FC,
        getConversationHistory: () =>
          (conversationHistory || []).map((m, i) => ({
            id: `hist-${i}`,
            role: m.role,
            content: m.content,
            timestamp: Date.now(),
          })),
      })
    )

    // JIT: 动态构建上下文 (传入 nexusId 注入 SOP)
    const { context: dynamicContext } = await this.buildDynamicContext(userPrompt, nexusId)

    // 构建精简系统提示词 (FC 模式无需工具文档)
    const soulSummary = this.soulContent ? this.extractSoulSummary(this.soulContent) : ''
    const systemPrompt = SYSTEM_PROMPT_FC
      .replace('{soul_summary}', soulSummary || '一个友好、专业的 AI 助手')
      .replace('{context}', dynamicContext)

    // V2: 估算系统提示 token 数并上报
    const systemTokens = estimateTokens(systemPrompt)
    console.log(`[LocalClaw/FC] System prompt tokens: ~${systemTokens}`)

    // 转换工具为 OpenAI Function Calling 格式
    let tools = convertToolInfoToFunctions(currentTaskTools)
    console.log(`[LocalClaw/FC] Registered ${tools.length} functions${isFiltered ? ` (filtered for Nexus: ${matchedNexus?.label})` : ''}`)

    // 消息历史 (使用标准 OpenAI 格式)
    // 注入最近对话历史，让模型了解前几轮的上下文
    const messages: SimpleChatMessage[] = [
      { role: 'system', content: systemPrompt },
    ]

    // 注入会话历史 (最近几轮对话摘要，让模型理解上下文)
    if (conversationHistory && conversationHistory.length > 0) {
      // 取最近 MAX_HISTORY_TURNS 轮对话，避免上下文膨胀
      const MAX_HISTORY_TURNS = 6  // 最近3轮 user+assistant = 6条
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
    
    // 🔄 升级机制状态
    let currentMaxTurns = maxTurns
    let escalationCount = 0
    let needEscalation = false

    // P2: 执行追踪收集
    const traceTools: ExecTraceToolCall[] = []
    const traceStartTime = Date.now()
    const TOKEN_BUDGET = 128000

    // 🧬 Gene Pool: 懒加载基因库
    await genePoolService.ensureLoaded()

    // 外层升级循环
    do {
      needEscalation = false
      
      // 主循环
      while (turnCount < currentMaxTurns) {
        // 🛑 终止检查: 每轮开始前检查是否已被用户终止
        if (signal?.aborted) {
          console.log(`[LocalClaw/FC] Aborted by user at turn ${turnCount}`)
          finalResponse = finalResponse || lastToolResult || '任务已被用户终止。'
          break
        }

        turnCount++
        console.log(`[LocalClaw/FC] Turn ${turnCount}`)

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

          // 调用 LLM (带 tools 参数)
          let streamedContent = ''
          agentEventBus.messageStart()
        const result: LLMStreamResult = await streamChat(
          messages,
          (chunk) => {
            streamedContent += chunk
            onUpdate?.(streamedContent)
            agentEventBus.textDelta(chunk, streamedContent)
          },
          signal, // 传入 AbortSignal，终止时中断 fetch
          undefined, // config
          tools
        )

        let { content, toolCalls, finishReason, reasoningContent } = result
        agentEventBus.messageEnd(content || '')
        console.log(`[LocalClaw/FC] finish_reason: ${finishReason}, toolCalls: ${toolCalls.length}`)

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

            // 发送思考步骤 (优先用 reasoningContent，其次用 content)
            const thinkingText = reasoningContent || content
            if (thinkingText) {
              onStep?.({
                id: `think-${Date.now()}`,
                type: 'thinking',
                content: thinkingText.slice(0, 2000),
                timestamp: Date.now(),
              })
            }

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
                  const recentL1Ids = confidenceTracker.getEntriesByNexus(this.getActiveNexusId() || '').slice(-3).map(e => e.id)
                  for (const id of recentL1Ids) {
                    confidenceTracker.addHumanFeedback(id, false)
                  }

                  continue
                }

                // V3: 审批通过 → 人类正面反馈信号
                const approvedL1Ids = confidenceTracker.getEntriesByNexus(this.getActiveNexusId() || '').slice(-3).map(e => e.id)
                for (const id of approvedL1Ids) {
                  confidenceTracker.addHumanFeedback(id, true)
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
            const toolResult = await this.executeTool({ name: toolName, args: toolArgs })
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
            traceTools.push({
              name: toolName,
              args: toolArgs,
              status: toolResult.status === 'error' ? 'error' : 'success',
              result: toolResult.result,
              latency: toolLatency,
              order: traceTools.length + 1,
            })

            // Layer 4: 缓存验证结果
            if (toolResult.verification) {
              this._verificationCache.set(`${toolName}:${traceTools.length}`, toolResult.verification)
            }

            lastToolResult = toolResult.result

            // 🔄 优化1+3: 实时规则评估 (每次工具执行后立即检查)
            {
              const realtimeNexusId = nexusId || this.getActiveNexusId()
              if (realtimeNexusId) {
                // 统计当前工具的连续错误次数
                const recentErrors: { tool: string; count: number }[] = []
                let consecutiveForTool = 0
                for (let k = traceTools.length - 1; k >= 0; k--) {
                  if (traceTools[k].name === toolName && traceTools[k].status === 'error') {
                    consecutiveForTool++
                  } else if (traceTools[k].name === toolName) {
                    break
                  }
                }
                if (consecutiveForTool > 0) {
                  recentErrors.push({ tool: toolName, count: consecutiveForTool })
                }

                const realtimeRule = nexusRuleEngine.evaluateRealtimeAfterTool(
                  realtimeNexusId,
                  toolName,
                  toolResult.status === 'error' ? 'error' : 'success',
                  recentErrors,
                )
                if (realtimeRule) {
                  console.log(`[LocalClaw/FC] Realtime rule activated: ${realtimeRule.type}`)
                }
              }
            }

            // 💾 保存 checkpoint（每次工具执行后，无论成功失败）
            if (onCheckpoint) {
              const checkpoint: TaskCheckpoint = {
                stepIndex: traceTools.length,
                savedAt: Date.now(),
                userPrompt,
                nexusId: nexusId || undefined,
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
              
              // 🧬 能力缺失检测
              this.detectAndRecordCapabilityGap(toolName, toolResult.result, userPrompt)

              // V2: Reflexion 开始事件
              agentEventBus.reflexionStart(toolName, toolResult.result.slice(0, 500))

              // 🎯 Layer 3: 运行时动态扩展 - 工具不足时自动补充
              if (isFiltered) {
                const expanded = nexusManager.expandToolsForReflexion(currentTaskTools, toolName, toolResult.result)
                if (expanded) {
                  currentTaskTools = expanded
                  tools = convertToolInfoToFunctions(currentTaskTools)
                  console.log(`[NexusRouter/FC] Expanded toolset to ${tools.length} after "${toolName}" missing`)
                }
                // 连续失败 2+ 次且仍在过滤模式 → 解锁全量工具
                if (consecutiveFailures >= 2 && currentTaskTools.length < this.availableTools.length) {
                  currentTaskTools = this.availableTools
                  tools = convertToolInfoToFunctions(currentTaskTools)
                  console.log(`[NexusRouter/FC] Safety unlock: full toolset (${tools.length}) after ${consecutiveFailures} failures`)
                }
              }
              
              // 🛡️ 错误签名追踪: 检测重复错误防止死循环
              const errorSig = `${toolName}:${toolResult.result.slice(0, 100)}`
              errorSignatureHistory.push(errorSig)
              const repeatCount = errorSignatureHistory.filter(e => e === errorSig).length
              
              if (repeatCount >= 2) {
                // 🚨 危机干预: 相同错误已出现2+次, 强制策略变更
                // 🧬 Gene Pool: 查找历史修复经验
                const crisisGeneMatches = genePoolService.findCrossNexusGenes(toolName, toolResult.result, this.getActiveNexusId() || undefined)
                const crisisGeneHint = genePoolService.buildGeneHint(crisisGeneMatches)

                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolResult.result + `

[CRITICAL - 重复错误检测]
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
                const nexusSkillCtxFC = nexusManager.buildSkillContext()
                // 🧬 Gene Pool: 查找历史修复经验
                const reflexionGeneMatches = genePoolService.findCrossNexusGenes(toolName, toolResult.result, this.getActiveNexusId() || undefined)
                const reflexionGeneHint = genePoolService.buildGeneHint(reflexionGeneMatches)

                const reflexionHint = `

[系统提示 - Reflexion 反思机制]
工具执行失败。在下一步操作前，请先进行结构化反思：
1. **根本原因**: 是路径错误？参数错误？权限问题？工具不支持？
2. **修正方案**: 如何调整参数或换用其他工具/方法？
3. **预防措施**: 如何避免再次出错？${nexusSkillCtxFC ? `
4. **技能充足性**: 当前 Nexus 的技能是否足以完成任务？如果缺少必要技能，可使用 nexusBindSkill 添加；如果某技能不适用，可使用 nexusUnbindSkill 移除。${nexusSkillCtxFC}` : ''}

请根据反思结果调整你的下一步操作。` + reflexionGeneHint
              
                // 将反思提示追加到工具结果中
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolResult.result + reflexionHint,
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

              // V3: 工具失败 → 系统失败信号
              const failNexusId = nexusId || this.getActiveNexusId()
              if (failNexusId) {
                const recentL1 = confidenceTracker.getEntriesByNexus(failNexusId).slice(-1)
                for (const entry of recentL1) {
                  confidenceTracker.addFailureSignal(entry.id)
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
              
              // 🔍 Critic 自检: 修改类工具成功后触发验证
              const needsCritic = CONFIG.CRITIC_TOOLS.includes(toolName)
              
              if (needsCritic) {
                const nexusSkillCtxFCCritic = nexusManager.buildSkillContext()
                const recentToolNamesFC = traceTools.slice(-5).map(t => t.name).join(', ')

                // 构建 Nexus 验收标准上下文
                let fcAcceptanceCriteria = ''
                const fcCriticNexusId = nexusId || this.getActiveNexusId()
                if (fcCriticNexusId) {
                  const nexuses = (this.storeActions as any)?.nexuses as Map<string, NexusEntity> | undefined
                  const nexus = nexuses?.get(fcCriticNexusId)
                  if (nexus?.objective) {
                    fcAcceptanceCriteria += `\n目标: ${nexus.objective}`
                  }
                  if (nexus?.metrics?.length) {
                    fcAcceptanceCriteria += `\n验收检查点:\n${nexus.metrics.map((m: string, i: number) => `${i + 1}. ${m}`).join('\n')}`
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
${fcAcceptanceCriteria ? '3. 逐条检查验收标准是否已满足\n' : ''}${nexusSkillCtxFCCritic ? `${fcAcceptanceCriteria ? '4' : '3'}. **技能优化**: 本次使用了 [${recentToolNamesFC}]。当前 Nexus 是否有未使用的冗余技能？是否需要新技能？${nexusSkillCtxFCCritic}\n` : ''}
如果满足需求，继续下一步或给出最终回复。如果发现问题，自行修正。`
                
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolResult.result + criticHint,
                  name: toolName,
                })
                
                this.storeActions?.addLog({
                  id: `critic-${Date.now()}`,
                  timestamp: Date.now(),
                  level: 'info',
                  message: `[Critic] 验证 ${toolName} 执行结果`,
                })

                // V3: Critic 验证通过 → 环境正面信号 (修改类工具执行成功)
                const criticNexusId = nexusId || this.getActiveNexusId()
                if (criticNexusId) {
                  const recentL1 = confidenceTracker.getEntriesByNexus(criticNexusId).slice(-1)
                  for (const entry of recentL1) {
                    confidenceTracker.addEnvironmentSignal(entry.id, true)
                  }
                }
              } else {
                // 非修改类工具：直接添加结果
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  content: toolResult.result,
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
                    
                    // 🧬 Phase 4: 注册产出物基因 (让其他 Nexus 能发现)
                    const currentNexusId = this.getActiveNexusId()
                    if (currentNexusId) {
                      const pathStr = String(toolArgs.path || '')
                      const ext = pathStr.split('.').pop()?.toLowerCase() || ''
                      const typeMap: Record<string, string> = {
                        md: 'document', txt: 'text', json: 'data',
                        ts: 'code', js: 'code', py: 'code',
                        pptx: 'presentation', docx: 'document', pdf: 'document',
                        png: 'image', jpg: 'image', svg: 'image',
                      }
                      genePoolService.registerArtifact({
                        nexusId: currentNexusId,
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
              String(toolArgs.path || '').replace(/\\/g, '/').includes('skills/'))) {
              try {
                await this.loadTools()
                await this.loadAllDataToStore()
                console.log('[LocalClaw/FC] Tools & skills refreshed mid-loop')
              } catch {
                console.warn('[LocalClaw/FC] Failed to refresh tools mid-loop')
              }
            }

            // 🌌 Nexus 技能绑定变更检测 (FC 模式)
            if ((toolName === 'nexusBindSkill' || toolName === 'nexusUnbindSkill') &&
                toolResult.status === 'success') {
              try {
                await this.loadAllDataToStore()
                console.log('[LocalClaw/FC] Nexus skills refreshed after self-adaptation')
              } catch {
                console.warn('[LocalClaw/FC] Failed to refresh nexuses after skill adaptation')
              }
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

          this.storeActions?.setAgentStatus('thinking')
          agentEventBus.changePhase('planning', `Turn ${turnCount} tools complete, re-thinking`)

          // Phase 1: ContextEngine.afterTurn() - 每轮工具执行后的 bookkeeping
          const turnToolSummaries: import('@/types').ToolCallSummary[] = toolCalls.map(tc => {
            const matched = traceTools.find(t => t.order === traceTools.length - toolCalls.length + toolCalls.indexOf(tc) + 1)
            const isMutating = CONFIG.CRITIC_TOOLS.includes(tc.function.name)
            return {
              callId: tc.id,
              toolName: tc.function.name,
              args: JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
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
            (window as any).__ddos_llm_model = newModel
            console.log(`[LocalClaw/FC] Model switched to: ${newModel}`)
          },
          onCompactNeeded: async () => {
            const tokenCount = messages.reduce((sum, m) => sum + estimateTokens(typeof m.content === 'string' ? m.content : '') + 4, 0)
            const result = await contextEngine.compact({
              sessionId: runId,
              tokenBudget: TOKEN_BUDGET,
              trigger: 'overflow',
              currentTokenCount: tokenCount,
            })
            return result.compacted
          },
        })

        if (recoveryResult.shouldRetry) {
          console.log(`[LocalClaw/FC] Recovery: ${recoveryResult.strategy}, retrying...`)
          continue // 继续 while 循环重试
        }

        // 不可恢复的错误
        agentEventBus.changePhase('error', error.message)
        if (recoveryResult.needsUserAction && recoveryResult.userMessage) {
          finalResponse = `${recoveryResult.userMessage}`
        } else {
          finalResponse = `执行出错: ${error.message}`
        }
        break
      }
    }

    this.storeActions?.setAgentStatus('idle')

    // V2: 发出 run_end 事件 (在 trace 保存前，计算最终统计)
    const runDurationMs = Date.now() - runStartTime
    const totalToolsCalled = traceTools.length
    const runSuccess = traceTools.length === 0 || traceTools.some(t => t.status === 'success')
    let finalScoreChange = 0

    // P2: 保存执行追踪 (含 Observer 元数据)
    // 优先使用传入的 nexusId (来自 Nexus 会话)，fallback 到全局 activeNexusId
    const activeNexusId = nexusId || this.getActiveNexusId()
    if (traceTools.length > 0) {
      const errorCount = traceTools.filter(t => t.status === 'error').length
      
      const trace: ExecTrace = {
        id: `trace-${traceStartTime}`,
        task: userPrompt.slice(0, 200),
        tools: traceTools,
        success: traceTools.every(t => t.status === 'success'),
        duration: Date.now() - traceStartTime,
        timestamp: traceStartTime,
        tags: userPrompt.split(/\s+/).filter(w => w.length > 2 && w.length < 15).slice(0, 5),
        // Observer 元数据
        turnCount,
        errorCount,
        skillIds: [],
        activeNexusId: activeNexusId || undefined,
      }

      // 先保存 trace，成功后再更新 stats，保证两者一致
      let traceSaved = false
      try {
        await this.saveExecTrace(trace)
        traceSaved = true
      } catch (err) {
        console.warn('[LocalClaw/FC] Failed to save exec trace:', err)
      }

      // 📊 记录 Nexus 性能统计 (仅在 trace 保存成功时更新，保持一致性)
      if (traceSaved) {
        nexusManager.recordPerformance(trace)
      }

      // 🧬 Gene Pool: 自动收割基因 (Phase 2 - 检测 error→success 修复模式)
      genePoolService.harvestGene(traceTools, userPrompt, activeNexusId || undefined)

      console.log(`[LocalClaw/FC] afterTurn: ${traceTools.length} tools, ${errorCount} errors, duration ${Date.now() - traceStartTime}ms`)

      // P4: Nexus 经验记录 (有工具调用时)
      if (activeNexusId) {
        const success = traceTools.every(t => t.status === 'success')
        nexusManager.recordExperience(
          activeNexusId,
          userPrompt,
          traceTools.map(t => t.name),
          success,
          finalResponse || ''
        ).catch(err => {
          console.warn('[LocalClaw/FC] Failed to record Nexus experience:', err)
        })

        // 🧬 Phase 4: 记录活动基因 (让其他 Nexus 能发现这个 Nexus 做了什么)
        const nexuses = (this.storeActions as any)?.nexuses as Map<string, NexusEntity> | undefined
        const nexusName = nexuses?.get(activeNexusId)?.label || activeNexusId
        const successCount = traceTools.filter(t => t.status === 'success').length
        const artifactsCreated = this._lastCreatedFiles.map(f => f.fileName).filter(Boolean)
        genePoolService.recordActivity({
          nexusId: activeNexusId,
          nexusName,
          summary: userPrompt.slice(0, 100) + (userPrompt.length > 100 ? '...' : ''),
          toolsUsed: [...new Set(traceTools.map(t => t.name))],
          artifactsCreated,
          duration: traceTools.reduce((sum, t) => sum + t.latency, 0),
          status: successCount > 0 ? 'success' : 'failed',
        })

        // Phase 3: NexusScoring - 使用 ExecTrace 驱动评分更新
        try {
          const { scoring, scoreChange } = nexusScoringService.updateFromTrace(activeNexusId, trace, finalResponse)
          finalScoreChange = scoreChange
          console.log(`[LocalClaw/FC] NexusScoring updated: ${activeNexusId} scoreChange=${scoreChange > 0 ? '+' : ''}${scoreChange}`)

          // 写回 Zustand Store，让 Dashboard / HoverCard 等组件即时反映
          this.storeActions?.updateNexusScoring?.(activeNexusId, scoring)

          // 持久化评分到后端
          nexusScoringService.saveToServer(activeNexusId, this.serverUrl).catch(err => {
            console.warn('[LocalClaw/FC] Failed to persist scoring:', err)
          })
        } catch (scoringErr) {
          console.warn('[LocalClaw/FC] NexusScoring update failed:', scoringErr)
        }

        // Phase 5: 将执行追踪写入 memoryStore (持久化到 SQLite)
        memoryStore.write({
          source: 'exec_trace',
          content: `Task: ${userPrompt.slice(0, 200)}\nTools: ${traceTools.map(t => `${t.name}(${t.status})`).join(', ')}\nDuration: ${trace.duration}ms\nSuccess: ${trace.success}`,
          nexusId: activeNexusId,
          tags: trace.tags,
          metadata: { traceId: trace.id, turnCount, toolCount: traceTools.length, success: trace.success },
        }).catch(err => console.warn('[LocalClaw/FC] memoryStore.write trace failed:', err))

        // V3: ConfidenceTracker - 批量追踪工具结果 + 评估 L1→L0 晋升
        if (activeNexusId) {
          // 1. 为本次执行的工具结果创建追踪条目并添加初始信号
          const trackedToolResults = traceTools.map((t, idx) => ({
            callId: `${trace.id}-${idx}`,
            toolName: t.name,
            status: t.status as 'success' | 'error',
            result: t.result,
          }))
          confidenceTracker.trackToolResults(activeNexusId, trackedToolResults)

          // 2. 评估是否有可晋升到 L0 的记忆
          const promotable = confidenceTracker.evaluatePromotions(activeNexusId)
          if (promotable.length > 0) {
            confidenceTracker.promoteToL0(promotable).then(count => {
              if (count > 0) {
                console.log(`[LocalClaw/FC] Promoted ${count} L1 memories to L0 for Nexus ${activeNexusId}`)
              }
            }).catch(err => {
              console.warn('[LocalClaw/FC] L1→L0 promotion failed:', err)
            })
          }
        }
      }
    }

    // P4: Nexus 经验记录 (无工具调用时也记录 — 纯文字交互也是 Nexus 使用)
    if (activeNexusId && traceTools.length === 0 && finalResponse) {
      nexusManager.recordExperience(
        activeNexusId,
        userPrompt,
        [],
        true,
        finalResponse
      ).catch(err => {
        console.warn('[LocalClaw/FC] Failed to record Nexus text experience:', err)
      })
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

    // 🔍 任务完成度验证 - 当没有最终响应或达到最大轮次时触发
    if (!finalResponse && traceTools.length > 0) {
      console.log('[LocalClaw/FC] No final response, validating task completion...')
      
      try {
        const validation = await this.validateTaskCompletion(userPrompt, traceTools, lastToolResult)
        
        // 🔄 升级机制：任务未完成且未达升级上限时，继续执行
        if (CONFIG.ESCALATION.ENABLED && 
            !validation.completed && 
            validation.completionRate < CONFIG.ESCALATION.MIN_COMPLETION_FOR_SKIP &&
            escalationCount < CONFIG.ESCALATION.MAX_ESCALATIONS) {
          
          escalationCount++
          currentMaxTurns += CONFIG.ESCALATION.EXTRA_TURNS
          
          console.log(`[LocalClaw/FC] 🔄 Task escalation #${escalationCount}: extending to ${currentMaxTurns} turns`)
          
          // 添加升级提示到消息历史
          messages.push({
            role: 'user',
            content: `[系统提示] 任务尚未完成 (完成度: ${Math.round(validation.completionRate)}%)。
待完成: ${validation.pendingSteps.join(', ') || '继续执行'}
原因: ${validation.failureReason || '未能达成目标'}

请继续执行任务，确保完成用户的原始请求。`,
          })
          
          this.storeActions?.addLog({
            id: `escalation-${Date.now()}`,
            timestamp: Date.now(),
            level: 'warn',
            message: `[升级] 任务未完成，扩展轮次 (+${CONFIG.ESCALATION.EXTRA_TURNS})，当前 ${escalationCount}/${CONFIG.ESCALATION.MAX_ESCALATIONS}`,
          })
          
          // 标记需要升级继续执行
          needEscalation = true
        }
        
        if (!needEscalation) {
          // 返回验证结果
          return this.formatTaskResult(validation, userPrompt, turnCount, currentMaxTurns)
        }
      } catch (validationError) {
        console.warn('[LocalClaw/FC] Task validation failed, using fallback:', validationError)
        
        // 降级：简单的工具调用总结
        const toolNames = traceTools.map(t => t.name).join('、')
        const successCount = traceTools.filter(t => t.status === 'success').length
        const failCount = traceTools.filter(t => t.status === 'error').length
        
        if (failCount > 0 || /Exit Code: (?!0)\d+/.test(lastToolResult)) {
          return `❌ **任务未能成功完成**\n\n**执行概要:**\n- 调用工具: ${toolNames}\n- 成功: ${successCount} / 失败: ${failCount}\n- 执行轮次: ${turnCount}/${currentMaxTurns}\n\n**说明:** 部分操作失败。请检查错误信息并重试，或提供更具体的指令。`
        }
        
        return `⚠️ **任务执行中断**\n\n**执行概要:**\n- 调用工具: ${toolNames}\n- 执行轮次: ${turnCount}/${currentMaxTurns}\n\n**说明:** AI 在工具调用后未能继续完成任务。请尝试更具体地描述你想要完成的目标。`
      }
    }
    } while (needEscalation && !signal?.aborted)
    
    return finalResponse || '任务执行完成，但未生成总结。'
  }

  // ============================================
  // 📋 任务规划器
  // ============================================

  private async generatePlan(prompt: string): Promise<PlanStep[]> {
    const plannerPrompt = PLANNER_PROMPT.replace('{prompt}', prompt)

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

      const reviewPrompt = PLAN_REVIEW_PROMPT
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
    registeredTools: Array<{ type: 'function'; function: { name: string } }>
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
          if (tool && (tool.function as any).parameters?.properties) {
            const firstParam = Object.keys((tool.function as any).parameters.properties)[0]
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

    // 🎯 获取 Nexus 目标函数验收标准 (如果有)
    let nexusMetricsSection = ''
    const activeNexusId = this.getActiveNexusId()
    if (activeNexusId) {
      const nexuses: Map<string, NexusEntity> | undefined = (this.storeActions as any)?.nexuses
      const nexus = nexuses?.get(activeNexusId)
      if (nexus?.objective && nexus.metrics && nexus.metrics.length > 0) {
        nexusMetricsSection = `
**Nexus 目标函数验收标准:**
目标: ${nexus.objective}
验收检查点:
${nexus.metrics.map((m, i) => `${i + 1}. ${m}`).join('\n')}

请逐一评估每个检查点是否满足，并在输出的 metricsStatus 字段中说明。
`
      }
    }
    // 无 Nexus 时补充通用验收提示
    if (!nexusMetricsSection) {
      nexusMetricsSection = `
**通用验收标准:**
- 工具调用成功 ≠ 任务完成，需要有证据证明操作的实际效果
- 如文件操作后需确认文件存在/内容正确，命令执行后需确认输出符合预期
`
    }

    const prompt = TASK_COMPLETION_PROMPT
      .replace('{user_prompt}', userPrompt)
      .replace('{execution_log}', (executionLog || '无工具调用') + lastResultSummary + verificationSummary)
      .replace('{tool_count}', String(traceTools.length))
      .replace('{success_count}', String(successCount))
      .replace('{fail_count}', String(failCount))
      .replace('{nexus_metrics_section}', nexusMetricsSection)

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
  private async saveExecTrace(trace: ExecTrace): Promise<void> {
    try {
      const res = await fetch(`${this.serverUrl}/api/traces/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trace),
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

  async executeTool(tool: ToolCall, _retryCount = 0): Promise<ToolResult> {
    // 旁路统计：记录调用
    skillStatsService.recordCall(tool.name)
    
    // 可重试的网络错误模式
    const RETRYABLE_PATTERNS = ['timeout', 'ECONNREFUSED', 'fetch failed', 'ECONNRESET', 'aborted']
    const MAX_TOOL_RETRIES = 2
    
    // 数字免疫系统自愈上下文
    const executeWithHealing = async (): Promise<ToolResult> => {
      try {
        const response = await fetch(`${this.serverUrl}/api/tools/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: tool.name, args: tool.args }),
          signal: AbortSignal.timeout(CONFIG.TOOL_TIMEOUT),
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
        
        return result
      } catch (error: any) {
        const errorMessage = error.message || String(error)
        
        // 数字免疫系统：匹配失败签名
        const matchResult = immuneService.matchFailure(errorMessage)
        
        if (matchResult && matchResult.healingScript) {
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
            
            return executeWithHealing()
          }
          
          return {
            tool: tool.name,
            status: 'error',
            result: `${healingResult.message}\n原始错误: ${errorMessage}`,
          }
        }
        
        // 旁路统计：记录失败
        skillStatsService.recordResult(tool.name, false)
        
        // 🔄 网络错误自动重试（指数退避）
        if (_retryCount < MAX_TOOL_RETRIES && RETRYABLE_PATTERNS.some(p => errorMessage.toLowerCase().includes(p))) {
          const backoffMs = 1000 * Math.pow(2, _retryCount)
          console.log(`[LocalClaw] Tool ${tool.name} failed with retryable error, retry ${_retryCount + 1}/${MAX_TOOL_RETRIES} after ${backoffMs}ms`)
          await new Promise(resolve => setTimeout(resolve, backoffMs))
          return this.executeTool(tool, _retryCount + 1)
        }
        
        return {
          tool: tool.name,
          status: 'error',
          result: `工具执行失败: ${errorMessage}`,
        }
      }
    }
    
    const result = await executeWithHealing()

    // V3: FileRegistry 自动注册/清理
    const FILE_OPS = FILE_REGISTRY_CONFIG.FILE_OPS as readonly string[]
    if (FILE_OPS.includes(tool.name)) {
      const toolPath = tool.args.path as string | undefined
      if (toolPath) {
        if (result.status === 'success') {
          fileRegistry.register(toolPath, tool.name, this.getActiveNexusId())
        } else {
          fileRegistry.handleToolError(toolPath, result.result)
        }
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

}

// 导出单例
export const localClawService = new LocalClawService()
