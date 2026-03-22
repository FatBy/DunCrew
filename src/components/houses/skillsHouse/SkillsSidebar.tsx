/**
 * SkillsSidebar - 左侧 Glassmorphism 导航栏
 *
 * DD-OS 视觉:
 * - bg-white/60 backdrop-blur-2xl 毛玻璃
 * - 特殊过滤 + 动态域目录
 * - rounded-[32px] 超大圆角
 */

import { motion } from 'framer-motion'
import { Layers, Key, AlertCircle, Flame, Map, Home, Globe, User } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { DomainGroup, SpecialFilter } from '@/utils/skillsHouseMapper'

export type SidebarSelection =
  | { kind: 'special'; filter: SpecialFilter }
  | { kind: 'domain'; domainId: string }

interface SkillsSidebarProps {
  domains: DomainGroup[]
  totalCount: number
  brokenCount: number
  apiCount: number
  builtinCount: number
  communityCount: number
  userCount: number
  selection: SidebarSelection
  onSelect: (sel: SidebarSelection) => void
  viewMode: 'grid' | 'mindmap'
  onViewModeChange: (mode: 'grid' | 'mindmap') => void
}

const specialItems: Array<{
  filter: SpecialFilter
  icon: typeof Layers
  label: string
  getCount?: (p: SkillsSidebarProps) => number
}> = [
  { filter: 'all', icon: Layers, label: '所有技能', getCount: (p) => p.totalCount },
  { filter: 'needs-api', icon: Key, label: '需 API 授权', getCount: (p) => p.apiCount },
  { filter: 'broken', icon: AlertCircle, label: '待修复', getCount: (p) => p.brokenCount },
  { filter: 'hot', icon: Flame, label: '热门活跃' },
]

const sourceItems: Array<{
  filter: SpecialFilter
  icon: typeof Home
  label: string
  getCount: (p: SkillsSidebarProps) => number
}> = [
  { filter: 'source-builtin', icon: Home, label: '系统内置', getCount: (p) => p.builtinCount },
  { filter: 'source-community', icon: Globe, label: '社区下载', getCount: (p) => p.communityCount },
  { filter: 'source-user', icon: User, label: '用户自建', getCount: (p) => p.userCount },
]

// DD-OS 缓动
const ddosEase = [0.23, 1, 0.32, 1]

export function SkillsSidebar(props: SkillsSidebarProps) {
  const { domains, selection, onSelect, viewMode, onViewModeChange } = props

  const isSelected = (sel: SidebarSelection) => {
    if (selection.kind !== sel.kind) return false
    if (sel.kind === 'special' && selection.kind === 'special') return sel.filter === selection.filter
    if (sel.kind === 'domain' && selection.kind === 'domain') return sel.domainId === selection.domainId
    return false
  }

  // 当选中"所有技能"时显示 viewMode 切换器
  const showViewSwitch = selection.kind === 'special' && selection.filter === 'all'

  return (
    <div className="w-56 shrink-0 flex flex-col h-full py-4 pl-4 pr-2">
      <motion.nav
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.4, ease: ddosEase }}
        className="flex flex-col h-full bg-white/60 backdrop-blur-2xl border border-slate-100 rounded-[32px] shadow-sm overflow-hidden"
      >
        {/* 标题 */}
        <div className="px-5 pt-5 pb-3">
          <h3 className="text-[10px] font-black text-stone-400 uppercase tracking-[0.2em]">
            技工学院
          </h3>
        </div>

        {/* 滚动区域 */}
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-1 scrollbar-thin scrollbar-thumb-stone-200">
          {/* 特殊过滤 */}
          <div className="space-y-0.5">
            {specialItems.map((item) => {
              const sel: SidebarSelection = { kind: 'special', filter: item.filter }
              const active = isSelected(sel)
              const Icon = item.icon
              const count = item.getCount?.(props)

              return (
                <button
                  key={item.filter}
                  onClick={() => onSelect(sel)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all duration-200',
                    active
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-500 hover:bg-stone-100/80 hover:text-stone-700',
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-semibold flex-1 truncate">{item.label}</span>
                  {count !== undefined && (
                    <span
                      className={cn(
                        'text-[10px] font-mono tabular-nums',
                        active ? 'text-white/60' : 'text-stone-300',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* 来源分类 */}
          <div className="space-y-0.5">
            <p className="px-3 pt-2 pb-1 text-[9px] font-black text-stone-300 uppercase tracking-[0.15em]">
              来源
            </p>
            {sourceItems.map((item) => {
              const sel: SidebarSelection = { kind: 'special', filter: item.filter }
              const active = isSelected(sel)
              const Icon = item.icon
              const count = item.getCount(props)

              return (
                <button
                  key={item.filter}
                  onClick={() => onSelect(sel)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all duration-200',
                    active
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-500 hover:bg-stone-100/80 hover:text-stone-700',
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="text-xs font-semibold flex-1 truncate">{item.label}</span>
                  <span
                    className={cn(
                      'text-[10px] font-mono tabular-nums',
                      active ? 'text-white/60' : 'text-stone-300',
                    )}
                  >
                    {count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* 分隔线 */}
          <div className="mx-3 my-2 h-px bg-stone-200/60" />

          {/* 视图切换 (仅"所有技能"时) */}
          {showViewSwitch && (
            <>
              <div className="flex items-center gap-1 px-2 py-1">
                <button
                  onClick={() => onViewModeChange('grid')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-colors',
                    viewMode === 'grid'
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-400 hover:bg-stone-100',
                  )}
                >
                  <Layers className="w-3 h-3" />
                  网格
                </button>
                <button
                  onClick={() => onViewModeChange('mindmap')}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px] font-bold transition-colors',
                    viewMode === 'mindmap'
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-400 hover:bg-stone-100',
                  )}
                >
                  <Map className="w-3 h-3" />
                  导图
                </button>
              </div>
              <div className="mx-3 my-2 h-px bg-stone-200/60" />
            </>
          )}

          {/* 动态域目录 */}
          <div className="space-y-0.5">
            <p className="px-3 pt-1 pb-1 text-[9px] font-black text-stone-300 uppercase tracking-[0.15em]">
              Domains
            </p>
            {domains.map((group) => {
              const sel: SidebarSelection = { kind: 'domain', domainId: group.id }
              const active = isSelected(sel)

              return (
                <button
                  key={group.id}
                  onClick={() => onSelect(sel)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all duration-200',
                    active
                      ? 'bg-stone-800 text-white'
                      : 'text-stone-500 hover:bg-stone-100/80 hover:text-stone-700',
                  )}
                >
                  <span className="text-sm shrink-0">{group.emoji}</span>
                  <span className="text-xs font-semibold flex-1 truncate">{group.name}</span>
                  <span
                    className={cn(
                      'text-[10px] font-mono tabular-nums',
                      active ? 'text-white/60' : 'text-stone-300',
                    )}
                  >
                    {group.skills.length}
                    {group.subGroups && group.subGroups.length > 0 && (
                      <span className={cn(
                        'ml-0.5',
                        active ? 'text-white/40' : 'text-stone-200',
                      )}>
                        ·{group.subGroups.length}组
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </motion.nav>
    </div>
  )
}
