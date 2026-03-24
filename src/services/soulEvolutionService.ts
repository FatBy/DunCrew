/**
 * SoulEvolutionService - 灵魂演化服务
 *
 * 核心编排层:
 * 1. onTraceCompleted() - 每次任务完成后累计，每 N 次触发跨 Nexus 模式检测
 * 2. triggerCheck()     - 聚合 Nexus 评分，发现跨域行为模式 → 调 LLM 萃取修正案
 * 3. applyDecay()       - 30 天半衰期衰减 + 自动归档
 * 4. refreshExpressedMBTI() - 重算 Layer 2 表达型 MBTI
 * 5. init() / destroy() - 生命周期管理
 */

import type { ExecTrace, SoulAmendment, NexusScoring } from '@/types'
import { SOUL_EVOLUTION_CONFIG } from '@/types'
import { nexusScoringService } from './nexusScoringService'
import { computeBehavioralModifiers, computeExpressedMBTI } from './mbtiAnalyzer'
import { chat, isLLMConfigured } from './llmService'

// ── 懒加载 store（打破循环依赖）────────────────
// 循环链: store/index → aiSlice → LocalClawService → 本文件 → store/index
// 用 dynamic import 在 init() 时缓存引用，后续同步访问
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _storeRef: { getState: () => any } | null = null

function getStore() {
  if (!_storeRef) throw new Error('[SoulEvolution] Store not initialized. Call init() first.')
  return _storeRef
}

// ── 内部状态 ─────────────────────────────────

/** 自上次检测以来的完成任务数 */
let tasksSinceLastCheck = 0

/** 衰减定时器 */
let decayIntervalId: ReturnType<typeof setInterval> | null = null

/** 上一次检测时间 (防抖) */
let lastCheckTimestamp = 0
const CHECK_COOLDOWN_MS = 60_000 // 最少间隔 1 分钟

// ── 对外 API ─────────────────────────────────

/**
 * 初始化: 加载修正案、执行衰减、启动定时器
 * 应在应用启动时调用一次
 */
export async function init(): Promise<void> {
  // 0. 懒加载 store（打破循环依赖）
  if (!_storeRef) {
    const { useStore } = await import('@/store')
    _storeRef = useStore
  }

  // 1. 加载已有修正案
  await getStore().getState().loadAmendments()

  // 2. 首次衰减
  getStore().getState().applyAmendmentDecay()

  // 3. 启动周期衰减 (默认 6 小时)
  if (decayIntervalId) clearInterval(decayIntervalId)
  decayIntervalId = setInterval(() => {
    getStore().getState().applyAmendmentDecay()
    refreshExpressedMBTI()
  }, SOUL_EVOLUTION_CONFIG.DECAY_INTERVAL_MS)

  console.log('[SoulEvolution] Initialized, decay interval =', SOUL_EVOLUTION_CONFIG.DECAY_INTERVAL_MS, 'ms')
}

/**
 * 销毁: 清理定时器
 */
export function destroy(): void {
  if (decayIntervalId) {
    clearInterval(decayIntervalId)
    decayIntervalId = null
  }
  tasksSinceLastCheck = 0
}

/**
 * 每次任务执行完成后调用
 * 累计计数 → 达到阈值时自动触发 triggerCheck
 */
export function onTraceCompleted(_trace: ExecTrace, _nexusId: string): void {
  tasksSinceLastCheck++

  // 每次任务完成后实时刷新表达型 MBTI（不依赖修正案）
  refreshExpressedMBTI()

  if (tasksSinceLastCheck >= SOUL_EVOLUTION_CONFIG.CHECK_INTERVAL_TASKS) {
    tasksSinceLastCheck = 0

    // 防抖: 过于频繁不重复检测
    const now = Date.now()
    if (now - lastCheckTimestamp < CHECK_COOLDOWN_MS) return
    lastCheckTimestamp = now

    // 异步检测，不阻塞主流程
    triggerCheck().catch((err) => {
      console.warn('[SoulEvolution] triggerCheck failed:', err)
    })
  }
}

// ── 核心: 跨 Nexus 模式检测 ─────────────────

/**
 * 聚合所有 Nexus 评分数据，检测跨域行为模式
 * 若发现显著模式 → LLM 萃取修正案 → 添加为 draft
 */
export async function triggerCheck(): Promise<void> {
  const scorings = nexusScoringService.getAllScorings()
  const nexusCount = scorings.length

  // 跨 Nexus 最小数量检查
  if (nexusCount < SOUL_EVOLUTION_CONFIG.MIN_NEXUS_COUNT) {
    console.log(`[SoulEvolution] Skip: only ${nexusCount} nexus(es), need >= ${SOUL_EVOLUTION_CONFIG.MIN_NEXUS_COUNT}`)
    return
  }

  // 收集行为信号
  const signals = detectBehavioralSignals(scorings)
  if (signals.length === 0) {
    console.log('[SoulEvolution] No significant behavioral signals detected')
    return
  }

  console.log(`[SoulEvolution] Detected ${signals.length} signal(s):`, signals.map(s => s.label))

  // 检查是否已存在相似修正案 (避免重复)
  const existingAmendments: SoulAmendment[] = getStore().getState().amendments
  const newSignals = signals.filter(
    (sig) => !existingAmendments.some(
      (a) => a.status === 'approved' && a.content.toLowerCase().includes(sig.label.toLowerCase()),
    ),
  )

  if (newSignals.length === 0) {
    console.log('[SoulEvolution] All signals already covered by existing amendments')
    return
  }

  // LLM 萃取自然语言修正案
  for (const signal of newSignals) {
    try {
      const amendment = await extractAmendment(signal, scorings)
      if (amendment) {
        getStore().getState().addDraft(amendment)
        console.log(`[SoulEvolution] Draft amendment created: "${amendment.content}"`)
      }
    } catch (err) {
      console.warn('[SoulEvolution] extractAmendment failed for signal:', signal.label, err)
    }
  }

  // 刷新表达型 MBTI
  refreshExpressedMBTI()
}

// ── 行为信号检测 ─────────────────────────────

interface BehavioralSignal {
  label: string           // 信号标签 (用于去重 + LLM prompt)
  type: 'tool_preference' | 'success_pattern' | 'style_shift'
  evidence: string[]      // 证据摘要 (<=3)
  nexusIds: string[]      // 来源 Nexus
  strength: number        // 信号强度 0~1
}

/**
 * 从所有 Nexus 评分中提取跨域行为信号
 */
function detectBehavioralSignals(
  scorings: Array<{ nexusId: string; scoring: NexusScoring }>,
): BehavioralSignal[] {
  const signals: BehavioralSignal[] = []

  // --- 1. 工具偏好信号: 某工具在多个 Nexus 中使用频率异常高 ---
  const toolAggregates = new Map<string, { totalCalls: number; nexusIds: string[]; successRate: number; totalSuccess: number }>()

  for (const { nexusId, scoring } of scorings) {
    for (const [toolName, dim] of Object.entries(scoring.dimensions)) {
      const agg = toolAggregates.get(toolName) || { totalCalls: 0, nexusIds: [], successRate: 0, totalSuccess: 0 }
      agg.totalCalls += dim.calls
      agg.totalSuccess += dim.successes
      if (!agg.nexusIds.includes(nexusId)) agg.nexusIds.push(nexusId)
      toolAggregates.set(toolName, agg)
    }
  }

  let grandTotalCalls = 0
  for (const agg of toolAggregates.values()) {
    grandTotalCalls += agg.totalCalls
    agg.successRate = agg.totalCalls > 0 ? agg.totalSuccess / agg.totalCalls : 0
  }

  if (grandTotalCalls > SOUL_EVOLUTION_CONFIG.TOOL_PREF_MIN_TOTAL_CALLS) {
    for (const [toolName, agg] of toolAggregates.entries()) {
      // 跨 Nexus 使用 + 占比 > 15% → 工具偏好信号
      if (agg.nexusIds.length >= SOUL_EVOLUTION_CONFIG.TOOL_PREF_MIN_NEXUS_SPREAD && agg.totalCalls / grandTotalCalls > 0.15) {
        signals.push({
          label: `heavy_${toolName}_usage`,
          type: 'tool_preference',
          evidence: [
            `${toolName} called ${agg.totalCalls} times across ${agg.nexusIds.length} nexuses`,
            `Accounts for ${(agg.totalCalls / grandTotalCalls * 100).toFixed(0)}% of all tool calls`,
            `Success rate: ${(agg.successRate * 100).toFixed(0)}%`,
          ],
          nexusIds: agg.nexusIds,
          strength: Math.min(1, agg.totalCalls / grandTotalCalls * 2),
        })
      }
    }
  }

  // --- 2. 成功模式信号: 所有 Nexus 的平均成功率极端偏高/低 ---
  if (scorings.length >= SOUL_EVOLUTION_CONFIG.SUCCESS_PATTERN_MIN_SCORINGS) {
    const avgSuccess = scorings.reduce((sum, s) => sum + s.scoring.successRate, 0) / scorings.length
    const totalRuns = scorings.reduce((sum, s) => sum + s.scoring.totalRuns, 0)

    if (totalRuns >= 10) {
      if (avgSuccess > 0.85) {
        signals.push({
          label: 'consistently_high_success',
          type: 'success_pattern',
          evidence: [
            `Average success rate: ${(avgSuccess * 100).toFixed(0)}% across ${scorings.length} nexuses`,
            `Total runs: ${totalRuns}`,
          ],
          nexusIds: scorings.map(s => s.nexusId),
          strength: Math.min(1, (avgSuccess - 0.7) * 3),
        })
      } else if (avgSuccess < 0.35) {
        signals.push({
          label: 'consistently_low_success',
          type: 'success_pattern',
          evidence: [
            `Average success rate: ${(avgSuccess * 100).toFixed(0)}% across ${scorings.length} nexuses`,
            `Total runs: ${totalRuns}`,
          ],
          nexusIds: scorings.map(s => s.nexusId),
          strength: Math.min(1, (0.5 - avgSuccess) * 3),
        })
      }
    }
  }

  // --- 3. 风格偏移信号: 某类工具在最近 runs 中比例显著变化 ---
  const recentToolCounts = new Map<string, number>()
  let recentTotal = 0

  for (const { scoring } of scorings) {
    for (const run of scoring.recentRuns.slice(-10)) {
      for (const tool of run.toolsCalled) {
        recentToolCounts.set(tool, (recentToolCounts.get(tool) || 0) + 1)
        recentTotal++
      }
    }
  }

  if (recentTotal > 5 && grandTotalCalls > SOUL_EVOLUTION_CONFIG.STYLE_SHIFT_MIN_TOTAL_CALLS) {
    for (const [toolName, recentCount] of recentToolCounts.entries()) {
      const historicalAgg = toolAggregates.get(toolName)
      if (!historicalAgg) continue

      const recentRatio = recentCount / recentTotal
      const historicalRatio = historicalAgg.totalCalls / grandTotalCalls

      // 近期使用比例明显上升 (差距 > 10 个百分点)
      if (recentRatio - historicalRatio > 0.10 && recentCount >= 3) {
        signals.push({
          label: `increasing_${toolName}_trend`,
          type: 'style_shift',
          evidence: [
            `${toolName} recent usage: ${(recentRatio * 100).toFixed(0)}% (was ${(historicalRatio * 100).toFixed(0)}%)`,
            `Shift detected across recent runs`,
          ],
          nexusIds: historicalAgg.nexusIds,
          strength: Math.min(1, (recentRatio - historicalRatio) * 5),
        })
      }
    }
  }

  // 按强度排序，只返回最显著的 (最多 3 个)
  return signals
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 3)
}

// ── LLM 萃取 ────────────────────────────────

/**
 * 将统计信号交给 LLM 提炼为自然语言偏好修正案
 * 返回 null 表示 LLM 不可用或萃取失败
 */
async function extractAmendment(
  signal: BehavioralSignal,
  scorings: Array<{ nexusId: string; scoring: NexusScoring }>,
): Promise<SoulAmendment | null> {
  if (!isLLMConfigured()) {
    // LLM 不可用 → 降级为模板生成
    return createTemplateAmendment(signal)
  }

  const evidenceBlock = signal.evidence.map((e, i) => `${i + 1}. ${e}`).join('\n')
  const scoringSummary = scorings.slice(0, 5).map(s =>
    `- Nexus "${s.nexusId}": score=${s.scoring.score}, runs=${s.scoring.totalRuns}, success=${(s.scoring.successRate * 100).toFixed(0)}%`,
  ).join('\n')

  const prompt = `You are analyzing behavioral patterns of an AI agent across multiple workspaces (called "Nexuses").

## Detected Signal
Type: ${signal.type}
Label: ${signal.label}
Evidence:
${evidenceBlock}

## Nexus Scoring Summary
${scoringSummary}

## Task
Based on this behavioral pattern, write a concise user preference statement (1 sentence, in Chinese) that describes what this agent's user seems to prefer.
Examples of good outputs:
- "偏好使用命令行工具直接操作，而非图形界面"
- "倾向于先搜索再执行，谨慎验证型工作风格"
- "高频使用文件读写，偏好代码级别的精细操作"

Return ONLY a JSON object: {"preference":"<your statement>","confidence":0.0-1.0}
Do not include any other text.`

  try {
    const result = await chat([
      { role: 'system', content: 'You are a behavioral analyst. Output ONLY valid JSON.' },
      { role: 'user', content: prompt },
    ])

    const match = result.match(/\{[\s\S]*?"preference"\s*:\s*"([^"]+)"[\s\S]*?"confidence"\s*:\s*([\d.]+)[\s\S]*?\}/)
    if (!match) {
      console.warn('[SoulEvolution] LLM extraction failed to parse:', result.slice(0, 200))
      return createTemplateAmendment(signal)
    }

    const preference = match[1]
    const confidence = parseFloat(match[2])

    if (!preference || preference.length < 4 || confidence < 0.3) {
      return null
    }

    return buildAmendment(preference, signal)
  } catch (err) {
    console.warn('[SoulEvolution] LLM extraction error:', err)
    return createTemplateAmendment(signal)
  }
}

/**
 * 降级方案: 无 LLM 时基于模板生成修正案
 */
function createTemplateAmendment(signal: BehavioralSignal): SoulAmendment {
  const templates: Record<BehavioralSignal['type'], (label: string) => string> = {
    tool_preference: (label) => {
      const toolName = label.replace('heavy_', '').replace('_usage', '')
      return `高频使用 ${toolName} 工具，偏好此类操作方式`
    },
    success_pattern: (label) => {
      if (label.includes('high')) return '任务完成率持续走高，当前工作方式高效'
      return '任务成功率偏低，可能需要调整执行策略'
    },
    style_shift: (label) => {
      const toolName = label.replace('increasing_', '').replace('_trend', '')
      return `近期 ${toolName} 使用频率上升，工作风格正在转变`
    },
  }

  const content = templates[signal.type](signal.label)
  return buildAmendment(content, signal)
}

/**
 * 构建 SoulAmendment 对象
 */
function buildAmendment(content: string, signal: BehavioralSignal): SoulAmendment {
  const now = Date.now()
  return {
    id: `amend-${now}-${Math.random().toString(36).slice(2, 8)}`,
    content,
    source: {
      nexusIds: signal.nexusIds.slice(0, 5),
      evidence: signal.evidence.slice(0, 3),
      detectedAt: now,
    },
    status: 'draft',
    weight: SOUL_EVOLUTION_CONFIG.INITIAL_DRAFT_WEIGHT,
    hitCount: 0,
    createdAt: now,
  }
}

// ── 表达型 MBTI 刷新 ─────────────────────────

/**
 * 重新计算行为修正 → 表达型 MBTI
 * 当修正案变化或衰减发生后调用
 */
export function refreshExpressedMBTI(): void {
  const state = getStore().getState()
  const base = state.soulMBTIBase
  if (!base) return

  // 收集所有 Nexus 评分
  const scoringMap: Record<string, NexusScoring> = {}
  const nexuses = state.nexuses
  for (const [id, nexus] of nexuses.entries()) {
    if (nexus.scoring) {
      scoringMap[id] = nexus.scoring
    }
  }

  // 计算行为修正因子
  const amendments = state.amendments
  const modifiers = computeBehavioralModifiers(scoringMap, amendments)

  // 合成表达型
  const { result, axes } = computeExpressedMBTI(base, modifiers)

  // 更新 store
  state.updateExpressedMBTI(result, axes)

  if (base.type !== result.type) {
    console.log(`[SoulEvolution] MBTI drift: ${base.type.toUpperCase()} → ${result.type.toUpperCase()}`)
  }
}

// ── 导出单例 API ─────────────────────────────

export const soulEvolutionService = {
  init,
  destroy,
  onTraceCompleted,
  triggerCheck,
  refreshExpressedMBTI,
}
