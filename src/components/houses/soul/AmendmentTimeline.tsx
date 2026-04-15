import { useState, forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, X, Archive, ChevronDown, ChevronUp, Clock, RotateCcw } from 'lucide-react'
import type { SoulAmendment } from '@/types'

// ============================================
// 单条修正案卡片（Demo 风格 + 实际数据结构）
// ============================================

interface AmendmentItemProps {
  amendment: SoulAmendment
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
}

/** 计算距今的友好时间差 */
function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  return `${days}天前`
}

/** 状态 → 边框样式 */
function statusBorderClass(status: SoulAmendment['status']): string {
  switch (status) {
    case 'draft':    return 'border-amber-300/50'
    case 'approved': return 'border-teal-300/50'
    case 'archived': return 'border-gray-200/50'
    default:         return 'border-gray-200/50'
  }
}

/** 状态 → 标签样式 */
function statusBadge(status: SoulAmendment['status']): { label: string; cls: string } {
  switch (status) {
    case 'draft':    return { label: '待审批', cls: 'bg-amber-50 text-amber-600 border-amber-200/50' }
    case 'approved': return { label: '已生效', cls: 'bg-teal-50 text-teal-600 border-teal-200/50' }
    case 'archived': return { label: '已归档', cls: 'bg-gray-50 text-gray-400 border-gray-200/50' }
    default:         return { label: status, cls: 'bg-gray-50 text-gray-400 border-gray-200/50' }
  }
}

const AmendmentItem = forwardRef<HTMLDivElement, AmendmentItemProps>(
  function AmendmentItem({ amendment, onApprove, onReject, onArchive, onUnarchive }, ref) {
  const badge = statusBadge(amendment.status)
  const borderCls = statusBorderClass(amendment.status)

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className={`bg-white/60 backdrop-blur-md border ${borderCls} rounded-xl p-3 transition-all`}
      style={{ opacity: Math.max(0.4, amendment.weight) }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] text-gray-700 leading-relaxed flex-1">
          {amendment.content}
        </p>
        <span className={`text-[10px] font-mono shrink-0 px-2 py-0.5 rounded-full border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      {/* Meta */}
      <div className="mt-2 flex items-center gap-3 text-[10px] font-mono text-gray-400">
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {timeAgo(amendment.createdAt)}
        </span>
        <span>权重: {amendment.weight.toFixed(2)}</span>
        {amendment.hitCount > 0 && <span>注入: {amendment.hitCount}x</span>}
      </div>

      {/* Evidence */}
      {amendment.source.evidence.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {amendment.source.evidence.slice(0, 2).map((e, i) => (
            <p key={i} className="text-[10px] text-gray-400/60 italic truncate">
              {e}
            </p>
          ))}
        </div>
      )}

      {/* Actions */}
      {amendment.status === 'draft' && (onApprove || onReject) && (
        <div className="mt-2 flex gap-2">
          {onApprove && (
            <button
              onClick={() => onApprove(amendment.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg bg-teal-50 text-teal-600 hover:bg-teal-100 transition-colors border border-teal-200/50"
            >
              <Check className="w-3 h-3" />
              批准
            </button>
          )}
          {onReject && (
            <button
              onClick={() => onReject(amendment.id)}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg bg-red-50 text-red-500 hover:bg-red-100 transition-colors border border-red-200/50"
            >
              <X className="w-3 h-3" />
              拒绝
            </button>
          )}
        </div>
      )}

      {amendment.status === 'approved' && onArchive && (
        <div className="mt-2">
          <button
            onClick={() => onArchive(amendment.id)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg bg-gray-50 text-gray-400 hover:bg-gray-100 transition-colors border border-gray-200/50"
          >
            <Archive className="w-3 h-3" />
            归档
          </button>
        </div>
      )}

      {amendment.status === 'archived' && onUnarchive && (
        <div className="mt-2">
          <button
            onClick={() => onUnarchive(amendment.id)}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg bg-teal-50 text-teal-600 hover:bg-teal-100 transition-colors border border-teal-200/50"
          >
            <RotateCcw className="w-3 h-3" />
            启用
          </button>
        </div>
      )}
    </motion.div>
  )
})

// ============================================
// 修正案时间线（全宽底部区域）
// ============================================

interface AmendmentTimelineProps {
  amendments: SoulAmendment[]
  draftAmendments: SoulAmendment[]
  onApprove: (id: string) => void
  onReject: (id: string) => void
  onArchive: (id: string) => void
  onUnarchive: (id: string) => void
}

export function AmendmentTimeline({
  amendments,
  draftAmendments,
  onApprove,
  onReject,
  onArchive,
  onUnarchive,
}: AmendmentTimelineProps) {
  const [showArchived, setShowArchived] = useState(false)

  const active = amendments.filter((a) => a.status === 'approved')
  const archived = amendments.filter((a) => a.status === 'archived')
  const hasContent = draftAmendments.length > 0 || active.length > 0 || archived.length > 0

  if (!hasContent) {
    return (
      <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4 text-center">
        <p className="text-[11px] text-gray-400 font-mono py-4">
          暂无修正案。使用更多 Nexus 后将自动检测行为模式。
        </p>
      </div>
    )
  }

  return (
    <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-gray-600 tracking-widest uppercase">
          行为修正案
        </div>
        <div className="text-[10px] text-gray-400 font-mono">
          {draftAmendments.length > 0 && (
            <span className="text-amber-500 mr-2">{draftAmendments.length} 待审</span>
          )}
          {active.length} 生效 · {archived.length} 归档
        </div>
      </div>

      <div className="space-y-2">
        {/* Drafts first */}
        <AnimatePresence mode="popLayout">
          {draftAmendments.map((a) => (
            <AmendmentItem
              key={a.id}
              amendment={a}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </AnimatePresence>

        {/* Active amendments */}
        <AnimatePresence mode="popLayout">
          {active.map((a) => (
            <AmendmentItem
              key={a.id}
              amendment={a}
              onArchive={onArchive}
            />
          ))}
        </AnimatePresence>

        {/* Archived (collapsible) */}
        {archived.length > 0 && (
          <div>
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="flex items-center gap-1 text-[11px] font-mono text-gray-400 hover:text-gray-600 transition-colors mt-1"
            >
              {showArchived ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              已归档 ({archived.length})
            </button>
            <AnimatePresence>
              {showArchived && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden mt-2 space-y-2"
                >
                  {archived.map((a) => (
                    <AmendmentItem key={a.id} amendment={a} onUnarchive={onUnarchive} />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  )
}
