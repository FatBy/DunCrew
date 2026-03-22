import { Sparkles, Activity } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { L0MemoryCard, NeuronStats, TraceEntry } from './useMemoryData'

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

const opDotColor: Record<TraceEntry['operationType'], string> = {
  read: 'bg-cyan-500',
  write: 'bg-emerald-500',
  edit: 'bg-amber-500',
  command: 'bg-indigo-500',
  unknown: 'bg-stone-400',
}

interface MemorySidebarProps {
  l0Memories: L0MemoryCard[]
  traces: TraceEntry[]
  neuronStats: NeuronStats
  selectedMemoryId: string | null
  onSelectMemory: (id: string | null) => void
}

export function MemorySidebar({
  l0Memories,
  traces,
  neuronStats,
  selectedMemoryId,
  onSelectMemory,
}: MemorySidebarProps) {
  const { totalL1, promotedCount, averageConfidence, solidificationPercent } = neuronStats

  // 环形图参数
  const radius = 32
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (circumference * solidificationPercent) / 100

  return (
    <div className="w-56 border-r border-stone-200/60 flex flex-col shrink-0">
      {/* 标题 */}
      <div className="px-4 py-3 flex items-center gap-2">
        {l0Memories.length > 0 ? (
          <Sparkles className="w-4 h-4 text-emerald-500" />
        ) : (
          <Activity className="w-4 h-4 text-indigo-500" />
        )}
        <h4 className="text-xs font-semibold text-stone-700 tracking-wide">
          {l0Memories.length > 0 ? '核心记忆' : '执行概览'}
        </h4>
        <span className="ml-auto text-[10px] font-mono text-stone-400">
          {l0Memories.length > 0 ? l0Memories.length : traces.length}
        </span>
      </div>

      {/* 列表区域 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
        {l0Memories.length > 0 ? (
          /* L0 记忆列表 */
          l0Memories.map(mem => {
            const isSelected = mem.id === selectedMemoryId
            return (
              <button
                key={mem.id}
                onClick={() => onSelectMemory(isSelected ? null : mem.id)}
                className={cn(
                  'w-full text-left px-3 py-2.5 rounded-xl transition-all duration-200',
                  'hover:bg-stone-50',
                  isSelected
                    ? 'bg-emerald-50/80 border-l-2 border-emerald-500'
                    : 'border-l-2 border-transparent',
                )}
              >
                <p className={cn(
                  'text-xs leading-relaxed line-clamp-2',
                  isSelected ? 'text-stone-800' : 'text-stone-600',
                )}>
                  {(mem.snippet || mem.content).slice(0, 80)}
                </p>

                {mem.nexusLabel && (
                  <span className="mt-1.5 inline-block px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100/80 text-emerald-700">
                    {mem.nexusLabel}
                  </span>
                )}

                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 h-1 rounded-full bg-stone-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-amber-400 transition-all"
                      style={{ width: `${Math.round(mem.confidence * 100)}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-stone-400 tabular-nums">
                    {Math.round(mem.confidence * 100)}%
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-2 text-[10px] font-mono text-stone-400">
                  {mem.l1Count > 0 && <span>L1: {mem.l1Count}</span>}
                  {mem.traceCount > 0 && <span>轨迹: {mem.traceCount}</span>}
                  <span className="ml-auto">{relativeTime(mem.createdAt)}</span>
                </div>
              </button>
            )
          })
        ) : traces.length > 0 ? (
          /* L0 为空时展示最近执行轨迹摘要 */
          <>
            <div className="px-3 py-1.5 text-[10px] font-mono text-stone-400 uppercase tracking-wider">
              最近操作
            </div>
            {traces.slice(0, 15).map(trace => (
              <div
                key={trace.id}
                className="px-3 py-2 rounded-lg hover:bg-stone-50 transition-colors"
              >
                <div className="flex items-center gap-1.5">
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', opDotColor[trace.operationType])} />
                  <p className="text-xs text-stone-600 truncate">{trace.summary.slice(0, 50)}</p>
                </div>
                <div className="mt-0.5 flex items-center gap-2 ml-3">
                  {trace.nexusLabel && (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-100/80 text-emerald-700">
                      {trace.nexusLabel}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-stone-400 ml-auto">
                    {relativeTime(trace.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </>
        ) : (
          <div className="py-8 text-center">
            <p className="text-xs text-stone-400">暂无记忆数据</p>
          </div>
        )}
      </div>

      {/* 神经元统计面板 */}
      <div className="border-t border-stone-200/60 p-4 shrink-0">
        <div className="flex items-center gap-3">
          {/* 环形进度图 */}
          <div className="relative w-[76px] h-[76px] shrink-0">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 76 76">
              <circle
                cx="38" cy="38" r={radius}
                fill="none" stroke="#f5f5f4" strokeWidth="5"
              />
              <circle
                cx="38" cy="38" r={radius}
                fill="none" stroke="#f59e0b" strokeWidth="5"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                className="transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-sm font-bold text-stone-700 tabular-nums">
                {solidificationPercent}%
              </span>
            </div>
          </div>

          {/* 数值 */}
          <div className="space-y-1.5 text-[11px]">
            <div>
              <span className="text-stone-400">已固化</span>
              <p className="font-mono font-semibold text-stone-700">{promotedCount}/{totalL1}</p>
            </div>
            <div>
              <span className="text-stone-400">平均置信度</span>
              <p className="font-mono font-semibold text-amber-600">
                {Math.round(averageConfidence * 100)}%
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
