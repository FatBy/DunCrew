/**
 * KnowledgeDetailModal - Entity 详情弹窗 (V4: WSJ Editorial Style)
 *
 * 设计语言参考华尔街日报 Daily Analysis：
 * - 衬线标题 + 无衬线正文 + 等宽数据
 * - 编号式章节 (01, 02...)
 * - 白卡数据面板 (居中大号等宽数值)
 * - 左侧色线信号卡
 * - 暖色中性调 + 大量留白
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, ChevronLeft, BookOpen, FileText, Sparkles, Search,
  Globe2, Layers, TrendingUp, TrendingDown, Minus,
  AlertTriangle, ArrowRight, Clock, Lightbulb, Quote,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/utils/cn'

// ============================================
// Types (matches wiki API response)
// ============================================

interface WikiEvidence {
  id: string
  sourceName: string
  chunkText: string | null
  timestamp: number
}

interface WikiClaim {
  id: string
  content: string
  type: string | null
  value: string | null
  trend: string | null
  confidence: number
  status: string
  conflictWith: string | null
  sourceIngestId: string | null
  createdAt: number
  updatedAt: number
  evidence: WikiEvidence[]
}

interface WikiRelation {
  id: string
  sourceId: string
  targetId: string
  type: string
  strength: number
  description: string | null
  targetTitle: string
  targetType: string
}

interface WikiEntityDetail {
  id: string
  dunId: string | null
  slug: string
  title: string
  type: string
  tldr: string | null
  tags: string[]
  status: string
  createdAt: number
  updatedAt: number
  claims: WikiClaim[]
  relations: WikiRelation[]
}

// ============================================
// WSJ-style palette & helpers
// ============================================

// Warm ink palette
const INK = '#1a1a1a'
const INK_LIGHT = '#4a4a4a'
const INK_DIM = '#6b6b6b'
const INK_MUTED = '#a0a0a0'
const BG = '#fafaf8'
const BG_WARM = '#f5f4f0'
const BORDER = '#e0ddd8'
const BORDER_LIGHT = '#f0eeeb'
const ACCENT = '#c4392d'
const GREEN = '#2d6a2d'

// Serif stack for headings
const FONT_SERIF = "'Georgia', 'Noto Serif SC', 'SimSun', serif"
// Monospace for data
const FONT_MONO = "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace"

const TYPE_META: Record<string, { icon: typeof BookOpen; accent: string; label: string }> = {
  concept:  { icon: BookOpen,   accent: ACCENT,  label: 'CONCEPT' },
  pattern:  { icon: Sparkles,   accent: '#8b6914', label: 'PATTERN' },
  tool:     { icon: Layers,     accent: GREEN,   label: 'TOOL' },
  domain:   { icon: Globe2,     accent: '#1a5276', label: 'DOMAIN' },
  metric:   { icon: TrendingUp, accent: ACCENT,  label: 'METRIC' },
}
const DEFAULT_META = { icon: FileText, accent: INK_DIM, label: 'ENTITY' }
function getMeta(type: string) { return TYPE_META[type] || DEFAULT_META }

const CLAIM_ACCENT: Record<string, { color: string; label: string; icon: typeof Lightbulb }> = {
  insight:  { color: ACCENT,    label: 'INSIGHT',  icon: Lightbulb },
  pattern:  { color: '#8b6914', label: 'PATTERN',  icon: Sparkles },
  fact:     { color: '#1a5276', label: 'FACT',      icon: BookOpen },
  metric:   { color: GREEN,     label: 'METRIC',    icon: TrendingUp },
}
const DEFAULT_CLAIM = { color: INK_DIM, label: 'CLAIM', icon: Quote }
function getClaimMeta(type: string | null) { return (type && CLAIM_ACCENT[type]) || DEFAULT_CLAIM }

const REL_LABELS: Record<string, { label: string; color: string }> = {
  related_to:  { label: '相关', color: '#1a5276' },
  contradicts: { label: '矛盾', color: ACCENT },
  subtopic_of: { label: '子主题', color: '#8b6914' },
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtShortDate(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ============================================
// SectionHeader (WSJ numbered section)
// ============================================

function SectionHeader({ num, title, subtitle, count }: {
  num: string; title: string; subtitle?: string; count?: number
}) {
  return (
    <div className="mb-4">
      <div className="text-[11px] font-medium tracking-[1.5px] mb-1"
           style={{ fontFamily: FONT_MONO, color: ACCENT }}>
        {num}
      </div>
      <h3 className="text-[18px] font-bold tracking-tight leading-snug"
          style={{ fontFamily: FONT_SERIF, color: INK }}>
        {title}
        {count !== undefined && (
          <span className="text-[13px] font-normal ml-2" style={{ color: INK_DIM }}>({count})</span>
        )}
      </h3>
      {subtitle && (
        <p className="text-[13px] mt-0.5" style={{ color: INK_DIM, fontWeight: 300 }}>
          {subtitle}
        </p>
      )}
    </div>
  )
}

// ============================================
// MetricCard (WSJ data-card style)
// ============================================

function MetricCard({ claim }: { claim: WikiClaim }) {
  const isConflicted = claim.status === 'conflicted'
  const trendIcon = claim.trend === 'up'
    ? <TrendingUp className="w-3.5 h-3.5" />
    : claim.trend === 'down'
      ? <TrendingDown className="w-3.5 h-3.5" />
      : claim.trend === 'stable'
        ? <Minus className="w-3.5 h-3.5" />
        : null
  const trendColor = claim.trend === 'up' ? GREEN : claim.trend === 'down' ? ACCENT : INK_DIM

  return (
    <div className="text-center py-4 px-3 relative"
         style={{
           background: isConflicted ? '#fef7f6' : '#fff',
           border: `1px solid ${BORDER}`,
           borderRadius: 6,
         }}>
      {isConflicted && (
        <AlertTriangle className="w-3 h-3 absolute top-2 right-2" style={{ color: ACCENT }} />
      )}
      <div className="text-[10px] font-semibold tracking-[0.8px] uppercase mb-2"
           style={{ color: INK_DIM }}>
        {claim.content.length > 30 ? claim.content.slice(0, 28) + '...' : claim.content}
      </div>
      <div className="text-[26px] font-medium leading-none mb-1.5"
           style={{ fontFamily: FONT_MONO, color: INK }}>
        {claim.value || '\u2014'}
      </div>
      <div className="text-[12px] font-semibold flex items-center justify-center gap-1"
           style={{ color: trendColor }}>
        {trendIcon}
        <span>
          {claim.trend === 'up' ? '\u4e0a\u5347' : claim.trend === 'down' ? '\u4e0b\u964d' : claim.trend === 'stable' ? '\u7a33\u5b9a' : ''}
        </span>
      </div>
      {claim.evidence[0]?.sourceName && (
        <div className="text-[10px] mt-2 pt-2"
             style={{ color: INK_MUTED, borderTop: `1px solid ${BORDER_LIGHT}` }}>
          {claim.evidence[0].sourceName}
        </div>
      )}
    </div>
  )
}

// ============================================
// ClaimCard (WSJ signal-card style)
// ============================================

function ClaimCard({ claim, index }: { claim: WikiClaim; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const isConflicted = claim.status === 'conflicted'
  const meta = getClaimMeta(claim.type)
  const conf = claim.confidence
  const hasEvidence = claim.evidence.length > 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.03, duration: 0.2 }}
      className="mb-3"
      style={{
        background: isConflicted ? '#fef7f6' : '#fff',
        border: `1px solid ${BORDER}`,
        borderLeft: `3px solid ${isConflicted ? ACCENT : meta.color}`,
        borderRadius: 4,
        padding: '14px 18px',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-[0.8px] uppercase"
                style={{ color: meta.color }}>
            {meta.label}
          </span>
          {isConflicted && (
            <span className="text-[10px] font-bold tracking-[0.5px] uppercase px-1.5 py-0.5 rounded"
                  style={{ background: ACCENT, color: '#fff' }}>
              CONFLICT
            </span>
          )}
        </div>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded"
              style={{ fontFamily: FONT_MONO, background: BG_WARM, color: INK_DIM }}>
          {Math.round(conf * 100)}%
        </span>
      </div>

      {/* Content */}
      <p className="text-[14px] leading-[1.7] mb-2" style={{ color: INK_LIGHT }}>
        {claim.content}
      </p>

      {/* Inline metric */}
      {claim.value && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[14px] font-medium px-2 py-0.5"
                style={{ fontFamily: FONT_MONO, background: BG_WARM, borderRadius: 3, color: INK }}>
            {claim.value}
          </span>
          {claim.trend && (
            <span className="text-[11px] font-semibold"
                  style={{ color: claim.trend === 'up' ? GREEN : claim.trend === 'down' ? ACCENT : INK_DIM }}>
              {claim.trend === 'up' ? '\u2191 \u4e0a\u5347' : claim.trend === 'down' ? '\u2193 \u4e0b\u964d' : '\u2192 \u7a33\u5b9a'}
            </span>
          )}
        </div>
      )}

      {/* Evidence footer */}
      {hasEvidence && (
        <div className="flex items-center gap-2 flex-wrap mt-1"
             style={{ borderTop: `1px solid ${BORDER_LIGHT}`, paddingTop: 8 }}>
          {claim.evidence.slice(0, 2).map(ev => (
            <span key={ev.id} className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{ background: BG_WARM, color: INK_DIM }}>
              {ev.sourceName}
            </span>
          ))}
          {claim.evidence.length > 2 && (
            <span className="text-[11px]" style={{ color: INK_MUTED }}>+{claim.evidence.length - 2}</span>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-auto text-[11px] flex items-center gap-0.5 hover:opacity-70 transition-opacity"
            style={{ color: INK_DIM }}
          >
            详情
            <ChevronDown className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      )}

      {/* Expanded evidence */}
      <AnimatePresence>
        {expanded && hasEvidence && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="mt-2 pt-2 space-y-2" style={{ borderTop: `1px solid ${BORDER_LIGHT}` }}>
              {claim.evidence.map(ev => (
                <div key={ev.id} className="text-[12px]">
                  <span className="font-medium" style={{ color: INK_LIGHT }}>{ev.sourceName}</span>
                  <span className="mx-1.5" style={{ color: '#d0d0d0' }}>&middot;</span>
                  <span style={{ color: INK_MUTED }}>{fmtShortDate(ev.timestamp)}</span>
                  {ev.chunkText && (
                    <p className="mt-1 pl-3 leading-[1.6] italic"
                       style={{ color: INK_DIM, borderLeft: `2px solid ${BORDER_LIGHT}` }}>
                      &ldquo;{ev.chunkText}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ============================================
// RelationItem (WSJ entity-item style)
// ============================================

function RelationItem({
  relation,
  currentEntityId,
  onNavigate,
}: {
  relation: WikiRelation
  currentEntityId: string
  onNavigate: (entityId: string) => void
}) {
  const relMeta = REL_LABELS[relation.type] || { label: relation.type, color: INK_DIM }
  const navId = relation.targetId === currentEntityId ? relation.sourceId : relation.targetId
  const targetMeta = getMeta(relation.targetType)
  const TargetIcon = targetMeta.icon

  return (
    <button
      onClick={() => onNavigate(navId)}
      className="flex items-center gap-3 w-full text-left px-4 py-3 transition-colors
                 hover:bg-[#fafaf8] group"
      style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}
    >
      <TargetIcon className="w-4 h-4 shrink-0" style={{ color: targetMeta.accent }} />
      <div className="flex-1 min-w-0">
        <span className="text-[14px] block truncate" style={{ color: INK }}>
          {relation.targetTitle}
        </span>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] font-semibold tracking-[0.5px] uppercase"
                style={{ color: relMeta.color }}>
            {relMeta.label}
          </span>
          {relation.description && (
            <span className="text-[11px]" style={{ color: INK_MUTED }}>{relation.description}</span>
          )}
        </div>
      </div>
      <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-30 group-hover:opacity-60 transition-opacity"
                  style={{ color: INK }} />
    </button>
  )
}

// ============================================
// Modal
// ============================================

interface SidebarEntity {
  id: string
  title: string
  type: string
  claimCount: number
}

interface KnowledgeDetailModalProps {
  entityId: string | null
  serverUrl: string
  allEntities: SidebarEntity[]
  onClose: () => void
}

export function KnowledgeDetailModal({
  entityId,
  serverUrl,
  allEntities,
  onClose,
}: KnowledgeDetailModalProps) {
  const [navStack, setNavStack] = useState<WikiEntityDetail[]>([])
  const [loading, setLoading] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const [sidebarQuery, setSidebarQuery] = useState('')

  const open = entityId !== null

  const fetchAndPush = useCallback(async (id: string, replace = false) => {
    setLoading(true)
    try {
      const resp = await fetch(`${serverUrl}/api/wiki/entity/${encodeURIComponent(id)}`)
      if (!resp.ok) return
      const detail = await resp.json() as WikiEntityDetail
      setNavStack(prev => replace ? [detail] : [...prev, detail])
    } catch (err) {
      console.warn('[KnowledgeDetail] fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }, [serverUrl])

  useEffect(() => {
    if (entityId) {
      setNavStack([])
      fetchAndPush(entityId, true)
    } else {
      setNavStack([])
    }
  }, [entityId, fetchAndPush])

  const current = navStack[navStack.length - 1]
  const canGoBack = navStack.length > 1

  const handleBack = useCallback(() => { setNavStack(s => s.slice(0, -1)) }, [])
  const handleNavigate = useCallback((id: string) => { fetchAndPush(id) }, [fetchAndPush])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (canGoBack) handleBack()
        else onClose()
      }
    }
    document.addEventListener('keydown', handler)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [open, canGoBack, handleBack, onClose])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [navStack.length])

  const { metricClaims, otherClaims } = useMemo(() => {
    if (!current) return { metricClaims: [], otherClaims: [] }
    const metrics: WikiClaim[] = []
    const others: WikiClaim[] = []
    for (const c of current.claims) {
      if (c.type === 'metric' && c.value) metrics.push(c)
      else others.push(c)
    }
    return { metricClaims: metrics, otherClaims: others }
  }, [current])

  const sourceCount = useMemo(() => {
    if (!current) return 0
    const names = new Set<string>()
    for (const c of current.claims) {
      for (const ev of c.evidence) {
        if (ev.sourceName) names.add(ev.sourceName)
      }
    }
    return names.size
  }, [current])

  const filteredSidebarEntities = useMemo(() => {
    if (!sidebarQuery) return allEntities
    const q = sidebarQuery.toLowerCase()
    return allEntities.filter(e => e.title.toLowerCase().includes(q))
  }, [allEntities, sidebarQuery])

  if (!open) return null

  const meta = current ? getMeta(current.type) : DEFAULT_META

  // Section numbering
  let sn = 0
  const ns = () => { sn++; return String(sn).padStart(2, '0') }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[250] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 backdrop-blur-sm" onClick={onClose}
               style={{ background: 'rgba(26,26,26,0.22)' }} />

          {/* Modal */}
          <motion.div
            className="relative w-full max-w-[1100px] max-h-[85vh] mx-4 flex flex-col overflow-hidden"
            style={{
              background: BG,
              borderRadius: 8,
              boxShadow: '0 25px 60px -15px rgba(26,26,26,0.18), 0 0 0 1px rgba(0,0,0,0.04)',
            }}
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            onClick={e => e.stopPropagation()}
          >
            {/* ── Top bar ── */}
            <div className="shrink-0 flex items-center justify-between px-5 h-[44px]"
                 style={{ background: '#fff', borderBottom: `1px solid ${BORDER}` }}>
              <div className="flex items-center gap-3">
                {canGoBack && (
                  <button onClick={handleBack}
                          className="p-1 rounded transition-colors hover:bg-[#f5f4f0]">
                    <ChevronLeft className="w-4 h-4" style={{ color: INK_DIM }} />
                  </button>
                )}
                <span className="text-[12px] font-semibold tracking-[0.5px] uppercase"
                      style={{ color: INK_DIM }}>
                  Entity Detail
                </span>
              </div>
              <button onClick={onClose}
                      className="p-1 rounded transition-colors hover:bg-[#f5f4f0]">
                <X className="w-4 h-4" style={{ color: INK_DIM }} />
              </button>
            </div>

            {/* Loading */}
            {loading && (
              <div className="h-[2px] shrink-0" style={{ background: BORDER_LIGHT }}>
                <motion.div className="h-full w-1/3 rounded-full" style={{ background: ACCENT }}
                  animate={{ x: ['0%', '200%'] }}
                  transition={{ repeat: Infinity, duration: 1, ease: 'easeInOut' }} />
              </div>
            )}

            {/* ── Body: sidebar + content ── */}
            <div className="flex-1 flex flex-row overflow-hidden min-h-0">
              {/* Left sidebar - entity navigation */}
              <div className="shrink-0 flex flex-col overflow-hidden"
                   style={{ width: 220, borderRight: `1px solid ${BORDER}`, background: '#fff' }}>
                <div className="shrink-0 px-3 py-2" style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3"
                            style={{ color: INK_MUTED }} />
                    <input
                      type="text"
                      placeholder="筛选实体..."
                      value={sidebarQuery}
                      onChange={e => setSidebarQuery(e.target.value)}
                      className="w-full pl-7 pr-2 py-1.5 text-[12px] focus:outline-none"
                      style={{ background: BG_WARM, border: `1px solid ${BORDER_LIGHT}`, borderRadius: 3, color: INK }}
                    />
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  {filteredSidebarEntities.map(ent => {
                    const m = getMeta(ent.type)
                    const Icon = m.icon
                    const isActive = current?.id === ent.id
                    return (
                      <button
                        key={ent.id}
                        onClick={() => fetchAndPush(ent.id, true)}
                        className="w-full text-left px-3 py-2.5 transition-colors hover:bg-[#fafaf8]"
                        style={{
                          borderBottom: `1px solid ${BORDER_LIGHT}`,
                          background: isActive ? BG_WARM : 'transparent',
                          borderLeft: isActive ? `3px solid ${m.accent}` : '3px solid transparent',
                        }}
                      >
                        <div className="flex items-center gap-1.5">
                          <Icon className="w-3 h-3 shrink-0" style={{ color: m.accent }} />
                          <span className="text-[10px] font-bold tracking-[0.5px] uppercase"
                                style={{ color: m.accent }}>
                            {m.label}
                          </span>
                        </div>
                        <div className="text-[13px] font-medium leading-snug mt-0.5 truncate"
                             style={{ fontFamily: FONT_SERIF, color: isActive ? INK : INK_LIGHT }}>
                          {ent.title}
                        </div>
                        <span className="text-[10px] mt-0.5 block"
                              style={{ fontFamily: FONT_MONO, color: INK_MUTED }}>
                          {ent.claimCount} claims
                        </span>
                      </button>
                    )
                  })}
                  {filteredSidebarEntities.length === 0 && (
                    <div className="text-center py-6">
                      <p className="text-[11px]" style={{ color: INK_MUTED }}>
                        {sidebarQuery ? '无匹配' : '暂无实体'}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Right content */}
              <div ref={contentRef} className="flex-1 overflow-y-auto">
              {current ? (
                <div className="px-7 pt-7 pb-10">

                  {/* ━━ Report Header ━━ */}
                  <div className="mb-7 pb-5" style={{ borderBottom: `2px solid ${INK}` }}>
                    {/* Kicker */}
                    <div className="text-[11px] font-bold tracking-[1.5px] uppercase mb-3"
                         style={{ color: meta.accent }}>
                      {meta.label}
                      {current.tags.length > 0 && (
                        <span style={{ color: INK_MUTED, fontWeight: 400 }}>
                          {' \u00b7 '}{current.tags.slice(0, 3).join(' \u00b7 ')}
                        </span>
                      )}
                    </div>
                    {/* Title */}
                    <h1 className="text-[28px] font-black leading-[1.15] mb-3"
                        style={{ fontFamily: FONT_SERIF, color: INK, letterSpacing: '-0.5px' }}>
                      {current.title}
                    </h1>
                    {/* Lead / TLDR */}
                    {current.tldr && (
                      <p className="text-[15px] leading-[1.65]"
                         style={{ color: INK_LIGHT, fontWeight: 300, maxWidth: 500 }}>
                        {current.tldr}
                      </p>
                    )}
                    {/* Meta line */}
                    <div className="flex items-center gap-4 mt-3 flex-wrap text-[11px]"
                         style={{ color: INK_MUTED }}>
                      <span>Claims: <strong style={{ color: INK_DIM }}>{current.claims.length}</strong></span>
                      {sourceCount > 0 && (
                        <span>Sources: <strong style={{ color: INK_DIM }}>{sourceCount}</strong></span>
                      )}
                      <span>Updated: <strong style={{ color: INK_DIM }}>{fmtShortDate(current.updatedAt)}</strong></span>
                    </div>
                  </div>

                  {/* ━━ Metric Data Cards ━━ */}
                  {metricClaims.length > 0 && (
                    <div className="mb-8 pb-7" style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
                      <SectionHeader num={ns()} title="Key Metrics" subtitle="\u6838\u5fc3\u6307\u6807\u4e0e\u6570\u636e" />
                      <div className={cn(
                        'grid gap-3',
                        metricClaims.length <= 2 ? 'grid-cols-2'
                        : metricClaims.length <= 4 ? 'grid-cols-2' : 'grid-cols-3',
                      )}>
                        {metricClaims.map(c => <MetricCard key={c.id} claim={c} />)}
                      </div>
                    </div>
                  )}

                  {/* ━━ Claims ━━ */}
                  {otherClaims.length > 0 && (
                    <div className="mb-8 pb-7" style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
                      <SectionHeader num={ns()} title="Knowledge Claims" subtitle="\u77e5\u8bc6\u6761\u76ee\u4e0e\u6d1e\u5bdf" count={otherClaims.length} />
                      {otherClaims.map((c, i) => <ClaimCard key={c.id} claim={c} index={i} />)}
                    </div>
                  )}

                  {/* ━━ Relations ━━ */}
                  {current.relations.length > 0 && (
                    <div className="mb-8 pb-7" style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
                      <SectionHeader num={ns()} title="Related Entities" subtitle="\u5173\u8054\u77e5\u8bc6\u7f51\u7edc" count={current.relations.length} />
                      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 6, overflow: 'hidden', background: '#fff' }}>
                        {current.relations.map(rel => (
                          <RelationItem key={rel.id} relation={rel} currentEntityId={current.id} onNavigate={handleNavigate} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Empty */}
                  {current.claims.length === 0 && current.relations.length === 0 && (
                    <div className="text-center py-14">
                      <BookOpen className="w-10 h-10 mx-auto mb-3" style={{ color: BORDER }} />
                      <p className="text-[14px]" style={{ color: INK_MUTED }}>此实体暂无知识条目</p>
                      <p className="text-[12px] mt-1" style={{ color: '#c8c8c8' }}>执行任务后将自动沉淀经验</p>
                    </div>
                  )}
                </div>
              ) : !loading && (
                <div className="text-center py-16">
                  <p className="text-[14px]" style={{ color: INK_MUTED }}>加载中...</p>
                </div>
              )}
            </div>
            </div>

            {/* ── Footer ── */}
            {current && (
              <div className="shrink-0 px-5 py-2.5 flex items-center justify-between text-[10px]"
                   style={{ background: '#fff', borderTop: `1px solid ${BORDER}`, color: INK_MUTED }}>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  自动沉淀
                  {sourceCount > 0 && <>{' \u00b7 '}融汇 {sourceCount} 份来源</>}
                </span>
                <span>{fmtDate(current.updatedAt)}</span>
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
