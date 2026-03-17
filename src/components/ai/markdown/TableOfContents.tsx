import { useState, useEffect, useCallback } from 'react'
import { cn } from '@/utils/cn'
import { List } from 'lucide-react'

export interface HeadingItem {
  id: string
  text: string
  level: 1 | 2 | 3
}

interface TableOfContentsProps {
  headings: HeadingItem[]
  scrollContainer?: HTMLElement | null
}

export function TableOfContents({ headings, scrollContainer }: TableOfContentsProps) {
  const [activeId, setActiveId] = useState<string>('')

  // 监听滚动，高亮当前可见的标题
  useEffect(() => {
    const container = scrollContainer
    if (!container || headings.length === 0) return

    const handleScroll = () => {
      const scrollTop = container.scrollTop
      let currentId = headings[0]?.id || ''

      for (const heading of headings) {
        const el = document.getElementById(heading.id)
        if (el) {
          const offsetTop = el.offsetTop - container.offsetTop
          if (scrollTop >= offsetTop - 80) {
            currentId = heading.id
          }
        }
      }
      setActiveId(currentId)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    handleScroll()
    return () => container.removeEventListener('scroll', handleScroll)
  }, [headings, scrollContainer])

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setActiveId(id)
    }
  }, [])

  if (headings.length === 0) return null

  return (
    <nav className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-stone-400 text-xs font-mono mb-2 px-2">
        <List className="w-3.5 h-3.5" />
        <span>目录</span>
      </div>
      {headings.map((heading) => (
        <button
          key={heading.id}
          onClick={() => handleClick(heading.id)}
          className={cn(
            'block w-full text-left text-xs font-mono leading-relaxed py-1 px-2 rounded transition-colors truncate',
            heading.level === 1 && 'pl-2',
            heading.level === 2 && 'pl-5',
            heading.level === 3 && 'pl-8',
            activeId === heading.id
              ? 'text-cyan-400 bg-cyan-500/10 border-l-2 border-cyan-400'
              : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100/80 border-l-2 border-transparent'
          )}
          title={heading.text}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  )
}
