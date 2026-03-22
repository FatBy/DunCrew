import { useState } from 'react'
import { X, Loader2, ChevronDown, ChevronRight, Eye, PenTool, Edit3, Terminal, Circle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/utils/cn'
import type { LensData, TraceEntry } from './useMemoryData'
import type { L1MemoryEntry } from '@/types'

/** 相对时间格式化 */
function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  const mon = Math.floor(day / 30)
  return `${mon}个月前`
}

const traceIcon: Record<TraceEntry['operationType'], typeof Eye> = {
  read: Eye, write: PenTool, edit: Edit3, command: Terminal, unknown: Circle,
}

interface TemporalLensProps {
  lensData: LensData | null
  onClose: () => void
}

/** 折叠区域 */
function Section({
  title,
  count,
  defaultOpen = true,
  children,
}: {
  title: string
  count?: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-stone-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-stone-600 hover:bg-stone-50 transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {title}
        {count !== undefined && (
          <span className="ml-auto text-[10px] font-mono text-stone-400">{count}</span>
        )}
      </button>
      {open && <div className="px-4 pb-3">{children}</div>}
    </div>
  )
}

export function TemporalLens({ lensData, onClose }: TemporalLensProps) {
  return (
    <AnimatePresence>
      {lensData && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 320, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: 'easeInOut' }}
          className="border-l border-stone-200/60 flex flex-col overflow-hidden shrink-0"
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200/60 shrink-0">
            <h4 className="text-xs font-semibold text-stone-700 tracking-wide">
              时空透视镜
            </h4>
            <button
              onClick={onClose}
              className="p-1 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 加载态 */}
          {lensData.loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-emerald-400 animate-spin" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {/* L0 详情 */}
              <Section title="核心记忆详情">
                <div className="space-y-2">
                  <p className="text-xs text-stone-700 leading-relaxed whitespace-pre-wrap">
                    {lensData.memory.content}
                  </p>

                  {/* tags */}
                  {lensData.memory.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {lensData.memory.tags.map(tag => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-stone-100 text-stone-500"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* 置信度 + 时间 */}
                  <div className="flex items-center gap-3 text-[10px] font-mono text-stone-400">
                    <div className="flex items-center gap-1.5 flex-1">
                      <span>置信度</span>
                      <div className="flex-1 h-1 rounded-full bg-stone-100 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-amber-400"
                          style={{ width: `${Math.round(lensData.memory.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="tabular-nums">{Math.round(lensData.memory.confidence * 100)}%</span>
                    </div>
                    <span>{relativeTime(lensData.memory.createdAt)}</span>
                  </div>
                </div>
              </Section>

              {/* L1 推演轨迹 */}
              <Section title="L1 推演轨迹" count={lensData.l1Entries.length}>
                {lensData.l1Entries.length === 0 ? (
                  <p className="text-[11px] text-stone-400 py-2">暂无 L1 推演数据</p>
                ) : (
                  <div className="space-y-2">
                    {lensData.l1Entries.map((entry: L1MemoryEntry) => (
                      <div
                        key={entry.id}
                        className="p-2.5 rounded-lg bg-stone-50/80 border border-stone-100"
                      >
                        <p className="text-[11px] text-stone-600 leading-relaxed line-clamp-3">
                          {entry.content.slice(0, 100)}
                        </p>
                        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono">
                          <div className="flex-1 h-1 rounded-full bg-stone-100 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-400"
                              style={{ width: `${Math.round(entry.confidence * 100)}%` }}
                            />
                          </div>
                          <span className="text-stone-400 tabular-nums">
                            {Math.round(entry.confidence * 100)}%
                          </span>
                          <span className={cn(
                            'px-1 py-0.5 rounded text-[9px]',
                            entry.promotedToL0
                              ? 'bg-emerald-100 text-emerald-600'
                              : 'bg-stone-100 text-stone-400',
                          )}>
                            {entry.promotedToL0 ? '已晋升' : '待晋升'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* 关联执行轨迹 */}
              <Section title="关联执行轨迹" count={lensData.relatedTraces.length}>
                {lensData.relatedTraces.length === 0 ? (
                  <p className="text-[11px] text-stone-400 py-2">暂无关联轨迹</p>
                ) : (
                  <div className="space-y-1.5">
                    {lensData.relatedTraces.map(trace => {
                      const Icon = traceIcon[trace.operationType]
                      return (
                        <div
                          key={trace.id}
                          className="flex items-start gap-2 py-1.5"
                        >
                          <Icon className="w-3.5 h-3.5 text-indigo-400 mt-0.5 shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] text-stone-600 line-clamp-2">
                              {trace.summary.slice(0, 60)}
                            </p>
                            <span className="text-[10px] font-mono text-stone-400">
                              {relativeTime(trace.timestamp)}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </Section>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
