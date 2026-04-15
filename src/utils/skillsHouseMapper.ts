/**
 * Skills House 数据映射层
 *
 * 职责:
 * 1. OpenClawSkill → UISkillModel 扁平映射
 * 2. 智能聚类引擎 (tags + toolNames 两层匹配, 兜底 utility)
 * 3. 侧边栏动态 Domain 目录生成
 */

import { ABILITY_DOMAIN_CONFIGS } from '@/services/skillStatsService'
import { skillStatsService } from '@/services/skillStatsService'
import {
  computeBayesianSuccessRate,
  computeFreshnessScore,
  computeQualityPrior,
  computeGlobalAverageSuccessRate,
} from '@/services/skillRankingService'
import type { OpenClawSkill, AbilityDomain, SkillSource } from '@/types'

// ============================================
// UI Skill Model (扁平 15 字段)
// ============================================

export interface UISkillModel {
  id: string
  name: string
  desc: string
  emoji: string
  type: 'instruction' | 'executable'
  tags: string[]
  toolNames: string[]
  status: 'active' | 'inactive' | 'error'
  missingReqs: string[]          // 未满足的依赖 (env/bins)
  danger: 'safe' | 'high' | 'critical'
  requiresAPI: boolean
  apiName: string | null
  usageCount: number
  healthScore: number            // 0-100 综合健康度
  domain: AbilityDomain          // 聚类结果
  isDormant: boolean             // 休眠态 (标灰)
  source: SkillSource            // 来源: builtin(系统内置) | community(社区下载) | user(用户自建)
  subGroupKey?: string           // 所属子组 key (由 computeSubGroups 回写)
  subGroupLabel?: string         // 所属子组显示名
  /** 综合排序分 (0-100, 浏览模式下不含语义分) */
  rankScore: number
  /** 各维度明细 (0-1) */
  scoreBreakdown: {
    usageScore: number       // 贝叶斯平均成功率
    freshnessScore: number   // 新鲜度衰减
    qualityScore: number     // SKILL.md 完整度
  }
  // 保留原始引用, 督查面板取额外信息
  _raw: OpenClawSkill
}

// ============================================
// getSkillEmoji - 三级回退专属 emoji 分配
// ============================================

// 语义关键词 → emoji 映射表
const KEYWORD_EMOJI_MAP: Array<[RegExp, string]> = [
  // 文件/文档类
  [/pdf/i, '📄'], [/doc|word|docx/i, '📝'], [/excel|xlsx|csv|spreadsheet/i, '📊'],
  [/ppt|slide|presentation/i, '📽️'], [/markdown|md/i, '📋'],
  // 搜索/分析
  [/search|find|lookup|query/i, '🔍'], [/analy[sz]|insight|report/i, '📈'],
  [/monitor|watch|track/i, '📡'], [/scrape|crawl|fetch/i, '🕸️'],
  // 代码/开发
  [/code|program|develop|debug/i, '💻'], [/git|repo|commit/i, '🔀'],
  [/test|spec|assert/i, '🧪'], [/deploy|build|compile/i, '🏗️'],
  [/database|sql|db/i, '🗄️'], [/api|endpoint|rest/i, '🔌'],
  // 网络/通讯
  [/email|mail|smtp/i, '📧'], [/chat|message|notify/i, '💬'],
  [/discord/i, '🎮'], [/slack/i, '📢'], [/telegram|tg/i, '✈️'],
  [/twitter|tweet/i, '🐦'], [/weibo|微博/i, '🌐'],
  [/wechat|微信/i, '💚'], [/小红书|redbook/i, '📕'],
  [/公众号/i, '📣'], [/即刻|jike/i, '⚡'],
  [/feishu|飞书|lark/i, '🪶'],
  // 媒体/创作
  [/image|img|photo|picture/i, '🖼️'], [/video|movie|film/i, '🎬'],
  [/audio|sound|music|voice/i, '🎵'], [/draw|paint|art|canvas/i, '🎨'],
  [/漫画|comic|manga/i, '🖌️'], [/小说|novel|story|fiction/i, '📖'],
  [/新闻|news|press/i, '📰'], [/翻译|translat/i, '🌍'],
  [/写作|writ|author|blog/i, '✍️'],
  // 数据/AI
  [/data|dataset/i, '📊'], [/machine.?learn|ml|train/i, '🤖'],
  [/nlp|text|语义/i, '🔤'], [/vision|ocr|识别/i, '👁️'],
  // 金融/商业
  [/stock|股票|trade|交易/i, '📉'], [/finance|财务|会计/i, '💰'],
  [/invest|投资/i, '🏦'], [/tax|税/i, '🧾'], [/budget|预算/i, '💵'],
  // 系统/安全
  [/shell|cmd|terminal|command/i, '🖥️'], [/file|directory|folder/i, '📁'],
  [/cach[e]/i, '💾'], [/password|auth|secret|key/i, '🔐'],
  [/encrypt|decrypt|cipher/i, '🔏'], [/secur|安全/i, '🛡️'],
  [/valid|check|verify/i, '✅'], [/organiz|sort|arrang/i, '📂'],
  // 行业/领域
  [/health|医|诊/i, '🏥'], [/legal|法|律/i, '⚖️'],
  [/education|教|学/i, '🎓'], [/travel|旅/i, '✈️'],
  [/food|cook|recipe|食/i, '🍳'], [/game|游戏/i, '🎮'],
  [/装修|interior|design/i, '🏠'], [/运营|operat/i, '📊'],
  [/政|politic|govern/i, '🏛️'],
  // AI/生成
  [/generat|create|produc/i, '✨'], [/optimi[sz]/i, '⚙️'],
  [/automat|自动/i, '🤖'], [/schedule|定时|cron/i, '⏰'],
]

// 极客风格兜底 emoji 池 (通过 hash 稳定分配)
const FALLBACK_EMOJI_POOL = [
  '🧊', '🪐', '🔮', '🧿', '🚀', '🧬', '🔬', '📡', '⚙️', '🧲',
  '🎯', '💎', '🪄', '🌀', '🔷', '🧩', '🎲', '⚗️', '🛸', '🌊',
]

function stableHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return Math.abs(hash)
}

/**
 * 获取技能专属 emoji (三级回退)
 * P1: 原生 skill.emoji
 * P2: name + desc 语义匹配
 * P3: id hash 兜底
 */
export function getSkillEmoji(skill: OpenClawSkill): string {
  // P1: 原生 emoji
  if (skill.emoji) return skill.emoji

  // P2: 语义关键词匹配 (name + desc + toolName)
  const text = [skill.name, skill.description, skill.toolName].filter(Boolean).join(' ')
  for (const [pattern, emoji] of KEYWORD_EMOJI_MAP) {
    if (pattern.test(text)) return emoji
  }

  // P3: hash 稳定兜底
  const key = skill.toolName || skill.name || 'unknown'
  return FALLBACK_EMOJI_POOL[stableHash(key) % FALLBACK_EMOJI_POOL.length]
}

// ============================================
// 高风险工具名识别 (与 LocalClawService CONFIG 保持一致)
// ============================================

const HIGH_RISK_TOOL_NAMES = new Set(['runCmd', 'run_cmd', 'shell', 'exec'])

// API Key 环境变量特征后缀
const API_ENV_SUFFIXES = ['_KEY', '_TOKEN', '_SECRET', '_API_KEY', '_API_TOKEN']

// 从 env 名推断 API 服务名
function inferApiName(envName: string): string {
  for (const suffix of API_ENV_SUFFIXES) {
    if (envName.toUpperCase().endsWith(suffix)) {
      const raw = envName.slice(0, envName.length - suffix.length)
      // GITHUB_TOKEN → GitHub, OPENAI_API_KEY → OpenAI
      return raw
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('')
    }
  }
  return envName
}

// ============================================
// 聚类引擎: tags + toolNames → AbilityDomain
// ============================================

/**
 * 按优先级匹配:
 * 1. tags 命中某域关键词 → 该域
 * 2. toolNames 命中某域关键词 → 该域
 * 3. 兜底 → utility
 */
export function classifySkill(skill: OpenClawSkill): AbilityDomain {
  const candidates = [
    ...(skill.tags ?? []).map((t) => t.toLowerCase()),
    ...(skill.toolNames ?? []).map((t) => t.toLowerCase()),
    ...(skill.toolName ? [skill.toolName.toLowerCase()] : []),
    skill.name.toLowerCase(),
  ]

  for (const config of ABILITY_DOMAIN_CONFIGS) {
    for (const kw of config.keywords) {
      if (candidates.some((c) => c.includes(kw))) {
        return config.id
      }
    }
  }
  return 'utility'
}

// ============================================
// 健康度评分 (0-100)
// ============================================

function computeHealthScore(
  skill: OpenClawSkill,
  missingReqs: string[],
  stats: { callCount: number; successCount: number; failureCount: number } | null,
): number {
  let score = 0

  // status === active → +40
  if (skill.status === 'active') score += 40

  // 所有 requires.env 已满足 → +30 (按满足比例线性)
  const totalEnv = skill.requires?.env?.length ?? 0
  if (totalEnv === 0) {
    score += 30
  } else {
    const satisfied = totalEnv - missingReqs.filter((r) => r.startsWith('env:')).length
    score += Math.round((satisfied / totalEnv) * 30)
  }

  // 最近有成功调用 → +20
  if (stats && stats.successCount > 0) score += 20

  // 无失败记录 → +10
  if (!stats || stats.failureCount === 0) score += 10

  return Math.min(score, 100)
}

// ============================================
// 推断技能类型 (instruction / executable)
// ============================================

function inferType(skill: OpenClawSkill): 'instruction' | 'executable' {
  if (skill.toolType) return skill.toolType
  if (skill.executable) return 'executable'
  if (skill.toolNames && skill.toolNames.length > 0) return 'executable'
  if (skill.toolName) return 'executable'
  return 'instruction'
}

// ============================================
// 推断危险等级
// ============================================

function inferDanger(skill: OpenClawSkill): 'safe' | 'high' | 'critical' {
  if (skill.dangerLevel === 'critical') return 'critical'
  if (skill.dangerLevel === 'high') return 'high'
  if (skill.dangerLevel === 'safe') return 'safe'
  // 自动推断: toolNames 包含高危工具
  const names = [...(skill.toolNames ?? []), ...(skill.toolName ? [skill.toolName] : [])]
  if (names.some((n) => HIGH_RISK_TOOL_NAMES.has(n))) return 'high'
  return 'safe'
}

// ============================================
// 推断技能来源 (builtin / community / user)
// ============================================

function inferSource(skill: OpenClawSkill): SkillSource {
  // 显式指定优先
  if (skill.source) return skill.source
  // 有 clawHub 市场信息且来源为 clawhub → 社区下载
  if (skill.clawHub?.source === 'clawhub') return 'community'
  // 用户自建: location 为 local 且无 clawHub 信息，或 path 包含 .duncrew/skills
  if (skill.location === 'local' && !skill.clawHub) return 'user'
  if (skill.path?.includes('.duncrew/skills') || skill.path?.includes('.duncrew\\skills')) return 'user'
  // 默认视为系统内置 (随 DunCrew 发行的 skills/ 目录下的技能)
  return 'builtin'
}

// ============================================
// 单条映射: OpenClawSkill → UISkillModel
// ============================================

export function mapSkillToUIModel(
  skill: OpenClawSkill,
  envValues: Record<string, string> | undefined,
): UISkillModel {
  // 计算缺失依赖
  const missingReqs: string[] = []
  const requiredEnvs = skill.requires?.env ?? []
  const currentEnv = envValues ?? {}
  for (const env of requiredEnvs) {
    if (!currentEnv[env]) {
      missingReqs.push(`env:${env}`)
    }
  }

  // 从 stats 获取用量
  const skillId = skill.toolName || skill.name
  const stats = skillStatsService.getSkillStats(skillId)

  // 推断 API 需求
  const apiEnvs = requiredEnvs.filter((e) =>
    API_ENV_SUFFIXES.some((s) => e.toUpperCase().endsWith(s)),
  )
  const requiresAPI = apiEnvs.length > 0
  const apiName = requiresAPI ? inferApiName(apiEnvs[0]) : null

  const type = inferType(skill)
  const danger = inferDanger(skill)
  const healthScore = computeHealthScore(skill, missingReqs, stats)
  const domain = classifySkill(skill)

  // 休眠态: 未激活 / 健康度过低 / 需要API但未配置
  const apiConfigured = !requiresAPI || apiEnvs.every((e) => !!currentEnv[e])
  const isDormant =
    skill.status !== 'active' ||
    healthScore < 50 ||
    (requiresAPI && !apiConfigured)

  const source = inferSource(skill)

  // 多信号融合评分 (浏览模式: 不含语义分，使用 3 维加权)
  const globalRate = computeGlobalAverageSuccessRate()
  const usageScore = computeBayesianSuccessRate(skillId, globalRate)
  const freshnessScore = computeFreshnessScore(skill)
  const qualityScore = computeQualityPrior(skill)
  // 浏览模式权重: 使用 0.50 / 新鲜度 0.25 / 质量 0.25
  const rankScore = Math.round(
    (0.50 * usageScore + 0.25 * freshnessScore + 0.25 * qualityScore) * 100,
  )

  return {
    id: skillId,
    name: skill.name,
    desc: skill.description ?? '',
    emoji: getSkillEmoji(skill),
    type,
    tags: skill.tags ?? [],
    toolNames: skill.toolNames ?? (skill.toolName ? [skill.toolName] : []),
    status: skill.status,
    missingReqs,
    danger,
    requiresAPI,
    apiName,
    usageCount: stats?.callCount ?? 0,
    healthScore,
    domain,
    isDormant,
    source,
    rankScore,
    scoreBreakdown: { usageScore, freshnessScore, qualityScore },
    _raw: skill,
  }
}

// ============================================
// 批量映射
// ============================================

export function mapAllSkills(
  skills: OpenClawSkill[],
  allEnvValues: Record<string, Record<string, string>>,
): UISkillModel[] {
  const seenIds = new Set<string>()
  return skills.map((s, index) => {
    const envKey = s.toolName || s.name
    // 兼容: env 可能存在 name 或 toolName 下, 合并两者
    const envForSkill = envKey !== s.name
      ? { ...(allEnvValues[s.name] || {}), ...(allEnvValues[envKey] || {}) }
      : allEnvValues[envKey] || {}
    const model = mapSkillToUIModel(s, envForSkill)
    // 保证 id 唯一: 同名技能追加 index 后缀
    if (seenIds.has(model.id)) {
      model.id = `${model.id}_${index}`
    }
    seenIds.add(model.id)
    return model
  })
}

// ============================================
// SubGroup (二级子分类)
// ============================================

export interface SubGroup {
  key: string         // "prefix:file" | "api:GitHub" | "tag:web" | "env:python"
  label: string       // 显示名
  source: 'prefix' | 'api' | 'tag' | 'env'
  skills: UISkillModel[]
}

// ============================================
// Domain 目录 (侧边栏用)
// ============================================

export interface DomainGroup {
  id: AbilityDomain
  name: string
  color: string
  emoji: string
  skills: UISkillModel[]
  totalUsage: number
  subGroups?: SubGroup[]         // 二级子分组 (仅 skills > 6 时计算)
  ungrouped?: UISkillModel[]     // 未被子组收纳的散户
}

const DOMAIN_EMOJI: Record<AbilityDomain, string> = {
  development: '💻',
  creative: '🎨',
  system: '🖥️',
  knowledge: '📚',
  social: '💬',
  security: '🔒',
  utility: '🔧',
}

// ============================================
// 二级子分组算法 (四层回退链)
// ============================================

const SUB_GROUP_TRIGGER = 6     // 域内技能数 > 此值才触发
const SUB_GROUP_MIN_SIZE = 2    // 子组最少技能数

// primaryEnv 显示名
const ENV_LABELS: Record<string, string> = {
  shell: 'Shell', node: 'Node.js', python: 'Python',
  go: 'Go', rust: 'Rust', browser: 'Browser',
}

/**
 * 提取 toolName 的命名空间前缀
 * file_read → "file", search_codebase → "search", weather → "weather"
 */
function extractToolPrefix(name: string): string {
  const idx = name.indexOf('_')
  return idx > 0 ? name.slice(0, idx) : name
}

/**
 * 首字母大写
 */
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * 条件触发的二级子分组
 * P1: toolName 前缀聚类
 * P2: apiName 生态聚类
 * P3: tags 共现聚类 (贪心)
 * P4: primaryEnv 兜底
 */
function computeSubGroups(
  skills: UISkillModel[],
): { subGroups: SubGroup[]; ungrouped: UISkillModel[] } {
  const remaining = new Set(skills.map((s) => s.id))
  const byId = new Map(skills.map((s) => [s.id, s]))
  const subGroups: SubGroup[] = []

  // 辅助: 从 remaining 中按 keyFn 聚类, 保留 size >= MIN
  function harvest(
    keyFn: (s: UISkillModel) => string | null,
    source: SubGroup['source'],
    keyPrefix: string,
    labelFn: (key: string) => string,
  ) {
    const buckets = new Map<string, UISkillModel[]>()
    for (const id of remaining) {
      const s = byId.get(id)!
      const key = keyFn(s)
      if (!key) continue
      const list = buckets.get(key) ?? []
      list.push(s)
      buckets.set(key, list)
    }
    for (const [key, items] of buckets) {
      if (items.length < SUB_GROUP_MIN_SIZE) continue
      const sg: SubGroup = {
        key: `${keyPrefix}:${key}`,
        label: labelFn(key),
        source,
        skills: items,
      }
      subGroups.push(sg)
      for (const s of items) {
        s.subGroupKey = sg.key
        s.subGroupLabel = sg.label
        remaining.delete(s.id)
      }
    }
  }

  // P1: toolName 前缀
  harvest(
    (s) => {
      const tn = s.toolNames[0] ?? s._raw.toolName
      return tn ? extractToolPrefix(tn.toLowerCase()) : null
    },
    'prefix',
    'prefix',
    (k) => capitalize(k),
  )

  // P2: apiName 生态
  harvest(
    (s) => s.apiName,
    'api',
    'api',
    (k) => k,
  )

  // P3: tags 共现 (贪心 — 按频次降序, 每个技能只进一个 tag 组)
  const tagCounts = new Map<string, number>()
  for (const id of remaining) {
    const s = byId.get(id)!
    for (const t of s.tags) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
    }
  }
  const sortedTags = [...tagCounts.entries()]
    .filter(([, c]) => c >= SUB_GROUP_MIN_SIZE)
    .sort((a, b) => b[1] - a[1])

  for (const [tag] of sortedTags) {
    const items: UISkillModel[] = []
    for (const id of remaining) {
      const s = byId.get(id)!
      if (s.tags.includes(tag)) items.push(s)
    }
    if (items.length < SUB_GROUP_MIN_SIZE) continue
    const sg: SubGroup = {
      key: `tag:${tag}`,
      label: tag,
      source: 'tag',
      skills: items,
    }
    subGroups.push(sg)
    for (const s of items) {
      s.subGroupKey = sg.key
      s.subGroupLabel = sg.label
      remaining.delete(s.id)
    }
  }

  // P4: primaryEnv 兜底
  harvest(
    (s) => s._raw.primaryEnv ?? null,
    'env',
    'env',
    (k) => ENV_LABELS[k] ?? capitalize(k),
  )

  // 剩余 = ungrouped
  const ungrouped = [...remaining].map((id) => byId.get(id)!)
  return { subGroups, ungrouped }
}

export function groupByDomain(models: UISkillModel[]): DomainGroup[] {
  const map = new Map<AbilityDomain, UISkillModel[]>()
  for (const m of models) {
    const list = map.get(m.domain) ?? []
    list.push(m)
    map.set(m.domain, list)
  }

  const groups: DomainGroup[] = []
  for (const config of ABILITY_DOMAIN_CONFIGS) {
    const skills = map.get(config.id) ?? []
    if (skills.length === 0) continue
    const group: DomainGroup = {
      id: config.id,
      name: config.name,
      color: config.color,
      emoji: DOMAIN_EMOJI[config.id] ?? '📦',
      skills,
      totalUsage: skills.reduce((sum, s) => sum + s.usageCount, 0),
    }
    // 条件触发二级子分组
    if (skills.length > SUB_GROUP_TRIGGER) {
      const { subGroups, ungrouped } = computeSubGroups(skills)
      if (subGroups.length > 0) {
        group.subGroups = subGroups
        group.ungrouped = ungrouped
      }
    }
    groups.push(group)
  }

  // 按域内平均 rankScore 降序
  groups.sort((a, b) => {
    const avgA = a.skills.length > 0 ? a.skills.reduce((s, x) => s + x.rankScore, 0) / a.skills.length : 0
    const avgB = b.skills.length > 0 ? b.skills.reduce((s, x) => s + x.rankScore, 0) / b.skills.length : 0
    return avgB - avgA
  })
  return groups
}

// ============================================
// 特殊过滤视图
// ============================================

export type SpecialFilter = 'all' | 'needs-api' | 'broken' | 'hot' | 'source-builtin' | 'source-community' | 'source-user'

export function filterBySpecial(models: UISkillModel[], filter: SpecialFilter): UISkillModel[] {
  switch (filter) {
    case 'needs-api':
      return models.filter((m) => m.requiresAPI)
    case 'broken':
      return models.filter((m) => m.status === 'error' || m.missingReqs.length > 0)
    case 'hot':
      return [...models].sort((a, b) => b.usageCount - a.usageCount).slice(0, 20)
    case 'source-builtin':
      return models.filter((m) => m.source === 'builtin')
    case 'source-community':
      return models.filter((m) => m.source === 'community')
    case 'source-user':
      return models.filter((m) => m.source === 'user')
    case 'all':
    default:
      return models
  }
}
