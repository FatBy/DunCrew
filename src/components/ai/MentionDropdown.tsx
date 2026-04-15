import { useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Puzzle, Server, Box } from 'lucide-react'
import { cn } from '@/utils/cn'

// ============================================
// Mention 数据类型
// ============================================

export type MentionCategory = 'skill' | 'mcp' | 'dun'

export interface MentionItem {
  category: MentionCategory
  name: string
  displayName: string    // 展示名（可含 emoji）
  description?: string
  keywords?: string[]
}

export interface MentionDropdownProps {
  /** 是否显示 */
  isOpen: boolean
  /** 搜索关键词（@ 后面的文本） */
  query: string
  /** 当前激活的 mention 类别（由前缀决定） */
  activeCategory: MentionCategory | null
  /** 全量候选数据 */
  items: MentionItem[]
  /** 选中高亮索引 */
  activeIndex: number
  /** 选中回调 */
  onSelect: (item: MentionItem) => void
  /** activeIndex 变更回调 */
  onActiveIndexChange: (index: number) => void
}

// ============================================
// 分层模糊搜索
// ============================================

/** 
 * 分层过滤：
 * 第一层: name 前缀匹配
 * 第二层: name + keywords 包含匹配
 * 第三层: description 包含匹配
 */
export function filterMentionItems(items: MentionItem[], query: string): MentionItem[] {
  if (!query) return items.slice(0, 12)

  const q = query.toLowerCase()

  // 第一层：name 前缀
  const prefixMatches = items.filter(i => i.name.toLowerCase().startsWith(q))
  if (prefixMatches.length >= 5) return prefixMatches.slice(0, 12)

  // 第二层：name 包含 + keywords 包含
  const nameOrKwMatches = items.filter(i => {
    if (i.name.toLowerCase().includes(q)) return true
    if (i.keywords?.some(kw => kw.toLowerCase().includes(q))) return true
    return false
  })
  if (nameOrKwMatches.length >= 3) return nameOrKwMatches.slice(0, 12)

  // 第三层：description 包含
  const descMatches = items.filter(i => {
    if (i.name.toLowerCase().includes(q)) return true
    if (i.keywords?.some(kw => kw.toLowerCase().includes(q))) return true
    if (i.description?.toLowerCase().includes(q)) return true
    return false
  })
  return descMatches.slice(0, 12)
}

// ============================================
// 类别图标 & 颜色
// ============================================

const CATEGORY_CONFIG: Record<MentionCategory, { icon: typeof Puzzle; color: string; bgColor: string; label: string }> = {
  skill: { icon: Puzzle, color: 'text-amber-500', bgColor: 'bg-amber-50', label: 'SKILL' },
  mcp:   { icon: Server, color: 'text-violet-500', bgColor: 'bg-violet-50', label: 'MCP' },
  dun:   { icon: Box, color: 'text-emerald-500', bgColor: 'bg-emerald-50', label: 'DUN' },
}

// ============================================
// MentionDropdown 组件
// ============================================

export function MentionDropdown({
  isOpen,
  query,
  activeCategory,
  items,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: MentionDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // 过滤结果
  const filtered = useMemo(() => {
    const categoryItems = activeCategory
      ? items.filter(i => i.category === activeCategory)
      : items
    return filterMentionItems(categoryItems, query)
  }, [items, query, activeCategory])

  // 高亮项滚动到可视区
  useEffect(() => {
    if (!listRef.current || filtered.length === 0) return
    const el = listRef.current.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, filtered.length])

  // activeIndex 越界修正
  useEffect(() => {
    if (filtered.length > 0 && activeIndex >= filtered.length) {
      onActiveIndexChange(0)
    }
  }, [filtered.length, activeIndex, onActiveIndexChange])

  const handleItemClick = useCallback((item: MentionItem) => {
    onSelect(item)
  }, [onSelect])

  if (!isOpen || filtered.length === 0) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 8 }}
        transition={{ duration: 0.15 }}
        className="absolute bottom-full left-0 right-0 mb-2 mx-auto max-w-3xl z-30"
      >
        <div
          ref={listRef}
          className="bg-white border border-stone-200 rounded-xl shadow-lg
                     max-h-[240px] overflow-y-auto py-1"
        >
          {/* 类别标签 */}
          {activeCategory && (
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-stone-400 border-b border-stone-100">
              {CATEGORY_CONFIG[activeCategory].label}
            </div>
          )}
          {!activeCategory && (
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-stone-400 border-b border-stone-100">
              @ Mention
            </div>
          )}

          {filtered.map((item, idx) => {
            const cfg = CATEGORY_CONFIG[item.category]
            const Icon = cfg.icon
            const isActive = idx === activeIndex

            return (
              <button
                key={`${item.category}-${item.name}`}
                onMouseDown={(e) => {
                  // 用 mouseDown 而非 click，防止 textarea blur 导致下拉关闭
                  e.preventDefault()
                  handleItemClick(item)
                }}
                onMouseEnter={() => onActiveIndexChange(idx)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'bg-stone-100'
                    : 'hover:bg-stone-50'
                )}
              >
                <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0', cfg.bgColor)}>
                  <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono font-medium text-stone-700 truncate">
                      {item.displayName}
                    </span>
                    {!activeCategory && (
                      <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-mono', cfg.bgColor, cfg.color)}>
                        {cfg.label}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <p className="text-xs text-stone-400 truncate mt-0.5">
                      {item.description}
                    </p>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

// ============================================
// Hook: useMentionDetection
// ============================================

export interface MentionState {
  isOpen: boolean
  query: string
  activeCategory: MentionCategory | null
  activeIndex: number
  /** @ 符号在 input 中的起始位置 */
  mentionStart: number
}

const INITIAL_MENTION_STATE: MentionState = {
  isOpen: false,
  query: '',
  activeCategory: null,
  activeIndex: 0,
  mentionStart: -1,
}

/**
 * 从输入文本和光标位置检测 @ mention 状态
 * 
 * 前缀规则：
 * - `@` → 默认显示所有类别
 * - `@mcp:` → 仅 MCP
 * - `@dun:` → 仅 Dun
 * 
 * 其他情况 (无前缀 @xxx) → 默认 skill 类别
 */
export function detectMention(text: string, cursorPos: number): MentionState {
  if (cursorPos <= 0) return INITIAL_MENTION_STATE

  // 从光标往前扫描，找到最近的 @ 符号
  let atPos = -1
  for (let i = cursorPos - 1; i >= 0; i--) {
    const ch = text[i]
    // 遇到空白或换行则停止（@ mention 不跨行/跨空格）
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') break
    if (ch === '@') {
      // 确保 @ 在行首或前面是空白
      if (i === 0 || /\s/.test(text[i - 1])) {
        atPos = i
      }
      break
    }
  }

  if (atPos === -1) return INITIAL_MENTION_STATE

  // 提取 @ 后面到光标的文本
  const afterAt = text.slice(atPos + 1, cursorPos)

  // 检测前缀
  let activeCategory: MentionCategory | null = null
  let query = afterAt

  if (afterAt.toLowerCase().startsWith('mcp:')) {
    activeCategory = 'mcp'
    query = afterAt.slice(4)
  } else if (afterAt.toLowerCase().startsWith('dun:')) {
    activeCategory = 'dun'
    query = afterAt.slice(4)
  } else if (afterAt.length > 0) {
    // 无前缀，默认搜索 skill（但也展示其他类别匹配结果）
    activeCategory = null
  }

  return {
    isOpen: true,
    query,
    activeCategory,
    activeIndex: 0,
    mentionStart: atPos,
  }
}

/** 获取关闭状态 */
export function closeMention(): MentionState {
  return INITIAL_MENTION_STATE
}
