// ============================================
// Dun 成长阶段系统
// 基于 score(0-100) 和 totalRuns 决定视觉演化
// ============================================

import type { DunScoring } from '@/types'

// 成长阶段
export type GrowthStage = 'egg' | 'hatchling' | 'youth' | 'adult' | 'master'

// 动物种族 (36 种)
export type AnimalSpecies =
  | 'cat' | 'dog' | 'fox' | 'rabbit'
  | 'owl' | 'eagle' | 'penguin' | 'parrot'
  | 'bear' | 'deer' | 'wolf' | 'lion'
  | 'dolphin' | 'turtle' | 'dragon' | 'phoenix'
  // ── 新增 20 种 ──
  | 'tiger' | 'monkey' | 'elephant' | 'giraffe'
  | 'snake' | 'shark' | 'whale' | 'octopus'
  | 'frog' | 'unicorn' | 'horse' | 'butterfly'
  | 'kangaroo' | 'camel' | 'hedgehog' | 'otter'
  | 'swan' | 'peacock' | 'trex' | 'bat'

// 每个阶段的 emoji 映射
const SPECIES_STAGE_EMOJI: Record<AnimalSpecies, Record<GrowthStage, string>> = {
  cat:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC31', youth: '\uD83D\uDE3A', adult: '\uD83D\uDE3C', master: '\uD83D\uDE38' },
  dog:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC36', youth: '\uD83D\uDC15', adult: '\uD83D\uDC15\u200D\uD83E\uDDBA', master: '\uD83D\uDC3A' },
  fox:     { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD8A', youth: '\uD83E\uDD8A', adult: '\uD83E\uDD8A', master: '\uD83E\uDD8A' },
  rabbit:  { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC30', youth: '\uD83D\uDC07', adult: '\uD83D\uDC07', master: '\uD83D\uDC07' },
  owl:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC23', youth: '\uD83E\uDD89', adult: '\uD83E\uDD89', master: '\uD83E\uDD89' },
  eagle:   { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC24', youth: '\uD83E\uDD85', adult: '\uD83E\uDD85', master: '\uD83E\uDD85' },
  penguin: { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC27', youth: '\uD83D\uDC27', adult: '\uD83D\uDC27', master: '\uD83D\uDC27' },
  parrot:  { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC25', youth: '\uD83E\uDD9C', adult: '\uD83E\uDD9C', master: '\uD83E\uDD9C' },
  bear:    { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC3B', youth: '\uD83D\uDC3B', adult: '\uD83D\uDC3B', master: '\uD83D\uDC3B\u200D\u2744\uFE0F' },
  deer:    { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD8C', youth: '\uD83E\uDD8C', adult: '\uD83E\uDD8C', master: '\uD83E\uDD8C' },
  wolf:    { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC3A', youth: '\uD83D\uDC3A', adult: '\uD83D\uDC3A', master: '\uD83D\uDC3A' },
  lion:    { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD81', youth: '\uD83E\uDD81', adult: '\uD83E\uDD81', master: '\uD83E\uDD81' },
  dolphin: { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC2C', youth: '\uD83D\uDC2C', adult: '\uD83D\uDC2C', master: '\uD83D\uDC33' },
  turtle:  { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC22', youth: '\uD83D\uDC22', adult: '\uD83D\uDC22', master: '\uD83D\uDC22' },
  dragon:  { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC32', youth: '\uD83D\uDC32', adult: '\uD83D\uDC09', master: '\uD83D\uDC09' },
  phoenix: { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC26', youth: '\uD83D\uDD25', adult: '\uD83D\uDD25', master: '\u2728' },
  // ── 新增 20 种 ──
  tiger:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC2F', youth: '\uD83D\uDC2F', adult: '\uD83D\uDC05', master: '\uD83D\uDC05' },
  monkey:    { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC35', youth: '\uD83D\uDC35', adult: '\uD83D\uDC12', master: '\uD83E\uDD8D' },
  elephant:  { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC18', youth: '\uD83D\uDC18', adult: '\uD83D\uDC18', master: '\uD83E\uDDA3' },
  giraffe:   { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD92', youth: '\uD83E\uDD92', adult: '\uD83E\uDD92', master: '\uD83E\uDD92' },
  snake:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC0D', youth: '\uD83D\uDC0D', adult: '\uD83D\uDC0D', master: '\uD83D\uDC0D' },
  shark:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC1F', youth: '\uD83E\uDD88', adult: '\uD83E\uDD88', master: '\uD83E\uDD88' },
  whale:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC2C', youth: '\uD83D\uDC33', adult: '\uD83D\uDC33', master: '\uD83D\uDC0B' },
  octopus:   { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC19', youth: '\uD83D\uDC19', adult: '\uD83D\uDC19', master: '\uD83D\uDC19' },
  frog:      { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC38', youth: '\uD83D\uDC38', adult: '\uD83D\uDC38', master: '\uD83D\uDC38' },
  unicorn:   { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC34', youth: '\uD83E\uDD84', adult: '\uD83E\uDD84', master: '\uD83E\uDD84' },
  horse:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC34', youth: '\uD83D\uDC0E', adult: '\uD83D\uDC0E', master: '\uD83C\uDFC7' },
  butterfly: { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC1B', youth: '\uD83D\uDC1B', adult: '\uD83E\uDD8B', master: '\uD83E\uDD8B' },
  kangaroo:  { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD98', youth: '\uD83E\uDD98', adult: '\uD83E\uDD98', master: '\uD83E\uDD98' },
  camel:     { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC2A', youth: '\uD83D\uDC2A', adult: '\uD83D\uDC2B', master: '\uD83D\uDC2B' },
  hedgehog:  { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD94', youth: '\uD83E\uDD94', adult: '\uD83E\uDD94', master: '\uD83E\uDD94' },
  otter:     { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDDA6', youth: '\uD83E\uDDA6', adult: '\uD83E\uDDA6', master: '\uD83E\uDDA6' },
  swan:      { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC23', youth: '\uD83E\uDDA2', adult: '\uD83E\uDDA2', master: '\uD83E\uDDA2' },
  peacock:   { egg: '\uD83E\uDD5A', hatchling: '\uD83D\uDC25', youth: '\uD83E\uDD9A', adult: '\uD83E\uDD9A', master: '\uD83E\uDD9A' },
  trex:      { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD95', youth: '\uD83E\uDD96', adult: '\uD83E\uDD96', master: '\uD83E\uDD96' },
  bat:       { egg: '\uD83E\uDD5A', hatchling: '\uD83E\uDD87', youth: '\uD83E\uDD87', adult: '\uD83E\uDD87', master: '\uD83E\uDD87' },
}

export const ALL_SPECIES: AnimalSpecies[] = [
  'cat', 'dog', 'fox', 'rabbit',
  'owl', 'eagle', 'penguin', 'parrot',
  'bear', 'deer', 'wolf', 'lion',
  'dolphin', 'turtle', 'dragon', 'phoenix',
  'tiger', 'monkey', 'elephant', 'giraffe',
  'snake', 'shark', 'whale', 'octopus',
  'frog', 'unicorn', 'horse', 'butterfly',
  'kangaroo', 'camel', 'hedgehog', 'otter',
  'swan', 'peacock', 'trex', 'bat',
]

// 每个种族的中文名
export const SPECIES_LABELS: Record<AnimalSpecies, string> = {
  cat: '猫咪', dog: '小狗', fox: '狐狸', rabbit: '兔子',
  owl: '猫头鹰', eagle: '雄鹰', penguin: '企鹅', parrot: '鹦鹉',
  bear: '小熊', deer: '小鹿', wolf: '灰狼', lion: '狮子',
  dolphin: '海豚', turtle: '乌龟', dragon: '龙', phoenix: '凤凰',
  tiger: '老虎', monkey: '猴子', elephant: '大象', giraffe: '长颈鹿',
  snake: '蛇', shark: '鲨鱼', whale: '鲸鱼', octopus: '章鱼',
  frog: '青蛙', unicorn: '独角兽', horse: '马', butterfly: '蝴蝶',
  kangaroo: '袋鼠', camel: '骆驼', hedgehog: '刺猬', otter: '水獭',
  swan: '天鹅', peacock: '孔雀', trex: '霸王龙', bat: '蝙蝠',
}

// 分数 → 成长阶段
export function getGrowthStage(score: number, totalRuns: number): GrowthStage {
  // 需要同时满足分数门槛和执行次数门槛
  if (score >= 80 && totalRuns >= 20) return 'master'
  if (score >= 60 && totalRuns >= 10) return 'adult'
  if (score >= 40 && totalRuns >= 5) return 'youth'
  if (score >= 20 && totalRuns >= 2) return 'hatchling'
  return 'egg'
}

// 成长阶段中文名
export const STAGE_LABELS: Record<GrowthStage, string> = {
  egg: '蛋',
  hatchling: '幼生',
  youth: '少年',
  adult: '成年',
  master: '大师',
}

// 获取 Dun 对应的 emoji
export function getDunEmoji(species: AnimalSpecies, scoring?: DunScoring): string {
  const stage = scoring
    ? getGrowthStage(scoring.score, scoring.totalRuns)
    : 'egg'
  return SPECIES_STAGE_EMOJI[species]?.[stage] ?? '\uD83E\uDD5A'
}

// 基于 ID 哈希确定默认种族 (fallback, 不保证唯一)
export function getDefaultSpecies(dunId: string): AnimalSpecies {
  let hash = 0
  for (let i = 0; i < dunId.length; i++) {
    hash = ((hash << 5) - hash + dunId.charCodeAt(i)) | 0
  }
  return ALL_SPECIES[Math.abs(hash) % ALL_SPECIES.length]
}

// 分配唯一种族：优先选未被使用的种族，全部用完则 fallback 到哈希
export function assignUniqueSpecies(dunId: string, usedSpecies: Set<AnimalSpecies>): AnimalSpecies {
  const available = ALL_SPECIES.filter(s => !usedSpecies.has(s))
  if (available.length === 0) {
    return getDefaultSpecies(dunId)
  }
  let hash = 0
  for (let i = 0; i < dunId.length; i++) {
    hash = ((hash << 5) - hash + dunId.charCodeAt(i)) | 0
  }
  return available[Math.abs(hash) % available.length]
}

// 情绪状态 (基于 streak)
export type EmotionState = 'ecstatic' | 'happy' | 'neutral' | 'sad' | 'dejected'

export function getEmotionState(streak: number): EmotionState {
  if (streak >= 5) return 'ecstatic'
  if (streak >= 3) return 'happy'
  if (streak <= -3) return 'dejected'
  if (streak <= -2) return 'sad'
  return 'neutral'
}

export const EMOTION_LABELS: Record<EmotionState, string> = {
  ecstatic: '狂喜',
  happy: '开心',
  neutral: '平静',
  sad: '低落',
  dejected: '沮丧',
}

// 成就定义
export type AchievementId =
  | 'first_success'
  | 'streak_5'
  | 'streak_10'
  | 'runs_10'
  | 'runs_50'
  | 'runs_100'
  | 'genes_10'
  | 'multi_tool_chain'
  | 'error_recovery'
  | 'master_tier'

export interface AchievementDef {
  id: AchievementId
  label: string
  description: string
  emoji: string
  tier: 'bronze' | 'silver' | 'gold'
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first_success', label: '初次成功', description: '完成第一次任务', emoji: '\uD83C\uDF1F', tier: 'bronze' },
  { id: 'streak_5', label: '五连胜', description: '连续5次成功执行', emoji: '\uD83D\uDD25', tier: 'silver' },
  { id: 'streak_10', label: '十连胜', description: '连续10次成功执行', emoji: '\u26A1', tier: 'gold' },
  { id: 'runs_10', label: '初出茅庐', description: '累计执行10次', emoji: '\uD83D\uDCAA', tier: 'bronze' },
  { id: 'runs_50', label: '驾轻就熟', description: '累计执行50次', emoji: '\uD83C\uDFC6', tier: 'silver' },
  { id: 'runs_100', label: '百战百胜', description: '累计执行100次', emoji: '\uD83D\uDC51', tier: 'gold' },
  { id: 'genes_10', label: '基因收集者', description: '收集10个自愈基因', emoji: '\uD83E\uDDEC', tier: 'silver' },
  { id: 'multi_tool_chain', label: '工具大师', description: '单次执行使用5种以上工具', emoji: '\uD83D\uDD27', tier: 'silver' },
  { id: 'error_recovery', label: '绝处逢生', description: '从错误中恢复并完成任务', emoji: '\uD83C\uDF00', tier: 'bronze' },
  { id: 'master_tier', label: '登峰造极', description: '达到 Master 等级', emoji: '\uD83C\uDF1E', tier: 'gold' },
]

// 检测新获得的成就
export function checkAchievements(scoring: DunScoring, existingAchievements: AchievementId[]): AchievementId[] {
  const newlyEarned: AchievementId[] = []
  const has = (id: AchievementId) => existingAchievements.includes(id)

  if (!has('first_success') && scoring.successCount >= 1) newlyEarned.push('first_success')
  if (!has('streak_5') && scoring.streak >= 5) newlyEarned.push('streak_5')
  if (!has('streak_10') && scoring.streak >= 10) newlyEarned.push('streak_10')
  if (!has('runs_10') && scoring.totalRuns >= 10) newlyEarned.push('runs_10')
  if (!has('runs_50') && scoring.totalRuns >= 50) newlyEarned.push('runs_50')
  if (!has('runs_100') && scoring.totalRuns >= 100) newlyEarned.push('runs_100')
  if (!has('master_tier') && scoring.score >= 80 && scoring.totalRuns >= 20) newlyEarned.push('master_tier')

  return newlyEarned
}
