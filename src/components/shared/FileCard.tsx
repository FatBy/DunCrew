import { useState, useRef, useEffect } from 'react'
import { FileText, MoreHorizontal, FolderOpen, Copy, ExternalLink, Check } from 'lucide-react'
import { getServerUrl } from '@/utils/env'
import { useT } from '@/i18n'

interface FileCardProps {
  filePath: string
  fileName?: string
  fileSize?: number
  message?: string
}

async function callTool(name: string, args: Record<string, string>) {
  const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
  await fetch(`${serverUrl}/api/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  })
}

export function FileCard({ filePath, fileName, fileSize }: FileCardProps) {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleOpen = async () => {
    setMenuOpen(false)
    await callTool('openInExplorer', { path: filePath, mode: 'open' })
  }

  const handleReveal = async () => {
    setMenuOpen(false)
    await callTool('openInExplorer', { path: filePath, mode: 'reveal' })
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(filePath)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // fallback
    }
    setMenuOpen(false)
  }

  return (
    <div className="group relative flex items-center gap-2 px-3 py-2.5 rounded-lg
                    bg-stone-100/80 dark:bg-white/[0.04] border border-stone-200/60 dark:border-white/[0.08]
                    hover:bg-stone-200/60 dark:hover:bg-white/[0.07] transition-colors cursor-pointer"
         onClick={handleOpen}
    >
      {/* File icon */}
      <div className="w-7 h-7 rounded-md bg-blue-500/10 dark:bg-blue-400/10 flex items-center justify-center shrink-0">
        <FileText className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
      </div>

      {/* Path display */}
      <div className="flex-1 min-w-0">
        {fileName ? (
          <>
            <p className="text-xs font-mono text-stone-600 dark:text-stone-300 truncate">{fileName}</p>
            <p className="text-[10px] font-mono text-stone-400 dark:text-stone-500 truncate" title={filePath}>{filePath}</p>
          </>
        ) : (
          <p className="text-xs font-mono text-stone-600 dark:text-stone-300 truncate" title={filePath}>
            {filePath}
          </p>
        )}
      </div>

      {/* File size */}
      {fileSize !== undefined && (
        <span className="text-[10px] font-mono text-stone-400 shrink-0">
          {fileSize > 1024 ? `${(fileSize / 1024).toFixed(1)} KB` : `${fileSize} B`}
        </span>
      )}

      {/* Menu trigger */}
      <button
        onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen) }}
        className="p-1 rounded hover:bg-stone-300/50 dark:hover:bg-white/10 transition-colors
                   opacity-0 group-hover:opacity-100 shrink-0"
      >
        <MoreHorizontal className="w-4 h-4 text-stone-400" />
      </button>

      {/* Dropdown menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-50 min-w-[180px]
                     bg-white dark:bg-stone-800 rounded-lg shadow-xl border border-stone-200 dark:border-stone-700
                     py-1 text-xs"
        >
          <button
            onClick={handleOpen}
            className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors text-stone-700 dark:text-stone-200"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            <span>{t('file.open')}</span>
          </button>
          <button
            onClick={handleReveal}
            className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors text-stone-700 dark:text-stone-200"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>{t('file.open_in_explorer')}</span>
          </button>
          <button
            onClick={handleCopy}
            className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors text-stone-700 dark:text-stone-200"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? t('file.copied') : t('file.copy_path')}</span>
          </button>
        </div>
      )}
    </div>
  )
}
