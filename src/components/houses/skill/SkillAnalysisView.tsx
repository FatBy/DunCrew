import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, RefreshCw, AlertCircle, Brain, Compass } from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'

interface SkillAnalysisViewProps {
  onShowDetail: () => void
}

export function SkillAnalysisView({ onShowDetail }: SkillAnalysisViewProps) {
  const skillAnalysis = useStore((s) => s.skillAnalysis)
  const shouldRefresh = useStore((s) => s.shouldRefreshSkillAnalysis)
  const generateAnalysis = useStore((s) => s.generateSkillAnalysis)
  const openClawSkills = useStore((s) => s.openClawSkills)
  const duns = useStore((s) => s.duns)
  const setActiveDun = useStore((s) => s.setActiveDun)
  const setChatOpen = useStore((s) => s.setChatOpen)

  const configured = isLLMConfigured()
  const skillCount = openClawSkills.length

  // 防误触状态
  const [weaknessHighlighted, setWeaknessHighlighted] = useState(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 自动触发分析
  useEffect(() => {
    if (configured && skillCount > 0 && shouldRefresh()) {
      generateAnalysis()
    }
  }, [configured, skillCount])

  // 5 秒后自动收起按钮
  useEffect(() => {
    if (weaknessHighlighted) {
      dismissTimer.current = setTimeout(() => setWeaknessHighlighted(false), 5000)
      return () => {
        if (dismissTimer.current) clearTimeout(dismissTimer.current)
      }
    }
  }, [weaknessHighlighted])

  const handleActivateDun = () => {
    const dun = duns.get('skill-scout')
    if (dun) {
      setActiveDun('skill-scout')
      // 打开聊天面板并切换到 skill-scout 的 Dun 会话
      const getOrCreate = useStore.getState().getOrCreateDunConversation
      getOrCreate('skill-scout')
      setChatOpen(true)
    }
    setWeaknessHighlighted(false)
  }

  // 空状态
  if (skillCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <div className="w-16 h-16 rounded-2xl bg-stone-100/80 border border-stone-200 flex items-center justify-center mb-4">
          <Brain className="w-8 h-8 text-stone-300" />
        </div>
        <h2 className="text-lg font-mono text-stone-400 mb-2">等待技能加载</h2>
        <p className="text-sm font-mono text-stone-300">通过连接 Native 服务加载技能</p>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-lg mx-auto"
    >
      <div className="rounded-xl border border-stone-200 bg-gradient-to-br from-cyan-500/5 via-transparent to-purple-500/5 p-6">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-cyan-400" />
            <span className="text-sm font-mono text-cyan-300/80">AI 能力画像</span>
            <span className="text-xs font-mono text-stone-300 bg-stone-100/80 px-2 py-0.5 rounded">
              {skillCount} 项技能
            </span>
          </div>
          <button
            onClick={() => generateAnalysis()}
            disabled={skillAnalysis.loading}
            className="p-1.5 text-stone-300 hover:text-cyan-400 transition-colors disabled:opacity-50"
            title="刷新分析"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${skillAnalysis.loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* 内容区域 */}
        {skillAnalysis.loading ? (
          <div className="space-y-3">
            <div className="h-4 bg-stone-100/80 rounded animate-pulse w-full" />
            <div className="h-4 bg-stone-100/80 rounded animate-pulse w-4/5" />
            <div className="h-4 bg-stone-100/80 rounded animate-pulse w-3/5" />
          </div>
        ) : skillAnalysis.error ? (
          <div className="flex items-start gap-2 text-sm text-red-400/70 font-mono">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{skillAnalysis.error}</span>
          </div>
        ) : skillAnalysis.summary ? (
          <div className="space-y-4">
            {/* 主摘要 */}
            <p className="text-sm font-mono text-stone-500 leading-relaxed whitespace-pre-wrap">
              {skillAnalysis.summary}
            </p>

            {/* 不足提示 + 防误触 Dun 激活 */}
            {skillAnalysis.weaknesses && (
              <div className="flex items-center flex-wrap gap-2">
                <p
                  onClick={() => setWeaknessHighlighted(true)}
                  className={`text-xs font-mono cursor-pointer transition-colors ${
                    weaknessHighlighted ? 'text-amber-400/80' : 'text-stone-300 hover:text-stone-400'
                  }`}
                >
                  <AlertCircle className="w-3 h-3 inline mr-1 -mt-0.5" />
                  {skillAnalysis.weaknesses}
                </p>

                <AnimatePresence>
                  {weaknessHighlighted && (
                    <motion.button
                      initial={{ opacity: 0, x: -10, width: 0 }}
                      animate={{ opacity: 1, x: 0, width: 'auto' }}
                      exit={{ opacity: 0, width: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                      onClick={handleActivateDun}
                    >
                      <span className="flex items-center whitespace-nowrap gap-1 px-2.5 py-1 bg-amber-500/15 text-amber-300 rounded-full text-xs font-mono hover:bg-amber-500/25 transition-colors border border-amber-500/20">
                        <Compass className="w-3 h-3" />
                        前往技能星球补充
                      </span>
                    </motion.button>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
        ) : !configured ? (
          <p className="text-sm font-mono text-stone-300">
            LLM 未配置 - 前往设置页面配置以启用 AI 分析
          </p>
        ) : (
          <p className="text-sm font-mono text-stone-300">
            点击刷新按钮生成分析
          </p>
        )}

        {/* 上次分析时间 + 查看详情 */}
        <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between">
          {skillAnalysis.timestamp > 0 && (
            <span className="text-xs font-mono text-stone-300">
              上次分析: {new Date(skillAnalysis.timestamp).toLocaleString('zh-CN')}
            </span>
          )}
          <button
            onClick={onShowDetail}
            className="text-xs font-mono text-stone-300 hover:text-cyan-400 transition-colors ml-auto"
          >
            查看详情 →
          </button>
        </div>
      </div>
    </motion.div>
  )
}
