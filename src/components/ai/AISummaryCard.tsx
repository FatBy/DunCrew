import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, RefreshCw, AlertCircle } from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'
import type { ViewType } from '@/types'

interface AISummaryCardProps {
  view: ViewType
}

export function AISummaryCard({ view }: AISummaryCardProps) {
  const generateSummary = useStore((s) => s.generateSummary)
  const getSummary = useStore((s) => s.getSummary)
  const summary = getSummary(view)
  const configured = isLLMConfigured()

  // 进入页面时自动生成摘要
  useEffect(() => {
    if (configured) {
      generateSummary(view)
    }
  }, [view, configured])

  if (!configured) {
    return (
      <div className="mb-4 px-4 py-3 bg-stone-100/80 border border-stone-200 rounded-lg">
        <div className="flex items-center gap-2 text-xs font-mono text-stone-400">
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI 未配置 - 前往设置页面配置 LLM API 以启用智能分析</span>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mb-4 px-4 py-3 bg-gradient-to-r from-amber-500/5 to-cyan-500/5 
                 border border-amber-500/20 rounded-lg"
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-mono text-amber-300/80">AI 洞察</span>
        </div>
        <button
          onClick={() => {
            // 强制刷新：清除缓存再重新生成
            useStore.getState().clearSummary(view)
            generateSummary(view)
          }}
          disabled={summary.loading}
          className="p-1 text-stone-300 hover:text-amber-400 transition-colors disabled:animate-spin"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {summary.loading ? (
        <div className="flex items-center gap-2">
          <div className="h-3 bg-stone-100 rounded animate-pulse flex-1" />
          <div className="h-3 bg-stone-100 rounded animate-pulse w-1/3" />
        </div>
      ) : summary.error ? (
        <div className="flex items-center gap-2 text-xs text-red-400/70 font-mono">
          <AlertCircle className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{summary.error}</span>
        </div>
      ) : summary.content ? (
        <p className="text-xs font-mono text-stone-500 leading-relaxed">
          {summary.content}
        </p>
      ) : (
        <p className="text-xs font-mono text-stone-300">点击刷新生成 AI 分析</p>
      )}
    </motion.div>
  )
}
