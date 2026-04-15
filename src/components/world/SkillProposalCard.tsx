import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '@/store'
import { useT } from '@/i18n'
import { Wrench, Sparkles, X, Check } from 'lucide-react'

/**
 * Skill 提案卡片 - 显示在右上角的悬浮卡片
 * 当 Observer 发现可固化的工具使用模式时自动弹出
 */
export function SkillProposalCard() {
  const currentSkillProposal = useStore((s) => s.currentSkillProposal)
  const acceptSkillProposal = useStore((s) => s.acceptSkillProposal)
  const rejectSkillProposal = useStore((s) => s.rejectSkillProposal)

  // 无提案或非 pending 状态时不显示
  if (!currentSkillProposal || currentSkillProposal.status !== 'pending') {
    return null
  }

  const t = useT()
  const { suggestedName, discoveryType, tools, description, confidence } = currentSkillProposal

  // 根据发现类型显示不同的标签颜色
  const typeColors: Record<string, string> = {
    tool_frequency: 'bg-blue-100 text-blue-700',
    tool_chain: 'bg-purple-100 text-purple-700',
    cross_tool: 'bg-emerald-100 text-emerald-700',
  }

  const typeLabels: Record<string, string> = {
    tool_frequency: t('skill.proposal_high_freq'),
    tool_chain: t('skill.proposal_toolchain'),
    cross_tool: t('skill.proposal_cross_tool'),
  }

  const handleAccept = async () => {
    const accepted = await acceptSkillProposal()
    if (accepted) {
      console.log('[SkillProposalCard] Skill proposal accepted:', accepted.suggestedName)
    }
  }

  const handleReject = () => {
    rejectSkillProposal()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -20, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="fixed top-4 right-4 z-50 w-80"
      >
        <div className="bg-white rounded-xl shadow-lg border border-stone-200 overflow-hidden">
          {/* Header */}
          <div className="px-4 py-3 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-stone-100">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-500" />
              <span className="text-sm font-medium text-amber-700">{t('skill.proposal_title')}</span>
            </div>
          </div>

          {/* Content */}
          <div className="p-4 space-y-3">
            {/* 名称 */}
            <h3 className="text-lg font-semibold text-stone-800">{suggestedName}</h3>

            {/* 类型标签 + 置信度 */}
            <div className="flex items-center gap-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${typeColors[discoveryType] || 'bg-stone-100 text-stone-600'}`}>
                {typeLabels[discoveryType] || discoveryType}
              </span>
              <span className="text-xs text-stone-400">
                {t('skill.proposal_confidence')} {Math.round(confidence * 100)}%
              </span>
            </div>

            {/* 工具列表 */}
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool, index) => (
                <span
                  key={index}
                  className="inline-flex items-center gap-1 text-xs bg-stone-100 text-stone-600 px-2 py-0.5 rounded"
                >
                  <Wrench className="w-3 h-3" />
                  {tool}
                </span>
              ))}
            </div>

            {/* 描述 */}
            <p className="text-sm text-stone-600 leading-relaxed">{description}</p>
          </div>

          {/* Actions */}
          <div className="px-4 py-3 bg-stone-50 border-t border-stone-100 flex gap-2">
            <button
              onClick={handleAccept}
              className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 rounded-lg transition-colors"
            >
              <Check className="w-4 h-4" />
              {t('skill.proposal_create')}
            </button>
            <button
              onClick={handleReject}
              className="flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium text-stone-500 hover:text-stone-700 hover:bg-stone-100 rounded-lg transition-colors"
            >
              <X className="w-4 h-4" />
              {t('skill.proposal_dismiss')}
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
