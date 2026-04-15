/**
 * 共享特征注册表 — 碱基序列 15 维特征提取 + 通用条件匹配
 *
 * 核心契约：Python 侧 rule_discovery.py 实现完全相同的提取逻辑，
 * 两端通过特征 ID 对齐。修改此文件时必须同步 Python 侧。
 */

import type { RuleCondition } from './ruleTypes'
import type { BaseType } from '@/utils/baseClassifier'

// ============================================
// 类型定义
// ============================================

interface BaseEntry {
  base: BaseType
  order: number
}

export interface FeatureRegistryEntry {
  id: string
  name: string
  type: 'continuous' | 'boolean'
  description: string
}

/** 15 维特征快照（V2，替代原 8 维 FeatureSnapshot） */
export type ExtendedFeatures = Record<string, number | boolean>

// ============================================
// 特征注册表（15 维）
// ============================================

export const FEATURE_REGISTRY: FeatureRegistryEntry[] = [
  { id: 'stepCount',          name: '序列长度',       type: 'continuous', description: 'entries.length' },
  { id: 'switchRate',         name: '切换频率',       type: 'continuous', description: '相邻不同碱基数 / (n-1)' },
  { id: 'xeRatio',            name: '探索/执行比',    type: 'continuous', description: 'X/(X+E)' },
  { id: 'vRatio',             name: '验证密度',       type: 'continuous', description: 'V/total' },
  { id: 'pRatio',             name: '规划密度',       type: 'continuous', description: 'P/total' },
  { id: 'eRatio',             name: '执行密度',       type: 'continuous', description: 'E/total' },
  { id: 'consecutiveXTail',   name: '末尾连续X',     type: 'continuous', description: '末尾连续X计数' },
  { id: 'consecutiveETail',   name: '末尾连续E',     type: 'continuous', description: '末尾连续E计数' },
  { id: 'maxERunLength',      name: '最长连续E',     type: 'continuous', description: '最长连续E游程' },
  { id: 'maxXRunLength',      name: '最长连续X',     type: 'continuous', description: '最长连续X游程' },
  { id: 'xRatioLast5',        name: '近期X占比',     type: 'continuous', description: '最近5步X占比' },
  { id: 'earlyXRatio',        name: '开局X占比',     type: 'continuous', description: '前3步X占比' },
  { id: 'pInLateHalf',        name: '后期规划',       type: 'boolean',    description: '后半段是否有P' },
  { id: 'lastPFollowedByV',   name: 'P→V路径',       type: 'boolean',    description: '最近P后是否接V' },
  { id: 'distinctBases',      name: '碱基种类数',     type: 'continuous', description: '碱基种类数(1-4)' },
]

// ============================================
// 特征提取（15 维）
// ============================================

/**
 * 从碱基序列中提取 15 维特征。O(n)，n = 序列长度。
 * Python 侧 _extract_trace_features() 必须产生完全相同的结果。
 */
export function extractFeaturesV2(entries: BaseEntry[]): ExtendedFeatures {
  const n = entries.length
  if (n === 0) {
    return {
      stepCount: 0, switchRate: 0, xeRatio: 0,
      vRatio: 0, pRatio: 0, eRatio: 0,
      consecutiveXTail: 0, consecutiveETail: 0,
      maxERunLength: 0, maxXRunLength: 0,
      xRatioLast5: 0, earlyXRatio: 0,
      pInLateHalf: false, lastPFollowedByV: false,
      distinctBases: 0,
    }
  }

  // 单次遍历收集基础计数
  let eCount = 0, pCount = 0, vCount = 0, xCount = 0
  let switches = 0
  let maxERun = 0, curERun = 0
  let maxXRun = 0, curXRun = 0
  const baseSet = new Set<string>()

  for (let i = 0; i < n; i++) {
    const b = entries[i].base
    baseSet.add(b)

    if (b === 'E') { eCount++; curERun++; curXRun = 0 }
    else if (b === 'X') { xCount++; curXRun++; curERun = 0 }
    else { if (b === 'P') pCount++; else vCount++; curERun = 0; curXRun = 0 }

    if (curERun > maxERun) maxERun = curERun
    if (curXRun > maxXRun) maxXRun = curXRun

    if (i > 0 && entries[i].base !== entries[i - 1].base) switches++
  }

  // 末尾连续 X
  let consecutiveXTail = 0
  for (let i = n - 1; i >= 0; i--) {
    if (entries[i].base === 'X') consecutiveXTail++; else break
  }

  // 末尾连续 E
  let consecutiveETail = 0
  for (let i = n - 1; i >= 0; i--) {
    if (entries[i].base === 'E') consecutiveETail++; else break
  }

  // 最近 5 步 X 占比
  const last5 = entries.slice(-Math.min(5, n))
  const xRatioLast5 = last5.filter(e => e.base === 'X').length / last5.length

  // 前 3 步 X 占比
  const early = entries.slice(0, Math.min(3, n))
  const earlyXRatio = early.filter(e => e.base === 'X').length / early.length

  // 后半段是否有 P
  const halfIndex = Math.floor(n / 2)
  let pInLateHalf = false
  for (let i = halfIndex; i < n; i++) {
    if (entries[i].base === 'P') { pInLateHalf = true; break }
  }

  // 最近 P 后是否接 V
  let lastPFollowedByV = false
  for (let i = n - 1; i >= 0; i--) {
    if (entries[i].base === 'P') {
      lastPFollowedByV = i + 1 < n && entries[i + 1].base === 'V'
      break
    }
  }

  return {
    stepCount: n,
    switchRate: n > 1 ? switches / (n - 1) : 0,
    xeRatio: (xCount + eCount) > 0 ? xCount / (xCount + eCount) : 0,
    vRatio: vCount / n,
    pRatio: pCount / n,
    eRatio: eCount / n,
    consecutiveXTail,
    consecutiveETail,
    maxERunLength: maxERun,
    maxXRunLength: maxXRun,
    xRatioLast5,
    earlyXRatio,
    pInLateHalf,
    lastPFollowedByV,
    distinctBases: baseSet.size,
  }
}

// ============================================
// 通用条件匹配器
// ============================================

/** 评估单个子句 */
function matchClause(features: ExtendedFeatures, clause: { feature: string; op: string; value: number }): boolean {
  const raw = features[clause.feature]
  // 布尔特征：true=1, false=0
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

/** 评估复合条件（AND/OR） */
export function matchCondition(features: ExtendedFeatures, condition: RuleCondition): boolean {
  if (condition.operator === 'AND') {
    return condition.clauses.every(c => matchClause(features, c))
  }
  return condition.clauses.some(c => matchClause(features, c))
}

/** 模板插值：{featureName} → 原始值，{featureName_pct} → ×100 取整 */
export function interpolateTemplate(template: string, features: ExtendedFeatures): string {
  return template.replace(/\{(\w+?)(_pct)?\}/g, (_, name, pct) => {
    const raw = features[name]
    if (raw == null) return `{${name}}`
    const num = typeof raw === 'boolean' ? (raw ? 1 : 0) : (raw as number)
    return pct ? String(Math.round(num * 100)) : String(Math.round(num * 1000) / 1000)
  })
}
