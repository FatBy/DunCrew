import { useState, useEffect, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, RefreshCw, AlertCircle, Inbox, Wand2, Search, X, Plus, Zap, Check } from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'
import type { OptimizationAction } from '@/store/slices/sessionsSlice'
import type { ObserverInsight } from '@/types'

export const SilentAnalysisView = memo(function SilentAnalysisView() {
  const silentAnalysis = useStore((s) => s.silentAnalysis)
  const shouldRefresh = useStore((s) => s.shouldRefreshAnalysis)
  const generateAnalysis = useStore((s) => s.generateSilentAnalysis)
  // 只提取 doneCount 而非整个数组，避免执行步骤更新时触发重渲染
  const doneCount = useStore((s) =>
    s.activeExecutions.filter(t => t.status === 'done' || t.status === 'terminated').length
  )
  const openDunPanelWithInput = useStore((s) => s.openDunPanelWithInput)
  const configured = isLLMConfigured()

  // ── 洞察系统 ──
  const insights = useStore((s) => s.insights)
  const dismissInsight = useStore((s) => s.dismissInsight)
  const createDunFromInsight = useStore((s) => s.createDunFromInsight)
  const enhanceDunFromInsight = useStore((s) => s.enhanceDunFromInsight)

  // 过滤 7 天过期的洞察
  const activeInsights = insights.filter(
    i => Date.now() - i.createdAt < 7 * 24 * 60 * 60 * 1000
  )

  // 应用优化建议
  const handleApplyOptimization = (opt: OptimizationAction) => {
    openDunPanelWithInput(opt.target, opt.prompt)
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
        className="w-full max-w-lg space-y-6"
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
                    targetType: 'dun' as const,
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

        {/* ── Observer 洞察区块（独立于 doneCount，始终可展示）── */}
        {activeInsights.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 mb-2">
              <Search className="w-3.5 h-3.5 text-stone-400" />
              <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                行为模式
              </span>
            </div>

            <AnimatePresence mode="popLayout">
              {activeInsights.map((insight) => (
                <InsightCard
                  key={insight.id}
                  insight={insight}
                  onDismiss={dismissInsight}
                  onCreateDun={createDunFromInsight}
                  onEnhanceDun={enhanceDunFromInsight}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </motion.div>
    </div>
  )
})

/** 单张洞察卡片 */
function InsightCard({ insight, onDismiss, onCreateDun, onEnhanceDun }: {
  insight: ObserverInsight
  onDismiss: (id: string) => void
  onCreateDun: (id: string) => void
  onEnhanceDun: (id: string) => Promise<void>
}) {
  const [enhancing, setEnhancing] = useState(false)
  const [enhanced, setEnhanced] = useState(false)

  const handleEnhance = async () => {
    setEnhancing(true)
    await onEnhanceDun(insight.id)
    setEnhanced(true)
    setTimeout(() => onDismiss(insight.id), 1200)
  }

  // 最常用工具链
  const chainSigs: Record<string, number> = {}
  for (const chain of insight.cluster.toolChains) {
    const sig = chain.join('→')
    chainSigs[sig] = (chainSigs[sig] || 0) + 1
  }
  const topChain = Object.entries(chainSigs).sort(([, a], [, b]) => b - a)[0]?.[0] || ''

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10, transition: { duration: 0.2 } }}
      className="rounded-lg border border-stone-200 bg-stone-50/80 p-4"
    >
      {/* 关键词标签 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {insight.coreKeywords.slice(0, 4).map((kw) => (
            <span
              key={kw}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-200/60 text-stone-500"
            >
              {kw}
            </span>
          ))}
        </div>
        <button
          onClick={() => onDismiss(insight.id)}
          className="p-1 text-stone-300 hover:text-stone-500 transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 统计摘要 */}
      <div className="text-xs font-mono text-stone-500 space-y-1 mb-3">
        <p>
          {insight.cluster.size} 次相似任务 / 成功率 {Math.round(insight.cluster.successRate * 100)}%
        </p>
        {topChain && (
          <p className="text-stone-400 truncate">{topChain}</p>
        )}
      </div>

      {/* 关联 Dun 提示 */}
      {insight.relatedDunLabel && (
        <p className="text-[11px] font-mono text-amber-500/80 mb-3">
          与 [{insight.relatedDunLabel}] 相关
        </p>
      )}

      {/* 行动按钮 */}
      <div className="flex items-center gap-2">
        {insight.relatedDunId && (
          <button
            onClick={handleEnhance}
            disabled={enhancing || enhanced}
            className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono
              bg-amber-500/10 hover:bg-amber-500/20 text-amber-600/80 hover:text-amber-600
              border border-amber-500/20 rounded-md transition-all disabled:opacity-50"
          >
            {enhanced ? (
              <><Check className="w-3 h-3" /> 已更新</>
            ) : enhancing ? (
              <><RefreshCw className="w-3 h-3 animate-spin" /> 更新中</>
            ) : (
              <><Zap className="w-3 h-3" /> 增强经验</>
            )}
          </button>
        )}
        <button
          onClick={() => onCreateDun(insight.id)}
          className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-mono
            bg-stone-100 hover:bg-stone-200 text-stone-500 hover:text-stone-700
            border border-stone-200 rounded-md transition-all"
        >
          <Plus className="w-3 h-3" /> 创建 Dun
        </button>
      </div>
    </motion.div>
  )
}
