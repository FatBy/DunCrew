import { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s\u4e00-\u9fff-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'heading'
}

/** 将 [[page]] wiki 链接预处理为标准 markdown 链接 */
function preprocessWikiLinks(md: string): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_match, page: string) => {
    const href = page.endsWith('.md') ? page : `${page}.md`
    const display = page.replace(/\.md$/, '')
    return `[${display}](#wiki:${href})`
  })
}

const WIKI_PREFIX = '#wiki:'

function buildComponents(onWikiLinkClick?: (pageName: string) => void): Components {
  return {
    h1: ({ children, ...props }) => {
      const text = String(children)
      return <h1 id={slugify(text)} {...props}>{children}</h1>
    },
    h2: ({ children, ...props }) => {
      const text = String(children)
      return <h2 id={slugify(text)} {...props}>{children}</h2>
    },
    h3: ({ children, ...props }) => {
      const text = String(children)
      return <h3 id={slugify(text)} {...props}>{children}</h3>
    },
    a: ({ children, href }) => {
      if (href?.startsWith(WIKI_PREFIX) && onWikiLinkClick) {
        const page = href.slice(WIKI_PREFIX.length)
        return (
          <button
            type="button"
            className="text-blue-600 hover:text-blue-800 underline decoration-blue-300
                       hover:decoration-blue-500 transition-colors cursor-pointer
                       inline-flex items-center gap-0.5"
            onClick={() => onWikiLinkClick(page)}
          >
            {children}
          </button>
        )
      }
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    },
    pre: ({ children, ...props }) => (
      <pre className="bg-white/60 border border-stone-200 rounded-lg p-4 overflow-x-auto" {...props}>
        {children}
      </pre>
    ),
    code: ({ children, className, ...props }) => {
      const isBlock = className?.includes('language-')
      if (isBlock) {
        return <code className={`${className || ''} text-sm`} {...props}>{children}</code>
      }
      return (
        <code className="text-emerald-400 bg-stone-50/50 px-1.5 py-0.5 rounded text-sm" {...props}>
          {children}
        </code>
      )
    },
    table: ({ children, ...props }) => (
      <div className="overflow-x-auto my-4">
        <table className="min-w-full border border-stone-200/50 text-sm" {...props}>{children}</table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th className="bg-stone-50/60 border border-stone-200/50 px-3 py-2 text-left text-stone-700 font-medium" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="border border-stone-200/50 px-3 py-2 text-stone-700" {...props}>{children}</td>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote className="border-l-4 border-cyan-500/40 pl-4 italic text-stone-500 my-4" {...props}>
        {children}
      </blockquote>
    ),
  }
}

interface MarkdownRendererProps {
  content: string
  className?: string
  onWikiLinkClick?: (pageName: string) => void
}

export function MarkdownRenderer({ content, className, onWikiLinkClick }: MarkdownRendererProps) {
  const processedContent = useMemo(
    () => onWikiLinkClick ? preprocessWikiLinks(content) : content,
    [content, onWikiLinkClick],
  )

  const components = useMemo(() => buildComponents(onWikiLinkClick), [onWikiLinkClick])

  const rendered = useMemo(() => (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {processedContent}
    </ReactMarkdown>
  ), [processedContent, components])

  return (
    <div className={`prose prose-stone prose-sm max-w-none ${className || ''}`}>
      {rendered}
    </div>
  )
}
