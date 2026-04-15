import { useMemo } from 'react'
import { TrendingUp, Activity, Heart, FolderOpen, Lightbulb, HelpCircle } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { L0MemoryCard, NeuronStats, TraceEntry } from './useMemoryData'

const CATEGORY_CONFIG = {
  discovery:       { label: '行为准则',   icon: Lightbulb,  color: 'text-amber-500', bar: 'bg-amber-400' },
  preference:      { label: '偏好共识',   icon: Heart,      color: 'text-rose-500',  bar: 'bg-rose-400' },
  project_context: { label: '环境上下文', icon: FolderOpen,  color: 'text-blue-500',  bar: 'bg-blue-400' },
  uncategorized:   { label: '观察备忘',   icon: HelpCircle,  color: 'text-stone-400', bar: 'bg-stone-400' },
} as const

type CategoryKey = keyof typeof CATEGORY_CONFIG
const CATEGORY_ORDER: CategoryKey[] = ['discovery', 'preference', 'project_context', 'uncategorized']

/** 提取记忆标题（简短版） */
function extractTitle(content: string, snippet?: string): string {
  const text = snippet || content || ''
  const firstLine = text.split(/[\n\r]+/).filter(l => l.trim())[0]?.trim() || ''
  if (firstLine.length <= 30) return firstLine || '无标题'
  const sentence = firstLine.split(/[。.!！?？]/)[0]?.trim()
  if (sentence && sentence.length <= 30) return sentence
  return firstLine.slice(0, 28) + '…'
}

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

  // 分类统计
  const categoryStats = useMemo(() => {
    const stats: Record<string, number> = {}
    for (const mem of l0Memories) {
      const cat = mem.category || 'uncategorized'
      stats[cat] = (stats[cat] || 0) + 1
    }
    return stats
  }, [l0Memories])

  // 置信度分布
  const confidenceDistribution = useMemo(() => {
    const high = l0Memories.filter(m => m.confidence >= 0.7).length
    const medium = l0Memories.filter(m => m.confidence >= 0.4 && m.confidence < 0.7).length
    const low = l0Memories.filter(m => m.confidence < 0.4).length
    return { high, medium, low }
  }, [l0Memories])

  // 最近 5 条（按时间排序）
  const recentMemories = useMemo(() => {
    return [...l0Memories]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
  }, [l0Memories])

  return (
    <div className="w-56 border-r border-stone-200/60 flex flex-col shrink-0">
      {/* 标题 */}
      <div className="px-4 py-3 flex items-center gap-2 border-b border-stone-100">
        {l0Memories.length > 0 ? (
          <TrendingUp className="w-4 h-4 text-emerald-500" />
        ) : (
          <Activity className="w-4 h-4 text-indigo-500" />
        )}
        <h4 className="text-xs font-semibold text-stone-700 tracking-wide">
          {l0Memories.length > 0 ? '记忆概览' : '执行概览'}
        </h4>
        <span className="ml-auto text-[10px] font-mono text-stone-400">
          {l0Memories.length > 0 ? l0Memories.length : traces.length}
        </span>
      </div>

      {/* 主体内容 */}
      <div className="flex-1 overflow-y-auto">
        {l0Memories.length > 0 ? (
          <>
            {/* 分类分布 */}
            <div className="px-4 py-3 space-y-2">
              <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">
                分类分布
              </span>
              {CATEGORY_ORDER.map(cat => {
                const count = categoryStats[cat] || 0
                if (count === 0) return null
                const config = CATEGORY_CONFIG[cat]
                const Icon = config.icon
                const percentage = l0Memories.length > 0 ? Math.round(count / l0Memories.length * 100) : 0
                return (
                  <div key={cat} className="flex items-center gap-2">
                    <Icon className={cn('w-3.5 h-3.5 shrink-0', config.color)} />
                    <span className="text-xs text-stone-600 flex-1 truncate">{config.label}</span>
                    <span className="text-[10px] font-mono text-stone-400">{count}</span>
                    <div className="w-10 h-1 rounded-full bg-stone-100 overflow-hidden shrink-0">
                      <div
                        className={cn('h-full rounded-full', config.bar)}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 置信度分布 */}
            <div className="px-4 py-3 border-t border-stone-100 space-y-2">
              <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">
                置信度分布
              </span>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" />
                <span className="text-xs text-stone-600 flex-1">高 (&ge;70%)</span>
                <span className="text-xs font-mono text-stone-500">{confidenceDistribution.high}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <span className="text-xs text-stone-600 flex-1">中 (40-70%)</span>
                <span className="text-xs font-mono text-stone-500">{confidenceDistribution.medium}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-stone-300 shrink-0" />
                <span className="text-xs text-stone-600 flex-1">低 (&lt;40%)</span>
                <span className="text-xs font-mono text-stone-500">{confidenceDistribution.low}</span>
              </div>
            </div>

            {/* 最近更新 */}
            <div className="px-4 py-3 border-t border-stone-100">
              <span className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">
                最近更新
              </span>
              <div className="mt-2 space-y-1">
                {recentMemories.map(mem => {
                  const isSelected = mem.id === selectedMemoryId
                  return (
                    <button
                      key={mem.id}
                      onClick={() => onSelectMemory(isSelected ? null : mem.id)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 rounded-lg text-xs truncate transition-colors',
                        isSelected
                          ? 'bg-emerald-50 text-emerald-700 font-medium'
                          : 'text-stone-600 hover:bg-stone-50',
                      )}
                    >
                      {extractTitle(mem.content, mem.snippet)}
                    </button>
                  )
                })}
              </div>
            </div>
          </>
        ) : traces.length > 0 ? (
          /* L0 为空时展示最近执行轨迹摘要 */
          <div className="px-2 pb-2 space-y-1">
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
                  {trace.dunLabel && (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-emerald-100/80 text-emerald-700">
                      {trace.dunLabel}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-stone-400 ml-auto">
                    {relativeTime(trace.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
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
