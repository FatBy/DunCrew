/**
 * LibraryContent - 主内容区: 实体详情 (WSJ Editorial Style)
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, TrendingUp, TrendingDown, Minus,
  AlertTriangle, ArrowRight, ChevronDown, Clock, Loader2,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import {
  INK, INK_LIGHT, INK_DIM, INK_MUTED,
  BG, BG_WARM, BORDER, BORDER_LIGHT, ACCENT, GREEN,
  FONT_SERIF, FONT_MONO,
  getMeta, getClaimMeta, REL_LABELS, formatRelativeTime,
} from '@/components/shared/wiki-ui/constants'
import type { WikiEntityDetail, WikiClaim, WikiRelation } from '@/components/shared/wiki-ui/types'

interface LibraryContentProps {
  entity: WikiEntityDetail | null
  loading: boolean
  onSelectEntity: (id: string) => void
}

export function LibraryContent({ entity, loading, onSelectEntity }: LibraryContentProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ background: BG }}>
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: INK_MUTED }} />
      </div>
    )
  }

  if (!entity) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center" style={{ background: BG }}>
        <BookOpen className="w-10 h-10 mb-3" style={{ color: INK_MUTED }} />
        <p className="text-[14px]" style={{ color: INK_DIM, fontFamily: FONT_SERIF }}>
          从左侧选择一个实体查看详情
        </p>
        <p className="text-[12px] mt-1" style={{ color: INK_MUTED }}>
          或导入 Library Processor 导出的 JSON 文件
        </p>
      </div>
    )
  }

  const meta = getMeta(entity.type)
  const Icon = meta.icon
  const metricClaims = entity.claims.filter(c => c.type === 'metric' && c.value)
  const nonMetricClaims = entity.claims.filter(c => !(c.type === 'metric' && c.value))
  const totalSources = new Set(entity.claims.flatMap(c => c.evidence.map(e => e.sourceName))).size

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: BG }}>
      <div className="px-7 pt-7 pb-10 max-w-[780px]">
        {/* Entity Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Icon className="w-4 h-4" style={{ color: meta.accent }} />
            <span className="text-[10px] font-bold tracking-[1.5px] uppercase"
                  style={{ fontFamily: FONT_MONO, color: meta.accent }}>
              {meta.label}
            </span>
            {entity.tags.map(tag => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: BG_WARM, color: INK_DIM }}>
                {tag}
              </span>
            ))}
          </div>

          <h1 className="text-[28px] font-bold leading-tight mb-3"
              style={{ fontFamily: FONT_SERIF, color: INK }}>
            {entity.title}
          </h1>

          {entity.tldr && (
            <p className="text-[14px] leading-[1.7] mb-3" style={{ color: INK_LIGHT, fontWeight: 300 }}>
              {entity.tldr}
            </p>
          )}

          <div className="flex items-center gap-3 text-[11px]" style={{ color: INK_MUTED }}>
            <Clock className="w-3 h-3" />
            <span>自动合成</span>
            <span>&middot;</span>
            <span>{totalSources} 来源</span>
            <span>&middot;</span>
            <span>{formatRelativeTime(entity.updatedAt)}</span>
          </div>
        </div>

        {/* Section 01: Key Metrics */}
        {metricClaims.length > 0 && (
          <section className="mb-8">
            <SectionHeader num="01" title="Key Metrics" count={metricClaims.length} />
            <div className={cn(
              'grid gap-3',
              metricClaims.length <= 2 ? 'grid-cols-2'
                : metricClaims.length <= 4 ? 'grid-cols-2'
                : 'grid-cols-3'
            )}>
              {metricClaims.map(claim => (
                <MetricCard key={claim.id} claim={claim} />
              ))}
            </div>
          </section>
        )}

        {/* Section 02: Knowledge Claims */}
        {nonMetricClaims.length > 0 && (
          <section className="mb-8">
            <SectionHeader
              num={metricClaims.length > 0 ? '02' : '01'}
              title="Knowledge Claims"
              count={nonMetricClaims.length}
            />
            {nonMetricClaims.map((claim, index) => (
              <ClaimCard key={claim.id} claim={claim} index={index} />
            ))}
          </section>
        )}

        {/* Section 03: Related Entities */}
        {entity.relations.length > 0 && (
          <section className="mb-8">
            <SectionHeader
              num={metricClaims.length > 0 ? '03' : nonMetricClaims.length > 0 ? '02' : '01'}
              title="Related Entities"
              count={entity.relations.length}
            />
            <div style={{ border: `1px solid ${BORDER}`, borderRadius: 4, overflow: 'hidden' }}>
              {entity.relations.map(rel => (
                <RelationItem key={rel.id} relation={rel} onNavigate={onSelectEntity} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ──

function SectionHeader({ num, title, count }: { num: string; title: string; count?: number }) {
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
    </div>
  )
}

function MetricCard({ claim }: { claim: WikiClaim }) {
  const isConflicted = claim.status === 'conflicted'
  const trendIcon = claim.trend === 'up'
    ? <TrendingUp className="w-3.5 h-3.5" />
    : claim.trend === 'down'
      ? <TrendingDown className="w-3.5 h-3.5" />
      : claim.trend === 'stable' ? <Minus className="w-3.5 h-3.5" /> : null
  const trendColor = claim.trend === 'up' ? GREEN : claim.trend === 'down' ? ACCENT : INK_DIM

  return (
    <div className="text-center py-4 px-3 relative"
         style={{
           background: isConflicted ? '#fef7f6' : '#fff',
           border: `1px solid ${BORDER}`, borderRadius: 6,
         }}>
      {isConflicted && <AlertTriangle className="w-3 h-3 absolute top-2 right-2" style={{ color: ACCENT }} />}
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
        <span>{claim.trend === 'up' ? '上升' : claim.trend === 'down' ? '下降' : claim.trend === 'stable' ? '稳定' : ''}</span>
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

function ClaimCard({ claim, index }: { claim: WikiClaim; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const isConflicted = claim.status === 'conflicted'
  const claimMeta = getClaimMeta(claim.type)
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
        borderLeft: `3px solid ${isConflicted ? ACCENT : claimMeta.color}`,
        borderRadius: 4, padding: '14px 18px',
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold tracking-[0.8px] uppercase" style={{ color: claimMeta.color }}>
            {claimMeta.label}
          </span>
          {isConflicted && (
            <span className="text-[10px] font-bold tracking-[0.5px] uppercase px-1.5 py-0.5 rounded"
                  style={{ background: ACCENT, color: '#fff' }}>CONFLICT</span>
          )}
        </div>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded"
              style={{ fontFamily: FONT_MONO, background: BG_WARM, color: INK_DIM }}>
          {Math.round(claim.confidence * 100)}%
        </span>
      </div>

      <p className="text-[14px] leading-[1.7] mb-2" style={{ color: INK_LIGHT }}>{claim.content}</p>

      {claim.value && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[14px] font-medium px-2 py-0.5"
                style={{ fontFamily: FONT_MONO, background: BG_WARM, borderRadius: 3, color: INK }}>
            {claim.value}
          </span>
          {claim.trend && (
            <span className="text-[11px] font-semibold"
                  style={{ color: claim.trend === 'up' ? GREEN : claim.trend === 'down' ? ACCENT : INK_DIM }}>
              {claim.trend === 'up' ? '\u2191 上升' : claim.trend === 'down' ? '\u2193 下降' : '\u2192 稳定'}
            </span>
          )}
        </div>
      )}

      {hasEvidence && (
        <div className="flex items-center gap-2 flex-wrap mt-1"
             style={{ borderTop: `1px solid ${BORDER_LIGHT}`, paddingTop: 8 }}>
          {claim.evidence.slice(0, 2).map(ev => (
            <span key={ev.id} className="text-[11px] px-1.5 py-0.5 rounded"
                  style={{ background: BG_WARM, color: INK_DIM }}>{ev.sourceName}</span>
          ))}
          {claim.evidence.length > 2 && (
            <span className="text-[11px]" style={{ color: INK_MUTED }}>+{claim.evidence.length - 2}</span>
          )}
          <button onClick={() => setExpanded(!expanded)}
                  className="ml-auto text-[11px] flex items-center gap-0.5 hover:opacity-70 transition-opacity"
                  style={{ color: INK_DIM }}>
            详情
            <ChevronDown className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      )}

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }}
                      className="overflow-hidden">
            <div className="pt-2 space-y-2">
              {claim.evidence.map(ev => (
                <div key={ev.id} className="text-[12px]" style={{ color: INK_LIGHT }}>
                  <span className="font-medium">{ev.sourceName}</span>
                  <span className="mx-1.5">&middot;</span>
                  <span style={{ color: INK_MUTED }}>{formatRelativeTime(ev.timestamp)}</span>
                  {ev.chunkText && (
                    <p className="mt-1 pl-3 leading-[1.6] italic text-[12px]"
                       style={{ borderLeft: `2px solid ${BORDER_LIGHT}`, color: INK_DIM }}>
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

function RelationItem({ relation, onNavigate }: { relation: WikiRelation; onNavigate: (id: string) => void }) {
  const targetMeta = getMeta(relation.targetType)
  const TargetIcon = targetMeta.icon
  const relMeta = REL_LABELS[relation.type] || { label: relation.type, color: INK_DIM }

  return (
    <button
      className="flex items-center gap-3 w-full text-left px-4 py-3 transition-colors group"
      style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}
      onClick={() => onNavigate(relation.targetId)}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#fafaf8' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '' }}
    >
      <TargetIcon className="w-4 h-4 shrink-0" style={{ color: targetMeta.accent }} />
      <div className="flex-1 min-w-0">
        <span className="text-[14px] block truncate" style={{ color: INK }}>{relation.targetTitle}</span>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] font-semibold tracking-[0.5px] uppercase"
                style={{ color: relMeta.color }}>{relMeta.label}</span>
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
