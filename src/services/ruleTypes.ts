/**
 * 规则 JSON 类型定义
 *
 * 核心原则：规则是数据，不是代码。
 * Python 发现管线生成 → JSON 持久化 → TypeScript 通用求值器消费。
 */

/** 规则条件子句 */
export interface RuleClause {
  /** 对应 FEATURE_REGISTRY 中的 id */
  feature: string
  op: '>' | '<' | '>=' | '<='
  value: number
}

/** 规则触发条件（AND/OR 组合，不超过一层嵌套） */
export interface RuleCondition {
  operator: 'AND' | 'OR'
  clauses: RuleClause[]
}

/** 规则统计信息 */
export interface RuleStatistics {
  /** 命中 SR - 未命中 SR（百分点） */
  effectSizePP: number
  pValue: number
  hitCount: number
  hitSuccessRate: number
  noHitSuccessRate: number
  sampleSize: number
  discoveredAt: number
  lastValidatedAt: number
  /** 累计验证通过次数 */
  validationCount: number
}

/** Layer 3 自动调参边界 */
export interface AdaptationBounds {
  feature: string
  min: number
  max: number
  step: number
}

/** 数据驱动的发现规则 */
export interface DiscoveredRule {
  id: string
  name: string
  lifecycle: 'candidate' | 'validated' | 'retired'

  condition: RuleCondition
  action: {
    promptTemplate: string
    severity: 'warning' | 'info'
  }

  stats: RuleStatistics
  adaptationBounds?: AdaptationBounds

  origin: 'discovered' | 'migrated' | 'manual'
  retiredReason?: string
}
