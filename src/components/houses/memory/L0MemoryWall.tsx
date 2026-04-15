import { Brain, Loader2, Heart, FolderOpen, Lightbulb, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'
import type { L0MemoryCard } from './useMemoryData'

/** category 分组配置 */
const CATEGORY_CONFIG = {
  preference:      { label: '偏好共识',   icon: Heart,      color: 'text-rose-500' },
  project_context: { label: '环境上下文', icon: FolderOpen,  color: 'text-blue-500' },
  discovery:       { label: '行为准则',   icon: Lightbulb,   color: 'text-amber-500' },
  uncategorized:   { label: '观察备忘',   icon: HelpCircle,  color: 'text-stone-400' },
} as const

/** 无信息量的 tag，不展示 */
const HIDDEN_TAGS = new Set(['memory_flush', 'l0_promoted'])

/** 提取记忆的标题和摘要 */
function extractTitleAndSummary(content: string, snippet?: string): { title: string; summary: string } {
  const text = snippet || content || ''
  const lines = text.split(/[\n\r]+/).filter(l => l.trim())
  const firstLine = lines[0]?.trim() || ''

  let title = firstLine
  if (title.length > 60) {
    const sentences = firstLine.split(/[。.!！?？]/)
    title = sentences[0]?.trim() || firstLine.slice(0, 60)
  }
  if (title.length > 60) {
    title = title.slice(0, 58) + '…'
  }

  const remaining = text.slice(title.length).replace(/^[。.!！?？\s]+/, '').trim()
  const summary = remaining.slice(0, 120)

  return { title: title || '无标题', summary }
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

/** 置信度圆点颜色 */
function confidenceDotClass(confidence: number): string {
  if (confidence >= 0.7) return 'bg-emerald-400'
  if (confidence >= 0.4) return 'bg-amber-400'
  return 'bg-stone-300'
}

const DEFAULT_VISIBLE_COUNT = 8

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
  const [expanded, setExpanded] = useState(false)

  // Hooks 必须在所有 early return 之前调用
  const groupedMemories = useMemo(() => {
    const groups = new Map<string, L0MemoryCard[]>()
    for (const mem of memories) {
      const cat = mem.category || 'uncategorized'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(mem)
    }
    const orderedCategories = ['discovery', 'preference', 'project_context', 'uncategorized'] as const
    const result: Array<{ category: typeof orderedCategories[number]; items: L0MemoryCard[] }> = []
    for (const cat of orderedCategories) {
      const items = groups.get(cat)
      if (items && items.length > 0) {
        result.push({ category: cat, items })
      }
    }
    return result
  }, [memories])

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

  const totalCount = memories.length
  const showAll = expanded || totalCount <= DEFAULT_VISIBLE_COUNT

  return (
    <div className="p-6 overflow-y-auto h-full space-y-8">
      {groupedMemories.map(({ category, items }) => {
        const config = CATEGORY_CONFIG[category]
        const CategoryIcon = config.icon

        // 折叠模式下，按比例分配每个分类的展示数量（至少 1 条）
        const visibleItems = showAll
          ? items
          : items.slice(0, Math.max(1, Math.ceil(DEFAULT_VISIBLE_COUNT * items.length / totalCount)))

        return (
          <div key={category}>
            {/* 分组标题 */}
            <div className="flex items-center gap-2 mb-4 pb-2 border-b border-stone-100">
              <CategoryIcon className={cn('w-4 h-4', config.color)} />
              <span className="text-sm font-semibold text-stone-700">{config.label}</span>
              <span className="text-xs font-mono text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">
                {items.length}
              </span>
            </div>

            {/* 分组内容 grid */}
            <div className="grid grid-cols-2 gap-4">
              {visibleItems.map((mem, idx) => {
                const isSelected = mem.id === selectedMemoryId
                // 过滤无意义 tag
                const visibleTags = (Array.isArray(mem.tags) ? mem.tags : [])
                  .filter(t => !HIDDEN_TAGS.has(t) && !t.startsWith('from_dun:'))

                return (
                  <motion.div
                    key={mem.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03, duration: 0.25 }}
                    onClick={() => onSelectMemory(isSelected ? null : mem.id)}
                    className={cn(
                      'group relative p-4 rounded-xl cursor-pointer transition-all duration-200',
                      'bg-white border',
                      'hover:shadow-md',
                      isSelected
                        ? 'border-emerald-300 ring-1 ring-emerald-300/40'
                        : 'border-stone-200/80 hover:border-stone-300',
                    )}
                  >
                    {/* 顶部：Dun 标签 + 时间 + 置信度圆点 */}
                    <div className="flex items-center gap-2 mb-3">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {mem.dunLabel && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-600 truncate">
                            {mem.dunLabel}
                          </span>
                        )}
                        <span className="text-[10px] font-mono text-stone-400 shrink-0">
                          {relativeTime(mem.createdAt)}
                        </span>
                      </div>
                      <span
                        className={cn('w-2 h-2 rounded-full shrink-0', confidenceDotClass(mem.confidence))}
                        title={`置信度 ${Math.round(mem.confidence * 100)}%`}
                      />
                    </div>

                    {/* 标题 + 摘要 */}
                    {(() => {
                      const { title, summary } = extractTitleAndSummary(mem.content, mem.snippet)
                      return (
                        <>
                          <h3 className="text-sm font-semibold text-stone-800 leading-snug mb-1.5 line-clamp-2">
                            {title}
                          </h3>
                          {summary && (
                            <p className="text-xs text-stone-500 leading-relaxed line-clamp-3">
                              {summary}
                            </p>
                          )}
                        </>
                      )
                    })()}

                    {/* tags（已过滤无意义标签） */}
                    {visibleTags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-3">
                        {visibleTags.slice(0, 3).map(tag => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-stone-100 text-stone-500"
                          >
                            #{tag}
                          </span>
                        ))}
                        {visibleTags.length > 3 && (
                          <span className="text-[10px] text-stone-400">+{visibleTags.length - 3}</span>
                        )}
                      </div>
                    )}
                  </motion.div>
                )
              })}
            </div>
          </div>
        )
      })}

      {/* 展开/收起按钮 */}
      {totalCount > DEFAULT_VISIBLE_COUNT && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-center gap-1.5 py-3 text-xs font-mono text-stone-400 hover:text-stone-600 transition-colors"
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              展开全部 {totalCount} 条
            </>
          )}
        </button>
      )}
    </div>
  )
}
