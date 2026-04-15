/**
 * Skill 发现引擎 — 从工具使用模式中发现可封装的 Skill
 *
 * 纯函数设计 [Q9]：不做任何 I/O，接收 traces + stats 作为参数。
 * 包含三条规则：frequency / dependency / cross-skill
 * complexity 规则已移至 nexusDiscoveryEngine [Q2]
 */

import type { ExecTrace, SkillProposal, TriggerPattern } from '@/types'

// ============================================
// 配置常量
// ============================================

export const SKILL_DISCOVERY_CONFIG = {
  FREQUENCY_THRESHOLD: 5,         // 同一工具调用 5+ 次触发
  FREQUENCY_DAYS: 7,              // 在 7 天内
  DEPENDENCY_MIN_OCCURRENCES: 3,  // 工具链出现 3+ 次
  MIN_TRACES_FOR_ANALYSIS: 5,     // 至少 5 条执行记录才分析
} as const

// ============================================
// 统计类型（与 observerSlice 中的 TraceStats 对齐）
// ============================================

export interface TraceStats {
  totalExecutions: number
  toolFrequency: Record<string, number>
  dunFrequency: Record<string, number>
  avgTurnsPerExecution: number
  totalErrors: number
  timeRangeDays: number
}

// ============================================
// 辅助函数
// ============================================

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** 提取工具调用序列作为"管道签名" */
function extractToolPipeline(trace: ExecTrace): string {
  return trace.tools.map(t => t.name).join('→')
}

// ============================================
// 规则 1: 频率触发 — 高频单工具
// ============================================

function detectFrequencyPattern(
  stats: TraceStats,
): SkillProposal | null {
  const topTools = Object.entries(stats.toolFrequency)
    .filter(([, count]) => count >= SKILL_DISCOVERY_CONFIG.FREQUENCY_THRESHOLD)
    .sort(([, a], [, b]) => b - a)

  if (topTools.length === 0) return null

  const [toolName, count] = topTools[0]
  const confidence = Math.min(0.5 + (count - SKILL_DISCOVERY_CONFIG.FREQUENCY_THRESHOLD) * 0.1, 0.9)
  const tools = topTools.slice(0, 3).map(([name]) => name)

  return {
    id: generateId(),
    discoveryType: 'tool_frequency',
    suggestedName: `${toolName} 快捷操作`,
    description: `将高频使用的 ${toolName} 等工具封装为专用技能，减少重复操作。`,
    tools,
    confidence,
    evidence: [
      `工具 "${toolName}" 在 ${SKILL_DISCOVERY_CONFIG.FREQUENCY_DAYS} 天内被调用 ${count} 次`,
      `高频工具: ${topTools.slice(0, 3).map(([name, cnt]) => `${name}(${cnt})`).join(', ')}`,
    ],
    status: 'pending',
    createdAt: Date.now(),
  }
}

// ============================================
// 规则 2: 依赖触发 — 重复工具链
// ============================================

function detectDependencyPattern(
  traces: ExecTrace[],
): SkillProposal | null {
  const pipelineFrequency: Record<string, number> = {}
  for (const trace of traces) {
    if (trace.tools.length >= 2) {
      const pipeline = extractToolPipeline(trace)
      pipelineFrequency[pipeline] = (pipelineFrequency[pipeline] || 0) + 1
    }
  }

  const frequentPipelines = Object.entries(pipelineFrequency)
    .filter(([, count]) => count >= SKILL_DISCOVERY_CONFIG.DEPENDENCY_MIN_OCCURRENCES)
    .sort(([, a], [, b]) => b - a)

  if (frequentPipelines.length === 0) return null

  const [pipeline, count] = frequentPipelines[0]
  const tools = pipeline.split('→')
  const confidence = Math.min(0.55 + count * 0.1, 0.85)

  return {
    id: generateId(),
    discoveryType: 'tool_chain',
    suggestedName: `${tools[0]}→${tools[tools.length - 1]} 流水线`,
    description: `将重复出现的工具链 "${pipeline}" 封装为一键执行的技能。`,
    tools,
    toolChainPattern: pipeline,
    confidence,
    evidence: [
      `工具链 "${pipeline}" 重复出现 ${count} 次`,
      `涉及工具: ${tools.join(', ')}`,
    ],
    status: 'pending',
    createdAt: Date.now(),
  }
}

// ============================================
// 规则 3: 跨技能成功检测 — 多工具组合
// ============================================

function detectCrossSkillPattern(
  traces: ExecTrace[],
): SkillProposal | null {
  const crossSkillTraces = traces.filter(trace => {
    if (!trace.success) return false
    const uniqueTools = new Set(trace.tools.map(tool => tool.name))
    return uniqueTools.size >= 2
  })

  if (crossSkillTraces.length < 2) return null

  const comboFrequency: Record<string, { count: number; tools: string[] }> = {}
  for (const trace of crossSkillTraces) {
    const toolNames = [...new Set(trace.tools.map(t => t.name))].sort()
    const comboKey = toolNames.join('+')
    if (!comboFrequency[comboKey]) {
      comboFrequency[comboKey] = { count: 0, tools: toolNames }
    }
    comboFrequency[comboKey].count++
  }

  const topCombo = Object.entries(comboFrequency)
    .filter(([, value]) => value.count >= 2)
    .sort(([, a], [, b]) => b.count - a.count)[0]

  if (!topCombo) return null

  const [, { count, tools }] = topCombo
  const confidence = Math.min(0.5 + count * 0.1, 0.85)

  return {
    id: generateId(),
    discoveryType: 'cross_tool',
    suggestedName: `${tools.slice(0, 2).join('×')} 协作`,
    description: `将 ${tools.join('、')} 的跨工具协作封装为一体化技能。`,
    tools,
    confidence,
    evidence: [
      `跨技能组合 "${tools.join(' + ')}" 成功执行 ${count} 次`,
      `涉及 ${tools.length} 个工具的协作模式`,
    ],
    status: 'pending',
    createdAt: Date.now(),
  }
}

// ============================================
// 兼容层: 生成 TriggerPattern（供 observerSlice 兜底使用）
// ============================================

/** 将 SkillProposal 转换为 TriggerPattern（兼容旧的 LLM 兜底路径） */
export function skillProposalToTriggerPattern(proposal: SkillProposal): TriggerPattern {
  const typeMap: Record<string, TriggerPattern['type']> = {
    'tool_frequency': 'frequency',
    'tool_chain': 'dependency',
    'cross_tool': 'cross-skill',
  }

  return {
    type: typeMap[proposal.discoveryType] || 'frequency',
    confidence: proposal.confidence,
    evidence: proposal.evidence,
    detectedAt: proposal.createdAt,
    suggestedSkills: proposal.tools,
    suggestedSOP: `你的核心任务是熟练使用 ${proposal.tools.join('、')} 工具。请根据用户的自然语言需求，选择合适的工具完成操作。`,
  }
}

// ============================================
// 公开 API — 纯函数 [Q9]
// ============================================

/**
 * 分析工具使用模式，返回 SkillProposal（如果检测到模式）
 *
 * 纯函数：不做任何 I/O，接收 traces + stats 作为参数。
 * 规则优先级：frequency > dependency > cross-skill
 */
export function analyzeToolPatterns(
  traces: ExecTrace[],
  stats: TraceStats,
): SkillProposal | null {
  if (traces.length < SKILL_DISCOVERY_CONFIG.MIN_TRACES_FOR_ANALYSIS) {
    return null
  }

  // 规则 1: 频率触发（高频单工具）
  const frequencyResult = detectFrequencyPattern(stats)
  if (frequencyResult) return frequencyResult

  // 规则 2: 依赖触发（重复工具链）
  const dependencyResult = detectDependencyPattern(traces)
  if (dependencyResult) return dependencyResult

  // 规则 3: 跨技能成功检测（多工具组合）
  const crossSkillResult = detectCrossSkillPattern(traces)
  if (crossSkillResult) return crossSkillResult

  return null
}
