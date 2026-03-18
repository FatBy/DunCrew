/**
 * SoulAmendmentPanel - 修正案管理面板
 * 展示 draft / approved / archived 修正案，支持审批操作
 */
import { motion, AnimatePresence } from 'framer-motion'
import { Check, X, Archive, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'
import { useStore } from '@/store'
import type { SoulAmendment } from '@/types'
import { useT } from '@/i18n'

function AmendmentCard({ amendment, onApprove, onReject, onArchive }: {
  amendment: SoulAmendment
  onApprove?: (id: string) => void
  onReject?: (id: string) => void
  onArchive?: (id: string) => void
}) {
  const t = useT()

  const statusColors: Record<string, string> = {
    draft: 'text-skin-accent-amber border-skin-accent-amber/30 bg-skin-accent-amber/5',
    approved: 'text-green-400 border-green-400/30 bg-green-400/5',
    archived: 'text-skin-text-secondary/40 border-skin-border/10 bg-skin-bg-secondary/10',
  }

  const statusLabels: Record<string, string> = {
    draft: t('soul.amendment_draft'),
    approved: t('soul.amendment_approved'),
    archived: t('soul.amendment_archived'),
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      className={`rounded-lg border p-3 ${statusColors[amendment.status] || ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12px] leading-relaxed text-skin-text-primary/80 flex-1">
          {amendment.content}
        </p>
        <span className="text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded border border-current/20 opacity-70">
          {statusLabels[amendment.status] || amendment.status}
        </span>
      </div>

      {/* Meta info */}
      <div className="mt-2 flex items-center gap-3 text-[10px] font-mono text-skin-text-secondary/40">
        <span>{t('soul.weight')}: {amendment.weight.toFixed(2)}</span>
        {amendment.hitCount > 0 && (
          <span>{t('soul.hit_count')}: {amendment.hitCount}</span>
        )}
        {amendment.source.nexusIds.length > 0 && (
          <span>{t('soul.detected_from')}: {amendment.source.nexusIds.length} nexus</span>
        )}
      </div>

      {/* Evidence (collapsed) */}
      {amendment.source.evidence.length > 0 && (
        <div className="mt-1.5 space-y-0.5">
          {amendment.source.evidence.slice(0, 2).map((e, i) => (
            <p key={i} className="text-[10px] text-skin-text-secondary/30 italic truncate">
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
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-green-500/10 text-green-400 hover:bg-green-500/20 transition-colors"
            >
              <Check className="w-3 h-3" />
              {t('soul.approve')}
            </button>
          )}
          {onReject && (
            <button
              onClick={() => onReject(amendment.id)}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
            >
              <X className="w-3 h-3" />
              {t('soul.reject')}
            </button>
          )}
        </div>
      )}

      {amendment.status === 'approved' && onArchive && (
        <div className="mt-2">
          <button
            onClick={() => onArchive(amendment.id)}
            className="flex items-center gap-1 px-2 py-1 text-[11px] rounded bg-skin-bg-secondary/20 text-skin-text-secondary/50 hover:bg-skin-bg-secondary/40 transition-colors"
          >
            <Archive className="w-3 h-3" />
            {t('soul.archive')}
          </button>
        </div>
      )}
    </motion.div>
  )
}

export function SoulAmendmentPanel() {
  const t = useT()
  const amendments = useStore((s) => s.amendments)
  const draftAmendments = useStore((s) => s.draftAmendments)
  const approveDraft = useStore((s) => s.approveDraft)
  const rejectDraft = useStore((s) => s.rejectDraft)
  const archiveAmendment = useStore((s) => s.archiveAmendment)

  const [showArchived, setShowArchived] = useState(false)

  const activeAmendments = amendments.filter((a) => a.status === 'approved')
  const archivedAmendments = amendments.filter((a) => a.status === 'archived')
  const hasContent = draftAmendments.length > 0 || activeAmendments.length > 0 || archivedAmendments.length > 0

  if (!hasContent) {
    return (
      <div className="text-[11px] text-skin-text-secondary/30 font-mono text-center py-4">
        {t('soul.amendments_empty')}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Drafts (pending review) */}
      <AnimatePresence mode="popLayout">
        {draftAmendments.map((a) => (
          <AmendmentCard
            key={a.id}
            amendment={a}
            onApprove={approveDraft}
            onReject={rejectDraft}
          />
        ))}
      </AnimatePresence>

      {/* Active amendments */}
      <AnimatePresence mode="popLayout">
        {activeAmendments.map((a) => (
          <AmendmentCard
            key={a.id}
            amendment={a}
            onArchive={archiveAmendment}
          />
        ))}
      </AnimatePresence>

      {/* Archived (collapsible) */}
      {archivedAmendments.length > 0 && (
        <div>
          <button
            onClick={() => setShowArchived(!showArchived)}
            className="flex items-center gap-1 text-[11px] font-mono text-skin-text-secondary/40 hover:text-skin-text-secondary/60 transition-colors"
          >
            {showArchived ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {t('soul.amendment_archived')} ({archivedAmendments.length})
          </button>
          <AnimatePresence>
            {showArchived && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden mt-2 space-y-2"
              >
                {archivedAmendments.map((a) => (
                  <AmendmentCard key={a.id} amendment={a} />
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
