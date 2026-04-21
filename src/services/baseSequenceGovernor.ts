/**
 * Base Sequence Governor — 碱基序列自适应闭环调节器 (v2)
 *
 * 三层架构，全部纯代码，不依赖任何 LLM：
 *
 * Layer 1 (在线规则引擎):
 *   在 ReAct 循环每轮结束时评估 baseSequenceEntries，
 *   触发时返回 prompt 注入文本，引导 LLM 调整策略。
 *   v2: 7 条规则 + 8 维特征 + 干预模式库查询
 *
 * Layer 2 (统计累加器):
 *   每次 ExecTrace 保存后，按特征分桶累加 (成功次数, 总次数)，
 *   同时记录干预事件，为 Layer 3 提供 A/B 对比数据。
 *
 * Layer 3 (阈值自适应):
 *   每 N 条 trace 触发一次，用卡方检验对比干预组 vs 未干预组，
 *   仅在统计显著时调整阈值，否则保持现状（安全阀）。
 *   v2: 反事实预测辅助决策
 *
 * 类比：空调恒温器 — 传感器(碱基分类器) + 规则(if/else) + 执行器(prompt注入)
 */

import type { BaseType } from '@/utils/baseClassifier'
import type { DiscoveredRule } from './ruleTypes'
import { extractFeaturesV2, matchCondition, interpolateTemplate } from './featureRegistry'

// ============================================
// 类型定义
// ============================================

/** 碱基序列条目（与 types.ts 中 BaseSequenceEntry 兼容的最小子集） */
interface BaseEntry {
  base: BaseType
  order: number
}

/** Layer 1 规则评估结果 */
export interface GovernorSignal {
  /** 是否触发了任何规则 */
  triggered: boolean
  /** 注入到 LLM 上下文的提示文本（空字符串 = 无干预） */
  promptInjection: string
  /** 触发的规则名称列表（用于 trace 记录） */
  triggeredRules: string[]
  /** 当前预估成功率（基于分桶查表，0-1，-1 表示数据不足） */
  estimatedSuccessRate: number
  /** 触发时的特征快照（供 InterventionRecord 使用） */
  _features: FeatureSnapshot
}

/** 干预事件记录（嵌入 ExecTrace，供 Layer 2/3 使用） */
export interface InterventionRecord {
  /** 触发的规则名称 */
  rule: string
  /** 触发时的碱基步数 */
  stepIndex: number
  /** 触发时的特征快照 */
  features: FeatureSnapshot
  /** 反事实预测：触发时从分桶查表的"如果不干预"预估成功率 */
  counterfactualSuccessRate: number
}

/** 特征快照（8 维，O(n) 可计算） */
export interface FeatureSnapshot {
  // 原有 4 维
  consecutiveX: number
  stepCount: number
  xRatioLast5: number
  switchRate: number
  // v2 新增 4 维（基于 v2 数据分析发现）
  /** 后半段是否出现 P（后段 P → 77% vs 前段 100%） */
  pInLateHalf: boolean
  /** 最近 P 后是否接 V（P→V → 96.9% vs P→E → 80.8%） */
  lastPFollowedByV: boolean
  /** 最长连续 E run（>=3 → ~100%） */
  maxERunLength: number
  /** X/(X+E) 比值（<0.5 → 97%） */
  xeRatio: number
}

/** 分桶统计条目 */
interface BucketStats {
  successCount: number
  totalCount: number
}

/** 规则阈值配置（可被 Layer 3 动态调整） */
interface RuleThresholds {
  /** 连续 X 刹车阈值（默认 2，即连续 2 个 X 就触发） */
  consecutiveXBrake: number
  /** 序列长度熔断阈值（默认 12） */
  stepLengthFuse: number
  /** 切换频率警告阈值（默认 0.6） */
  switchRateWarning: number
  /** Layer 3 自适应触发间隔（每 N 条 trace） */
  adaptationInterval: number
  // v2 新增规则阈值
  /** 多样性崩溃检测窗口大小（默认 5） */
  diversityCollapseWindow: number
  /** 后期规划警告的位置比例阈值（默认 0.5） */
  latePlanningRatio: number
  /** 验证缺失检测的步数阈值（默认 3） */
  missingVerificationSteps: number
  /** 探索过度的 X/(X+E) 阈值（默认 0.7） */
  exploreDominanceRatio: number
  /** 探索过度的最小步数（默认 8） */
  exploreDominanceMinSteps: number
}

/** 干预模式库条目 */
interface PatternEntry {
  bucketKey: string
  sequenceSnapshot: string
  rule: string
  success: boolean
  recoveryPath?: string
}

/** 持久化的统计数据 */
export interface GovernorStats {
  /** 版本号（用于数据迁移） */
  version: number
  /** 分桶统计表：key = bucketKey, value = {successCount, totalCount} */
  buckets: Record<string, BucketStats>
  /** 干预效果统计：key = ruleName, value = {intervened: BucketStats, control: BucketStats} */
  interventionEffects: Record<string, { intervened: BucketStats; control: BucketStats }>
  /** 当前阈值 */
  thresholds: RuleThresholds
  /** 总 trace 计数（用于触发 Layer 3） */
  totalTraceCount: number
  /** 上次自适应时的 trace 计数 */
  lastAdaptationCount: number
  /** v2: 干预模式库（上限 200 条，FIFO 淘汰） */
  patternLibrary?: PatternEntry[]
  /** v2: 反事实预测累加（key = ruleName） */
  counterfactualAccumulator?: Record<string, { sumPredicted: number; sumActual: number; count: number }>
}

// ============================================
// 常量
// ============================================

const DEFAULT_THRESHOLDS: RuleThresholds = {
  consecutiveXBrake: 12,         // V4: 8→12，数据显示连续X 8~12次对成功率影响仅1pp(92%→93%)
  stepLengthFuse: 12,
  switchRateWarning: 0.6,
  adaptationInterval: 50,
  // v2 新增
  diversityCollapseWindow: 5,
  latePlanningRatio: 0.5,
  missingVerificationSteps: 3,
  exploreDominanceRatio: 0.55,   // V4: 0.7→0.55，原阈值太高几乎不触发，55%更贴近有害区间
  exploreDominanceMinSteps: 6,   // V4: 8→6，提前介入
}

/** 卡方检验临界值 (df=1, α=0.05) */
const CHI_SQUARE_CRITICAL_005 = 3.841

/** 最小样本量：低于此值不做自适应调整 */
const MIN_SAMPLE_FOR_ADAPTATION = 20

/** 模式库最大容量 */
const MAX_PATTERN_LIBRARY_SIZE = 200

/** 位置折扣衰减因子 */
const GAMMA = 0.9

const STATS_VERSION = 2

/** 全部 7 条规则名称 */
const ALL_RULE_NAMES = [
  'consecutive_x_brake',
  'step_length_fuse',
  'switch_rate_warning',
  'diversity_collapse',
  'late_planning_warning',
  'missing_verification',
  'explore_dominance',
]

// ============================================
// Layer 1: 在线规则引擎
// ============================================

/**
 * 从碱基序列中提取 8 维特征向量。
 * 所有计算均为 O(n)，n = 序列长度（通常 <25）。
 */
export function extractFeatures(entries: BaseEntry[]): FeatureSnapshot {
  if (entries.length === 0) {
    return {
      consecutiveX: 0, stepCount: 0, xRatioLast5: 0, switchRate: 0,
      pInLateHalf: false, lastPFollowedByV: false, maxERunLength: 0, xeRatio: 0,
    }
  }

  // 1. 连续 X 计数（从末尾往前数）
  let consecutiveX = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].base === 'X') consecutiveX++
    else break
  }

  // 2. 总步数
  const stepCount = entries.length

  // 3. 最近 5 步中 X 的占比
  const last5 = entries.slice(-5)
  const xCountLast5 = last5.filter(e => e.base === 'X').length
  const xRatioLast5 = last5.length > 0 ? xCountLast5 / last5.length : 0

  // 4. 切换频率（相邻碱基不同的次数 / 总步数）
  let switchCount = 0
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].base !== entries[i - 1].base) switchCount++
  }
  const switchRate = entries.length > 1 ? switchCount / (entries.length - 1) : 0

  // --- v2 新增 4 维 ---

  // 5. 后半段是否出现 P
  const halfIndex = Math.floor(entries.length / 2)
  let pInLateHalf = false
  for (let i = halfIndex; i < entries.length; i++) {
    if (entries[i].base === 'P') { pInLateHalf = true; break }
  }

  // 6. 最近 P 后是否接 V（P→V 黄金路径检测）
  let lastPFollowedByV = false
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].base === 'P') {
      lastPFollowedByV = i + 1 < entries.length && entries[i + 1].base === 'V'
      break
    }
  }

  // 7. 最长连续 E 游程
  let maxERunLength = 0
  let currentERun = 0
  for (const entry of entries) {
    if (entry.base === 'E') {
      currentERun++
      if (currentERun > maxERunLength) maxERunLength = currentERun
    } else {
      currentERun = 0
    }
  }

  // 8. X/(X+E) 比值
  let xCount = 0
  let eCount = 0
  for (const entry of entries) {
    if (entry.base === 'X') xCount++
    else if (entry.base === 'E') eCount++
  }
  const xeRatio = (xCount + eCount) > 0 ? xCount / (xCount + eCount) : 0

  return {
    consecutiveX, stepCount, xRatioLast5, switchRate,
    pInLateHalf, lastPFollowedByV, maxERunLength, xeRatio,
  }
}

/**
 * Layer 1: 评估当前碱基序列，返回干预信号。
 *
 * 在 ReAct 循环每轮工具执行完成后调用。
 * 纯代码 if/else，0ms 延迟，不调用任何模型。
 * v2: 7 条规则 + 8 维特征
 */
export function evaluateSequence(
  entries: BaseEntry[],
  thresholds: RuleThresholds = DEFAULT_THRESHOLDS,
  disabledRules?: Set<string>,
): GovernorSignal {
  const features = extractFeatures(entries)
  const triggeredRules: string[] = []
  const injections: string[] = []

  // 规则 1: 连续 X 刹车（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('consecutive_x_brake')
    && features.consecutiveX >= thresholds.consecutiveXBrake) {
    triggeredRules.push('consecutive_x_brake')
    injections.push(
      `[连续探索刹车] 已连续 ${features.consecutiveX} 次探索(X)未获实质进展。` +
      `请停止当前方向，换一个完全不同的策略。`
    )
  }

  // 规则 2: 序列长度熔断（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('step_length_fuse')
    && features.stepCount >= thresholds.stepLengthFuse) {
    triggeredRules.push('step_length_fuse')
    injections.push(
      `[序列长度熔断] 任务已执行 ${features.stepCount} 步，接近上限。` +
      `请尽快收敛到最终结果，避免继续发散。`
    )
  }

  // 规则 3: 切换频率警告（仅在步数 >= 5 时才有统计意义）
  if (!disabledRules?.has('switch_rate_warning')
    && features.stepCount >= 5 && features.switchRate > thresholds.switchRateWarning) {
    triggeredRules.push('switch_rate_warning')
    injections.push(
      `[策略一致性提示] 你的操作在不同方向之间频繁切换（切换率 ${(features.switchRate * 100).toFixed(0)}%）。` +
      `请集中精力在一个方向上深入推进，而不是反复跳跃。`
    )
  }

  // --- v2 新增规则 ---

  // 规则 4: 碱基多样性崩溃（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('diversity_collapse')
    && features.stepCount >= thresholds.diversityCollapseWindow * 2) {
    const window = entries.slice(-thresholds.diversityCollapseWindow)
    const uniqueBases = new Set(window.map(e => e.base))
    if (uniqueBases.size === 1) {
      triggeredRules.push('diversity_collapse')
      injections.push(
        `[多样性崩溃] 最近 ${thresholds.diversityCollapseWindow} 步全部是相同碱基类型(${window[0].base})。` +
        `这可能意味着陷入了重复循环，请尝试不同的操作类型。`
      )
    }
  }

  // 规则 5: 后期规划警告（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('late_planning_warning')
    && features.stepCount > thresholds.stepLengthFuse * thresholds.latePlanningRatio
    && entries.length > 0 && entries[entries.length - 1].base === 'P') {
    triggeredRules.push('late_planning_warning')
    injections.push(
      `[后期规划警告] 任务已执行 ${features.stepCount} 步（已过半），你仍在重新规划。` +
      `后期规划的成功率显著低于早期规划，请直接利用已有信息执行，而非再次调整方案。`
    )
  }

  // 规则 6: 验证缺失（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('missing_verification')
    && entries.length >= thresholds.missingVerificationSteps) {
    const recent = entries.slice(-thresholds.missingVerificationSteps)
    const hasV = recent.some(e => e.base === 'V')
    if (!hasV && recent.some(e => e.base === 'E')) {
      triggeredRules.push('missing_verification')
      injections.push(
        `[验证缺失提醒] 最近 ${thresholds.missingVerificationSteps} 步执行中没有验证(V)步骤。` +
        `建议在执行操作后添加验证确认结果正确。`
      )
    }
  }

  // 规则 7: 探索过度（默认禁用，可通过 UI 启用）
  if (!disabledRules?.has('explore_dominance')
    && features.stepCount >= thresholds.exploreDominanceMinSteps
    && features.xeRatio > thresholds.exploreDominanceRatio) {
    triggeredRules.push('explore_dominance')
    injections.push(
      `[探索过度] 探索与执行比 X/(X+E) = ${(features.xeRatio * 100).toFixed(0)}%，超过阈值 ${(thresholds.exploreDominanceRatio * 100).toFixed(0)}%。` +
      `探索过多可能导致效率低下，建议减少探索、增加直接执行。`
    )
  }

  const promptInjection = injections.length > 0
    ? injections.join('\n')
    : ''

  return {
    triggered: triggeredRules.length > 0,
    promptInjection,
    triggeredRules,
    estimatedSuccessRate: -1,
    _features: features,
  }
}

/**
 * 通用求值器：基于 JSON 规则（DiscoveredRule[]）评估碱基序列。
 *
 * 替代硬编码 evaluateSequence，规则来自 Python 发现管线或手动迁移。
 * 冲突解决：仅注入 |effectSizePP| 最大的一条规则。
 */
export function evaluateWithRules(
  entries: BaseEntry[],
  rules: DiscoveredRule[],
): GovernorSignal {
  const features = extractFeaturesV2(entries)
  const triggeredRules: string[] = []
  const injections: string[] = []

  // 仅评估未退休的规则
  const activeRules = rules.filter(r => r.lifecycle !== 'retired')

  // 收集所有命中的规则
  const hits: Array<{ rule: DiscoveredRule }> = []
  for (const rule of activeRules) {
    if (matchCondition(features, rule.condition)) {
      hits.push({ rule })
    }
  }

  // 冲突解决：仅注入最强的一条（max |effectSizePP|）
  if (hits.length > 0) {
    hits.sort((a, b) => Math.abs(b.rule.stats.effectSizePP) - Math.abs(a.rule.stats.effectSizePP))
    const strongest = hits[0]
    triggeredRules.push(strongest.rule.id)
    injections.push(interpolateTemplate(strongest.rule.action.promptTemplate, features))
  }

  // 将 V2 特征映射回旧版 FeatureSnapshot（兼容 InterventionRecord）
  const legacyFeatures: FeatureSnapshot = {
    consecutiveX: (features.consecutiveXTail as number) || 0,
    stepCount: (features.stepCount as number) || 0,
    xRatioLast5: (features.xRatioLast5 as number) || 0,
    switchRate: (features.switchRate as number) || 0,
    pInLateHalf: !!features.pInLateHalf,
    lastPFollowedByV: !!features.lastPFollowedByV,
    maxERunLength: (features.maxERunLength as number) || 0,
    xeRatio: (features.xeRatio as number) || 0,
  }

  return {
    triggered: triggeredRules.length > 0,
    promptInjection: injections.join('\n'),
    triggeredRules,
    estimatedSuccessRate: -1,
    _features: legacyFeatures,
  }
}

// ============================================
// Layer 2: 统计累加器
// ============================================

/**
 * 将特征快照映射到分桶 key。
 * 桶的粒度故意设计得较粗，避免稀疏问题。
 * 维持 4D 分桶（72 桶）不变 — 新增 4 维仅用于规则触发。
 */
function toBucketKey(features: FeatureSnapshot): string {
  const cxBucket = Math.min(features.consecutiveX, 3)
  const stepBucket = features.stepCount <= 4 ? 'S' : features.stepCount <= 11 ? 'M' : 'L'
  const xrBucket = features.xRatioLast5 < 0.4 ? 'lo' : features.xRatioLast5 <= 0.8 ? 'mi' : 'hi'
  const srBucket = features.switchRate <= 0.6 ? 'L' : 'H'

  return `${cxBucket}_${stepBucket}_${xrBucket}_${srBucket}`
}

/**
 * 创建空的统计数据。
 */
export function createEmptyStats(): GovernorStats {
  return {
    version: STATS_VERSION,
    buckets: {},
    interventionEffects: {},
    thresholds: { ...DEFAULT_THRESHOLDS },
    totalTraceCount: 0,
    lastAdaptationCount: 0,
    patternLibrary: [],
    counterfactualAccumulator: {},
  }
}

/**
 * Layer 2: 从一条完成的 trace 中更新统计数据。
 *
 * @param stats 当前统计数据（会被原地修改）
 * @param baseSequence 碱基序列字符串（如 "X-E-E-V-X"）
 * @param success 任务是否成功
 * @param interventions 本次执行中触发的干预记录
 * @returns 是否应触发 Layer 3 自适应
 */
export function updateStats(
  stats: GovernorStats,
  baseSequence: string,
  success: boolean,
  interventions: InterventionRecord[],
  /** 动态规则名列表（为空时 fallback 到硬编码 ALL_RULE_NAMES） */
  dynamicRuleNames?: string[],
): boolean {
  if (!baseSequence) return false

  const bases = baseSequence.split('-').filter(b => 'EPVX'.includes(b)) as BaseType[]
  if (bases.length === 0) return false

  const entries: BaseEntry[] = bases.map((base, index) => ({ base, order: index }))
  const features = extractFeatures(entries)
  const bucketKey = toBucketKey(features)

  // 更新分桶统计
  if (!stats.buckets[bucketKey]) {
    stats.buckets[bucketKey] = { successCount: 0, totalCount: 0 }
  }
  stats.buckets[bucketKey].totalCount++
  if (success) stats.buckets[bucketKey].successCount++

  // 更新干预效果统计（动态规则名列表）
  const triggeredRuleNames = new Set(interventions.map(i => i.rule))
  const ruleNames = dynamicRuleNames && dynamicRuleNames.length > 0 ? dynamicRuleNames : ALL_RULE_NAMES

  for (const ruleName of ruleNames) {
    if (!stats.interventionEffects[ruleName]) {
      stats.interventionEffects[ruleName] = {
        intervened: { successCount: 0, totalCount: 0 },
        control: { successCount: 0, totalCount: 0 },
      }
    }
    const effect = stats.interventionEffects[ruleName]
    if (triggeredRuleNames.has(ruleName)) {
      effect.intervened.totalCount++
      if (success) effect.intervened.successCount++
    } else {
      effect.control.totalCount++
      if (success) effect.control.successCount++
    }
  }

  // v2: 反事实预测累加
  if (!stats.counterfactualAccumulator) stats.counterfactualAccumulator = {}
  for (const intervention of interventions) {
    const acc = stats.counterfactualAccumulator[intervention.rule]
      || { sumPredicted: 0, sumActual: 0, count: 0 }
    if (intervention.counterfactualSuccessRate >= 0) {
      acc.sumPredicted += intervention.counterfactualSuccessRate
      acc.sumActual += success ? 1 : 0
      acc.count++
    }
    stats.counterfactualAccumulator[intervention.rule] = acc
  }

  // v2: 更新干预模式库
  if (!stats.patternLibrary) stats.patternLibrary = []
  for (const intervention of interventions) {
    const seqSnapshot = bases.slice(
      Math.max(0, intervention.stepIndex - 5),
      intervention.stepIndex,
    ).join('-')
    // 干预后的恢复路径（干预点之后的碱基）
    const recoveryBases = bases.slice(intervention.stepIndex)
    const recoveryPath = recoveryBases.length > 0 ? recoveryBases.join('-') : undefined

    stats.patternLibrary.push({
      bucketKey,
      sequenceSnapshot: seqSnapshot,
      rule: intervention.rule,
      success,
      recoveryPath,
    })
  }
  // FIFO 淘汰
  if (stats.patternLibrary.length > MAX_PATTERN_LIBRARY_SIZE) {
    stats.patternLibrary = stats.patternLibrary.slice(-MAX_PATTERN_LIBRARY_SIZE)
  }

  stats.totalTraceCount++

  const shouldAdapt = (stats.totalTraceCount - stats.lastAdaptationCount) >= stats.thresholds.adaptationInterval
  return shouldAdapt
}

/**
 * 从统计数据中查询预估成功率。
 * v2: 位置折扣权重 — fallback 查询时按桶接近度加权。
 */
export function lookupSuccessRate(stats: GovernorStats, entries: BaseEntry[]): number {
  const features = extractFeatures(entries)
  const bucketKey = toBucketKey(features)
  const bucket = stats.buckets[bucketKey]

  if (bucket && bucket.totalCount >= 3) {
    return bucket.successCount / bucket.totalCount
  }

  // Fallback: 位置折扣加权 — 按 consecutiveX 和 stepBucket 的接近度加权
  const cxBucket = Math.min(features.consecutiveX, 3)
  const stepBucket = features.stepCount <= 4 ? 'S' : features.stepCount <= 11 ? 'M' : 'L'

  let weightedSuccess = 0
  let weightedTotal = 0
  for (const [key, value] of Object.entries(stats.buckets)) {
    const parts = key.split('_')
    if (parts.length < 2) continue
    const keyCx = parseInt(parts[0])
    const keyStep = parts[1]

    // 计算接近度权重：consecutiveX 差距越小权重越高
    const cxDist = Math.abs(keyCx - cxBucket)
    const stepMatch = keyStep === stepBucket ? 1.0 : 0.5
    const weight = Math.pow(GAMMA, cxDist) * stepMatch

    weightedSuccess += value.successCount * weight
    weightedTotal += value.totalCount * weight
  }

  if (weightedTotal >= 3) {
    return weightedSuccess / weightedTotal
  }

  return -1 // 数据不足
}

/**
 * 从模式库查询历史经验。
 * 返回匹配的成功恢复路径（最多 1 条）。
 */
function queryPatternLibrary(
  patternLibrary: PatternEntry[] | undefined,
  rule: string,
  bucketKey: string,
): string | undefined {
  if (!patternLibrary || patternLibrary.length === 0) return undefined

  // 查询相同规则 + 优先匹配相同 bucketKey 的成功案例
  const candidates = patternLibrary.filter(
    p => p.rule === rule && p.success && p.recoveryPath
  )
  if (candidates.length === 0) return undefined

  // 优先精确匹配
  const exactMatch = candidates.find(p => p.bucketKey === bucketKey)
  if (exactMatch) return exactMatch.recoveryPath

  // 退而求其次：取最近一条
  return candidates[candidates.length - 1].recoveryPath
}

// ============================================
// Layer 3: 阈值自适应
// ============================================

/**
 * 卡方检验（2x2 列联表）。
 * 返回卡方统计量。
 */
function chiSquare(
  interventionSuccess: number,
  interventionFail: number,
  controlSuccess: number,
  controlFail: number,
): number {
  const a = interventionSuccess
  const b = interventionFail
  const c = controlSuccess
  const d = controlFail
  const n = a + b + c + d

  if (n === 0) return 0

  // Yates 校正的卡方检验
  const numerator = n * Math.pow(Math.abs(a * d - b * c) - n / 2, 2)
  const denominator = (a + b) * (c + d) * (a + c) * (b + d)

  if (denominator === 0) return 0
  return numerator / denominator
}

/**
 * 单条规则的自适应调整逻辑。
 * 返回调整说明（null = 无调整）。
 */
function adaptSingleRule(
  stats: GovernorStats,
  ruleName: string,
  adjustFn: (direction: 'tighten' | 'loosen') => string | null,
): string | null {
  const effect = stats.interventionEffects[ruleName]
  if (!effect) return null

  const { intervened, control } = effect
  if (intervened.totalCount < MIN_SAMPLE_FOR_ADAPTATION
    || control.totalCount < MIN_SAMPLE_FOR_ADAPTATION) {
    return null
  }

  const interventionRate = intervened.successCount / intervened.totalCount
  const controlRate = control.successCount / control.totalCount

  const chi2 = chiSquare(
    intervened.successCount,
    intervened.totalCount - intervened.successCount,
    control.successCount,
    control.totalCount - control.successCount,
  )

  if (chi2 < CHI_SQUARE_CRITICAL_005) return null

  // v2: 反事实辅助决策 — 如果反事实预测数据充足，参考预测与实际的差值
  const cfAcc = stats.counterfactualAccumulator?.[ruleName]
  let cfHint = ''
  if (cfAcc && cfAcc.count >= 10) {
    const avgPredicted = cfAcc.sumPredicted / cfAcc.count
    const avgActual = cfAcc.sumActual / cfAcc.count
    const delta = avgActual - avgPredicted
    cfHint = `, cf_delta=${delta.toFixed(2)}`
  }

  if (interventionRate > controlRate) {
    const result = adjustFn('tighten')
    return result ? `${result} (干预有效, χ²=${chi2.toFixed(1)}${cfHint})` : null
  } else if (interventionRate < controlRate) {
    const result = adjustFn('loosen')
    return result ? `${result} (干预无效, χ²=${chi2.toFixed(1)}${cfHint})` : null
  }
  return null
}

/**
 * Layer 3: 自适应调整阈值。
 * v2: 覆盖全部 7 条规则 + 反事实预测辅助。
 *
 * @returns 调整说明（空数组 = 无调整）
 */
export function adaptThresholds(stats: GovernorStats): string[] {
  const adjustments: string[] = []
  const t = stats.thresholds

  // 规则 1: consecutive_x_brake
  const adj1 = adaptSingleRule(stats, 'consecutive_x_brake', (dir) => {
    if (dir === 'tighten' && t.consecutiveXBrake > 1) {
      t.consecutiveXBrake = Math.max(1, t.consecutiveXBrake - 1)
      return `consecutive_x_brake: 收紧到 ${t.consecutiveXBrake}`
    } else if (dir === 'loosen' && t.consecutiveXBrake < 12) {
      t.consecutiveXBrake = Math.min(12, t.consecutiveXBrake + 1)
      return `consecutive_x_brake: 放宽到 ${t.consecutiveXBrake}`
    }
    return null
  })
  if (adj1) adjustments.push(adj1)

  // 规则 2: step_length_fuse
  const adj2 = adaptSingleRule(stats, 'step_length_fuse', (dir) => {
    if (dir === 'tighten' && t.stepLengthFuse > 8) {
      t.stepLengthFuse = Math.max(8, t.stepLengthFuse - 2)
      return `step_length_fuse: 收紧到 ${t.stepLengthFuse}`
    } else if (dir === 'loosen' && t.stepLengthFuse < 20) {
      t.stepLengthFuse = Math.min(20, t.stepLengthFuse + 2)
      return `step_length_fuse: 放宽到 ${t.stepLengthFuse}`
    }
    return null
  })
  if (adj2) adjustments.push(adj2)

  // 规则 3: switch_rate_warning
  const adj3 = adaptSingleRule(stats, 'switch_rate_warning', (dir) => {
    if (dir === 'tighten' && t.switchRateWarning > 0.4) {
      t.switchRateWarning = Math.max(0.4, t.switchRateWarning - 0.1)
      return `switch_rate_warning: 收紧到 ${t.switchRateWarning.toFixed(1)}`
    } else if (dir === 'loosen' && t.switchRateWarning < 0.8) {
      t.switchRateWarning = Math.min(0.8, t.switchRateWarning + 0.1)
      return `switch_rate_warning: 放宽到 ${t.switchRateWarning.toFixed(1)}`
    }
    return null
  })
  if (adj3) adjustments.push(adj3)

  // 规则 4: diversity_collapse
  const adj4 = adaptSingleRule(stats, 'diversity_collapse', (dir) => {
    if (dir === 'tighten' && t.diversityCollapseWindow > 3) {
      t.diversityCollapseWindow = Math.max(3, t.diversityCollapseWindow - 1)
      return `diversity_collapse: 收紧窗口到 ${t.diversityCollapseWindow}`
    } else if (dir === 'loosen' && t.diversityCollapseWindow < 8) {
      t.diversityCollapseWindow = Math.min(8, t.diversityCollapseWindow + 1)
      return `diversity_collapse: 放宽窗口到 ${t.diversityCollapseWindow}`
    }
    return null
  })
  if (adj4) adjustments.push(adj4)

  // 规则 5: late_planning_warning
  const adj5 = adaptSingleRule(stats, 'late_planning_warning', (dir) => {
    if (dir === 'tighten' && t.latePlanningRatio > 0.3) {
      t.latePlanningRatio = Math.max(0.3, t.latePlanningRatio - 0.1)
      return `late_planning_warning: 收紧比例到 ${t.latePlanningRatio.toFixed(1)}`
    } else if (dir === 'loosen' && t.latePlanningRatio < 0.8) {
      t.latePlanningRatio = Math.min(0.8, t.latePlanningRatio + 0.1)
      return `late_planning_warning: 放宽比例到 ${t.latePlanningRatio.toFixed(1)}`
    }
    return null
  })
  if (adj5) adjustments.push(adj5)

  // 规则 6: missing_verification
  const adj6 = adaptSingleRule(stats, 'missing_verification', (dir) => {
    if (dir === 'tighten' && t.missingVerificationSteps > 2) {
      t.missingVerificationSteps = Math.max(2, t.missingVerificationSteps - 1)
      return `missing_verification: 收紧步数到 ${t.missingVerificationSteps}`
    } else if (dir === 'loosen' && t.missingVerificationSteps < 6) {
      t.missingVerificationSteps = Math.min(6, t.missingVerificationSteps + 1)
      return `missing_verification: 放宽步数到 ${t.missingVerificationSteps}`
    }
    return null
  })
  if (adj6) adjustments.push(adj6)

  // 规则 7: explore_dominance
  const adj7 = adaptSingleRule(stats, 'explore_dominance', (dir) => {
    if (dir === 'tighten' && t.exploreDominanceRatio > 0.5) {
      t.exploreDominanceRatio = Math.max(0.5, t.exploreDominanceRatio - 0.1)
      return `explore_dominance: 收紧比例到 ${t.exploreDominanceRatio.toFixed(1)}`
    } else if (dir === 'loosen' && t.exploreDominanceRatio < 0.9) {
      t.exploreDominanceRatio = Math.min(0.9, t.exploreDominanceRatio + 0.1)
      return `explore_dominance: 放宽比例到 ${t.exploreDominanceRatio.toFixed(1)}`
    }
    return null
  })
  if (adj7) adjustments.push(adj7)

  stats.lastAdaptationCount = stats.totalTraceCount
  return adjustments
}

/**
 * 通用自适应：基于 A/B 统计对 DiscoveredRule 的阈值进行调整。
 * 仅当规则有 adaptationBounds 且 A/B 数据充足时才调整。
 *
 * @returns 被修改的规则列表（空 = 无调整）
 */
export function adaptDiscoveredRules(
  stats: GovernorStats,
  rules: DiscoveredRule[],
): DiscoveredRule[] {
  const modified: DiscoveredRule[] = []

  for (const rule of rules) {
    if (rule.lifecycle === 'retired') continue
    if (!rule.adaptationBounds) continue

    const effect = stats.interventionEffects[rule.id]
    if (!effect) continue

    const { intervened, control } = effect
    if (intervened.totalCount < MIN_SAMPLE_FOR_ADAPTATION
      || control.totalCount < MIN_SAMPLE_FOR_ADAPTATION) continue

    const interventionRate = intervened.successCount / intervened.totalCount
    const controlRate = control.successCount / control.totalCount

    const chi2 = chiSquare(
      intervened.successCount,
      intervened.totalCount - intervened.successCount,
      control.successCount,
      control.totalCount - control.successCount,
    )

    if (chi2 < CHI_SQUARE_CRITICAL_005) continue

    // 找到对应 adaptationBounds.feature 的条件子句
    const bounds = rule.adaptationBounds
    const clause = rule.condition.clauses.find(c => c.feature === bounds.feature)
    if (!clause) continue

    if (interventionRate > controlRate) {
      // 干预有效 → 收紧阈值（让更多 trace 命中）
      const newVal = clause.op.includes('>') 
        ? Math.max(bounds.min, clause.value - bounds.step)
        : Math.min(bounds.max, clause.value + bounds.step)
      if (newVal !== clause.value) {
        clause.value = Math.round(newVal * 10000) / 10000
        modified.push(rule)
      }
    } else {
      // 干预无效 → 放宽阈值（让更少 trace 命中）
      const newVal = clause.op.includes('>')
        ? Math.min(bounds.max, clause.value + bounds.step)
        : Math.max(bounds.min, clause.value - bounds.step)
      if (newVal !== clause.value) {
        clause.value = Math.round(newVal * 10000) / 10000
        modified.push(rule)
      }
    }
  }

  return modified
}

// ============================================
// Governor 单例服务
// ============================================

class BaseSequenceGovernor {
  private stats: GovernorStats = createEmptyStats()
  private serverUrl = ''
  private loaded = false
  /** 用户禁用的 legacy 规则名集合（从后端 /api/governor/rule-prefs 加载） */
  private disabledLegacyRules: Set<string> = new Set()
  /** 数据发现的规则（从后端 /api/discovered-rules 加载） */
  private discoveredRules: DiscoveredRule[] = []

  /**
   * 初始化：设置后端 URL，加载统计数据 + 规则配置。
   */
  async initialize(serverUrl: string): Promise<void> {
    this.serverUrl = serverUrl
    await this.loadStats()
    await this.loadRuleConfig()
  }

  /**
   * 加载用户规则偏好 + 数据发现规则。
   * 初始化时调用一次，UI 切换规则后可通过 reload() 重新加载。
   */
  private async loadRuleConfig(): Promise<void> {
    if (!this.serverUrl) return

    // 1. 加载 legacy 规则偏好
    try {
      const res = await fetch(`${this.serverUrl}/api/governor/rule-prefs`)
      if (res.ok) {
        const prefs = await res.json() as Record<string, boolean>
        this.disabledLegacyRules = new Set(
          Object.entries(prefs).filter(([, enabled]) => !enabled).map(([name]) => name)
        )
      }
    } catch {
      // 首次运行或后端未就绪，使用空集（全部启用 fallback）
    }

    // 2. 加载 discovered rules
    try {
      const res = await fetch(`${this.serverUrl}/api/discovered-rules`)
      if (res.ok) {
        const data = await res.json() as { rules: DiscoveredRule[] }
        this.discoveredRules = data.rules || []
      }
    } catch {
      // 容错
    }

    const legacyActive = 7 - this.disabledLegacyRules.size
    const discoveredActive = this.discoveredRules.filter(r => r.lifecycle !== 'retired').length
    console.log(`[Governor] Rules loaded: ${legacyActive} legacy active, ${discoveredActive} discovered active`)
  }

  /**
   * UI 切换规则后调用，重新从后端加载规则配置。
   */
  async reload(): Promise<void> {
    await this.loadRuleConfig()
  }

  /**
   * Layer 1: 评估当前碱基序列，返回干预信号。
   * 在 ReAct 循环每轮工具执行完成后调用。
   *
   * 双路径合并：
   * - 路径 1: Legacy 硬编码规则（受用户偏好 disabledLegacyRules 控制）
   * - 路径 2: 数据发现规则（受 lifecycle 字段控制）
   *
   * V8: 可选接受 BaseLedger，利用 LedgerFacts 避免重复干预
   */
  evaluate(entries: BaseEntry[], ledger?: { facts?: { failedApproaches?: string[] } }): GovernorSignal {
    // 路径 1: Legacy 规则（受用户 UI 开关控制）
    const legacySignal = evaluateSequence(entries, this.stats.thresholds, this.disabledLegacyRules)

    // 路径 2: 数据发现规则（受 lifecycle 控制，evaluateWithRules 内部过滤 retired）
    let discoveredSignal: GovernorSignal | null = null
    if (this.discoveredRules.length > 0) {
      discoveredSignal = evaluateWithRules(entries, this.discoveredRules)
    }

    // 合并信号
    const signal: GovernorSignal = {
      triggered: legacySignal.triggered || (discoveredSignal?.triggered ?? false),
      promptInjection: [
        legacySignal.promptInjection,
        discoveredSignal?.promptInjection || '',
      ].filter(Boolean).join('\n'),
      triggeredRules: [
        ...legacySignal.triggeredRules,
        ...(discoveredSignal?.triggeredRules || []),
      ],
      estimatedSuccessRate: -1,
      _features: legacySignal._features,
    }

    // 如果有足够的历史数据，附加预估成功率
    if (this.loaded && this.stats.totalTraceCount >= 10) {
      signal.estimatedSuccessRate = lookupSuccessRate(this.stats, entries)
    }

    // v2: 模式库查询 — 为触发的规则附加历史恢复经验
    if (signal.triggered && this.stats.patternLibrary && this.stats.patternLibrary.length > 0) {
      const bucketKey = toBucketKey(signal._features)
      const patternHints: string[] = []

      for (const rule of signal.triggeredRules) {
        const recoveryPath = queryPatternLibrary(this.stats.patternLibrary, rule, bucketKey)
        if (recoveryPath) {
          patternHints.push(
            `[历史经验] 类似 ${rule} 情况下，通过 ${recoveryPath} 路径成功解决。`
          )
        }
      }

      if (patternHints.length > 0) {
        signal.promptInjection = signal.promptInjection + '\n' + patternHints.join('\n')
      }
    }

    // V8: Ledger-aware 增强 — 利用 failedApproaches 去重干预提示
    if (signal.triggered && ledger?.facts?.failedApproaches && ledger.facts.failedApproaches.length > 0) {
      const failedSummary = ledger.facts.failedApproaches.slice(-3).join('; ')
      signal.promptInjection = signal.promptInjection + `\n[Ledger] 已知失败路径: ${failedSummary}。请尝试不同的策略。`
    }

    return signal
  }

  /**
   * Layer 2 + 3: 在 trace 保存后调用，更新统计并可能触发自适应。
   */
  async recordTrace(
    baseSequence: string,
    success: boolean,
    interventions: InterventionRecord[],
  ): Promise<void> {
    const shouldAdapt = updateStats(
      this.stats, baseSequence, success, interventions,
      // 将 discovered rules 的活跃 ID 传入，确保 A/B 统计覆盖动态规则
      this.discoveredRules.filter(r => r.lifecycle !== 'retired').map(r => r.id),
    )

    if (shouldAdapt) {
      const adjustments = adaptThresholds(this.stats)
      if (adjustments.length > 0) {
        console.log('[Governor/L3] 阈值自适应调整:', adjustments.join('; '))
      } else {
        console.log('[Governor/L3] 自适应检查完成，无需调整')
      }
    }

    // 异步持久化（不阻塞主流程）
    this.saveStats().catch(err => {
      console.warn('[Governor] Failed to persist stats:', err)
    })
  }

  /**
   * 获取当前阈值（供外部读取）。
   */
  getThresholds(): Readonly<RuleThresholds> {
    return this.stats.thresholds
  }

  /**
   * 获取统计摘要（供 UI 展示）。
   */
  getStatsSummary(): {
    totalTraces: number
    bucketCount: number
    thresholds: RuleThresholds
    interventionSummary: Record<string, { interventionRate: string; controlRate: string; sampleSize: number }>
  } {
    const interventionSummary: Record<string, { interventionRate: string; controlRate: string; sampleSize: number }> = {}

    for (const [rule, effect] of Object.entries(this.stats.interventionEffects)) {
      const iRate = effect.intervened.totalCount > 0
        ? (effect.intervened.successCount / effect.intervened.totalCount * 100).toFixed(1) + '%'
        : 'N/A'
      const cRate = effect.control.totalCount > 0
        ? (effect.control.successCount / effect.control.totalCount * 100).toFixed(1) + '%'
        : 'N/A'
      interventionSummary[rule] = {
        interventionRate: iRate,
        controlRate: cRate,
        sampleSize: effect.intervened.totalCount + effect.control.totalCount,
      }
    }

    return {
      totalTraces: this.stats.totalTraceCount,
      bucketCount: Object.keys(this.stats.buckets).length,
      thresholds: { ...this.stats.thresholds },
      interventionSummary,
    }
  }

  /**
   * 获取完整统计数据（供 deriveStrategies 使用）。
   * 返回浅层只读引用——调用方不应修改返回值。
   */
  getFullStats(): Readonly<GovernorStats> {
    return this.stats
  }

  // ---- 持久化 ----

  private async loadStats(): Promise<void> {
    if (!this.serverUrl) return
    try {
      const response = await fetch(`${this.serverUrl}/api/governor/stats`)
      if (response.ok) {
        const data = await response.json() as GovernorStats
        if (data && data.version) {
          // v2 兼容：旧版 stats 缺少新字段时补齐
          if (!data.patternLibrary) data.patternLibrary = []
          if (!data.counterfactualAccumulator) data.counterfactualAccumulator = {}
          // 补齐新阈值字段（从旧版本升级时）
          data.thresholds = { ...DEFAULT_THRESHOLDS, ...data.thresholds }
          this.stats = data
          this.stats.version = STATS_VERSION
          this.loaded = true
          console.log(`[Governor] Loaded stats: ${data.totalTraceCount} traces, ${Object.keys(data.buckets).length} buckets`)
          return
        }
      }
    } catch {
      // 首次运行或后端未就绪，使用默认值
    }
    this.stats = createEmptyStats()
    this.loaded = true
    console.log('[Governor] Initialized with empty stats (first run or backend unavailable)')
  }

  private async saveStats(): Promise<void> {
    if (!this.serverUrl) return
    try {
      await fetch(`${this.serverUrl}/api/governor/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.stats),
      })
    } catch {
      // 静默失败，下次重试
    }
  }
}

// ============================================
// Phase 0: 策略自动提炼（纯统计，零 LLM）
// ============================================

/** 分桶 key 解析结果（对应 toBucketKey 的 4 维输出） */
interface ParsedBucketKey {
  /** 末尾连续 X 数 (0-3, 其中 3 表示 ≥3) */
  consecutiveX: number
  /** 序列长度分桶 */
  stepBucket: 'S' | 'M' | 'L'
  /** 最近5步探索比例 */
  exploreRatio: 'lo' | 'mi' | 'hi'
  /** 切换频率 */
  switchRate: 'L' | 'H'
}

/** 解析 toBucketKey 产出的 "2_M_mi_L" 格式 */
function parseBucketKey(key: string): ParsedBucketKey | null {
  const parts = key.split('_')
  if (parts.length !== 4) return null

  const consecutiveX = parseInt(parts[0])
  if (isNaN(consecutiveX) || consecutiveX < 0 || consecutiveX > 3) return null

  const stepBucket = parts[1]
  if (stepBucket !== 'S' && stepBucket !== 'M' && stepBucket !== 'L') return null

  const exploreRatio = parts[2]
  if (exploreRatio !== 'lo' && exploreRatio !== 'mi' && exploreRatio !== 'hi') return null

  const switchRateBucket = parts[3]
  if (switchRateBucket !== 'L' && switchRateBucket !== 'H') return null

  return { consecutiveX, stepBucket, exploreRatio, switchRate: switchRateBucket }
}

/** 步长分桶的人类可读描述 */
const STEP_BUCKET_LABELS: Record<string, string> = {
  S: '短任务(≤4步)',
  M: '中等任务(5-11步)',
  L: '长任务(≥12步)',
}

/** 探索比例分桶的人类可读描述 */
const EXPLORE_RATIO_LABELS: Record<string, string> = {
  lo: '低探索(<40%)',
  mi: '中等探索(40-80%)',
  hi: '高探索(>80%)',
}

/** 将高成功率分桶特征转化为正面策略文本 */
function describeBucketAsStrategy(parsed: ParsedBucketKey): string {
  const parts: string[] = []

  if (parsed.consecutiveX === 0) {
    parts.push('避免末尾连续探索')
  }

  parts.push(STEP_BUCKET_LABELS[parsed.stepBucket] || parsed.stepBucket)

  if (parsed.exploreRatio === 'lo') {
    parts.push('保持低探索比例')
  } else if (parsed.exploreRatio === 'mi') {
    parts.push('适度探索')
  }

  if (parsed.switchRate === 'L') {
    parts.push('策略切换频率低（专注推进）')
  }

  return parts.join('，')
}

/** 将低成功率分桶特征转化为警告文本 */
function describeBucketAsWarning(parsed: ParsedBucketKey): string {
  const parts: string[] = []

  if (parsed.consecutiveX >= 2) {
    const prefix = parsed.consecutiveX === 3 ? '≥' : ''
    parts.push(`末尾连续探索 ${prefix}${parsed.consecutiveX} 次`)
  }

  if (parsed.exploreRatio === 'hi') {
    parts.push(EXPLORE_RATIO_LABELS.hi)
  }

  if (parsed.switchRate === 'H') {
    parts.push('策略切换过于频繁')
  }

  parts.push(STEP_BUCKET_LABELS[parsed.stepBucket] || parsed.stepBucket)

  return parts.join('，')
}

/** 规则显示名称映射 */
const RULE_STRATEGY_LABELS: Record<string, string> = {
  consecutive_x_brake: '连续探索刹车',
  step_length_fuse: '序列长度熔断',
  switch_rate_warning: '频繁切换警告',
  diversity_collapse: '多样性崩溃检测',
  late_planning_warning: '后期规划警告',
  missing_verification: '验证缺失检测',
  explore_dominance: '探索过度检测',
}

/**
 * 从 Governor 统计数据中提炼出人类可读的策略规则。
 * 纯代码统计，零 LLM 开销。
 *
 * 数据来源：
 * 1. interventionEffects（干预 A/B 对比）→ 有效/无效规则（因果性，优先级高）
 * 2. buckets（分桶成功率）→ 高/低成功率模式（相关性，作为补充）
 *
 * 注意：v2 特征（pInLateHalf、lastPFollowedByV 等）不在 bucket key 中，
 * 通过 interventionEffects 的 missing_verification 规则间接获取验证策略价值。
 */
export function deriveStrategies(stats: GovernorStats): string[] {
  if (stats.totalTraceCount < 10) return []

  // 干预效果优先（因果性 > 相关性）
  const interventionStrategies: string[] = []
  const bucketStrategies: string[] = []

  // --- 1. 从干预效果统计中提取有效/无效规则 ---
  for (const [ruleName, effect] of Object.entries(stats.interventionEffects)) {
    const { intervened, control } = effect

    if (intervened.totalCount < 3 || control.totalCount < 3) continue

    const intervenedRate = intervened.successCount / intervened.totalCount
    const controlRate = control.successCount / control.totalCount
    const deltaPercentagePoints = Math.round((intervenedRate - controlRate) * 100)

    if (Math.abs(deltaPercentagePoints) < 10) continue

    const ruleLabel = RULE_STRATEGY_LABELS[ruleName] || ruleName

    if (deltaPercentagePoints > 0) {
      interventionStrategies.push(
        `${ruleLabel} 有效 (+${deltaPercentagePoints}pp): ` +
        `干预后 ${Math.round(intervenedRate * 100)}% vs 未干预 ${Math.round(controlRate * 100)}%`
      )
    } else {
      interventionStrategies.push(
        `${ruleLabel} 可能过度 (${deltaPercentagePoints}pp): 考虑放宽阈值`
      )
    }
  }

  // --- 2. 从分桶统计中提取高/低成功率模式 ---
  const significantBuckets = Object.entries(stats.buckets)
    .filter(([, bucket]) => bucket.totalCount >= 5)
    .map(([key, bucket]) => ({
      key,
      parsed: parseBucketKey(key),
      successRate: bucket.successCount / bucket.totalCount,
      sampleSize: bucket.totalCount,
    }))
    .filter((b): b is typeof b & { parsed: ParsedBucketKey } => b.parsed !== null)
    .sort((a, b) => b.successRate - a.successRate)

  // 最高成功率模式（≥90%）
  const bestPattern = significantBuckets.find(b => b.successRate >= 0.9)
  if (bestPattern) {
    bucketStrategies.push(
      `高成功率模式 (${Math.round(bestPattern.successRate * 100)}%, n=${bestPattern.sampleSize}): ` +
      describeBucketAsStrategy(bestPattern.parsed)
    )
  }

  // 最低成功率模式（≤50%）— ES2020 兼容写法
  let worstPattern: typeof significantBuckets[number] | undefined
  for (let i = significantBuckets.length - 1; i >= 0; i--) {
    if (significantBuckets[i].successRate <= 0.5) {
      worstPattern = significantBuckets[i]
      break
    }
  }
  if (worstPattern) {
    bucketStrategies.push(
      `⚠ 风险模式 (${Math.round(worstPattern.successRate * 100)}%, n=${worstPattern.sampleSize}): ` +
      describeBucketAsWarning(worstPattern.parsed)
    )
  }

  // 干预效果优先，分桶模式补充
  return [...interventionStrategies, ...bucketStrategies].slice(0, 5)
}

/** 全局单例 */
export const baseSequenceGovernor = new BaseSequenceGovernor()
