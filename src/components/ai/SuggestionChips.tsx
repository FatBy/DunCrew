import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import { Check, Play, ChevronRight } from 'lucide-react'
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
          label: optionMatch[1].trim().replace(/\*\*/g, ''),
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
  const fallbackPattern = /((?:下一步建议|接下来可以|你可以选择|建议如下|可选操作|需要我|是否需要|要不要|你希望)[^：:\n]{0,20}[：:?？]*)\s*\n((?:\s*(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+.+\n?){2,})/
  const fallbackMatch = content.match(fallbackPattern)
  if (fallbackMatch) {
    const prompt = fallbackMatch[1].replace(/[：:?？]+$/, '').trim()
    const block = fallbackMatch[2]
    const items: SuggestionItem[] = []
    let idx = 0
    const lines = block.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const m = trimmed.match(/^(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+(.+)/)
      if (m) {
        // 清理 Markdown 加粗标记 (全局移除所有 **)
        const label = m[1].trim().replace(/\*\*/g, '').replace(/^`(.+?)`/, '$1')
        items.push({
          index: idx,
          label,
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

  // 方案C: 尾部问句 + 编号列表 (OpenClaw Agent 常见格式)
  // 匹配内容末尾的 "？\n1. xxx\n2. xxx" 格式
  const tailPattern = /([^\n]*[？?])\s*\n((?:\s*(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+.+\n?){2,})$/
  const tailMatch = content.match(tailPattern)
  if (tailMatch) {
    const prompt = tailMatch[1].trim()
    const block = tailMatch[2]
    const items: SuggestionItem[] = []
    let idx = 0
    const lines = block.split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      const m = trimmed.match(/^(?:\d+[\.\)、]|[A-Za-z][\.\)]|-)\s+(.+)/)
      if (m) {
        const label = m[1].trim().replace(/\*\*/g, '').replace(/^`(.+?)`/, '$1')
        items.push({
          index: idx,
          label,
          letter: LETTERS[idx] || `${idx + 1}`,
        })
        idx++
      }
    }
    if (items.length >= 2) {
      const startIdx = content.indexOf(tailMatch[0])
      const endIdx = startIdx + tailMatch[0].length
      return {
        contentBefore: content.slice(0, startIdx).trimEnd(),
        contentAfter: content.slice(endIdx).trimStart(),
        prompt: prompt || '你可以选择以下操作继续：',
        items,
      }
    }
  }

  // 方案D: 自然语言内联选项 — 识别"是A，还是B？或者C？"等口语化选项
  {
    const trimmedContent = content.trimEnd()
    const lastParaBreak = trimmedContent.lastIndexOf('\n\n')
    const lastParagraph = lastParaBreak >= 0
      ? trimmedContent.slice(lastParaBreak + 2)
      : trimmedContent

    // 整个末段必须以问号结尾，且包含"还是"/"或者"等分隔词
    if (/[？?]\s*$/.test(lastParagraph) && /(?:还是|或者|或是|亦或)/.test(lastParagraph)) {
      const questionBody = lastParagraph.replace(/[？?]\s*$/, '')
      const splitPattern = /(?:[，,；;。\s])*(?:还是|或者|或是|亦或|又或者|又或)(?:[，,\s])*/
      const parts = questionBody.split(splitPattern).map(s => s.trim()).filter(s => s.length > 0)

      if (parts.length >= 2) {
        const cleanOption = (s: string) =>
          s.replace(/^(?:是|要|想|需要|选择|去|做)\s*/, '')
           .replace(/[？?。，,！!：:]+$/, '')
           .replace(/\*\*/g, '')
           .trim()

        const items: SuggestionItem[] = []
        for (const part of parts) {
          const label = cleanOption(part)
          if (label.length >= 2 && label.length <= 60) {
            items.push({
              index: items.length,
              label,
              letter: LETTERS[items.length] || `${items.length + 1}`,
            })
          }
        }

        if (items.length >= 2 && items.length <= 6) {
          const startIdx = lastParaBreak >= 0 ? lastParaBreak : 0
          const promptRaw = lastParagraph.replace(/[？?]\s*$/, '').trim()
          const promptText = promptRaw.length > 50
            ? promptRaw.slice(0, 50) + '...'
            : promptRaw
          return {
            contentBefore: content.slice(0, startIdx).trimEnd(),
            contentAfter: '',
            prompt: promptText || '你可以选择以下方向：',
            items,
          }
        }
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

export function SuggestionChips({ prompt: _prompt, items, aiContent, disabled }: SuggestionChipsProps) {
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
      className="mt-4 space-y-2"
    >
      {/* 选项列表 — 独立卡片式按钮 */}
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
              'w-full text-left group flex items-center gap-3 bg-white border rounded-xl p-3 transition-all shadow-sm',
              isDisabled
                ? 'opacity-40 cursor-not-allowed border-stone-200'
                : isSelected
                  ? 'border-amber-300 bg-amber-50'
                  : 'border-stone-200 hover:border-amber-300 hover:bg-amber-50 cursor-pointer'
            )}
          >
            {/* 编号徽章 */}
            <span className={cn(
              'w-6 h-6 shrink-0 rounded flex items-center justify-center text-xs font-black transition-colors',
              isSelected
                ? 'bg-amber-200 text-amber-700'
                : 'bg-stone-100 text-stone-500 group-hover:bg-amber-200 group-hover:text-amber-700'
            )}>
              {isSelected ? <Check className="w-3.5 h-3.5" /> : item.letter}
            </span>

            {/* 选项文本 */}
            <span className={cn(
              'text-xs font-bold flex-1 transition-colors',
              isSelected
                ? 'text-stone-800'
                : executed
                  ? 'text-stone-400'
                  : 'text-stone-600 group-hover:text-stone-800'
            )}>
              {item.label}
            </span>

            {/* 箭头 */}
            {!isDisabled && !isSelected && (
              <ChevronRight className="w-4 h-4 text-stone-300 ml-auto opacity-0 group-hover:opacity-100 group-hover:text-amber-500 transition-all transform -translate-x-2 group-hover:translate-x-0" />
            )}
          </button>
        )
      })}

      {/* 底部操作栏 */}
      <div className="pt-2 border-t border-stone-200/60 flex items-center gap-2">
        {!executed && selected.size === 0 && (
          <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">单击直接执行，右键多选</span>
        )}

        {selected.size > 0 && !executed && (
          <>
            <button
              onClick={handleExecute}
              disabled={isDisabled}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold
                         bg-amber-100 border border-amber-200 text-amber-700
                         hover:bg-amber-200 transition-colors
                         disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play className="w-3.5 h-3.5" />
              执行选中 ({selected.size})
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs font-bold text-stone-400 hover:text-stone-600 transition-colors"
            >
              清除
            </button>
          </>
        )}

        {executed && (
          <div className="flex items-center gap-1.5 text-xs font-bold text-emerald-500">
            <Check className="w-3.5 h-3.5" />
            <span>已发送</span>
          </div>
        )}
      </div>
    </motion.div>
  )
}
