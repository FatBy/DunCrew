import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, X, ExternalLink, Loader2 } from 'lucide-react'
import { useStore } from '@/store'
import type { ClawHubSuggestion, ClawHubSkillSummary } from '@/types'

interface ClawHubSuggestionCardProps {
  suggestion: ClawHubSuggestion
}

function SkillRow({ skill, onInstall, installing }: {
  skill: ClawHubSkillSummary
  onInstall: (slug: string) => void
  installing: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2 px-3 bg-stone-100/80 rounded-lg">
      <div className="flex items-center gap-2 min-w-0">
        {skill.emoji && <span className="text-lg shrink-0">{skill.emoji}</span>}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-stone-800 truncate">{skill.name}</span>
            <span className="text-xs text-stone-400">v{skill.version}</span>
          </div>
          <p className="text-xs text-stone-400 truncate">{skill.description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 ml-2">
        <span className="text-xs text-stone-300">{formatDownloads(skill.downloads)}</span>
        <button
          onClick={() => onInstall(skill.slug)}
          disabled={installing}
          className="px-3 py-1 text-xs font-medium rounded-md bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {installing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            '安装'
          )}
        </button>
      </div>
    </div>
  )
}

function formatDownloads(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

export function ClawHubSuggestionCard({ suggestion }: ClawHubSuggestionCardProps) {
  const [dismissed, setDismissed] = useState(false)
  const dismissSuggestion = useStore(s => s.dismissClawHubSuggestion)
  const installSkill = useStore(s => s.clawHubInstallSkill)
  const installing = useStore(s => s.clawHubInstalling)
  const setView = useStore(s => s.setView)

  if (dismissed || suggestion.dismissed) return null

  const handleDismiss = () => {
    setDismissed(true)
    dismissSuggestion(suggestion.id)
  }

  const handleInstall = async (slug: string) => {
    // 构造下载 URL
    const archiveUrl = `https://clawhub.ai/api/v1/download/${encodeURIComponent(slug)}`
    const result = await installSkill(slug, archiveUrl)
    if (result.success) {
      console.log(`[ClawHub] Installed: ${slug}`)
    }
  }

  const handleBrowseMore = () => {
    setView('skill')
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -10 }}
        className="my-3 mx-2 rounded-xl border border-cyan-500/20 bg-gradient-to-br from-cyan-950/40 to-slate-900/60 overflow-hidden"
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-stone-100">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-medium text-cyan-400">
              发现匹配技能
            </span>
            <span className="text-xs text-stone-300">来自 ClawHub</span>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 rounded hover:bg-stone-100 transition-colors"
          >
            <X className="w-3.5 h-3.5 text-stone-400" />
          </button>
        </div>

        {/* 触发信息 */}
        <div className="px-4 py-2 text-xs text-stone-400">
          执行 <code className="px-1 py-0.5 bg-stone-100 rounded text-stone-600">{suggestion.triggerTool}</code> 时未找到对应工具
        </div>

        {/* 匹配结果列表 */}
        <div className="px-4 pb-2 space-y-1.5">
          {suggestion.matches.map(skill => (
            <SkillRow
              key={skill.slug}
              skill={skill}
              onInstall={handleInstall}
              installing={!!installing[skill.slug]}
            />
          ))}
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-stone-100">
          <button
            onClick={handleDismiss}
            className="text-xs text-stone-400 hover:text-stone-500 transition-colors"
          >
            跳过
          </button>
          <button
            onClick={handleBrowseMore}
            className="flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            浏览更多
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
