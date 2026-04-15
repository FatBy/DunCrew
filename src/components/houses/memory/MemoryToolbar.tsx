import { useState, useCallback, useRef } from 'react'
import { Search, RefreshCw, Brain, Route, Share2 } from 'lucide-react'
import { cn } from '@/utils/cn'

export type MemoryTab = 'wall' | 'traces' | 'graph'

interface MemoryToolbarProps {
  activeTab: MemoryTab
  onTabChange: (tab: MemoryTab) => void
  l0Count: number
  traceCount: number
  onSearch: (query: string) => Promise<void>
  onRefresh: () => Promise<void>
  loading: boolean
}

const tabs: { key: MemoryTab; label: string; icon: typeof Brain }[] = [
  { key: 'wall', label: '核心记忆', icon: Brain },
  { key: 'traces', label: '执行分析', icon: Route },
  { key: 'graph', label: '概念图谱', icon: Share2 },
]

export function MemoryToolbar({
  activeTab,
  onTabChange,
  l0Count,
  traceCount,
  onSearch,
  onRefresh,
  loading,
}: MemoryToolbarProps) {
  const [searchValue, setSearchValue] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      setSearchValue(val)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onSearch(val)
      }, 300)
    },
    [onSearch],
  )

  return (
    <div className="h-14 flex items-center gap-4 px-5 border-b border-stone-200/60 shrink-0">
      {/* 搜索框 */}
      <div className="relative w-52">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
        <input
          type="text"
          value={searchValue}
          onChange={handleSearchChange}
          placeholder="搜索记忆..."
          className="w-full pl-8 pr-3 py-1.5 text-xs font-mono rounded-lg bg-stone-50 border border-stone-200/80 text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-emerald-400/60 focus:ring-1 focus:ring-emerald-400/20 transition-colors"
        />
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 bg-stone-100/60 rounded-lg p-0.5">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all',
              activeTab === key
                ? 'bg-emerald-500 text-white shadow-sm'
                : 'text-stone-500 hover:text-stone-700 hover:bg-white/60',
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* 刷新 + 统计 */}
      <button
        onClick={onRefresh}
        disabled={loading}
        className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors disabled:opacity-30"
        title="刷新数据"
      >
        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
      </button>

      <span className="text-xs font-mono text-stone-400">
        {l0Count} 核心 · {traceCount} 轨迹
      </span>
    </div>
  )
}
