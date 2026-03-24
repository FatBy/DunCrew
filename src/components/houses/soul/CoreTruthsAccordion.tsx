import { useState, useRef, useEffect } from 'react'
import { ShieldAlert, ChevronDown, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import type { SoulTruth } from '@/types'

interface CoreTruthsAccordionProps {
  truths: SoulTruth[]
  summary: string
}

/** 从 truth 的各字段中提取一句话摘要（最多 50 字） */
function summarizeTruth(truth: SoulTruth): string {
  const candidate = truth.description || truth.principle || truth.title || ''
  const firstSentence = candidate.split(/[。.!！?\n]/)[0]?.trim() || candidate
  return firstSentence.length > 50
    ? firstSentence.slice(0, 48) + '…'
    : firstSentence
}

export function CoreTruthsAccordion({ truths, summary }: CoreTruthsAccordionProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭 Popover
  useEffect(() => {
    if (!popoverOpen) return
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        cardRef.current && !cardRef.current.contains(event.target as Node)
      ) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [popoverOpen])

  const displaySummary = summary || `${truths.length} 条核心协议规则`

  return (
    <div className="relative">
      {/* 紧凑卡片：一句话总结 */}
      <div
        ref={cardRef}
        className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4 cursor-pointer hover:bg-indigo-50/30 transition-colors group"
        onClick={() => setPopoverOpen(!popoverOpen)}
      >
        <div className="flex items-center gap-2 text-indigo-400/80 text-xs font-semibold tracking-widest uppercase">
          <ShieldAlert className="w-4 h-4" />
          核心协议 (L1)
          <span className="ml-auto text-[10px] text-gray-400 font-normal normal-case tracking-normal">
            {truths.length} 条
          </span>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <p className="text-[12px] text-gray-600 leading-relaxed flex-1 line-clamp-2 group-hover:text-indigo-600 transition-colors">
            {displaySummary}
          </p>
          <ChevronDown
            className={`w-4 h-4 shrink-0 text-gray-400 transition-transform duration-200 ${
              popoverOpen ? 'rotate-180 text-indigo-400' : ''
            }`}
          />
        </div>
      </div>

      {/* Popover 气泡：完整协议列表 */}
      <AnimatePresence>
        {popoverOpen && (
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, y: -8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.96 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="absolute z-50 top-full left-0 right-0 mt-2 bg-white/95 backdrop-blur-xl border border-indigo-100/60 shadow-[0_12px_48px_-12px_rgba(0,0,0,0.15)] rounded-2xl p-4 max-h-[50vh] flex flex-col"
            style={{ minWidth: '320px' }}
          >
            {/* 气泡头部 */}
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-gray-100">
              <div className="text-xs font-semibold text-indigo-500 tracking-wider uppercase flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5" />
                全部协议 ({truths.length})
              </div>
              <button
                onClick={(event) => { event.stopPropagation(); setPopoverOpen(false) }}
                className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
              >
                <X className="w-3.5 h-3.5 text-gray-400" />
              </button>
            </div>

            {/* 协议列表 */}
            <div className="space-y-1 overflow-y-auto flex-1 pr-1">
              {truths.map((truth) => {
                const isExpanded = expandedId === truth.id
                const truthSummary = summarizeTruth(truth)
                return (
                  <div
                    key={truth.id}
                    className={`group/item border rounded-xl transition-all duration-200 overflow-hidden cursor-pointer ${
                      isExpanded
                        ? 'bg-indigo-50/50 border-indigo-100'
                        : 'bg-transparent border-transparent hover:bg-gray-50/50'
                    }`}
                    onClick={(event) => { event.stopPropagation(); setExpandedId(isExpanded ? null : truth.id) }}
                  >
                    <div className="flex gap-2.5 p-2 items-center">
                      <div className={`text-[10px] font-mono shrink-0 ${isExpanded ? 'text-indigo-500 font-bold' : 'text-indigo-300'}`}>
                        {truth.id}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className={`text-[11px] leading-snug truncate ${isExpanded ? 'text-indigo-700 font-medium' : 'text-gray-600'}`}>
                          {truthSummary}
                        </div>
                      </div>
                      <ChevronDown className={`w-3 h-3 shrink-0 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180 text-indigo-400' : ''}`} />
                    </div>

                    <div className={`grid transition-all duration-300 ease-in-out ${isExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
                      <div className="overflow-hidden">
                        <div className="mx-2 mb-2 p-2.5 bg-white/80 rounded-lg border border-indigo-100/50">
                          {truth.title && <div className="text-[11px] font-semibold text-indigo-600 mb-1">{truth.title}</div>}
                          {truth.principle && <div className="text-[10px] text-indigo-400/80 font-medium mb-1 tracking-wider uppercase">{truth.principle}</div>}
                          {truth.description && <div className="text-[11px] text-gray-500 leading-relaxed">{truth.description}</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
