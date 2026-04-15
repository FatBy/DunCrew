/**
 * Skill 多信号融合排序服务
 *
 * 替代原有的硬编码关键词匹配（DEFAULT_SKILL_TRIGGERS + string.includes），
 * 使用 4 维信号融合排序：
 *   1. 语义相关度 (BGE 向量 / 本地 TF-IDF fallback)
 *   2. 使用信号   (贝叶斯平均成功率，解决马太效应)
 *   3. 新鲜度     (衰减窗口，让新/更新技能有曝光期)
 *   4. 质量先验   (SKILL.md 完整度，解决冷启动)
 */

import { embed, cosineSimilarity } from './llmService'
import { skillStatsService } from './skillStatsService'
import type { OpenClawSkill } from '@/types'

// ============================================
// 排序权重配置
// ============================================

const RANKING_WEIGHTS = {
  semanticRelevance: 0.50,
  usageSignal: 0.25,
  freshness: 0.15,
  qualityPrior: 0.10,
}

/** 贝叶斯平均置信阈值：调用次数低于此值时，向全局均值收缩 */
const BAYESIAN_CONFIDENCE_THRESHOLD = 5

/** 新鲜度窗口 (天) */
const FRESHNESS_FULL_WINDOW_DAYS = 14
const FRESHNESS_DECAY_WINDOW_DAYS = 28

// ============================================
// 各维度评分函数
// ============================================

/**
 * 贝叶斯平均成功率
 * 新技能（调用次数少）向全局均值收缩，避免马太效应
 */
export function computeBayesianSuccessRate(
  skillId: string,
  globalAvgRate: number,
): number {
  const stats = skillStatsService.getSkillStats(skillId)
  if (!stats) return globalAvgRate

  const total = stats.successCount + stats.failureCount
  if (total === 0) return globalAvgRate

  const actualRate = stats.successCount / total
  const w = total / (total + BAYESIAN_CONFIDENCE_THRESHOLD)
  return w * actualRate + (1 - w) * globalAvgRate
}

/**
 * 新鲜度加分
 *
 * 由于 OpenClawSkill 没有 updatedAt 字段，按以下优先级取时间：
 *   1. clawHub.publishedAt  (社区/版本发布时间)
 *   2. skillStatsService.firstUsedAt  (首次使用 ≈ 首次注册时间)
 * 无法获取时返回 0（不加分也不扣分）
 */
export function computeFreshnessScore(skill: OpenClawSkill): number {
  let refTime: number | undefined

  // 优先用 publishedAt
  if (skill.clawHub?.publishedAt) {
    const parsed = Date.parse(skill.clawHub.publishedAt)
    if (!isNaN(parsed)) refTime = parsed
  }

  // fallback: firstUsedAt
  if (!refTime) {
    const stats = skillStatsService.getSkillStats(skill.name)
    if (stats?.firstUsedAt) refTime = stats.firstUsedAt
  }

  if (!refTime) return 0

  const daysSince = (Date.now() - refTime) / 86_400_000
  if (daysSince <= FRESHNESS_FULL_WINDOW_DAYS) return 1.0
  const decay = (daysSince - FRESHNESS_FULL_WINDOW_DAYS) / FRESHNESS_DECAY_WINDOW_DAYS
  return decay >= 1 ? 0 : 1.0 - decay
}

/**
 * 质量先验评分 — 基于 OpenClawSkill 实际字段
 *
 * 评估标准（满分 1.0）：
 *   - 有描述且 > 20 字           +0.25
 *   - 有 inputs schema            +0.15
 *   - 有 keywords                 +0.10
 *   - 有 tags                     +0.10
 *   - 有版本号                    +0.05
 *   - requires.env 一致性         +0.10 (内容提到 API 时须声明)
 *   - 有 dangerLevel 声明         +0.05
 *   - 基础分                      +0.20
 */
export function computeQualityPrior(skill: OpenClawSkill): number {
  let score = 0.20
  if (skill.description && skill.description.length > 20) score += 0.25
  if (skill.inputs && Object.keys(skill.inputs).length > 0) score += 0.15
  if (skill.keywords && skill.keywords.length > 0) score += 0.10
  if (skill.tags && skill.tags.length > 0) score += 0.10
  if (skill.version) score += 0.05

  // requires.env 一致性: 描述/关键词提到 API/token/key 时，requires.env 应有值
  const textToCheck = [
    skill.description ?? '',
    ...(skill.keywords ?? []),
    skill.whenToUse ?? '',
  ].join(' ').toLowerCase()
  const mentionsApi = /\bapi[_\s-]?key\b|\btoken\b|\bsecret\b|\bapi_key\b/.test(textToCheck)
  const hasEnvDeclared = (skill.requires?.env?.length ?? 0) > 0
  if (mentionsApi && !hasEnvDeclared) {
    // 提到了 API 依赖但没有声明 requires.env → 不加分（隐含扣分）
    score += 0
  } else {
    score += 0.10
  }

  if (skill.dangerLevel && skill.dangerLevel !== 'safe') score += 0.05
  else if (skill.dangerLevel === 'safe') score += 0.05

  return Math.min(score, 1.0)
}

/**
 * 质量诊断报告 — 返回具体扣分项和修复建议
 * 用于 UI 展示和自动优化的输入
 */
export interface QualityDiagnostic {
  field: string
  passed: boolean
  suggestion: string
  weight: number
}

export function diagnoseQuality(skill: OpenClawSkill): QualityDiagnostic[] {
  const diags: QualityDiagnostic[] = []

  diags.push({
    field: 'description',
    passed: !!(skill.description && skill.description.length > 20),
    suggestion: skill.description ? '描述过短，建议 > 20 字并包含使用场景' : '缺少 description 字段',
    weight: 0.25,
  })
  diags.push({
    field: 'inputs',
    passed: !!(skill.inputs && Object.keys(skill.inputs).length > 0),
    suggestion: '缺少 inputs schema，建议声明输入参数定义',
    weight: 0.15,
  })
  diags.push({
    field: 'keywords',
    passed: !!(skill.keywords && skill.keywords.length > 0),
    suggestion: '缺少 keywords，建议添加语义触发关键词',
    weight: 0.10,
  })
  diags.push({
    field: 'tags',
    passed: !!(skill.tags && skill.tags.length > 0),
    suggestion: '缺少 tags，建议添加分类标签',
    weight: 0.10,
  })
  diags.push({
    field: 'version',
    passed: !!skill.version,
    suggestion: '缺少 version 字段',
    weight: 0.05,
  })

  const textToCheck = [
    skill.description ?? '',
    ...(skill.keywords ?? []),
    skill.whenToUse ?? '',
  ].join(' ').toLowerCase()
  const mentionsApi = /\bapi[_\s-]?key\b|\btoken\b|\bsecret\b|\bapi_key\b/.test(textToCheck)
  const hasEnvDeclared = (skill.requires?.env?.length ?? 0) > 0
  diags.push({
    field: 'requires.env',
    passed: !mentionsApi || hasEnvDeclared,
    suggestion: mentionsApi && !hasEnvDeclared
      ? '内容提到 API/token 依赖但未在 requires.env 中声明'
      : '无需外部 API 或已正确声明',
    weight: 0.10,
  })

  diags.push({
    field: 'dangerLevel',
    passed: !!skill.dangerLevel,
    suggestion: '缺少 dangerLevel 声明（safe/high/critical）',
    weight: 0.05,
  })

  return diags
}

// ============================================
// 全局均值（贝叶斯收缩锚点）
// ============================================

export function computeGlobalAverageSuccessRate(): number {
  const all = skillStatsService.getAllStats()
  const withAttempts = all.filter(s => s.successCount + s.failureCount > 0)
  if (withAttempts.length === 0) return 0.7 // 无数据时假设 70%

  const totalSuccess = withAttempts.reduce((s, x) => s + x.successCount, 0)
  const totalAttempts = withAttempts.reduce((s, x) => s + x.successCount + x.failureCount, 0)
  return totalAttempts > 0 ? totalSuccess / totalAttempts : 0.7
}

// ============================================
// 向量缓存（localStorage 持久化，避免每次冷启动重新 embed）
// ============================================

interface CachedVector {
  vector: number[]
  /** 缓存创建时间 */
  cachedAt: number
  /** 用于检测技能内容是否变化的 fingerprint */
  fingerprint: string
}

const skillEmbeddingCache = new Map<string, CachedVector>()
const EMBEDDING_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 小时（技能内容很少变化）
const LS_CACHE_KEY = 'duncrew_skill_embedding_cache'

/** 从 localStorage 恢复缓存 */
function loadEmbeddingCacheFromStorage(): void {
  try {
    const raw = localStorage.getItem(LS_CACHE_KEY)
    if (!raw) return
    const entries: [string, CachedVector][] = JSON.parse(raw)
    const now = Date.now()
    for (const [key, val] of entries) {
      if (now - val.cachedAt < EMBEDDING_CACHE_TTL) {
        skillEmbeddingCache.set(key, val)
      }
    }
    console.log(`[SkillRanking] Restored ${skillEmbeddingCache.size} cached embeddings from localStorage`)
  } catch { /* 缓存损坏则忽略 */ }
}

// 启动时恢复缓存
loadEmbeddingCacheFromStorage()

// 防抖持久化 timer
let _persistTimer: ReturnType<typeof setTimeout> | null = null

function skillFingerprint(skill: OpenClawSkill): string {
  return `${skill.name}::${skill.description ?? ''}::${(skill.keywords ?? []).join(',')}`
}

async function getSkillEmbedding(skill: OpenClawSkill): Promise<number[] | null> {
  const fp = skillFingerprint(skill)
  const cached = skillEmbeddingCache.get(skill.name)

  if (cached && cached.fingerprint === fp && Date.now() - cached.cachedAt < EMBEDDING_CACHE_TTL) {
    return cached.vector
  }

  try {
    const text = [
      skill.name,
      skill.description ?? '',
      (skill.keywords ?? []).join(' '),
      (skill.tags ?? []).join(' '),
    ].filter(Boolean).join(' | ')

    const vector = await embed(text)
    if (vector && vector.length > 0) {
      skillEmbeddingCache.set(skill.name, { vector, cachedAt: Date.now(), fingerprint: fp })
      // 防抖持久化到 localStorage（500ms 内多次写入只触发一次）
      if (_persistTimer) clearTimeout(_persistTimer)
      _persistTimer = setTimeout(() => {
        try {
          localStorage.setItem(LS_CACHE_KEY, JSON.stringify(Array.from(skillEmbeddingCache.entries())))
        } catch { /* quota 超出则忽略 */ }
      }, 500)
    }
    return vector
  } catch {
    return null
  }
}

// ============================================
// 公开接口
// ============================================

export interface SkillScoreBreakdown {
  semanticScore: number
  usageScore: number
  freshnessScore: number
  qualityScore: number
}

export interface RankedSkill {
  skill: OpenClawSkill
  totalScore: number
  breakdown: SkillScoreBreakdown
}

/**
 * 多信号融合排序（主路径，async）
 *
 * @param query    用户意图文本
 * @param skills   候选技能列表
 * @param topK     返回前 K 个
 * @param minScore 最低总分阈值（低于此分的技能直接过滤，默认 0.25）
 */
export async function rankSkills(
  query: string,
  skills: OpenClawSkill[],
  topK = 10,
  minScore = 0.40,
): Promise<RankedSkill[]> {
  if (skills.length === 0) return []

  // 1. 向量化用户意图
  let queryVector: number[] | null = null
  try {
    queryVector = await embed(query)
    if (queryVector && queryVector.length === 0) queryVector = null
  } catch {
    console.warn('[SkillRanking] embed(query) failed, degrading to keyword mode')
  }

  // 2. 全局均值
  const globalRate = computeGlobalAverageSuccessRate()

  // 3. 限流并发获取技能向量（每批 3 个，避免打满本地 embedding 服务）
  const skillVectors: (number[] | null)[] = new Array(skills.length).fill(null)
  if (queryVector) {
    const CONCURRENCY = 12
    for (let i = 0; i < skills.length; i += CONCURRENCY) {
      const batch = skills.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(s => getSkillEmbedding(s)))
      for (let j = 0; j < results.length; j++) {
        skillVectors[i + j] = results[j]
      }
    }
  }

  // 4. 逐技能计算 4 维得分
  const ranked: RankedSkill[] = skills.map((skill, i) => {
    const semanticScore =
      queryVector && skillVectors[i]
        ? Math.max(0, cosineSimilarity(queryVector, skillVectors[i]!))
        : 0.5 // 无向量时给中性分，不惩罚也不奖励

    const usageScore = computeBayesianSuccessRate(skill.name, globalRate)
    const freshnessScore = computeFreshnessScore(skill)
    const qualityScore = computeQualityPrior(skill)

    const totalScore =
      RANKING_WEIGHTS.semanticRelevance * semanticScore +
      RANKING_WEIGHTS.usageSignal * usageScore +
      RANKING_WEIGHTS.freshness * freshnessScore +
      RANKING_WEIGHTS.qualityPrior * qualityScore

    return {
      skill,
      totalScore,
      breakdown: { semanticScore, usageScore, freshnessScore, qualityScore },
    }
  })

  return ranked
    .filter(r => r.totalScore >= minScore)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, topK)
}

/**
 * 关键词降级排序（embed 完全不可用时的 fallback）
 *
 * 保留原有关键词匹配逻辑，但叠加使用信号 + 新鲜度 + 质量先验
 */
export function rankSkillsByKeyword(
  query: string,
  skills: OpenClawSkill[],
  topK = 10,
  minScore = 0.35,
): RankedSkill[] {
  const queryLower = query.toLowerCase()
  const queryTokens = queryLower.split(/\s+/).filter(Boolean)
  const globalRate = computeGlobalAverageSuccessRate()

  const ranked: RankedSkill[] = skills.map(skill => {
    // 构造技能文本
    const skillText = [
      skill.name,
      skill.description ?? '',
      (skill.keywords ?? []).join(' '),
      (skill.tags ?? []).join(' '),
    ].join(' ').toLowerCase()

    // TF 匹配（命中词数 / 查询词数）
    const hits = queryTokens.filter(t => skillText.includes(t)).length
    const semanticScore = queryTokens.length > 0 ? hits / queryTokens.length : 0

    const usageScore = computeBayesianSuccessRate(skill.name, globalRate)
    const freshnessScore = computeFreshnessScore(skill)
    const qualityScore = computeQualityPrior(skill)

    const totalScore =
      RANKING_WEIGHTS.semanticRelevance * semanticScore +
      RANKING_WEIGHTS.usageSignal * usageScore +
      RANKING_WEIGHTS.freshness * freshnessScore +
      RANKING_WEIGHTS.qualityPrior * qualityScore

    return {
      skill,
      totalScore,
      breakdown: { semanticScore, usageScore, freshnessScore, qualityScore },
    }
  })

  return ranked
    .filter(r => r.totalScore >= minScore)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, topK)
}

/**
 * 清理过期的向量缓存条目
 * 可在技能列表刷新时调用
 */
export function pruneEmbeddingCache(): void {
  const now = Date.now()
  for (const [key, cached] of skillEmbeddingCache) {
    if (now - cached.cachedAt > EMBEDDING_CACHE_TTL) {
      skillEmbeddingCache.delete(key)
    }
  }
}

/**
 * 后台预热所有技能的 embedding 向量
 * 在技能加载完成后调用，静默预计算，不阻塞主流程
 * 已有缓存的技能直接跳过
 */
export async function warmupSkillEmbeddings(skills: OpenClawSkill[]): Promise<void> {
  const uncached = skills.filter(s => {
    const fp = skillFingerprint(s)
    const cached = skillEmbeddingCache.get(s.name)
    return !(cached && cached.fingerprint === fp && Date.now() - cached.cachedAt < EMBEDDING_CACHE_TTL)
  })

  if (uncached.length === 0) {
    console.log(`[SkillRanking] Warmup: all ${skills.length} skills already cached`)
    return
  }

  console.log(`[SkillRanking] Warmup: ${uncached.length}/${skills.length} skills need embedding`)

  const CONCURRENCY = 12
  for (let i = 0; i < uncached.length; i += CONCURRENCY) {
    const batch = uncached.slice(i, i + CONCURRENCY)
    await Promise.all(batch.map(s => getSkillEmbedding(s)))
  }

  console.log(`[SkillRanking] Warmup complete: ${uncached.length} embeddings computed`)
}
