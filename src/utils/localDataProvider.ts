/**
 * 本地数据 Provider
 * 支持从 localStorage 加载用户配置的数据
 */

import type { OpenClawSkill, SoulTruth, SoulBoundary, SoulIdentity, MemoryEntry } from '@/types'
import { parseSoulMd } from './soulParser'

// localStorage keys
const STORAGE_KEYS = {
  SOUL_MD: 'duncrew_soul_md',
  IDENTITY_MD: 'duncrew_identity_md',
  SKILLS_JSON: 'duncrew_skills_json',
  MEMORIES_JSON: 'duncrew_memories_json',
  DATA_MODE: 'duncrew_data_mode', // 'local' | 'network'
}

export type DataMode = 'local' | 'network'

// ============================================
// 数据模式管理
// ============================================

export function getDataMode(): DataMode {
  return (localStorage.getItem(STORAGE_KEYS.DATA_MODE) as DataMode) || 'local'
}

export function setDataMode(mode: DataMode): void {
  localStorage.setItem(STORAGE_KEYS.DATA_MODE, mode)
}

// ============================================
// Soul 数据
// ============================================

export function saveSoulMd(content: string): void {
  localStorage.setItem(STORAGE_KEYS.SOUL_MD, content)
}

export function getSoulMd(): string | null {
  return localStorage.getItem(STORAGE_KEYS.SOUL_MD)
}

export function saveIdentityMd(content: string): void {
  localStorage.setItem(STORAGE_KEYS.IDENTITY_MD, content)
}

export function getIdentityMd(): string | null {
  return localStorage.getItem(STORAGE_KEYS.IDENTITY_MD)
}

export interface LocalSoulData {
  identity: SoulIdentity
  coreTruths: SoulTruth[]
  boundaries: SoulBoundary[]
  vibeStatement: string
  continuityNote: string
  rawContent: string
}

export function getLocalSoulData(): LocalSoulData | null {
  const soulMd = getSoulMd()
  if (!soulMd) return null
  
  const parsed = parseSoulMd(soulMd)
  const identityMd = getIdentityMd()
  
  // 从 IDENTITY.md 提取名字和 emoji（如果有）
  let name = 'DunCrew Agent'
  let symbol = '🤖'
  
  if (identityMd) {
    // 简单解析 IDENTITY.md
    const nameMatch = identityMd.match(/name[:\s]+([^\n]+)/i)
    const emojiMatch = identityMd.match(/emoji[:\s]+([^\n]+)/i) || identityMd.match(/([\u{1F300}-\u{1F9FF}])/u)
    if (nameMatch) name = nameMatch[1].trim()
    if (emojiMatch) symbol = emojiMatch[1].trim()
  }
  
  return {
    identity: {
      name,
      essence: parsed.subtitle || parsed.title || 'AI Assistant',
      vibe: parsed.vibeStatement ? parsed.vibeStatement.slice(0, 100) : '',
      symbol,
    },
    coreTruths: parsed.coreTruths,
    boundaries: parsed.boundaries,
    vibeStatement: parsed.vibeStatement,
    continuityNote: parsed.continuityNote,
    rawContent: soulMd,
  }
}

// ============================================
// Skills 数据
// ============================================

export function saveSkillsJson(skills: OpenClawSkill[]): void {
  localStorage.setItem(STORAGE_KEYS.SKILLS_JSON, JSON.stringify(skills))
}

export function getLocalSkills(): OpenClawSkill[] {
  const json = localStorage.getItem(STORAGE_KEYS.SKILLS_JSON)
  if (!json) return []
  
  try {
    return JSON.parse(json)
  } catch {
    return []
  }
}

/**
 * 从 skills 目录列表文本解析技能
 * 支持简单的文本格式，每行一个技能名
 */
export function parseSkillsFromText(text: string): OpenClawSkill[] {
  const lines = text.split('\n').filter(line => line.trim())
  const skills: OpenClawSkill[] = []
  
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    
    // 支持格式: "skill-name" 或 "skill-name - description" 或 "skill-name (location)"
    const match = trimmed.match(/^([a-zA-Z0-9_-]+)(?:\s*[-–—]\s*(.+?))?(?:\s*\((\w+)\))?$/)
    if (match) {
      skills.push({
        name: match[1],
        description: match[2] || undefined,
        location: (match[3] as 'global' | 'local' | 'extension') || 'local',
        status: 'active',
        enabled: true,
      })
    } else {
      // 如果不匹配，直接用整行作为名字
      skills.push({
        name: trimmed.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase(),
        description: trimmed,
        location: 'local',
        status: 'active',
        enabled: true,
      })
    }
  }
  
  return skills
}

// ============================================
// Memories 数据
// ============================================

export function saveMemoriesJson(memories: MemoryEntry[]): void {
  localStorage.setItem(STORAGE_KEYS.MEMORIES_JSON, JSON.stringify(memories))
}

export function getLocalMemories(): MemoryEntry[] {
  const json = localStorage.getItem(STORAGE_KEYS.MEMORIES_JSON)
  if (!json) return []
  
  try {
    return JSON.parse(json)
  } catch {
    return []
  }
}

/**
 * 从 MEMORY.md 内容解析记忆条目
 */
export function parseMemoriesFromMd(content: string): MemoryEntry[] {
  const memories: MemoryEntry[] = []
  const sections = content.split(/^##\s+/m).filter(Boolean)
  
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    const lines = section.split('\n')
    const title = lines[0]?.trim() || `Memory ${i + 1}`
    const contentText = lines.slice(1).join('\n').trim()
    
    if (contentText) {
      memories.push({
        id: `memory-${i}`,
        title,
        content: contentText,
        type: 'long-term',
        timestamp: new Date().toISOString(),
        tags: extractTagsFromContent(contentText),
      })
    }
  }
  
  return memories
}

function extractTagsFromContent(content: string): string[] {
  const tags: string[] = []
  // 提取 #tag 格式的标签
  const tagMatches = content.match(/#([a-zA-Z\u4e00-\u9fa5]+)/g)
  if (tagMatches) {
    tags.push(...tagMatches.map(t => t.slice(1)))
  }
  return tags.slice(0, 5) // 最多 5 个标签
}

// ============================================
// 清除数据
// ============================================

export function clearLocalData(): void {
  Object.values(STORAGE_KEYS).forEach(key => {
    localStorage.removeItem(key)
  })
}

// ============================================
// 检查是否有本地数据
// ============================================

export function hasLocalData(): boolean {
  return !!(getSoulMd() || getLocalSkills().length > 0 || getLocalMemories().length > 0)
}

// ============================================
// 导出/导入完整配置
// ============================================

export interface DdosConfig {
  soulMd?: string
  identityMd?: string
  skills?: OpenClawSkill[]
  memories?: MemoryEntry[]
}

export function exportConfig(): DdosConfig {
  return {
    soulMd: getSoulMd() || undefined,
    identityMd: getIdentityMd() || undefined,
    skills: getLocalSkills(),
    memories: getLocalMemories(),
  }
}

export function importConfig(config: DdosConfig): void {
  if (config.soulMd) saveSoulMd(config.soulMd)
  if (config.identityMd) saveIdentityMd(config.identityMd)
  if (config.skills) saveSkillsJson(config.skills)
  if (config.memories) saveMemoriesJson(config.memories)
}
