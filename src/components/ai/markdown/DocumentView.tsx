import { useState, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { List, X, Bot } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { TableOfContents, type HeadingItem } from './TableOfContents'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'heading'
}

/** 从 Markdown 内容中提取标题 */
export function extractHeadings(content: string): HeadingItem[] {
  const headings: HeadingItem[] = []
  const usedIds = new Set<string>()
  const regex = /^(#{1,3})\s+(.+)$/gm
  let match: RegExpExecArray | null

  while ((match = regex.exec(content)) !== null) {
    const level = match[1].length as 1 | 2 | 3
    const text = match[2].replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim()
    let id = slugify(text)

    // 确保 id 唯一：如果已存在，递增后缀直到找到未使用的
    if (usedIds.has(id)) {
      let counter = 1
      while (usedIds.has(`${id}-${counter}`)) {
        counter++
      }
      id = `${id}-${counter}`
    }
    usedIds.add(id)

    headings.push({ id, text, level })
  }

  return headings
}

/** 判断内容是否为长文档 */
export function isLongFormContent(content: string): boolean {
  const headingCount = (content.match(/^#{1,3}\s+.+$/gm) || []).length
  return content.length > 800 || headingCount >= 2
}

interface DocumentViewProps {
  content: string
  containerWidth?: 'main' | 'nexus'
}

export function DocumentView({ content, containerWidth = 'main' }: DocumentViewProps) {
  const [tocOpen, setTocOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const isMain = containerWidth === 'main'

  const headings = useMemo(() => extractHeadings(content), [content])
  const hasToc = headings.length > 0

  return (
    <div className="flex gap-2">
      {/* Bot 头像 */}
      <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-amber-500/20">
        <Bot className="w-3.5 h-3.5 text-amber-400" />
      </div>

      {/* 文档容器 */}
      <div className="flex-1 min-w-0 bg-white/40 border border-stone-200 rounded-xl overflow-hidden">
        {/* 顶部栏：nexus 模式或 main 无 TOC 时显示目录按钮 */}
        {hasToc && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-stone-100">
            {!isMain && (
              <button
                onClick={() => setTocOpen(!tocOpen)}
                className="flex items-center gap-1.5 text-xs font-mono text-stone-400 hover:text-cyan-400 transition-colors"
              >
                <List className="w-3.5 h-3.5" />
                <span>目录 ({headings.length})</span>
              </button>
            )}
            {isMain && (
              <span className="text-xs font-mono text-stone-300">
                {headings.length} 个章节
              </span>
            )}
          </div>
        )}

        <div className="flex">
          {/* 左侧 TOC (仅 main 模式) */}
          {isMain && hasToc && (
            <div className="w-[180px] flex-shrink-0 border-r border-stone-100 py-3 px-1 overflow-y-auto max-h-[70vh]">
              <TableOfContents
                headings={headings}
                scrollContainer={contentRef.current}
              />
            </div>
          )}

          {/* 内容区 */}
          <div
            ref={contentRef}
            className="flex-1 min-w-0 p-5 overflow-y-auto max-h-[70vh]"
          >
            <MarkdownRenderer content={content} />
          </div>
        </div>

        {/* Nexus 模式浮层 TOC */}
        <AnimatePresence>
          {!isMain && tocOpen && hasToc && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-stone-900/10 z-50"
                onClick={() => setTocOpen(false)}
              />
              <motion.div
                initial={{ x: -280, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: -280, opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed left-0 top-0 bottom-0 w-[280px] bg-white/95 backdrop-blur-sm border-r border-stone-200 z-50 py-4 px-2 overflow-y-auto"
              >
                <div className="flex items-center justify-between px-2 mb-3">
                  <span className="text-xs font-mono text-stone-500">文档目录</span>
                  <button
                    onClick={() => setTocOpen(false)}
                    className="text-stone-400 hover:text-stone-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <TableOfContents
                  headings={headings}
                  scrollContainer={contentRef.current}
                />
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
