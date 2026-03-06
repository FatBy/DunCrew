import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check, Play, ListChecks } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useStore } from '@/store'

// ============================================
// 建议解析器
// ============================================

export interface SuggestionItem {
  index: number
  label: string
  /** 显示用的字母编号 A, B, C... */
  letter: string
}

export interface ParsedSuggestions {
  /** suggestions 块之前的内容 */
  contentBefore: string
  /** suggestions 块之后的内容 */
  contentAfter: string
  /** 引导语/提示语（告诉用户为什么选择） */
  prompt: string
  /** 解析出的建议列表 */
  items: SuggestionItem[]
}

const SUGGESTION_REGEX = /<!-- suggestions -->\s*\n([\s\S]*?)\n\s*<!-- \/suggestions -->/

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 从 AI 回复内容中提取 <!-- suggestions --> 块
 * 格式约定：
 *   <!-- suggestions -->
 *   引导语（第一行非选项文本）
 *   - 选项A
 *   - 选项B
 *   <!-- /suggestions -->
 *
 * 如果没有约定格式，fallback 尝试匹配"下一步建议"后的编号列表
 */
export function parseSuggestions(content: string): ParsedSuggestions | null {
  // 方案A: 约定格式
  const match = content.match(SUGGESTION_REGEX)
  if (match) {
    const block = match[1]
    const items: SuggestionItem[] = []
    const lines = block.split('\n')
    let prompt = ''
    let idx = 0

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // 匹配选项行: "- xxx" 或 "- [ ] xxx" 或 "A. xxx" 或 "1. xxx"
      const optionMatch = trimmed.match(/^(?:-\s*(?:\[[ x]?\]\s*)?|[A-Za-z][\.\)]\s*|\d+[\.\)、]\s*)(.+)/)
      if (optionMatch) {
        items.push({
          index: idx,
          label: optionMatch[1].trim(),
          letter: LETTERS[idx] || `${idx + 1}`,
        })
        idx++
      } else if (items.length === 0) {
        // 选项之前的文本 → 引导语
        prompt = prompt ? `${prompt} ${trimmed}` : trimmed
      }
    }

    if (items.length >= 2) {
      const startIdx = content.indexOf(match[0])
      const endIdx = startIdx + match[0].length
      return {
        contentBefore: content.slice(0, startIdx).trimEnd(),
        contentAfter: content.slice(endIdx).trimStart(),
        prompt: prompt || '你可以选择以下操作继续：',
        items,
      }
    }
  }

  // 方案B: fallback — 匹配 "下一步建议" / "你可以" 后面的编号列表
  const fallbackPattern = /((?:下一步建议|接下来可以|你可以选择|建议如下|可选操作)[：:]*)\s*\n((?:\s*(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+.+\n?){2,})/
  const fallbackMatch = content.match(fallbackPattern)
  if (fallbackMatch) {
    const prompt = fallbackMatch[1].replace(/[：:]+$/, '').trim()
    const block = fallbackMatch[2]
    const items: SuggestionItem[] = []
    let idx = 0
    const lines = block.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const m = trimmed.match(/^(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+(.+)/)
      if (m) {
        items.push({
          index: idx,
          label: m[1].trim(),
          letter: LETTERS[idx] || `${idx + 1}`,
        })
        idx++
      }
    }
    if (items.length >= 2) {
      const startIdx = content.indexOf(fallbackMatch[0])
      const endIdx = startIdx + fallbackMatch[0].length
      return {
        contentBefore: content.slice(0, startIdx).trimEnd(),
        contentAfter: content.slice(endIdx).trimStart(),
        prompt: prompt || '你可以选择以下操作继续：',
        items,
      }
    }
  }

  return null
}

// ============================================
// 构建隐形上下文
// ============================================

function buildHiddenContext(aiContent: string): string {
  const cleaned = aiContent
    .replace(SUGGESTION_REGEX, '')
    .trim()
  const maxCtx = 2000
  const truncated = cleaned.length > maxCtx
    ? cleaned.slice(0, maxCtx) + '...'
    : cleaned

  // 尝试从 AI 回复中提取已完成的 Phase 信息，防止模型重复执行
  const phaseCompletionHints: string[] = []
  const phasePatterns = [
    /Phase\s*(\d+)[^]*?(?:已完成|完成了|finished|completed)/gi,
    /(?:已完成|完成了)[^]*?Phase\s*(\d+)/gi,
    /(?:步骤|阶段)\s*(\d+)[^]*?(?:已完成|完成)/gi,
  ]
  for (const pattern of phasePatterns) {
    let m
    while ((m = pattern.exec(cleaned)) !== null) {
      phaseCompletionHints.push(`Phase ${m[1]}`)
    }
  }

  let context = truncated
  if (phaseCompletionHints.length > 0) {
    const unique = [...new Set(phaseCompletionHints)]
    context += `\n\n⚠️ 重要提示：以下阶段已在之前完成，不要重复执行：${unique.join('、')}。请直接从下一个未完成的阶段继续。`
  }

  return context
}

// ============================================
// SuggestionChips UI 组件
// ============================================

interface SuggestionChipsProps {
  /** 引导语 */
  prompt: string
  items: SuggestionItem[]
  /** 当前消息的完整 AI 回复内容（用作隐形上下文） */
  aiContent: string
  /** 是否禁用 */
  disabled?: boolean
}

export function SuggestionChips({ prompt, items, aiContent, disabled }: SuggestionChipsProps) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [executed, setExecuted] = useState(false)
  const sendChat = useStore((s) => s.sendChat)
  const currentView = useStore((s) => s.currentView)
  const chatStreaming = useStore((s) => s.chatStreaming)

  const isDisabled = disabled || chatStreaming || executed

  const toggleItem = (index: number) => {
    if (isDisabled) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  const selectedItems = useMemo(() => {
    return items.filter(item => selected.has(item.index))
  }, [items, selected])

  /** 多选执行 */
  const handleExecute = () => {
    if (selectedItems.length === 0 || isDisabled) return
    const choiceList = selectedItems.map(item => `${item.letter}. ${item.label}`).join('\n')
    const visibleMessage = `我选择执行：\n${choiceList}`
    const hiddenContext = buildHiddenContext(aiContent)
    setExecuted(true)
    sendChat(visibleMessage, currentView, hiddenContext)
  }

  /** 单选直接执行 */
  const handleSingleClick = (item: SuggestionItem) => {
    if (isDisabled) return
    const visibleMessage = `继续执行: ${item.label}`
    const hiddenContext = buildHiddenContext(aiContent)
    setExecuted(true)
    sendChat(visibleMessage, currentView, hiddenContext)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="mt-3 rounded-lg border border-amber-500/15 bg-[#1a1a2e] overflow-hidden"
    >
      {/* 引导语 */}
      <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-amber-500/10 bg-[#1e1e35]">
        <ListChecks className="w-3.5 h-3.5 text-amber-400/70 flex-shrink-0" />
        <span className="text-sm text-white/60">{prompt}</span>
      </div>

      {/* 选项列表 — 竖排 */}
      <div className="divide-y divide-white/5 bg-[#16162a]">
        {items.map((item) => {
          const isSelected = selected.has(item.index)
          return (
            <button
              key={item.index}
              onClick={() => {
                if (selected.size === 0 && !isDisabled) {
                  handleSingleClick(item)
                } else {
                  toggleItem(item.index)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                toggleItem(item.index)
              }}
              disabled={isDisabled}
              className={cn(
                'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-all duration-150',
                isDisabled
                  ? 'opacity-40 cursor-not-allowed'
                  : 'cursor-pointer',
                isSelected
                  ? 'bg-amber-500/10'
                  : executed
                  ? 'bg-transparent'
                  : 'hover:bg-amber-500/5'
              )}
            >
              {/* 编号 */}
              <span className={cn(
                'w-6 h-6 rounded flex items-center justify-center text-xs font-mono font-bold flex-shrink-0 transition-colors',
                isSelected
                  ? 'bg-amber-500/25 text-amber-300 border border-amber-500/40'
                  : executed
                  ? 'bg-white/5 text-white/20 border border-white/8'
                  : 'bg-white/8 text-white/50 border border-white/12'
              )}>
                {isSelected ? <Check className="w-3 h-3" /> : item.letter}
              </span>

              {/* 选项文本 */}
              <span className={cn(
                'text-sm font-mono flex-1 transition-colors',
                isSelected
                  ? 'text-amber-300'
                  : executed
                  ? 'text-white/25'
                  : 'text-white/70'
              )}>
                {item.label}
              </span>
            </button>
          )
        })}
      </div>

      {/* 底部操作栏 */}
      <div className="px-3 py-2 border-t border-white/6 bg-[#1e1e35] flex items-center gap-2">
        {!executed && selected.size === 0 && (
          <span className="text-xs text-white/25">单击直接执行，右键多选</span>
        )}

        {selected.size > 0 && !executed && (
          <>
            <button
              onClick={handleExecute}
              disabled={isDisabled}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono transition-colors',
                'bg-amber-500/20 border border-amber-500/40 text-amber-300',
                'hover:bg-amber-500/30',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              <Play className="w-3 h-3" />
              执行选中 ({selected.size})
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-white/25 hover:text-white/40 transition-colors"
            >
              清除
            </button>
          </>
        )}

        {executed && (
          <div className="flex items-center gap-1.5 text-xs text-emerald-400/50">
            <Check className="w-3 h-3" />
            <span>已发送</span>
          </div>
        )}
      </div>
    </motion.div>
  )
}
