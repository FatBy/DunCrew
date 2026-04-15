import type { StateCreator } from 'zustand'
import type { 
  BehaviorRecord, 
  TriggerPattern, 
  BuildProposal, 
  VisualDNA,
  ExecTrace,
  SkillProposal
} from '@/types'
import { chatBackground, getLLMConfig } from '@/services/llmService'
import { localServerService } from '@/services/localServerService'
import { analyzeToolPatterns, type TraceStats } from '@/services/skillDiscoveryEngine'
import { analyzeIntentPatterns } from '@/services/dunDiscoveryEngine'
import type { DunEntity, ObserverInsight } from '@/types'  // #12: 用于从 store 获取 dunes
import { memoryStore } from '@/services/memoryStore'

// ============================================
// 常量配置 - 双引擎阈值
// ============================================

const BEHAVIOR_WINDOW_SIZE = 50        // 保留最近 N 条行为记录
const ANALYSIS_COOLDOWN_MS = 60000     // 分析冷却 (60秒，原 20秒)
const REJECTION_COOLDOWN_MS = 300000   // 拒绝后冷却 5 分钟
const SKILL_REJECTION_COOLDOWN_MS = 300000  // Skill 提案拒绝后冷却 5 分钟 [Q8]
const REJECTION_EXPIRY_MS = 24 * 60 * 60 * 1000  // #21: 拒绝记录过期时间 24h
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

export interface ObserverSlice {
  // State
  behaviorRecords: BehaviorRecord[]
  currentProposal: BuildProposal | null
  lastAnalysisTime: number
  isAutoAnalyzing: boolean   // #6: 自动分析互斥锁
  isUserAnalyzing: boolean   // #6: 用户操作互斥锁
  dunPanelOpen: boolean
  selectedDunForPanel: string | null
  pendingDunChatInput: string | null  // 预填的 Dun 对话输入
  // Skill 提案状态 [Q6][Q8]
  currentSkillProposal: SkillProposal | null
  /** discoveryType+tools签名 → rejection timestamp [Q8] */
  rejectedSkillPatterns: Map<string, number>
  // 去重状态
  rejectedPatterns: Map<string, number>  // pattern type → rejection time

  // Actions
  addBehaviorRecord: (record: Omit<BehaviorRecord, 'id' | 'timestamp' | 'keywords'>) => void
  loadBehaviorRecords: () => Promise<void>
  analyze: () => Promise<TriggerPattern | null>
  fetchRecentTraces: () => Promise<{ traces: ExecTrace[]; stats: TraceStats } | null>
  createProposal: (trigger: TriggerPattern) => void
  acceptProposal: () => BuildProposal | null
  rejectProposal: () => void
  clearProposal: () => void
  checkDuplicateDun: (suggestedSkills: string[]) => boolean
  
  // Skill 提案操作 [Q8]
  acceptSkillProposal: () => Promise<SkillProposal | null>
  rejectSkillProposal: () => void
  clearSkillProposal: () => void
  
  // Panel Actions
  openDunPanel: (dunId: string) => void
  openDunPanelWithInput: (dunId: string, input: string) => void  // 打开面板并预填输入
  closeDunPanel: () => void
  clearPendingInput: () => void  // 清除预填输入
  
  // Chat → Dun (旧版，创建 Proposal)
  generateDunFromChat: (messages: Array<{ role: string; content: string }>) => Promise<void>
  
  // Observer → Builder: 分析对话并返回结果供建构者使用
  analyzeConversationForBuilder: (messages: Array<{ role: string; content: string }>) => Promise<DunAnalysisResult | null>

  // ── 洞察系统 ──
  insights: ObserverInsight[]
  insightForDunCreation: ObserverInsight | null
  dismissInsight: (id: string) => void
  createDunFromInsight: (id: string) => void
  enhanceDunFromInsight: (id: string) => Promise<void>
  clearInsightForDunCreation: () => void
}

// Observer 分析结果类型（供 Builder 使用）
export interface DunAnalysisResult {
  name: string
  description: string
  sopContent: string           // 完整 Markdown SOP
  confidence: number
  suggestedSkills: string[]    // 建议绑定的技能/工具
  tags: string[]               // 分类标签
  triggers: string[]           // 触发词（用户说什么会激活这个 Dun）
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

// #12: 从 store 获取 dunes（延迟导入避免循环依赖）
function getDunsFromStore(): Map<string, DunEntity> | null {
  try {
    // 使用动态导入避免循环依赖
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const store = require('@/store') as { useStore: () => { duns: Map<string, DunEntity> } }
    return store.useStore().duns || null
  } catch {
    return null
  }
}

// ---- 已消费 Trace ID 追踪（防止同一批 trace 重复触发 Dun 提案）----

const CONSUMED_TRACE_IDS_KEY = 'duncrew_consumed_trace_ids'

function loadConsumedTraceIds(): Set<string> {
  try {
    const saved = localStorage.getItem(CONSUMED_TRACE_IDS_KEY)
    if (saved) return new Set(JSON.parse(saved))
  } catch { /* ignore */ }
  return new Set()
}

function saveConsumedTraceIds(ids: Set<string>): void {
  try {
    // 只保留最近 500 条，防止 localStorage 膨胀
    const arr = [...ids].slice(-500)
    localStorage.setItem(CONSUMED_TRACE_IDS_KEY, JSON.stringify(arr))
  } catch { /* ignore */ }
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

// #20: HMR 清理 - 防止热更新时定时器泄漏
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (_observerFlushTimer) {
      clearTimeout(_observerFlushTimer)
      _observerFlushTimer = null
    }
  })
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
 * 计算两段文本的 bigram 相似度 (Dice coefficient) [Q3]
 */
function ngramSimilarity(textA: string, textB: string): number {
  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()
  const normalizedA = textA.toLowerCase()
  const normalizedB = textB.toLowerCase()
  for (let i = 0; i < normalizedA.length - 1; i++) bigramsA.add(normalizedA.slice(i, i + 2))
  for (let i = 0; i < normalizedB.length - 1; i++) bigramsB.add(normalizedB.slice(i, i + 2))
  if (bigramsA.size === 0 || bigramsB.size === 0) return 0
  let intersection = 0
  for (const bigram of bigramsA) { if (bigramsB.has(bigram)) intersection++ }
  return (2 * intersection) / (bigramsA.size + bigramsB.size)
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
// 对话转 Dun 提示词 (升级版 - 完整 Dun 格式)
// ============================================

const CHAT_TO_DUN_PROMPT = `你是 DunCrew 的"提炼器"。分析用户与 AI 的对话记录，提炼出可复用的 Dun（自动化执行节点）。

## Dun 是什么
Dun 是 DunCrew 的核心工作单元，类似于"专家角色+标准作业程序"的组合。每个 Dun 应该：
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
  "description": "一句话描述这个 Dun 的核心功能和适用场景",
  "suggestedSkills": ["工具名1", "工具名2", "工具名3"],
  "tags": ["分类标签1", "分类标签2"],
  "triggers": ["触发词1", "触发词2", "触发词3"],
  "objective": "这个 Dun 要达成的核心目标（一句话）",
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
// Slice 创建函数
// ============================================
// Dun 名称生成器
// ============================================

/**
 * 根据触发模式生成有意义的 Dun 名称
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
    'intent-cluster': '意图模式',
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
  isAutoAnalyzing: false,   // #6: 自动分析互斥锁
  isUserAnalyzing: false,   // #6: 用户操作互斥锁
  dunPanelOpen: false,
  selectedDunForPanel: null,
  pendingDunChatInput: null,
  currentSkillProposal: null,
  rejectedSkillPatterns: new Map(),
  rejectedPatterns: new Map(),
  // ── 洞察系统 ──
  insights: [],
  insightForDunCreation: null,

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

      // 检查是否应该触发分析 (#19: 增加 currentSkillProposal 检查)
      const shouldTriggerAnalysis = 
        (Date.now() - state.lastAnalysisTime > ANALYSIS_COOLDOWN_MS) &&
        !state.isAutoAnalyzing &&
        !state.currentProposal &&
        !state.currentSkillProposal

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
          dunFrequency: {},
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
   * 主分析入口 - 双路径分叉 [Q6][Q9]
   * 路径 A: Skill 发现（工具维度）— 始终执行
   * 路径 B: Dun 发现（意图维度）— 始终执行
   * 兜底: LLM 语义引擎（两条路径都无 Dun 结果时）
   */
  analyze: async () => {
    const { lastAnalysisTime, isAutoAnalyzing, currentProposal } = get()
    if (isAutoAnalyzing) return null
    if (currentProposal) return null  // #5: 防止覆盖用户正在查看的 proposal
    if (Date.now() - lastAnalysisTime < ANALYSIS_COOLDOWN_MS) return null

    // #21: 清理过期的拒绝记录（24h 过期）
    const now = Date.now()
    const { rejectedPatterns, rejectedSkillPatterns } = get()
    const cleanedPatterns = new Map([...rejectedPatterns].filter(([_, t]) => now - t < REJECTION_EXPIRY_MS))
    const cleanedSkillPatterns = new Map([...rejectedSkillPatterns].filter(([_, t]) => now - t < REJECTION_EXPIRY_MS))
    if (cleanedPatterns.size !== rejectedPatterns.size || cleanedSkillPatterns.size !== rejectedSkillPatterns.size) {
      set({ rejectedPatterns: cleanedPatterns, rejectedSkillPatterns: cleanedSkillPatterns })
      console.log(`[Observer] Cleaned expired rejection records`)
    }

    set({ isAutoAnalyzing: true })  // #7: lastAnalysisTime 移到成功后
    console.log('[Observer] Starting dual-path analysis...')

    try {
      // ═══ 统一获取数据（一次 HTTP）[Q9] ═══
      const data = await get().fetchRecentTraces()
      if (!data) return null
      const { traces, stats } = data

      if (traces.length < RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS) {
        console.log(`[Observer] Not enough traces (${traces.length} < ${RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS})`)
        return null
      }

      // ═══ 路径 A: Skill 发现（工具维度）— 始终执行 [Q6] ═══
      const skillProposal = analyzeToolPatterns(traces, stats)
      if (skillProposal) {
        // 检查拒绝冷却 [Q8]
        const skillKey = `${skillProposal.discoveryType}:${[...skillProposal.tools].sort().join(',')}`
        const lastRejection = get().rejectedSkillPatterns.get(skillKey)
        if (!lastRejection || Date.now() - lastRejection >= SKILL_REJECTION_COOLDOWN_MS) {
          // 查询后端已有技能列表，避免对已存在的技能重复弹出提案
          const skillNameCandidate = skillProposal.suggestedName
            .replace(/[^a-zA-Z0-9_\-]/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase()
          let alreadyExists = false
          try {
            const listRes = await fetch(`${SERVER_URL}/skills`)
            if (listRes.ok) {
              const listData: Array<{ id: string; name: string }> = await listRes.json()
              const existingIds = listData.map(s => s.id.toLowerCase())
              if (existingIds.includes(skillNameCandidate)) {
                alreadyExists = true
                // 自动加入冷却，防止下次再弹
                const newPatterns = new Map(get().rejectedSkillPatterns)
                newPatterns.set(skillKey, Date.now())
                set({ rejectedSkillPatterns: newPatterns })
                console.log(`[Observer/SkillDiscovery] Skill "${skillNameCandidate}" already exists, skipping proposal`)
              }
            }
          } catch (e) {
            // 查询失败不阻塞，正常弹出
          }

          if (!alreadyExists) {
            console.log('[Observer/SkillDiscovery] Found:', skillProposal.suggestedName)
            set({ currentSkillProposal: skillProposal })
            // #17: Path A 有结果时跳过 Path B，直接返回
            set({ isAutoAnalyzing: false, lastAnalysisTime: Date.now() })
            return null
          }
        }
      }

      // ═══ 路径 B: Dun 发现（意图维度）→ 写记忆 + 生成洞察 ═══
      const consumedTraceIds = loadConsumedTraceIds()
      const freshTraces = traces.filter(t => !consumedTraceIds.has(t.id))
      const intentTrigger = freshTraces.length >= RULE_ENGINE.MIN_TRACES_FOR_ANALYSIS
        ? analyzeIntentPatterns(freshTraces)
        : null
      if (intentTrigger && intentTrigger.intentCluster) {
        const cluster = intentTrigger.intentCluster
        console.log('[Observer/DunDiscovery] Found intent cluster:', cluster.coreKeywords)

        // 标记 cluster 中的 trace 为已消费
        const consumed = loadConsumedTraceIds()
        for (const traceId of cluster.traceIds) {
          consumed.add(traceId)
        }
        saveConsumedTraceIds(consumed)

        // ── 层 1：写入记忆系统 ──
        const toolFrequency: Record<string, number> = {}
        for (const chain of cluster.toolChains) {
          for (const tool of chain) {
            toolFrequency[tool] = (toolFrequency[tool] || 0) + 1
          }
        }
        const topTools = Object.entries(toolFrequency)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([name]) => name)

        const mostCommonChain = (() => {
          const chainSigs: Record<string, number> = {}
          for (const chain of cluster.toolChains) {
            const sig = chain.join('→')
            chainSigs[sig] = (chainSigs[sig] || 0) + 1
          }
          return Object.entries(chainSigs).sort(([, a], [, b]) => b - a)[0]?.[0] || topTools.join('→')
        })()

        const sortedTasks = [...cluster.taskDescriptions].sort((a, b) => a.length - b.length)
        const representativeTask = sortedTasks[0] || ''

        const memoryContent = [
          `[行为模式] 近 ${cluster.timeSpanDays} 天内执行了 ${cluster.size} 次相似任务`,
          `关键词：${cluster.coreKeywords.join('、')}`,
          `常用工具链：${mostCommonChain}`,
          `成功率：${Math.round(cluster.successRate * 100)}%，平均 ${Math.round(cluster.avgTurnCount)} 轮完成`,
          `代表性任务：${representativeTask.slice(0, 80)}`,
        ].join('\n')

        try {
          await memoryStore.writeWithDedup({
            source: 'memory',
            content: memoryContent,
            tags: ['observer-insight', ...cluster.coreKeywords.slice(0, 5)],
          })
          console.log('[Observer] Insight written to memory')
        } catch (err) {
          console.warn('[Observer] Failed to write insight to memory:', err)
        }

        // ── 层 2：生成 UI 洞察 ──
        const confidence = intentTrigger.confidence || 0.5

        // 匹配已有 Dun（三条 OR 规则）
        let relatedDunId: string | undefined
        let relatedDunLabel: string | undefined
        const dunesMap = getDunsFromStore()
        if (dunesMap && dunesMap.size > 0) {
          let bestMatchScore = 0
          for (const [dunId, dun] of dunesMap) {
            const existingSkills = dun.boundSkillIds || []
            const dunTriggers = dun.triggers || []
            const dunObjective = dun.objective || ''

            // 规则 1：工具重叠 ≥ 50%
            const skillOverlap = topTools.filter(s => existingSkills.includes(s)).length
            const skillOverlapRatio = topTools.length > 0 ? skillOverlap / topTools.length : 0
            const rule1 = skillOverlapRatio >= 0.5

            // 规则 2：语义相似 > 0.5
            const rule2 = dunObjective && representativeTask
              ? ngramSimilarity(representativeTask, dunObjective) > 0.5
              : false

            // 规则 3：关键词与 triggers 重叠 ≥ 2
            const keywordOverlap = cluster.coreKeywords.filter(kw =>
              dunTriggers.some(trigger => trigger.toLowerCase().includes(kw.toLowerCase()))
            ).length
            const rule3 = keywordOverlap >= 2

            if (rule1 || rule2 || rule3) {
              const matchScore = (rule1 ? skillOverlapRatio : 0)
                + (rule2 ? 0.3 : 0)
                + (rule3 ? keywordOverlap * 0.1 : 0)
              if (matchScore > bestMatchScore) {
                bestMatchScore = matchScore
                relatedDunId = dunId
                relatedDunLabel = dun.label || dunId
              }
            }
          }
        }

        // 展示阈值：confidence ≥ 0.6 且 cluster.size ≥ 5
        if (confidence >= 0.6 && cluster.size >= 5) {
          const insight: ObserverInsight = {
            id: `insight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            cluster,
            confidence,
            suggestedSkills: topTools,
            coreKeywords: cluster.coreKeywords,
            representativeTask,
            relatedDunId,
            relatedDunLabel,
            memoryWritten: true,
            createdAt: Date.now(),
          }

          // 合并到 insights 队列（最多 3 条，按 confidence × size 排序取 Top 3）
          const existingInsights = get().insights.filter(
            i => Date.now() - i.createdAt < 7 * 24 * 60 * 60 * 1000
          )
          const allInsights = [...existingInsights, insight]
            .sort((a, b) => (b.confidence * b.cluster.size) - (a.confidence * a.cluster.size))
            .slice(0, 3)

          set({ insights: allInsights })
          console.log('[Observer] Insight added to UI queue:', insight.coreKeywords)
        }

        set({ isAutoAnalyzing: false, lastAnalysisTime: Date.now() })
        return intentTrigger
      }

      console.log('[Observer] No significant pattern detected')
      set({ isAutoAnalyzing: false, lastAnalysisTime: Date.now() })  // #7: 成功后设置
      return null

    } catch (error) {
      console.warn('[Observer] Analysis failed:', error)
      return null
    } finally {
      set({ isAutoAnalyzing: false })
    }
  },

  createProposal: (trigger) => {
    const boundSkillIds = trigger.suggestedSkills || []

    // ── 工具维度去重（保留原有逻辑）──
    if (get().checkDuplicateDun(boundSkillIds)) {
      console.log('[Observer] Skipping proposal - duplicate Dun (skill overlap)')
      return
    }

    // ── 意图维度去重 [Q3] (#12: 从 store 读取) ──
    if (trigger.discoveredObjective) {
      const dunesMap = getDunsFromStore()
      if (dunesMap) {
        for (const dun of dunesMap.values()) {
          const existingText = dun.objective || dun.label || ''
          if (!existingText) continue
          const similarity = ngramSimilarity(trigger.discoveredObjective, existingText)
          if (similarity > 0.6) {
            console.log(`[Observer] Skipping proposal - duplicate objective (similarity: ${similarity.toFixed(2)})`)
            return
          }
        }
      }
    }

    // ── 拒绝冷却检查（使用更精确的键：type + 名称签名）──
    const { rejectedPatterns } = get()
    const specificKey = trigger.suggestedName ? `${trigger.type}:${trigger.suggestedName}` : null
    const typeRejection = rejectedPatterns.get(trigger.type)
    const specificRejection = specificKey ? rejectedPatterns.get(specificKey) : null
    const lastRejection = Math.max(typeRejection || 0, specificRejection || 0)
    if (lastRejection && Date.now() - lastRejection < REJECTION_COOLDOWN_MS) {
      console.log(`[Observer] Skipping proposal - ${trigger.type}${trigger.suggestedName ? ':' + trigger.suggestedName : ''} was recently rejected`)
      return
    }

    // ── 生成提案 ──
    const proposalId = generateId()
    let suggestedName: string
    let purposeSummary: string

    if (trigger.discoveredObjective) {
      // 意图驱动：使用意图信息（可能已被 LLM 合成增强）
      suggestedName = trigger.suggestedName || generateMeaningfulName(trigger)

      // ★ 兜底校验：即使 LLM 合成失败，也不产出垃圾名称
      const hasNoiseChars = /[[\]·*—…~`!@#$%^&()+={}|\\/<>]/.test(suggestedName)
      const isTooLong = suggestedName.length > 8
      if (hasNoiseChars || isTooLong) {
        suggestedName = generateMeaningfulName(trigger)
      }

      purposeSummary = trigger.discoveredObjective
    } else {
      // 兜底：旧逻辑（LLM 引擎产出的）
      const nameFromEvidence = trigger.evidence.find(e => e.startsWith('建议名称:'))
      suggestedName = nameFromEvidence
        ? nameFromEvidence.replace('建议名称:', '').trim()
        : generateMeaningfulName(trigger)
      if (/^[A-Z0-9-_]+$/.test(suggestedName) || suggestedName.length > 10) {
        suggestedName = generateMeaningfulName(trigger)
      }
      purposeSummary = generatePurposeSummary(trigger)
    }

    const sopContent = trigger.suggestedSOP || ''

    const proposal: BuildProposal = {
      id: proposalId,
      triggerPattern: trigger,
      suggestedName,
      previewVisualDNA: generateVisualDNASync(proposalId),
      purposeSummary,
      boundSkillIds,
      sopContent,
      suggestedObjective: trigger.discoveredObjective || '',
      suggestedTriggers: trigger.suggestedTriggers || [],
      suggestedMetrics: trigger.suggestedMetrics || [],
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
    
    // 接受提案后，标记相关 trace 为已消费，防止同一 trace 再次触发提案
    const trigger = currentProposal.triggerPattern
    if (trigger.intentCluster) {
      const consumed = loadConsumedTraceIds()
      for (const traceId of trigger.intentCluster.traceIds) {
        consumed.add(traceId)
      }
      saveConsumedTraceIds(consumed)
    }
    
    set({ currentProposal: accepted })
    return accepted
  },

  rejectProposal: () => {
    const { currentProposal, rejectedPatterns } = get()
    if (!currentProposal) return
    
    // 记录拒绝：同时标记具体签名和类型，防止同一模式冷却后再次触发
    const trigger = currentProposal.triggerPattern
    const patternType = trigger.type
    const newRejectedPatterns = new Map(rejectedPatterns)
    newRejectedPatterns.set(patternType, Date.now())
    // 额外标记具体名称签名（更精确的冷却）
    if (trigger.suggestedName) {
      newRejectedPatterns.set(`${patternType}:${trigger.suggestedName}`, Date.now())
    }
    // 被拒绝的提案中的 trace 也标记为已消费，防止重复触发
    if (trigger.intentCluster) {
      const consumed = loadConsumedTraceIds()
      for (const traceId of trigger.intentCluster.traceIds) {
        consumed.add(traceId)
      }
      saveConsumedTraceIds(consumed)
    }
    
    set({
      currentProposal: {
        ...currentProposal,
        status: 'rejected',
      },
      rejectedPatterns: newRejectedPatterns,
    })
    
    console.log(`[Observer] Proposal rejected, pattern "${patternType}${trigger.suggestedName ? ':' + trigger.suggestedName : ''}" on cooldown for ${REJECTION_COOLDOWN_MS / 1000}s`)
    
    setTimeout(() => {
      set({ currentProposal: null })
    }, 500)
  },

  clearProposal: () => {
    set({ currentProposal: null })
  },

  // ── Skill 提案操作 [Q8] ──

  acceptSkillProposal: async () => {
    const { currentSkillProposal, rejectedSkillPatterns } = get()
    if (!currentSkillProposal || currentSkillProposal.status !== 'pending') return null

    // 先标记为 accepted，让 UI 立即响应
    const accepted: SkillProposal = {
      ...currentSkillProposal,
      status: 'accepted',
    }
    set({ currentSkillProposal: accepted })

    // 调用后端 API 真正创建技能
    try {
      const skillName = currentSkillProposal.suggestedName
        .replace(/[^a-zA-Z0-9_\-]/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || `skill-${Date.now()}`

      const response = await fetch(`${SERVER_URL}/skills/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: skillName,
          description: currentSkillProposal.description,
          type: 'instruction',
        }),
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        console.warn('[Observer] Failed to create skill:', errorData.error || response.status)
        
        // 409 Conflict: 技能已存在，标记为 rejected 并加入冷却列表，防止再次提案
        if (response.status === 409) {
          const rejectKey = `${currentSkillProposal.discoveryType}:${currentSkillProposal.tools.sort().join(',')}`
          const newPatterns = new Map(rejectedSkillPatterns)
          newPatterns.set(rejectKey, Date.now())
          set({
            currentSkillProposal: { ...currentSkillProposal, status: 'rejected' },
            rejectedSkillPatterns: newPatterns,
          })
          console.log(`[Observer] Skill already exists (409), pattern "${rejectKey}" added to cooldown`)
          setTimeout(() => set({ currentSkillProposal: null }), 500)
          return null
        }
        
        // 其他错误（网络、500等），恢复为 pending 让用户可以重试
        set({ currentSkillProposal: { ...currentSkillProposal, status: 'pending' } })
        return null
      }

      console.log('[Observer] Skill created successfully:', skillName)
    } catch (error) {
      console.warn('[Observer] Skill creation network error:', error)
      // 网络错误，恢复为 pending
      set({ currentSkillProposal: { ...currentSkillProposal, status: 'pending' } })
      return null
    }

    // 记录已接受的签名，防止同一模式再次触发
    const acceptKey = `${currentSkillProposal.discoveryType}:${currentSkillProposal.tools.sort().join(',')}`
    const newPatterns = new Map(rejectedSkillPatterns)
    newPatterns.set(acceptKey, Date.now())
    set({ rejectedSkillPatterns: newPatterns })

    // 延迟清除提案
    setTimeout(() => set({ currentSkillProposal: null }), 1000)

    return accepted
  },

  rejectSkillProposal: () => {
    const { currentSkillProposal, rejectedSkillPatterns } = get()
    if (!currentSkillProposal) return

    // 记录拒绝签名：discoveryType + tools 组合 [Q8]
    const rejectKey = `${currentSkillProposal.discoveryType}:${[...currentSkillProposal.tools].sort().join(',')}`
    const newRejected = new Map(rejectedSkillPatterns)
    newRejected.set(rejectKey, Date.now())

    set({
      currentSkillProposal: { ...currentSkillProposal, status: 'rejected' },
      rejectedSkillPatterns: newRejected,
    })

    console.log(`[Observer] Skill proposal rejected, key "${rejectKey}" on cooldown for ${SKILL_REJECTION_COOLDOWN_MS / 1000}s`)

    setTimeout(() => set({ currentSkillProposal: null }), 500)
  },

  clearSkillProposal: () => {
    set({ currentSkillProposal: null })
  },

  /**
   * 检查是否已存在相似的 Dun（基于技能重叠度）
   * #12: 从 Zustand store 读取 dunes
   */
  checkDuplicateDun: (suggestedSkills: string[]) => {
    const dunesMap = getDunsFromStore()
    if (!dunesMap || dunesMap.size === 0) return false
    
    // 检查是否有 Dun 的技能与建议技能高度重叠
    for (const dun of dunesMap.values()) {
      const existingSkills = dun.boundSkillIds || []
      if (existingSkills.length === 0) continue
      
      // 计算重叠度
      const overlap = suggestedSkills.filter(s => existingSkills.includes(s)).length
      const overlapRatio = overlap / Math.max(suggestedSkills.length, 1)
      
      if (overlapRatio >= 0.5) {
        console.log(`[Observer] Found duplicate Dun "${dun.label}" with ${Math.round(overlapRatio * 100)}% skill overlap`)
        return true
      }
    }
    
    return false
  },
  
  // Panel Actions
  openDunPanel: (dunId) => {
    set({
      dunPanelOpen: true,
      selectedDunForPanel: dunId,
    })
  },

  openDunPanelWithInput: (dunId, input) => {
    set({
      dunPanelOpen: true,
      selectedDunForPanel: dunId,
      pendingDunChatInput: input,
    })
  },

  closeDunPanel: () => {
    set({
      dunPanelOpen: false,
      selectedDunForPanel: null,
      pendingDunChatInput: null,
    })
  },

  clearPendingInput: () => {
    set({ pendingDunChatInput: null })
  },

  // ── 洞察 Actions ──

  dismissInsight: (id) => {
    set((state) => ({
      insights: state.insights.filter(i => i.id !== id),
    }))
  },

  createDunFromInsight: (id) => {
    const insight = get().insights.find(i => i.id === id)
    if (!insight) return
    // 将洞察数据存入 store，由 UI 层读取并打开 CreateDunModal
    set((state) => ({
      insightForDunCreation: insight,
      insights: state.insights.filter(i => i.id !== id),
    }))
  },

  enhanceDunFromInsight: async (id) => {
    const insight = get().insights.find(i => i.id === id)
    if (!insight || !insight.relatedDunId) return

    const mostCommonChain = (() => {
      const chainSigs: Record<string, number> = {}
      for (const chain of insight.cluster.toolChains) {
        const sig = chain.join('→')
        chainSigs[sig] = (chainSigs[sig] || 0) + 1
      }
      return Object.entries(chainSigs).sort(([, a], [, b]) => b - a)[0]?.[0] || ''
    })()

    const keyInsight = [
      `近 ${insight.cluster.timeSpanDays} 天检测到 ${insight.cluster.size} 次相似执行。`,
      `常用工具链：${mostCommonChain}（成功率 ${Math.round(insight.cluster.successRate * 100)}%）。`,
      `代表性任务：${insight.representativeTask.slice(0, 100)}`,
    ].join('')

    try {
      const dunName = insight.relatedDunLabel || insight.relatedDunId
      const response = await fetch(`${SERVER_URL}/duns/${encodeURIComponent(dunName)}/experience`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: 'Observer 行为模式洞察',
          tools_used: insight.suggestedSkills,
          outcome: 'success',
          key_insight: keyInsight,
        }),
      })

      if (response.ok) {
        console.log(`[Observer] Enhanced Dun "${dunName}" with insight experience`)
      } else {
        console.warn(`[Observer] Failed to enhance Dun: ${response.status}`)
      }
    } catch (err) {
      console.warn('[Observer] Failed to enhance Dun:', err)
    }

    // 移除已行动的洞察
    set((state) => ({
      insights: state.insights.filter(i => i.id !== id),
    }))
  },

  clearInsightForDunCreation: () => {
    set({ insightForDunCreation: null })
  },

  /**
   * 从当前对话生成 Dun 提案（手动触发）
   */
  generateDunFromChat: async (messages) => {
    const { isUserAnalyzing, currentProposal } = get()  // #6: 使用 isUserAnalyzing
    if (isUserAnalyzing || currentProposal?.status === 'pending') return

    // 过滤有效对话（排除系统消息和空消息）
    const validMessages = messages.filter(
      m => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
    )
    if (validMessages.length < 2) {
      console.warn('[Observer] Not enough messages to generate Dun')
      return
    }

    set({ isUserAnalyzing: true })  // #6: 使用 isUserAnalyzing
    console.log('[Observer] Generating Dun from chat...')

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

      const response = await chatBackground(
        [
          { role: 'system', content: CHAT_TO_DUN_PROMPT },
          { role: 'user', content: `以下是用户与 AI 的对话记录：\n\n${conversationText}\n\n请分析并提炼。` }
        ],
        { priority: 8 },
      )

      if (!response) {
        console.warn('[Observer] chatBackground returned null (rate-limited or failed)')
        return
      }

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[Observer] Invalid JSON from chat analysis')
        return
      }

      const result = JSON.parse(jsonMatch[0])
      console.log('[Observer] Chat analysis result:', result)

      if (!result.canCreate) {
        console.log('[Observer] Chat not suitable for Dun:', result.reason)
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
      console.log('[Observer] Dun proposal created from chat')
    } catch (error) {
      console.warn('[Observer] Failed to generate Dun from chat:', error)
    } finally {
      set({ isUserAnalyzing: false })  // #6: 使用 isUserAnalyzing
    }
  },

  /**
   * 观察者分析对话，返回结果供建构者（CreateDunModal）使用
   * 这是 Observer → Builder 的核心桥接方法
   */
  analyzeConversationForBuilder: async (messages): Promise<DunAnalysisResult | null> => {
    const { isUserAnalyzing } = get()  // #6: 使用 isUserAnalyzing
    if (isUserAnalyzing) return null

    // 过滤有效对话
    const validMessages = messages.filter(
      m => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
    )
    
    if (validMessages.length < 2) {
      console.warn('[Observer] Not enough messages to analyze')
      return null
    }

    set({ isUserAnalyzing: true })  // #6: 使用 isUserAnalyzing
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

      const response = await chatBackground(
        [
          { role: 'system', content: CHAT_TO_DUN_PROMPT },
          { role: 'user', content: `以下是用户与 AI 的对话记录：\n\n${conversationText}\n\n请分析并提炼。` }
        ],
        { priority: 8 },
      )

      if (!response) {
        console.warn('[Observer] chatBackground returned null (rate-limited or failed)')
        return null
      }

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        console.warn('[Observer] Invalid JSON from chat analysis')
        return null
      }

      const result = JSON.parse(jsonMatch[0])
      console.log('[Observer] 📋 Analysis result for Builder:', result)

      if (!result.canCreate) {
        console.log('[Observer] Chat not suitable for Dun:', result.reason)
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
      set({ isUserAnalyzing: false })  // #6: 使用 isUserAnalyzing
    }
  },
})
