/**
 * TranscriptaseEngine — 碱基驱动的多 Agent 编排器
 *
 * 生物学类比：转录酶 (Transcriptase) 读取 DNA (碱基序列 Ledger)，
 * 输出 mRNA (ChildContextEnvelope)，指导核糖体 (ReAct 循环) 执行。
 *
 * Phase 2: 纯规则引擎，不调用 LLM。
 * - 读取 BaseLedger（碱基序列 + 15 维特征 + LedgerFacts）
 * - 模式匹配 TranscriptasePattern[]
 * - 输出 TranscriptaseDecision（continue / spawn_child / handoff / abort / escalate）
 *
 * 关键设计原则：
 * - Transcriptase 的决策不产生碱基（避免循环依赖）
 * - 决策记录在 LedgerMilestone 中
 * - 碱基是滞后指标，Transcriptase 是前瞻性决策者
 */

import type {
  BaseLedger,
  TranscriptaseDecision,
  TranscriptasePattern,
  TranscriptaseConfig,
  ChildContextEnvelope,
  LedgerFacts,
} from '@/types'
import { CHILD_LIMITS } from '@/types'
import type { TranscriptaseGovernor } from './transcriptaseGovernor'

// ============================================
// 默认配置
// ============================================

const DEFAULT_CONFIG: TranscriptaseConfig = {
  enabled: true,
  minStepsBeforeSpawn: 8,
  maxActiveChildren: CHILD_LIMITS.maxChildrenPerSession,
  minFactsForSpawn: 2,
  minStepsBetweenSpawns: 5,
  patterns: [
    // ─── 规则 1: 子目标分裂 (Sub-objective Split) ───
    // 碱基序列长度超过阈值 + 存在多个子目标 → 转录酶开始复制子链
    {
      id: 'sub_objective_split',
      name: '子目标分裂',
      featureCondition: {
        operator: 'AND',
        clauses: [
          { feature: 'stepCount', op: '>=', value: 8 },
        ],
      },
      factsCondition: {
        minSubObjectives: 2,
      },
      decision: 'spawn_child',
      confidence: 0.7,
      enabled: true,
    },

    // ─── 规则 2: 失败路径委托 (Failure Delegation) ───
    // 多次失败 + 连续探索 → 尝试替代转录路径
    {
      id: 'failure_delegation',
      name: '失败路径委托',
      featureCondition: {
        operator: 'AND',
        clauses: [
          { feature: 'consecutiveXTail', op: '>=', value: 3 },
          { feature: 'stepCount', op: '>=', value: 6 },
        ],
      },
      factsCondition: {
        hasFailedApproaches: true,
      },
      decision: 'spawn_child',
      confidence: 0.6,
      enabled: true,
    },

    // ─── 规则 3: 探索聚焦 (Explore Focus) ───
    // 探索碱基过多 + 已发现大量资源 → 分裂出专门的执行链
    {
      id: 'explore_focus',
      name: '探索聚焦',
      featureCondition: {
        operator: 'AND',
        clauses: [
          { feature: 'xeRatio', op: '>', value: 0.6 },
          { feature: 'stepCount', op: '>=', value: 10 },
        ],
      },
      factsCondition: {
        minDiscoveredResources: 5,
      },
      decision: 'spawn_child',
      confidence: 0.65,
      enabled: true,
    },
  ],
}

// ============================================
// 继续决策（无动作）
// ============================================

const CONTINUE_DECISION: TranscriptaseDecision = {
  type: 'continue',
  confidence: 1.0,
  reasoning: '当前碱基模式无需编排干预',
}

// ============================================
// TranscriptaseEngine
// ============================================

class TranscriptaseEngine {
  private config: TranscriptaseConfig = DEFAULT_CONFIG
  /** 上次 spawn 时的碱基步数（用于冷却间隔） */
  private lastSpawnStepCount = 0
  /** Phase 3: 可选的 Governor 引用（休眠态下为 null） */
  private governor: TranscriptaseGovernor | null = null
  /** Phase 3: LLM 辅助评估回调（休眠态下为 null） */
  private llmEvaluator: ((ledger: BaseLedger) => Promise<TranscriptaseDecision | null>) | null = null

  // ═══ 核心评估 ═══

  /**
   * 读取 Ledger，输出编排决策。
   *
   * 在 ReAct 循环每轮 Governor evaluate 之后调用。
   * 纯规则引擎，0ms 延迟，不调用任何模型。
   *
   * @param ledger 当前 BaseLedger
   * @param activeChildCount 当前活跃子 Agent 数量
   * @returns TranscriptaseDecision
   */
  evaluate(ledger: BaseLedger, activeChildCount: number): TranscriptaseDecision {
    if (!this.config.enabled) {
      return CONTINUE_DECISION
    }

    const features = ledger.features
    const facts = ledger.facts
    const stepCount = (features.stepCount as number) || 0

    // 前置条件检查
    if (stepCount < this.config.minStepsBeforeSpawn) {
      return CONTINUE_DECISION
    }

    if (activeChildCount >= this.config.maxActiveChildren) {
      return CONTINUE_DECISION
    }

    // 冷却间隔检查：两次 spawn 之间至少间隔 N 步
    if (this.lastSpawnStepCount > 0 &&
        stepCount - this.lastSpawnStepCount < this.config.minStepsBetweenSpawns) {
      return CONTINUE_DECISION
    }

    // Facts 最小量检查
    const totalFacts = facts.completedActions.length + facts.discoveredResources.length
    if (totalFacts < this.config.minFactsForSpawn) {
      return CONTINUE_DECISION
    }

    // 模式匹配（按顺序，首个匹配即返回）
    for (const pattern of this.config.patterns) {
      if (!pattern.enabled) continue

      const matched = this.matchPattern(pattern, features, facts)
      if (matched) {
        const decision = this.buildDecision(pattern, ledger)
        if (decision.type === 'spawn_child') {
          this.lastSpawnStepCount = stepCount
        }
        return decision
      }
    }

    return CONTINUE_DECISION
  }

  // ═══ 上下文信封构建 ═══

  /**
   * 从 Ledger 快照构建子 Agent 上下文信封 (mRNA)
   *
   * @param parentLedger 父 Ledger 快照（深拷贝）
   * @param childTask 子任务描述
   * @param parentRunId 父 runId
   * @param maxDurationMs 最大执行时间
   */
  buildContextEnvelope(
    parentLedger: BaseLedger,
    childTask: string,
    parentRunId: string,
    maxDurationMs: number = CHILD_LIMITS.defaultTimeoutSeconds * 1000,
  ): ChildContextEnvelope {
    // 精选共享 facts（只传递对子任务有价值的部分）
    const sharedFacts: LedgerFacts = {
      completedActions: parentLedger.facts.completedActions.slice(-10),
      discoveredResources: parentLedger.facts.discoveredResources.slice(-20),
      failedApproaches: parentLedger.facts.failedApproaches.slice(-5),
      currentObjective: childTask,
      subObjectives: [],
    }

    return {
      parentLedgerSnapshot: parentLedger,
      assignedTask: childTask,
      sharedFacts,
      parentBaseSequence: parentLedger.entries.map(e => e.base).join('-'),
      returnContract: {
        expectedOutputType: 'text',
        maxDurationMs,
        reportBackTo: parentRunId,
      },
    }
  }

  // ═══ 配置管理 ═══

  /** 获取当前配置（只读） */
  getConfig(): Readonly<TranscriptaseConfig> {
    return this.config
  }

  /** 启用/禁用 Transcriptase */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled
  }

  /** 更新 spawn 阈值（Phase 3 自适应调整用） */
  updateThresholds(partial: Partial<Pick<TranscriptaseConfig, 'minStepsBeforeSpawn' | 'minFactsForSpawn' | 'minStepsBetweenSpawns'>>): void {
    Object.assign(this.config, partial)
  }

  /** 添加新模式规则 */
  addPattern(pattern: TranscriptasePattern): void {
    this.config.patterns.push(pattern)
  }

  /** 重置冷却状态（新 run 开始时调用） */
  resetCooldown(): void {
    this.lastSpawnStepCount = 0
  }

  // ═══ Phase 3: 自适应集成 ═══

  /**
   * 注入 TranscriptaseGovernor 引用（Phase 3 激活时调用）。
   * Governor 激活后，buildDecision() 会自动调用 getConfidenceModifier()。
   */
  setGovernor(governor: TranscriptaseGovernor | null): void {
    this.governor = governor
    if (governor) {
      console.log('[TranscriptaseEngine] Governor 已注入, 激活状态:', governor.isActive())
    }
  }

  /** 获取当前 Governor 引用 */
  getGovernor(): TranscriptaseGovernor | null {
    return this.governor
  }

  /**
   * 注册 LLM 辅助评估回调（Phase 3 条件允许时激活）。
   *
   * 回调接收当前 Ledger，返回 TranscriptaseDecision 或 null（无意见）。
   * 当 LLM 评估返回非 null 且置信度 > 规则引擎结果时，优先采用 LLM 决策。
   *
   * 设为 null 可禁用 LLM 辅助。
   */
  setLLMEvaluator(
    evaluator: ((ledger: BaseLedger) => Promise<TranscriptaseDecision | null>) | null,
  ): void {
    this.llmEvaluator = evaluator
    console.log(`[TranscriptaseEngine] LLM 辅助评估: ${evaluator ? '已注册' : '已禁用'}`)
  }

  /**
   * 异步评估（支持 LLM 辅助）。
   *
   * 优先使用纯规则 evaluate()。如果 LLM 辅助已注册且规则引擎返回 continue，
   * 尝试 LLM 评估。LLM 失败时静默回退到规则结果。
   *
   * 在不需要 LLM 辅助时，直接调用同步的 evaluate() 即可。
   */
  async evaluateAsync(ledger: BaseLedger, activeChildCount: number): Promise<TranscriptaseDecision> {
    // 首先执行规则引擎
    const ruleDecision = this.evaluate(ledger, activeChildCount)

    // 如果规则已触发 spawn，直接返回（规则引擎已有明确意见）
    if (ruleDecision.type !== 'continue') {
      return ruleDecision
    }

    // 如果 LLM 辅助未注册，返回规则结果
    if (!this.llmEvaluator) {
      return ruleDecision
    }

    // 尝试 LLM 辅助评估
    try {
      const llmDecision = await this.llmEvaluator(ledger)
      if (llmDecision && llmDecision.type !== 'continue') {
        llmDecision.reasoning = `[LLM辅助] ${llmDecision.reasoning}`
        return llmDecision
      }
    } catch (err) {
      console.warn('[TranscriptaseEngine] LLM 辅助评估失败, 回退到规则引擎:', err)
    }

    return ruleDecision
  }

  // ═══ 内部方法 ═══

  /** 匹配单个模式 */
  private matchPattern(
    pattern: TranscriptasePattern,
    features: Record<string, number | boolean>,
    facts: LedgerFacts,
  ): boolean {
    // 1. 特征条件匹配
    const featureMatch = this.matchFeatureCondition(pattern.featureCondition, features)
    if (!featureMatch) return false

    // 2. Facts 条件匹配（如有）
    if (pattern.factsCondition) {
      const fc = pattern.factsCondition
      if (fc.minSubObjectives !== undefined && facts.subObjectives.length < fc.minSubObjectives) return false
      if (fc.minDiscoveredResources !== undefined && facts.discoveredResources.length < fc.minDiscoveredResources) return false
      if (fc.hasFailedApproaches && facts.failedApproaches.length === 0) return false
      if (fc.minCompletedActions !== undefined && facts.completedActions.length < fc.minCompletedActions) return false
    }

    return true
  }

  /** 匹配特征条件 */
  private matchFeatureCondition(
    condition: TranscriptasePattern['featureCondition'],
    features: Record<string, number | boolean>,
  ): boolean {
    const evaluateClause = (clause: { feature: string; op: string; value: number }): boolean => {
      const raw = features[clause.feature]
      const val = typeof raw === 'boolean' ? (raw ? 1 : 0) : (raw as number)
      if (val == null) return false

      switch (clause.op) {
        case '>':  return val > clause.value
        case '<':  return val < clause.value
        case '>=': return val >= clause.value
        case '<=': return val <= clause.value
        default:   return false
      }
    }

    if (condition.operator === 'AND') {
      return condition.clauses.every(evaluateClause)
    }
    return condition.clauses.some(evaluateClause)
  }

  /** 从模式匹配结果构建决策 */
  private buildDecision(pattern: TranscriptasePattern, ledger: BaseLedger): TranscriptaseDecision {
    let confidence = pattern.confidence

    // Phase 3: Governor 置信度调整（仅当 Governor 已激活时生效）
    if (this.governor && this.governor.isActive()) {
      const modifier = this.governor.getConfidenceModifier(pattern.id)
      if (modifier !== null) {
        confidence = Math.max(0.1, Math.min(1.0, confidence * modifier))
      }
    }

    const decision: TranscriptaseDecision = {
      type: pattern.decision,
      confidence,
      reasoning: `规则 [${pattern.name}] 触发`,
      triggeredPatternId: pattern.id,
    }

    // 为 spawn_child 类型填充子任务信息
    if (pattern.decision === 'spawn_child') {
      decision.childTask = this.deriveChildTask(pattern, ledger)
      decision.childPriority = 'normal'
    }

    return decision
  }

  /** 从 Ledger facts 推导子任务描述 */
  private deriveChildTask(pattern: TranscriptasePattern, ledger: BaseLedger): string {
    const facts = ledger.facts

    switch (pattern.id) {
      case 'sub_objective_split':
        // 取第一个未完成的子目标
        if (facts.subObjectives.length > 0) {
          return facts.subObjectives[0]
        }
        return `继续执行: ${facts.currentObjective}`

      case 'failure_delegation':
        // 基于失败路径，要求尝试不同方法
        if (facts.failedApproaches.length > 0) {
          const lastFailure = facts.failedApproaches[facts.failedApproaches.length - 1]
          return `用不同方法完成任务。已知失败路径: ${lastFailure.slice(0, 100)}。目标: ${facts.currentObjective}`
        }
        return `用替代方法完成: ${facts.currentObjective}`

      case 'explore_focus':
        // 基于已发现的资源，整合分析
        if (facts.discoveredResources.length > 0) {
          const resourceList = facts.discoveredResources.slice(-5).join(', ')
          return `整合已发现的资源并执行: ${resourceList}。目标: ${facts.currentObjective}`
        }
        return `整合探索结果并执行: ${facts.currentObjective}`

      default:
        return facts.currentObjective || '继续执行任务'
    }
  }
}

// 导出单例
export const transcriptaseEngine = new TranscriptaseEngine()
