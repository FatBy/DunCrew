/**
 * TranscriptaseGovernor — Transcriptase 编排决策的自适应层 (Phase 3)
 *
 * 复用 BaseSequenceGovernor 的 Layer 2/3 架构，应用于 Transcriptase spawn 决策：
 *
 * Layer 2 (统计累加器):
 *   每次包含 Transcriptase 决策的 ExecTrace 保存后，
 *   按特征分桶累加 spawn 组 vs 非 spawn 组的 (成功次数, 总次数)。
 *
 * Layer 3 (阈值自适应):
 *   每 N 条 trace 触发一次卡方检验，对比 spawn 效果。
 *   仅在统计显著时调整 TranscriptaseEngine 的阈值和 Pattern 置信度。
 *
 * ═══ 休眠态 ═══
 * 默认 enabled=false。需要积累足够的含 Transcriptase 决策的 trace 后，
 * 调用 activate() 激活。激活条件: totalTraceCount >= minTracesForAdaptation。
 *
 * 类比：空调恒温器的恒温器 — 对 Transcriptase 这个"空调"进行自动调参。
 */

import type {
  TranscriptaseGovernorStats,
  TranscriptaseGovernorConfig,
  TranscriptaseSpawnRecord,
} from '@/types'

// ============================================
// 默认配置（休眠态）
// ============================================

const DEFAULT_CONFIG: TranscriptaseGovernorConfig = {
  enabled: false,                    // Phase 3 休眠态：默认关闭
  minTracesForAdaptation: 50,        // 需要 50+ 含 spawn 决策的 trace
  adaptationInterval: 25,            // 每 25 条 trace 触发一次自适应
  significanceLevel: 0.05,           // α = 0.05
  minSamplePerBucket: 10,            // 分桶内最小样本量
}

const STATS_VERSION = 1

/** 卡方检验临界值 (df=1, α=0.05) */
const CHI_SQUARE_CRITICAL_005 = 3.841

/** 自适应历史记录上限 */
const MAX_ADAPTATION_LOG = 20

// ============================================
// Layer 2: 分桶逻辑
// ============================================

/**
 * 将 spawn 决策时的特征映射到 4 维分桶 key。
 *
 * 维度: stepCount(S/M/L) × subObjectives(0/1/2+) × xeRatio(lo/mi/hi) × childrenSpawned(0/1/2+)
 * 总桶数: 3 × 3 × 3 × 3 = 81 桶（粗粒度，避免稀疏）
 */
function toSpawnBucketKey(record: TranscriptaseSpawnRecord): string {
  const stepBucket = record.stepCount <= 8 ? 'S' : record.stepCount <= 15 ? 'M' : 'L'
  const objBucket = record.subObjectiveCount === 0 ? '0' : record.subObjectiveCount === 1 ? '1' : '2+'
  const xeBucket = record.xeRatio < 0.3 ? 'lo' : record.xeRatio <= 0.6 ? 'mi' : 'hi'
  const childBucket = record.childrenSpawned === 0 ? '0' : record.childrenSpawned === 1 ? '1' : '2+'

  return `${stepBucket}_${objBucket}_${xeBucket}_${childBucket}`
}

// ============================================
// Layer 3: 卡方检验
// ============================================

/**
 * Yates 校正卡方检验（2×2 列联表）
 * 与 baseSequenceGovernor.ts 中的 chiSquare 完全一致。
 */
function chiSquare(
  spawnSuccess: number,
  spawnFail: number,
  noSpawnSuccess: number,
  noSpawnFail: number,
): number {
  const a = spawnSuccess
  const b = spawnFail
  const c = noSpawnSuccess
  const d = noSpawnFail
  const n = a + b + c + d

  if (n === 0) return 0

  const numerator = n * Math.pow(Math.abs(a * d - b * c) - n / 2, 2)
  const denominator = (a + b) * (c + d) * (a + c) * (b + d)

  if (denominator === 0) return 0
  return numerator / denominator
}

// ============================================
// TranscriptaseGovernor
// ============================================

export class TranscriptaseGovernor {
  private config: TranscriptaseGovernorConfig = { ...DEFAULT_CONFIG }
  private stats: TranscriptaseGovernorStats = this.createEmptyStats()
  private serverUrl = ''
  private loaded = false

  // ═══ 初始化 ═══

  async initialize(serverUrl: string): Promise<void> {
    this.serverUrl = serverUrl
    await this.loadStats()
  }

  // ═══ 激活控制（休眠态核心） ═══

  /**
   * 检查是否可以激活自适应层。
   * 返回 true = 数据充足，可以调用 activate()。
   */
  canActivate(): boolean {
    return this.stats.totalTraceCount >= this.config.minTracesForAdaptation
  }

  /**
   * 激活自适应层。
   * 前置条件: canActivate() === true。
   * 激活后 TranscriptaseGovernor 将开始参与 Transcriptase 决策调整。
   */
  activate(): boolean {
    if (!this.canActivate()) {
      console.log(
        `[TranscriptaseGovernor] 无法激活: 当前 trace 数 ${this.stats.totalTraceCount}` +
        ` < 最小要求 ${this.config.minTracesForAdaptation}`
      )
      return false
    }
    this.config.enabled = true
    console.log(
      `[TranscriptaseGovernor] 已激活! trace 数: ${this.stats.totalTraceCount}, ` +
      `桶数: ${Object.keys(this.stats.buckets).length}`
    )
    return true
  }

  /** 手动停用 */
  deactivate(): void {
    this.config.enabled = false
    console.log('[TranscriptaseGovernor] 已停用')
  }

  /** 当前是否激活 */
  isActive(): boolean {
    return this.config.enabled
  }

  // ═══ Layer 2: 统计累加 ═══

  /**
   * 记录一条 trace 的 Transcriptase 决策结果。
   *
   * 在 ExecTrace 保存后调用。
   * 如果 trace 中无 Transcriptase 决策，传入空的 spawnRecords。
   *
   * @param hadSpawn 本次执行是否触发了 spawn
   * @param success 本次任务是否成功
   * @param spawnRecords 所有 spawn 决策记录（可能有多次）
   * @returns 是否触发了自适应调整
   */
  recordOutcome(
    hadSpawn: boolean,
    success: boolean,
    spawnRecords: TranscriptaseSpawnRecord[],
  ): boolean {
    // 无论是否激活，都持续累加统计（为未来激活积累数据）

    // 更新全局分桶
    for (const record of spawnRecords) {
      const bucketKey = toSpawnBucketKey(record)
      if (!this.stats.buckets[bucketKey]) {
        this.stats.buckets[bucketKey] = {
          spawnSuccessCount: 0, spawnTotalCount: 0,
          noSpawnSuccessCount: 0, noSpawnTotalCount: 0,
        }
      }
      const bucket = this.stats.buckets[bucketKey]
      bucket.spawnTotalCount++
      if (record.success) bucket.spawnSuccessCount++
    }

    // 对于没有 spawn 的 trace，也记录在最接近的桶中（作为 control 组）
    if (!hadSpawn && spawnRecords.length === 0) {
      // 使用默认桶 key（无 spawn 时特征未知，记录在全局 control）
      const controlKey = 'CONTROL_GLOBAL'
      if (!this.stats.buckets[controlKey]) {
        this.stats.buckets[controlKey] = {
          spawnSuccessCount: 0, spawnTotalCount: 0,
          noSpawnSuccessCount: 0, noSpawnTotalCount: 0,
        }
      }
      this.stats.buckets[controlKey].noSpawnTotalCount++
      if (success) this.stats.buckets[controlKey].noSpawnSuccessCount++
    }

    // 更新每规则效果统计
    const triggeredPatterns = new Set(spawnRecords.map(r => r.patternId))
    for (const patternId of triggeredPatterns) {
      if (!this.stats.patternEffects[patternId]) {
        this.stats.patternEffects[patternId] = {
          spawnSuccess: 0, spawnTotal: 0,
          noSpawnSuccess: 0, noSpawnTotal: 0,
        }
      }
      const effect = this.stats.patternEffects[patternId]
      effect.spawnTotal++
      if (success) effect.spawnSuccess++
    }

    this.stats.totalTraceCount++

    // 检查是否应触发 Layer 3 自适应
    const shouldAdapt = this.config.enabled &&
      (this.stats.totalTraceCount - this.stats.lastAdaptationCount) >= this.config.adaptationInterval

    if (shouldAdapt) {
      const adjustments = this.runAdaptation()
      if (adjustments.length > 0) {
        console.log('[TranscriptaseGovernor/L3] 自适应调整:', adjustments.join('; '))
        this.stats.adaptationLog.push({
          timestamp: Date.now(),
          adjustments,
          traceCount: this.stats.totalTraceCount,
        })
        if (this.stats.adaptationLog.length > MAX_ADAPTATION_LOG) {
          this.stats.adaptationLog = this.stats.adaptationLog.slice(-MAX_ADAPTATION_LOG)
        }
      }
      this.stats.lastAdaptationCount = this.stats.totalTraceCount
    }

    // 异步持久化
    this.saveStats().catch(err => {
      console.warn('[TranscriptaseGovernor] 持久化失败:', err)
    })

    return shouldAdapt
  }

  // ═══ 置信度调节器（供 TranscriptaseEngine 调用） ═══

  /**
   * 基于历史数据，为给定模式的 spawn 决策计算置信度修正因子。
   *
   * 返回 1.0 = 无修正
   * 返回 >1.0 = spawn 历史上效果好，提高置信度
   * 返回 <1.0 = spawn 历史上效果差，降低置信度
   * 返回 null = 数据不足，不做调整
   *
   * TranscriptaseEngine 可用此值乘以 pattern.confidence 得到最终置信度。
   */
  getConfidenceModifier(patternId: string): number | null {
    if (!this.config.enabled || !this.loaded) return null

    const effect = this.stats.patternEffects[patternId]
    if (!effect) return null
    if (effect.spawnTotal < this.config.minSamplePerBucket) return null

    const spawnRate = effect.spawnSuccess / effect.spawnTotal
    const noSpawnRate = effect.noSpawnTotal > 0
      ? effect.noSpawnSuccess / effect.noSpawnTotal
      : 0.5 // 无 control 数据时假设 50%

    if (noSpawnRate === 0) return null

    // 置信度修正因子 = spawn成功率 / 基线成功率，钳制在 [0.5, 1.5]
    const modifier = spawnRate / noSpawnRate
    return Math.max(0.5, Math.min(1.5, modifier))
  }

  // ═══ Layer 3: 自适应调整 ═══

  /**
   * 执行自适应调整。
   * 使用卡方检验对比 spawn 组 vs 全局 control 组。
   *
   * @returns 调整说明列表（空 = 无调整）
   */
  private runAdaptation(): string[] {
    const adjustments: string[] = []

    // 聚合全局 spawn vs noSpawn 统计
    let globalSpawnSuccess = 0, globalSpawnTotal = 0
    let globalNoSpawnSuccess = 0, globalNoSpawnTotal = 0

    for (const bucket of Object.values(this.stats.buckets)) {
      globalSpawnSuccess += bucket.spawnSuccessCount
      globalSpawnTotal += bucket.spawnTotalCount
      globalNoSpawnSuccess += bucket.noSpawnSuccessCount
      globalNoSpawnTotal += bucket.noSpawnTotalCount
    }

    // 全局有效性检查
    if (globalSpawnTotal < this.config.minSamplePerBucket ||
        globalNoSpawnTotal < this.config.minSamplePerBucket) {
      return adjustments
    }

    const globalSpawnRate = globalSpawnTotal > 0 ? globalSpawnSuccess / globalSpawnTotal : 0
    const globalNoSpawnRate = globalNoSpawnTotal > 0 ? globalNoSpawnSuccess / globalNoSpawnTotal : 0
    const globalChi2 = chiSquare(
      globalSpawnSuccess,
      globalSpawnTotal - globalSpawnSuccess,
      globalNoSpawnSuccess,
      globalNoSpawnTotal - globalNoSpawnSuccess,
    )

    if (globalChi2 >= CHI_SQUARE_CRITICAL_005) {
      const direction = globalSpawnRate > globalNoSpawnRate ? 'spawn 整体有效' : 'spawn 整体无效'
      const deltaPP = Math.round((globalSpawnRate - globalNoSpawnRate) * 100)
      adjustments.push(
        `全局: ${direction} (delta=${deltaPP}pp, chi2=${globalChi2.toFixed(1)}, ` +
        `spawn=${globalSpawnTotal}, control=${globalNoSpawnTotal})`
      )
    }

    // 每规则检查
    for (const [patternId, effect] of Object.entries(this.stats.patternEffects)) {
      if (effect.spawnTotal < this.config.minSamplePerBucket) continue

      // 用全局 noSpawn 作为 control（规则级别没有独立 control 组）
      if (globalNoSpawnTotal < this.config.minSamplePerBucket) continue

      const patternRate = effect.spawnSuccess / effect.spawnTotal
      const chi2 = chiSquare(
        effect.spawnSuccess,
        effect.spawnTotal - effect.spawnSuccess,
        globalNoSpawnSuccess,
        globalNoSpawnTotal - globalNoSpawnSuccess,
      )

      if (chi2 >= CHI_SQUARE_CRITICAL_005) {
        const deltaPP = Math.round((patternRate - globalNoSpawnRate) * 100)
        if (patternRate > globalNoSpawnRate) {
          adjustments.push(
            `规则 [${patternId}]: spawn 有效 (+${deltaPP}pp, chi2=${chi2.toFixed(1)}, n=${effect.spawnTotal})`
          )
        } else {
          adjustments.push(
            `规则 [${patternId}]: spawn 无效 (${deltaPP}pp, chi2=${chi2.toFixed(1)}, n=${effect.spawnTotal}) — 建议降低置信度`
          )
        }
      }
    }

    return adjustments
  }

  // ═══ 查询接口 ═══

  /** 获取统计摘要（供 UI / 调试） */
  getStatsSummary(): {
    enabled: boolean
    totalTraces: number
    bucketCount: number
    canActivate: boolean
    patternSummary: Record<string, { spawnRate: string; sampleSize: number }>
    recentAdaptations: TranscriptaseGovernorStats['adaptationLog']
  } {
    const patternSummary: Record<string, { spawnRate: string; sampleSize: number }> = {}
    for (const [patternId, effect] of Object.entries(this.stats.patternEffects)) {
      patternSummary[patternId] = {
        spawnRate: effect.spawnTotal > 0
          ? (effect.spawnSuccess / effect.spawnTotal * 100).toFixed(1) + '%'
          : 'N/A',
        sampleSize: effect.spawnTotal,
      }
    }

    return {
      enabled: this.config.enabled,
      totalTraces: this.stats.totalTraceCount,
      bucketCount: Object.keys(this.stats.buckets).length,
      canActivate: this.canActivate(),
      patternSummary,
      recentAdaptations: this.stats.adaptationLog.slice(-5),
    }
  }

  /** 获取完整统计数据 */
  getFullStats(): Readonly<TranscriptaseGovernorStats> {
    return this.stats
  }

  /** 获取配置 */
  getConfig(): Readonly<TranscriptaseGovernorConfig> {
    return this.config
  }

  // ═══ 持久化 ═══

  private createEmptyStats(): TranscriptaseGovernorStats {
    return {
      version: STATS_VERSION,
      buckets: {},
      patternEffects: {},
      totalTraceCount: 0,
      lastAdaptationCount: 0,
      adaptationLog: [],
    }
  }

  private async loadStats(): Promise<void> {
    if (!this.serverUrl) return
    try {
      const response = await fetch(`${this.serverUrl}/api/transcriptase-governor/stats`)
      if (response.ok) {
        const data = await response.json() as TranscriptaseGovernorStats
        if (data && data.version) {
          this.stats = data
          this.stats.version = STATS_VERSION
          if (!this.stats.adaptationLog) this.stats.adaptationLog = []
          this.loaded = true
          console.log(
            `[TranscriptaseGovernor] 加载统计: ${data.totalTraceCount} traces, ` +
            `${Object.keys(data.buckets).length} 桶, ` +
            `激活状态: ${this.config.enabled ? '是' : '否'}`
          )
          return
        }
      }
    } catch {
      // 首次运行或后端未就绪
    }
    this.stats = this.createEmptyStats()
    this.loaded = true
    console.log('[TranscriptaseGovernor] 初始化空统计 (首次运行/后端不可用), 休眠态')
  }

  private async saveStats(): Promise<void> {
    if (!this.serverUrl) return
    try {
      await fetch(`${this.serverUrl}/api/transcriptase-governor/stats`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.stats),
      })
    } catch {
      // 静默失败
    }
  }
}

// 导出单例
export const transcriptaseGovernor = new TranscriptaseGovernor()
