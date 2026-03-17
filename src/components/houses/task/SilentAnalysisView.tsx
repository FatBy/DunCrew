import { useEffect } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, RefreshCw, AlertCircle, Inbox, Wand2 } from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'
import type { OptimizationAction } from '@/store/slices/sessionsSlice'

export function SilentAnalysisView() {
  const silentAnalysis = useStore((s) => s.silentAnalysis)
  const shouldRefresh = useStore((s) => s.shouldRefreshAnalysis)
  const generateAnalysis = useStore((s) => s.generateSilentAnalysis)
  const activeExecutions = useStore((s) => s.activeExecutions)
  const openNexusPanelWithInput = useStore((s) => s.openNexusPanelWithInput)
  const configured = isLLMConfigured()

  const doneCount = activeExecutions.filter(
    t => t.status === 'done' || t.status === 'terminated'
  ).length

  // 应用优化建议
  const handleApplyOptimization = (opt: OptimizationAction) => {
    openNexusPanelWithInput(opt.target, opt.prompt)
  }

  // 自动触发静默分析
  useEffect(() => {
    if (configured && doneCount > 0 && shouldRefresh()) {
      generateAnalysis()
    }
  }, [configured, doneCount])

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-lg"
      >
        {doneCount === 0 ? (
          /* 无历史任务 - 空状态 */
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl bg-stone-100/80 border border-stone-200 flex items-center justify-center mx-auto mb-4">
              <Inbox className="w-8 h-8 text-stone-300" />
            </div>
            <h2 className="text-lg font-mono text-stone-400 mb-2">
              系统就绪
            </h2>
            <p className="text-sm font-mono text-stone-300">
              等待任务...通过 AI 聊天面板发起对话
            </p>
          </div>
        ) : (
          /* 有历史任务 - 显示 AI 分析 */
          <div className="rounded-xl border border-stone-200 bg-gradient-to-br from-amber-500/5 via-transparent to-cyan-500/5 p-6">
            {/* 标题栏 */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-mono text-amber-300/80">
                  AI 洞察
                </span>
                <span className="text-xs font-mono text-stone-300 bg-stone-100/80 px-2 py-0.5 rounded">
                  {doneCount} 条任务
                </span>
              </div>
              <button
                onClick={() => generateAnalysis()}
                disabled={silentAnalysis.loading}
                className="p-1.5 text-stone-300 hover:text-amber-400 transition-colors disabled:opacity-50"
                title="刷新分析"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${silentAnalysis.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* 内容区域 */}
            {silentAnalysis.loading ? (
              <div className="space-y-3">
                <div className="h-4 bg-stone-100/80 rounded animate-pulse w-full" />
                <div className="h-4 bg-stone-100/80 rounded animate-pulse w-4/5" />
                <div className="h-4 bg-stone-100/80 rounded animate-pulse w-3/5" />
              </div>
            ) : silentAnalysis.error ? (
              <div className="flex items-start gap-2 text-sm text-red-400/70 font-mono">
                <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                <span>{silentAnalysis.error}</span>
              </div>
            ) : silentAnalysis.content ? (
              <p className="text-sm font-mono text-stone-500 leading-relaxed whitespace-pre-wrap">
                {silentAnalysis.content}
              </p>
            ) : !configured ? (
              <p className="text-sm font-mono text-stone-300">
                LLM 未配置 - 前往设置页面配置以启用 AI 分析
              </p>
            ) : (
              <p className="text-sm font-mono text-stone-300">
                点击刷新按钮生成分析
              </p>
            )}

            {/* 优化建议按钮 */}
            {silentAnalysis.content && !silentAnalysis.loading && (() => {
              const opts = silentAnalysis.optimizations && silentAnalysis.optimizations.length > 0
                ? silentAnalysis.optimizations
                : [{
                    target: 'default',
                    targetType: 'nexus' as const,
                    label: '根据分析优化',
                    prompt: `根据以下 AI 分析改进执行策略:\n${silentAnalysis.content.slice(0, 300)}`,
                  }]
              return (
                <div className="mt-4 pt-3 border-t border-stone-100">
                  <div className="text-xs font-mono text-stone-300 mb-2">一键优化</div>
                  <div className="flex flex-wrap gap-2">
                    {opts.map((opt, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleApplyOptimization(opt)}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                          bg-amber-500/10 hover:bg-amber-500/20 text-amber-300/80 hover:text-amber-300
                          border border-amber-500/20 hover:border-amber-500/40 rounded-lg transition-all"
                      >
                        <Wand2 className="w-3 h-3" />
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* 上次分析时间 */}
            {silentAnalysis.timestamp > 0 && (
              <div className="mt-4 pt-3 border-t border-stone-100 text-xs font-mono text-stone-300">
                上次分析: {new Date(silentAnalysis.timestamp).toLocaleString('zh-CN')}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  )
}
