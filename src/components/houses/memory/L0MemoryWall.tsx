import { Brain, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'
import type { L0MemoryCard } from './useMemoryData'

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

interface L0MemoryWallProps {
  memories: L0MemoryCard[]
  selectedMemoryId: string | null
  onSelectMemory: (id: string | null) => void
  loading: boolean
}

export function L0MemoryWall({
  memories,
  selectedMemoryId,
  onSelectMemory,
  loading,
}: L0MemoryWallProps) {
  if (loading && memories.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          <p className="text-sm text-stone-400">加载记忆中...</p>
        </div>
      </div>
    )
  }

  if (memories.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center">
          <Brain className="w-14 h-14 text-stone-200" />
          <p className="text-sm text-stone-500">暂无核心记忆</p>
          <p className="text-xs text-stone-400 leading-relaxed max-w-sm">
            核心记忆由 AI 从执行轨迹中自动提炼。当同一类操作被反复执行且置信度达到阈值时，系统会将其晋升为核心记忆。你可以切换到「执行轨迹」Tab 查看当前的操作记录。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-4 p-6 overflow-y-auto h-full">
      {memories.map((mem, idx) => {
        const isSelected = mem.id === selectedMemoryId
        return (
          <motion.div
            key={mem.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.03, duration: 0.25 }}
            onClick={() => onSelectMemory(isSelected ? null : mem.id)}
            className={cn(
              'group relative p-5 rounded-2xl cursor-pointer transition-all duration-200',
              'bg-white/60 backdrop-blur-xl border shadow-lg',
              'hover:scale-[1.02] hover:shadow-xl',
              isSelected
                ? 'border-emerald-300 ring-1 ring-emerald-300/40 shadow-emerald-100'
                : 'border-stone-200/60',
            )}
          >
            {/* 顶部：nexus + 时间 */}
            <div className="flex items-center gap-2 mb-3">
              {mem.nexusLabel && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100/80 text-emerald-700">
                  {mem.nexusLabel}
                </span>
              )}
              <span className="ml-auto text-[10px] font-mono text-stone-400">
                {relativeTime(mem.createdAt)}
              </span>
            </div>

            {/* 内容 */}
            <p className="text-sm text-stone-700 leading-relaxed line-clamp-4 mb-3">
              {mem.content}
            </p>

            {/* tags */}
            {Array.isArray(mem.tags) && mem.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {mem.tags.slice(0, 5).map(tag => (
                  <span
                    key={tag}
                    className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-stone-100 text-stone-500"
                  >
                    #{tag}
                  </span>
                ))}
                {mem.tags.length > 5 && (
                  <span className="text-[10px] text-stone-400">+{mem.tags.length - 5}</span>
                )}
              </div>
            )}

            {/* 底部：置信度 + 计数 */}
            <div className="flex items-center gap-3">
              {/* 置信度条 */}
              <div className="flex-1 flex items-center gap-1.5">
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

              {/* 计数徽章 */}
              <div className="flex items-center gap-2 text-[10px] font-mono">
                {mem.l1Count > 0 && (
                  <span className="flex items-center gap-0.5 text-stone-500" title="L1 推演">
                    <Brain className="w-3 h-3" />
                    {mem.l1Count}
                  </span>
                )}
                {mem.traceCount > 0 && (
                  <span className="flex items-center gap-0.5 text-indigo-500" title="执行轨迹">
                    ⚡{mem.traceCount}
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}
