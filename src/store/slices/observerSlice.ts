import type { StateCreator } from 'zustand'
import type { 
  BehaviorRecord, 
  TriggerPattern, 
  BuildProposal, 
  VisualDNA,
  ExecTrace
} from '@/types'
import { chat, getLLMConfig } from '@/services/llmService'
import { localServerService } from '@/services/localServerService'

// ============================================
// 常量配置 - 双引擎阈值
// ============================================

const BEHAVIOR_WINDOW_SIZE = 50        // 保留最近 N 条行为记录
const ANALYSIS_COOLDOWN_MS = 60000     // 分析冷却 (60秒，原 20秒)
const CONFIDENCE_THRESHOLD = 0.5       // 触发置信度阈值 (原 0.6)
const REJECTION_COOLDOWN_MS = 300000   // 拒绝后冷却 5 分钟
const OBSERVER_DATA_KEY = 'observer_behavior_records'  // 后端持久化 key
const OBSERVER_FLUSH_DEBOUNCE = 10000  // 持久化防抖 10 秒

// 规则引擎阈值
const RULE_ENGINE = {
  FREQUENCY_THRESHOLD: 5,         // 同一工具调用 5+ 次触发 (原 3)
  FREQUENCY_DAYS: 7,              // 在 7 天内 (原 3)
  COMPLEXITY_TURNS: 10,           // 单次执行超过 10 轮视为复杂 (原 8)
  DEPENDENCY_MIN_OCCURRENCES: 3,  // 工具链出现 3+ 次 (原 2)
  MIN_TRACES_FOR_ANALYSIS: 5,     // 至少 5 条执行记录才分析 (原 3)
}

// 后端 API
import { getServerUrl } from '@/utils/env'
const SERVER_URL = getServerUrl()

// ============================================
// Slice 类型定义
// ============================================

interface TraceStats {
  totalExecutions: number
  toolFrequency: Record<string, number>
  nexusFrequency: Record<string, number>
  avgTurnsPerExecution: number
  totalErrors: number
  timeRangeDays: number
}

export interface ObserverSlice {
  // State
  behaviorRecords: BehaviorRecord[]
  currentProposal: BuildProposal | null
  lastAnalysisTime: number
  isAnalyzing: boolean
  nexusPanelOpen: boolean
  selectedNexusForPanel: string | null
  pendingNexusChatInput: string | null  // 预填的 Nexus 对话输入
  // 双引擎状态
  lastRuleCheckTime: number
  cachedTraces: ExecTrace[]
  cachedStats: TraceStats | null
  // 去重状态
  rejectedPatterns: Map<string, number>  // pattern type → rejection time
  lastRejectionTime: number

  // Actions
  addBehaviorRecord: (record: Omit<BehaviorRecord, 'id' | 'timestamp' | 'keywords'>) => void
  loadBehaviorRecords: () => Promise<void>
  analyze: () => Promise<TriggerPattern | null>
  analyzeWithRuleEngine: () => Promise<TriggerPattern | null>
  analyzeWithLLM: (traces: ExecTrace[], stats: TraceStats) => Promise<TriggerPattern | null>
  fetchRecentTraces: () => Promise<{ traces: ExecTrace[]; stats: TraceStats } | null>
  createProposal: (trigger: TriggerPattern) => void
  acceptProposal: () => BuildProposal | null
  rejectProposal: () => void
  clearProposal: () => void
  checkDuplicateNexus: (suggestedSkills: string[]) => boolean
  
  // Panel Actions
  openNexusPanel: (nexusId: string) => void
  openNexusPanelWithInput: (nexusId: string, input: string) => void  // 打开面板并预填输入
  closeNexusPanel: () => void
  clearPendingInput: () => void  // 清除预填输入
  
  // Chat → Nexus (旧版，创建 Proposal)
  generateNexusFromChat: (messages: Array<{ role: string; content: string }>) => Promise<void>
  
  // Observer → Builder: 分析对话并返回结果供建构者使用
  analyzeConversationForBuilder: (messages: Array<{ role: string; content: string }>) => Promise<NexusAnalysisResult | null>
}

// Observer 分析结果类型（供 Builder 使用）
export interface NexusAnalysisResult {
  name: string
  description: string
  sopContent: string           // 完整 Markdown SOP
  confidence: number
  suggestedSkills: string[]    // 建议绑定的技能/工具
  tags: string[]               // 分类标签
  triggers: string[]           // 触发词（用户说什么会激活这个 Nexus）
  objective: string            // 核心目标
  metrics: string[]            // 质量指标
  strategy: string             // 执行策略
}

// ============================================
// 辅助函数
// ============================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Observer 持久化: 防抖 flush
let _observerFlushTimer: ReturnType<typeof setTimeout> | null = null
function scheduleObserverFlush(records: BehaviorRecord[]): void {
  if (_observerFlushTimer) clearTimeout(_observerFlushTimer)
  _observerFlushTimer = setTimeout(() => {
    _observerFlushTimer = null
    // 只持久化最近 BEHAVIOR_WINDOW_SIZE 条
    const toSave = records.slice(-BEHAVIOR_WINDOW_SIZE)
    localServerService.setData(OBSERVER_DATA_KEY, toSave).catch(() => {
      console.warn('[Observer] Failed to persist behavior records to backend')
    })
  }, OBSERVER_FLUSH_DEBOUNCE)
}

/**
 * 同步生成 VisualDNA（用于 Observer 快速创建 Proposal）
 * 注意：这是一个简化的同步版本，完整版本在 visualHash.ts 中
 */
function generateVisualDNASync(id: string): VisualDNA {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  const h = Math.abs(hash)
  
  const primaryHue = h % 360
  const geometryVariant = h % 4
  
  return {
    primaryHue,
    primarySaturation: 50 + (h >> 8) % 40,
    primaryLightness: 35 + (h >> 16) % 30,
    accentHue: (primaryHue + 60) % 360,
    textureMode: 'solid',
    glowIntensity: 0.5 + (h % 50) / 100,
    geometryVariant,
  }
}

/**
 * 提取工具调用序列作为"管道签名"
 */
function extractToolPipeline(trace: ExecTrace): string {
  return trace.tools.map(t => t.name).join('→')
}

/**
 * 根据触发类型和证据生成功能目标概述
 */
function generatePurposeSummary(trigger: TriggerPattern): string {
  // LLM 分析的第一条 evidence 通常是 summary，直接使用
  if (trigger.type === 'frequency' || trigger.type === 'complexity' || trigger.type === 'dependency') {
    // 从 evidence 中提取关键工具名
    const toolMatch = trigger.evidence[0]?.match(/工具\s*"?(\w+)"?/)
    const toolName = toolMatch?.[1]

    if (toolName) {
      return `将您频繁使用的 ${toolName} 等能力整合为专用执行节点，减少重复操作、提升效率。`
    }
    return '将检测到的行为模式固化为可复用的执行节点，提升操作效率。'
  }

  if (trigger.type === 'periodic') {
    return '将周期性重复任务固化为自动触发的执行节点，实现定时自动化。'
  }

  if (trigger.type === 'cross-skill') {
    const skills = trigger.suggestedSkills?.join('、') || '多项工具'
    return `将 ${skills} 的跨技能协作固化为一体化执行节点，实现多工具联动自动化。`
  }

  // fallback: LLM 分析可能在 evidence[0] 有 summary
  const llmSummary = trigger.evidence[0]
  if (llmSummary && !llmSummary.startsWith('建议名称:')) {
    return llmSummary
  }

  return '将检测到的行为模式固化为可复用的执行节点，提升操作效率。'
}

// ============================================
// 对话转 Nexus 提示词 (升级版 - 完整 Nexus 格式)
// ============================================

const CHAT_TO_NEXUS_PROMPT = `你是 DunCrew 的"提炼器"。分析用户与 AI 的对话记录，提炼出可复用的 Nexus（自动化执行节点）。

## Nexus 是什么
Nexus 是 DunCrew 的核心工作单元，类似于"专家角色+标准作业程序"的组合。每个 Nexus 应该：
- 有清晰的功能定位和适用场景
- 包含可执行的详细 SOP（标准作业程序）
- 绑定必要的工具/技能
- 有明确的触发条件和质量标准

## 分析维度
1. 用户在对话中试图完成什么任务？核心目标是什么？
2. 涉及哪些工具/技能？它们如何协作？
3. 工作流程是什么？有哪些关键步骤和注意事项？
4. 可以提炼出什么样的可复用模式？

## 返回格式
返回 JSON：
{
  "canCreate": true,
  "suggestedName": "2-6个中文字，体现功能用途。好的例子：'代码审查'、'漫改剧制作'、'文档整理'",
  "description": "一句话描述这个 Nexus 的核心功能和适用场景",
  "suggestedSkills": ["工具名1", "工具名2", "工具名3"],
  "tags": ["分类标签1", "分类标签2"],
  "triggers": ["触发词1", "触发词2", "触发词3"],
  "objective": "这个 Nexus 要达成的核心目标（一句话）",
  "metrics": ["质量指标1：具体标准", "质量指标2：具体标准"],
  "strategy": "执行策略概述（如何组织工作流程）",
  "sopContent": "## 完整的 Markdown 格式 SOP\\n\\n详细的标准作业程序，包含：\\n- 执行流程步骤\\n- 每步的具体操作说明\\n- 关键注意事项\\n- 质量检查点\\n- 常见问题处理\\n\\n至少300字，可以包含代码块、表格、列表等",
  "confidence": 0.1 ~ 1.0
}

## SOP 编写要求
sopContent 必须是详细可执行的操作指南，包含：
1. **流程概览**: 用列表或流程图描述整体步骤
2. **详细步骤**: 每个步骤的具体操作方法
3. **参数配置**: 相关配置项和推荐值
4. **质量标准**: 如何判断每步是否成功
5. **注意事项**: 常见陷阱和规避方法
6. **执行指令**: 当用户请求相关任务时，应该如何响应

## 如果对话不适合提炼
返回：{"canCreate": false, "reason": "原因说明"}

只输出 JSON，不要其他内容。`

// ============================================
// LLM 模式分析提示词 (语义引擎)
// ============================================

const ANALYST_SYSTEM_PROMPT = `你是 DunCrew 系统的"观察者"。分析用户的执行日志，识别可固化的行为模式。

输入格式：执行统计 + 工具频率 + 执行追踪样本

判定标准：
1. **频率性 (frequency)**：用户反复解决同一类问题
2. **复杂性 (complexity)**：执行复杂的多步骤任务
3. **依赖性 (dependency)**：固定的工具调用链（如: search→read→write）
4. **周期性 (periodic)**：周期性行为模式

如果发现模式，返回 JSON：
{
  "detected": true,
  "type": "frequency" | "complexity" | "dependency" | "periodic",
  "summary": "简短描述这个模式（10-20字）",
  "reasoning": "为什么需要固化这个模式",
  "suggestedName": "建议的 Nexus 名称（2-5个中文字，体现功能特点，如'文档助手'、'代码审查'、'日志分析'）",
  "suggestedSkills": ["工具名1", "工具名2"],
  "suggestedSOP": "为这个 Nexus 编写系统提示词，告诉它如何处理此类任务。必须是可执行的指令说明，50-150字。",
  "confidence": 0.1 ~ 1.0
}

如果没有明显模式，返回：{"detected": false}

只输出 JSON。`

// ============================================
// Slice 创建函数
// ============================================
// Nexus 名称生成器
// ============================================

/**
 * 根据触发模式生成有意义的 Nexus 名称
 */
function generateMeaningfulName(trigger: TriggerPattern): string {
  // 常见工具到功能名称的映射
  const toolToName: Record<string, string> = {
    'readFile': '文件读取',
    'writeFile': '文件编辑',
    'listDir': '目录浏览',
    'runCmd': '命令执行',
    'search': '搜索助手',
    'webSearch': '网页搜索',
    'webFetch': '网页抓取',
    'codeReview': '代码审查',
    'analyze': '分析助手',
    'generate': '内容生成',
    'translate': '翻译助手',
    'summarize': '摘要生成',
  }

  // 根据类型生成基础名称
  const typeNames: Record<string, string> = {
    'frequency': '常用任务',
    'complexity': '复杂流程',
    'dependency': '工具链',
    'periodic': '定时任务',
    'cross-skill': '技能组合',
  }

  // 尝试从建议的技能中推断名称
  if (trigger.suggestedSkills && trigger.suggestedSkills.length > 0) {
    const firstSkill = trigger.suggestedSkills[0]
    // 检查是否有直接映射
    for (const [key, name] of Object.entries(toolToName)) {
      if (firstSkill.toLowerCase().includes(key.toLowerCase())) {
        return name
      }
    }
    // 使用技能名称的前几个字
    if (firstSkill.length <= 6 && !/^[a-zA-Z0-9_-]+$/.test(firstSkill)) {
      return firstSkill
    }
  }

  // 根据类型和时间生成
  const baseName = typeNames[trigger.type] || '智能助手'
  const hour = new Date().getHours()
  const timeHint = hour < 12 ? '晨' : hour < 18 ? '午' : '夜'
  
  return `${timeHint}间${baseName}`
}

// ============================================

export const createObserverSlice: StateCreator<
  ObserverSlice,
  [],
  [],
  ObserverSlice
> = (set, get) => ({
  // Initial State
  behaviorRecords: [],
  currentProposal: null,
  lastAnalysisTime: 0,
  isAnalyzing: false,
  nexusPanelOpen: false,
  selectedNexusForPanel: null,
  pendingNexusChatInput: null,
  lastRuleCheckTime: 0,
  cachedTraces: [],
  cachedStats: null,
  rejectedPatterns: new Map(),
  lastRejectionTime: 0,

  // Actions
  addBehaviorRecord: (record) => {
    const newRecord: BehaviorRecord = {
      ...record,
      id: generateId(),
      timestamp: Date.now(),
      keywords: [],
    }
    
    set((state) => {
      const updatedRecords = [
        ...state.behaviorRecords.slice(-BEHAVIOR_WINDOW_SIZE + 1),
        newRecord,
      ]

      // 检查是否应该触发分析
      const shouldTriggerAnalysis = 
        (Date.now() - state.lastAnalysisTime > ANALYSIS_COOLDOWN_MS) &&
        !state.isAnalyzing &&
        !state.currentProposal

      if (shouldTriggerAnalysis) {
        // 异步触发双引擎分析
        setTimeout(() => get().analyze(), 100)
      }

      return { behaviorRecords: updatedRecords }
    })

    // 持久化到后端 (防抖)
    scheduleObserverFlush(get().behaviorRecords)
  },

  /**
   * 从后端加载行为记录 (应用启动时调用)
   */
  loadBehaviorRecords: async () => {
    try {
      const saved = await localServerService.getData<BehaviorRecord[]>(OBSERVER_DATA_KEY)
      if (saved && saved.length > 0) {
        set({ behaviorRecords: saved.slice(-BEHAVIOR_WINDOW_SIZE) })
        console.log(`[Observer] Restored ${saved.length} behavior records from backend`)
      }
    } catch {
      // 后端不可用，保持空数组
    }
  },

  /**
   * 从后端获取最近的执行日志
   */
  fetchRecentTraces: async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/traces/recent?days=${RULE_ENGINE.FREQUENCY_DAYS}&limit=100`)
      if (!res.ok) return null
      const data = await res.json()
      return {
        traces: data.traces || [],
        stats: data.stats || {
          totalExecutions: 0,
          toolFrequency: {},
          nexusFrequency: {},
          avgTurnsPerExecution: 0,
          totalErrors: 0,
          timeRangeDays: RULE_ENGINE.FREQUENCY_DAYS,
        }
      }
    } catch (err) {
      console.warn('[Observer] Failed to fetch traces:', err)
      return null
    }
  },

  /**
   * 主分析入口 - 双引擎协同
   */
  analyze: async () => {
    const { isAnalyzing, currentProposal, lastRejectionTime } = get()
    
    if (isAnalyzing) return null
    if (currentProposal?.status === 'pending') return null
    
    // 如果用户最近拒绝过提案，增加冷却时间
    if (Date.now() - lastRejectionTime < REJECTION_COOLDOWN_MS) {
      console.log('[Observer] In rejection cooldown period, skipping analysis')
      return null
    }
    
    set({ isAnalyzing: true, lastAnalysisTime: Date.now() })
    console.log('[Observer] Starting dual-engine analysis...')

    try {
      // Phase 1: 规则引擎 (本地, 不消耗 Token)
      const ruleTrigger = await get().analyzeWithRuleEngine()
      if (ruleTrigger) {
        console.log('[Observer] Rule engine detected pattern:', ruleTrigger.type)
        get().createProposal(ruleTrigger)
        return ruleTrigger
      }

      // Phase 2: LLM 语义引擎 (消耗 Token, 仅在规则引擎无结果时)
      const config = getLLMConfig()
      if (!config.apiKey) {
        console.log('[Observer] No LLM API key, skipping semantic analysis')
        return null
      }

      const { cachedTraces, cachedStats } = get()
      if (cachedTraces.length >= RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS && cachedStats) {
        const llmTrigger = await get().analyzeWithLLM(cachedTraces, cachedStats)
        if (llmTrigger) {
          console.log('[Observer] LLM engine detected pattern:', llmTrigger.type)
          get().createProposal(llmTrigger)
          return llmTrigger
        }
      }

      console.log('[Observer] No significant pattern detected')
      return null

    } catch (error) {
      console.warn('[Observer] Analysis failed:', error)
      return null
    } finally {
      set({ isAnalyzing: false })
    }
  },

  /**
   * 规则引擎分析 (本地, 零 Token 消耗)
   */
  analyzeWithRuleEngine: async () => {
    console.log('[Observer/Rule] Starting rule-based analysis...')
    
    // 获取最近的执行日志
    const data = await get().fetchRecentTraces()
    if (!data) return null
    
    const { traces, stats } = data
    set({ cachedTraces: traces, cachedStats: stats })
    
    if (traces.length < RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS) {
      console.log(`[Observer/Rule] Not enough traces (${traces.length} < ${RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS})`)
      return null
    }

    // ========== 规则 1: 频率触发 ==========
    const topTools = Object.entries(stats.toolFrequency)
      .filter(([, count]) => count >= RULE_ENGINE.FREQUENCY_THRESHOLD)
      .sort(([, a], [, b]) => b - a)
    
    if (topTools.length > 0) {
      const [toolName, count] = topTools[0]
      const confidence = Math.min(0.5 + (count - RULE_ENGINE.FREQUENCY_THRESHOLD) * 0.1, 0.9)
      const suggestedSkills = topTools.slice(0, 3).map(([t]) => t)
      
      console.log(`[Observer/Rule] Frequency trigger: ${toolName} used ${count} times`)
      
      return {
        type: 'frequency' as const,
        confidence,
        evidence: [
          `工具 "${toolName}" 在 ${RULE_ENGINE.FREQUENCY_DAYS} 天内被调用 ${count} 次`,
          `高频工具: ${topTools.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ')}`
        ],
        detectedAt: Date.now(),
        suggestedSkills,
        suggestedSOP: `你的核心任务是熟练使用 ${suggestedSkills.join('、')} 工具。请根据用户的自然语言需求，选择合适的工具完成操作。优先使用 ${toolName}，它是用户最常用的工具。`,
      }
    }

    // ========== 规则 2: 复杂度触发 ==========
    const complexTraces = traces.filter(t => (t.turnCount || 0) >= RULE_ENGINE.COMPLEXITY_TURNS)
    if (complexTraces.length >= 2) {
      const avgTurns = complexTraces.reduce((sum, t) => sum + (t.turnCount || 0), 0) / complexTraces.length
      const confidence = Math.min(0.5 + (avgTurns - RULE_ENGINE.COMPLEXITY_TURNS) * 0.05, 0.85)
      
      // 从复杂任务中提取常用工具
      const complexToolFreq: Record<string, number> = {}
      for (const trace of complexTraces) {
        for (const tool of trace.tools) {
          complexToolFreq[tool.name] = (complexToolFreq[tool.name] || 0) + 1
        }
      }
      const suggestedSkills = Object.entries(complexToolFreq)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([t]) => t)
      
      console.log(`[Observer/Rule] Complexity trigger: ${complexTraces.length} complex executions`)
      
      return {
        type: 'complexity' as const,
        confidence,
        evidence: [
          `发现 ${complexTraces.length} 次复杂执行 (平均 ${avgTurns.toFixed(1)} 轮)`,
          `示例任务: ${complexTraces[0].task.slice(0, 50)}...`
        ],
        detectedAt: Date.now(),
        suggestedSkills,
        suggestedSOP: `你是一个复杂任务处理专家。当用户提出多步骤任务时，先分析任务结构，制定执行计划，然后逐步完成。常用工具: ${suggestedSkills.join('、')}。遇到问题时主动反思并调整策略。`,
      }
    }

    // ========== 规则 3: 依赖触发 (工具链检测) ==========
    const pipelineFreq: Record<string, number> = {}
    for (const trace of traces) {
      if (trace.tools.length >= 2) {
        const pipeline = extractToolPipeline(trace)
        pipelineFreq[pipeline] = (pipelineFreq[pipeline] || 0) + 1
      }
    }
    
    const frequentPipelines = Object.entries(pipelineFreq)
      .filter(([, count]) => count >= RULE_ENGINE.DEPENDENCY_MIN_OCCURRENCES)
      .sort(([, a], [, b]) => b - a)
    
    if (frequentPipelines.length > 0) {
      const [pipeline, count] = frequentPipelines[0]
      const tools = pipeline.split('→')
      const confidence = Math.min(0.55 + count * 0.1, 0.85)
      
      console.log(`[Observer/Rule] Dependency trigger: pipeline "${pipeline}" appeared ${count} times`)
      
      return {
        type: 'dependency' as const,
        confidence,
        evidence: [
          `工具链 "${pipeline}" 重复出现 ${count} 次`,
          `涉及工具: ${tools.join(', ')}`
        ],
        detectedAt: Date.now(),
        suggestedSkills: tools,
        suggestedSOP: `你的标准作业流程(SOP)是执行以下工具链：${tools.join(' → ')}。请按顺序规划并调用这些工具完成任务。在每一步完成后验证结果，确保下一步有正确的输入。`,
      }
    }

    // ========== 规则 4: 跨技能成功检测 ==========
    // 检测成功使用 2+ 种不同工具的执行记录，若此模式出现 ≥2 次则触发
    const crossSkillTraces = traces.filter(t => {
      if (!t.success) return false
      const uniqueTools = new Set(t.tools.map(tool => tool.name))
      return uniqueTools.size >= 2
    })

    if (crossSkillTraces.length >= 2) {
      // 统计跨技能组合出现频率
      const comboFreq: Record<string, { count: number; tools: string[] }> = {}
      for (const trace of crossSkillTraces) {
        const toolNames = [...new Set(trace.tools.map(t => t.name))].sort()
        const comboKey = toolNames.join('+')
        if (!comboFreq[comboKey]) {
          comboFreq[comboKey] = { count: 0, tools: toolNames }
        }
        comboFreq[comboKey].count++
      }

      const topCombo = Object.entries(comboFreq)
        .filter(([, v]) => v.count >= 2)
        .sort(([, a], [, b]) => b.count - a.count)[0]

      if (topCombo) {
        const [, { count, tools }] = topCombo
        const confidence = Math.min(0.5 + count * 0.1, 0.85)

        console.log(`[Observer/Rule] Cross-skill trigger: ${tools.join('+')} appeared ${count} times`)

        return {
          type: 'cross-skill' as const,
          confidence,
          evidence: [
            `跨技能组合 "${tools.join(' + ')}" 成功执行 ${count} 次`,
            `建议名称: ${tools.slice(0, 2).join('×')}协作`,
          ],
          detectedAt: Date.now(),
          suggestedSkills: tools,
          suggestedSOP: `你是一个多工具协作专家。你的核心能力是组合使用 ${tools.join('、')} 来完成复杂任务。接收用户需求后，判断需要哪些工具的协作，制定执行计划并逐步完成。`,
        }
      }
    }

    console.log('[Observer/Rule] No rule-based pattern detected')
    return null
  },

  /**
   * LLM 语义引擎分析
   */
  analyzeWithLLM: async (traces: ExecTrace[], stats: TraceStats) => {
    console.log('[Observer/LLM] Starting semantic analysis...')
    
    // 准备分析数据
    const summaryData = {
      totalExecutions: stats.totalExecutions,
      avgTurns: stats.avgTurnsPerExecution.toFixed(1),
      topTools: Object.entries(stats.toolFrequency)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([t, c]) => `${t}: ${c}次`),
      recentTasks: traces.slice(0, 10).map(t => ({
        task: t.task.slice(0, 80),
        tools: t.tools.map(tool => tool.name).join('→'),
        turns: t.turnCount || 'N/A',
        success: t.success,
      })),
    }

    const userPrompt = `执行统计 (过去 ${RULE_ENGINE.FREQUENCY_DAYS} 天):
- 总执行次数: ${summaryData.totalExecutions}
- 平均轮次: ${summaryData.avgTurns}
- 高频工具: ${summaryData.topTools.join(', ')}

最近执行样本:
${summaryData.recentTasks.map((t, i) => 
  `${i + 1}. "${t.task}" → [${t.tools}] (${t.turns}轮, ${t.success ? '成功' : '失败'})`
).join('\n')}

请分析是否存在可固化的行为模式。`

    try {
      const response = await chat(
        [
          { role: 'system', content: ANALYST_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        { temperature: 0.3 } as any
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[Observer/LLM] Invalid JSON response')
        return null
      }
      
      const result = JSON.parse(jsonMatch[0])
      console.log('[Observer/LLM] Analysis result:', result)

      if (result.detected && result.confidence >= CONFIDENCE_THRESHOLD) {
        return {
          type: result.type,
          confidence: result.confidence,
          evidence: [
            result.summary,
            result.reasoning,
            result.suggestedName ? `建议名称: ${result.suggestedName}` : ''
          ].filter(Boolean),
          detectedAt: Date.now(),
          suggestedSkills: result.suggestedSkills || [],
          suggestedSOP: result.suggestedSOP || '',
        }
      }

      return null
    } catch (error) {
      console.warn('[Observer/LLM] Analysis failed:', error)
      return null
    }
  },

  createProposal: (trigger) => {
    // 从 trigger 提取技能
    const boundSkillIds = trigger.suggestedSkills || []
    
    // 检查是否已存在相似的 Nexus
    if (get().checkDuplicateNexus(boundSkillIds)) {
      console.log('[Observer] Skipping proposal - duplicate Nexus exists')
      return
    }
    
    // 检查最近是否拒绝过相同类型的提案
    const { rejectedPatterns } = get()
    const lastRejection = rejectedPatterns.get(trigger.type)
    if (lastRejection && Date.now() - lastRejection < REJECTION_COOLDOWN_MS) {
      console.log(`[Observer] Skipping proposal - ${trigger.type} was recently rejected`)
      return
    }
    
    const proposalId = generateId()
    
    // 从 evidence 中提取名称建议
    const nameFromEvidence = trigger.evidence.find(e => e.startsWith('建议名称:'))
    let suggestedName: string
    
    if (nameFromEvidence) {
      suggestedName = nameFromEvidence.replace('建议名称:', '').trim()
      // 验证名称质量：如果是无意义的标识符，使用更好的默认值
      if (/^[A-Z0-9-_]+$/.test(suggestedName) || suggestedName.length > 10) {
        suggestedName = generateMeaningfulName(trigger)
      }
    } else {
      suggestedName = generateMeaningfulName(trigger)
    }

    // 生成功能目标概述
    const purposeSummary = generatePurposeSummary(trigger)
    
    // 从 trigger 提取 SOP
    const sopContent = trigger.suggestedSOP || ''
    
    const proposal: BuildProposal = {
      id: proposalId,
      triggerPattern: trigger,
      suggestedName,
      previewVisualDNA: generateVisualDNASync(proposalId),
      purposeSummary,
      boundSkillIds,           // 新增：技能列表
      sopContent,              // 新增：SOP 内容
      status: 'pending',
      createdAt: Date.now(),
    }
    
    console.log('[Observer] Proposal created:', proposal)
    set({ currentProposal: proposal })
  },

  acceptProposal: () => {
    const { currentProposal } = get()
    if (!currentProposal || currentProposal.status !== 'pending') return null
    
    const accepted: BuildProposal = {
      ...currentProposal,
      status: 'accepted',
    }
    
    set({ currentProposal: accepted })
    return accepted
  },

  rejectProposal: () => {
    const { currentProposal, rejectedPatterns } = get()
    if (!currentProposal) return
    
    // 记录拒绝的模式类型和时间
    const patternType = currentProposal.triggerPattern.type
    const newRejectedPatterns = new Map(rejectedPatterns)
    newRejectedPatterns.set(patternType, Date.now())
    
    set({
      currentProposal: {
        ...currentProposal,
        status: 'rejected',
      },
      rejectedPatterns: newRejectedPatterns,
      lastRejectionTime: Date.now(),
    })
    
    console.log(`[Observer] Proposal rejected, pattern "${patternType}" on cooldown for ${REJECTION_COOLDOWN_MS / 1000}s`)
    
    setTimeout(() => {
      set({ currentProposal: null })
    }, 500)
  },

  clearProposal: () => {
    set({ currentProposal: null })
  },

  /**
   * 检查是否已存在相似的 Nexus（基于技能重叠度）
   */
  checkDuplicateNexus: (suggestedSkills: string[]) => {
    // 从 localStorage 获取已有的 Nexus
    try {
      const stored = localStorage.getItem('duncrew_nexuses')
      if (!stored) return false
      
      const nexuses = JSON.parse(stored) as Array<{ boundSkillIds?: string[]; label?: string }>
      if (!nexuses || nexuses.length === 0) return false
      
      // 检查是否有 Nexus 的技能与建议技能高度重叠
      for (const nexus of nexuses) {
        const existingSkills = nexus.boundSkillIds || []
        if (existingSkills.length === 0) continue
        
        // 计算重叠度
        const overlap = suggestedSkills.filter(s => existingSkills.includes(s)).length
        const overlapRatio = overlap / Math.max(suggestedSkills.length, 1)
        
        if (overlapRatio >= 0.5) {
          console.log(`[Observer] Found duplicate Nexus "${nexus.label}" with ${Math.round(overlapRatio * 100)}% skill overlap`)
          return true
        }
      }
      
      return false
    } catch {
      return false
    }
  },
  
  // Panel Actions
  openNexusPanel: (nexusId) => {
    set({
      nexusPanelOpen: true,
      selectedNexusForPanel: nexusId,
    })
  },

  openNexusPanelWithInput: (nexusId, input) => {
    set({
      nexusPanelOpen: true,
      selectedNexusForPanel: nexusId,
      pendingNexusChatInput: input,
    })
  },

  closeNexusPanel: () => {
    set({
      nexusPanelOpen: false,
      selectedNexusForPanel: null,
      pendingNexusChatInput: null,
    })
  },

  clearPendingInput: () => {
    set({ pendingNexusChatInput: null })
  },

  /**
   * 从当前对话生成 Nexus 提案（手动触发）
   */
  generateNexusFromChat: async (messages) => {
    const { isAnalyzing, currentProposal } = get()
    if (isAnalyzing || currentProposal?.status === 'pending') return

    // 过滤有效对话（排除系统消息和空消息）
    const validMessages = messages.filter(
      m => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
    )
    if (validMessages.length < 2) {
      console.warn('[Observer] Not enough messages to generate Nexus')
      return
    }

    set({ isAnalyzing: true })
    console.log('[Observer] Generating Nexus from chat...')

    try {
      const config = getLLMConfig()
      if (!config.apiKey) {
        console.warn('[Observer] No LLM API key configured')
        return
      }

      // 截取最近 20 条消息避免 token 溢出
      const recentMessages = validMessages.slice(-20)
      const conversationText = recentMessages
        .map(m => `[${m.role}]: ${m.content.slice(0, 300)}`)
        .join('\n')

      const response = await chat(
        [
          { role: 'system', content: CHAT_TO_NEXUS_PROMPT },
          { role: 'user', content: `以下是用户与 AI 的对话记录：\n\n${conversationText}\n\n请分析并提炼。` }
        ],
        { temperature: 0.3 } as any
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[Observer] Invalid JSON from chat analysis')
        return
      }

      const result = JSON.parse(jsonMatch[0])
      console.log('[Observer] Chat analysis result:', result)

      if (!result.canCreate) {
        console.log('[Observer] Chat not suitable for Nexus:', result.reason)
        return
      }

      // 构造 TriggerPattern 并创建 Proposal
      const trigger: TriggerPattern = {
        type: 'dependency',
        confidence: result.confidence || 0.7,
        evidence: [
          result.summary || '从对话中提炼',
          `建议名称: ${result.suggestedName}`,
        ],
        detectedAt: Date.now(),
        suggestedSkills: result.suggestedSkills || [],
        suggestedSOP: result.suggestedSOP || '',
      }

      get().createProposal(trigger)
      console.log('[Observer] Nexus proposal created from chat')
    } catch (error) {
      console.warn('[Observer] Failed to generate Nexus from chat:', error)
    } finally {
      set({ isAnalyzing: false })
    }
  },

  /**
   * 观察者分析对话，返回结果供建构者（CreateNexusModal）使用
   * 这是 Observer → Builder 的核心桥接方法
   */
  analyzeConversationForBuilder: async (messages): Promise<NexusAnalysisResult | null> => {
    const { isAnalyzing } = get()
    if (isAnalyzing) return null

    // 过滤有效对话
    const validMessages = messages.filter(
      m => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
    )
    
    if (validMessages.length < 2) {
      console.warn('[Observer] Not enough messages to analyze')
      return null
    }

    set({ isAnalyzing: true })
    console.log('[Observer] 🔍 Analyzing conversation for Builder...')

    try {
      const config = getLLMConfig()
      if (!config.apiKey) {
        console.warn('[Observer] No LLM API key configured')
        return null
      }

      // 截取最近 30 条消息（比旧版更多，提取更完整信息）
      const recentMessages = validMessages.slice(-30)
      const conversationText = recentMessages
        .map(m => `[${m.role}]: ${m.content.slice(0, 500)}`)
        .join('\n')

      const response = await chat(
        [
          { role: 'system', content: CHAT_TO_NEXUS_PROMPT },
          { role: 'user', content: `以下是用户与 AI 的对话记录：\n\n${conversationText}\n\n请分析并提炼。` }
        ],
        { temperature: 0.3 } as any
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[Observer] Invalid JSON from chat analysis')
        return null
      }

      const result = JSON.parse(jsonMatch[0])
      console.log('[Observer] 📋 Analysis result for Builder:', result)

      if (!result.canCreate) {
        console.log('[Observer] Chat not suitable for Nexus:', result.reason)
        // 即使 LLM 认为不适合，也返回部分信息让用户决定
        return null
      }

      // 返回结构化结果供 Builder 使用
      return {
        name: result.suggestedName || '',
        description: result.description || result.summary || '',
        sopContent: result.sopContent || result.suggestedSOP || '',
        confidence: result.confidence || 0.7,
        suggestedSkills: result.suggestedSkills || [],
        tags: result.tags || [],
        triggers: result.triggers || [],
        objective: result.objective || '',
        metrics: result.metrics || [],
        strategy: result.strategy || '',
      }
    } catch (error) {
      console.warn('[Observer] Failed to analyze conversation:', error)
      return null
    } finally {
      set({ isAnalyzing: false })
    }
  },
})
