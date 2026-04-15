/**
 * WSJ Editorial Style 共享常量和工具
 */

import {
  BookOpen, FileText, Sparkles, Globe2, Layers, TrendingUp,
  Lightbulb, Quote,
} from 'lucide-react'

// ── 颜色 ──
export const INK = '#1a1a1a'
export const INK_LIGHT = '#4a4a4a'
export const INK_DIM = '#6b6b6b'
export const INK_MUTED = '#a0a0a0'
export const BG = '#fafaf8'
export const BG_WARM = '#f5f4f0'
export const BORDER = '#e0ddd8'
export const BORDER_LIGHT = '#f0eeeb'
export const ACCENT = '#c4392d'
export const GREEN = '#2d6a2d'

// ── 字体 ──
export const FONT_SERIF = "'Georgia', 'Noto Serif SC', 'SimSun', serif"
export const FONT_MONO = "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace"

// ── Entity 类型元数据 ──
export const TYPE_META: Record<string, { icon: typeof BookOpen; accent: string; label: string }> = {
  concept:  { icon: BookOpen,   accent: ACCENT,    label: 'CONCEPT' },
  pattern:  { icon: Sparkles,   accent: '#8b6914', label: 'PATTERN' },
  tool:     { icon: Layers,     accent: GREEN,     label: 'TOOL' },
  domain:   { icon: Globe2,     accent: '#1a5276', label: 'DOMAIN' },
  metric:   { icon: TrendingUp, accent: ACCENT,    label: 'METRIC' },
  topic:    { icon: FileText,   accent: '#1a5276', label: 'TOPIC' },
}
const DEFAULT_META = { icon: FileText, accent: INK_DIM, label: 'ENTITY' }
export function getMeta(type: string) { return TYPE_META[type] || DEFAULT_META }

// ── Claim 类型元数据 ──
export const CLAIM_ACCENT: Record<string, { color: string; label: string; icon: typeof Lightbulb }> = {
  insight:  { color: ACCENT,    label: 'INSIGHT',  icon: Lightbulb },
  pattern:  { color: '#8b6914', label: 'PATTERN',  icon: Sparkles },
  fact:     { color: '#1a5276', label: 'FACT',      icon: BookOpen },
  metric:   { color: GREEN,     label: 'METRIC',    icon: TrendingUp },
}
const DEFAULT_CLAIM = { color: INK_DIM, label: 'CLAIM', icon: Quote }
export function getClaimMeta(type: string | null) { return (type && CLAIM_ACCENT[type]) || DEFAULT_CLAIM }

// ── Relation 类型标签 ──
export const REL_LABELS: Record<string, { label: string; color: string }> = {
  related_to:  { label: '相关', color: '#1a5276' },
  contradicts: { label: '矛盾', color: ACCENT },
  subtopic_of: { label: '子主题', color: '#8b6914' },
}

// ── 工具函数 ──
export function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function fmtShortDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}h前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d前`
  return `${Math.floor(days / 30)}月前`
}
