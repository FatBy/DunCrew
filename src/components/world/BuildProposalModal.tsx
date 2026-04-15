import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, Building2 } from 'lucide-react'
import { useStore } from '@/store'
import { createInitialScoring } from '@/types'
import { useT } from '@/i18n'
import { getServerUrl } from '@/utils/env'

export function BuildProposalModal() {
  const currentProposal = useStore((s) => s.currentProposal)
  const acceptProposal = useStore((s) => s.acceptProposal)
  const rejectProposal = useStore((s) => s.rejectProposal)
  const addDun = useStore((s) => s.addDun)
  
  const t = useT()
  const isOpen = currentProposal?.status === 'pending'
  
  const handleAccept = async () => {
    const accepted = acceptProposal()
    if (accepted) {
      // 创建新的 Dun
      const dunId = `dun-${Date.now()}`
      
      // 找一个空闲位置（简单实现：随机偏移）
      const gridX = Math.floor(Math.random() * 6) - 3
      const gridY = Math.floor(Math.random() * 6) - 3
      
      addDun({
        id: dunId,
        position: { gridX, gridY },
        scoring: createInitialScoring(),
        visualDNA: accepted.previewVisualDNA,
        label: accepted.suggestedName,
        constructionProgress: 0, // 开始建造动画
        createdAt: Date.now(),
        // 传入技能和 SOP
        boundSkillIds: accepted.boundSkillIds || [],
        sopContent: accepted.sopContent || '',
        flavorText: `由 Observer 在 ${new Date().toLocaleDateString()} 创建`,
        // intent-cluster 元数据
        objective: accepted.suggestedObjective || '',
        triggers: accepted.suggestedTriggers || [],
        metrics: accepted.suggestedMetrics || [],
      })

      // 后端同步：创建 DUN.md，确保目录名与前端 dunId 一致
      const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
      try {
        await fetch(`${serverUrl}/duns/${encodeURIComponent(dunId)}/meta`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: accepted.suggestedName }),
        })
        if (accepted.sopContent) {
          const skillDeps = accepted.boundSkillIds?.length
            ? '\nskill_dependencies:\n' + accepted.boundSkillIds.map((s: string) => `  - ${s}`).join('\n')
            : '\nskill_dependencies: []'
          const fullContent = [
            '---',
            `name: ${accepted.suggestedName}`,
            `description: ${accepted.purposeSummary || ''}`,
            'version: 1.0.0',
            skillDeps,
            '---',
            '',
            accepted.sopContent,
          ].join('\n')
          await fetch(`${serverUrl}/duns/${encodeURIComponent(dunId)}/sop-content`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: fullContent }),
          })
        }
      } catch (e) {
        console.warn('[BuildProposal] Backend sync failed (non-critical):', e)
      }
    }
  }
  
  if (!currentProposal) return null
  
  // 从 previewVisualDNA 获取动态颜色
  const hue = currentProposal.previewVisualDNA?.primaryHue ?? 180
  const dynamicBg = { backgroundColor: `hsla(${hue}, 70%, 50%, 0.1)` }
  const dynamicBorder = { borderColor: `hsla(${hue}, 70%, 50%, 0.3)` }
  const dynamicText = { color: `hsl(${hue}, 80%, 65%)` }
  const dynamicBgHover = { backgroundColor: `hsla(${hue}, 70%, 50%, 0.2)` }
  
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* 背景遮罩 - 提高 z-index 确保在最上层 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={rejectProposal}
            className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[100]"
          />
          
          {/* 弹窗 - 使用 inset-0 m-auto 实现居中，避免与 framer-motion transform 冲突 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed inset-0 z-[101] m-auto
                       w-[90%] max-w-md h-fit
                       bg-white border border-stone-200/98 border-2 border-amber-500/40 
                       rounded-2xl shadow-[0_0_60px_rgba(245,158,11,0.3)]
                       overflow-hidden"
          >
            {/* 头部 */}
            <div className="flex items-center justify-between p-4 border-b border-stone-100">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-400" />
                <span className="font-mono text-sm text-amber-400">Observer Signal</span>
              </div>
              <button 
                onClick={rejectProposal}
                className="p-1 hover:bg-stone-100 rounded transition-colors"
              >
                <X className="w-4 h-4 text-stone-400" />
              </button>
            </div>
            
            {/* 内容 */}
            <div className="p-6">
              <p className="text-sm text-stone-700 mb-6 leading-relaxed">
                {t('build.proposal_message')}
              </p>
              
              {/* 预览 - 使用动态颜色 */}
              <div className="flex items-center gap-6 mb-4">
                <div 
                  className="w-24 h-24 rounded-lg flex items-center justify-center flex-shrink-0 border"
                  style={{ ...dynamicBg, ...dynamicBorder }}
                >
                  <span className="text-4xl">🏗️</span>
                </div>
                
                <div className="flex-1 min-w-0">
                  <h3 className="font-mono text-lg text-stone-800 mb-1">
                    {currentProposal.suggestedName}
                  </h3>
                  <p className="text-xs font-mono" style={dynamicText}>
                    Dun
                  </p>
                  <p className="text-xs text-stone-400 mt-1">
                    {t('build.proposal_based_on')}
                  </p>
                </div>
              </div>
              
              {/* 功能目标概述 */}
              <div 
                className="mb-6 p-3 rounded-lg border-l-2"
                style={{ ...dynamicBg, borderLeftColor: `hsla(${hue}, 70%, 50%, 0.5)` }}
              >
                <p className="text-xs text-stone-600 leading-relaxed">
                  {currentProposal.purposeSummary}
                </p>
              </div>
              
              {/* 触发证据 */}
              <div className="mb-6 p-3 bg-stone-100/80 rounded-lg border border-stone-100">
                <p className="text-[13px] font-mono text-stone-400 mb-2">{t('build.proposal_evidence')}</p>
                <div className="space-y-1">
                  {currentProposal.triggerPattern.evidence.slice(0, 3).map((ev, i) => (
                    <p key={i} className="text-xs font-mono text-stone-500 truncate">
                      • {ev}
                    </p>
                  ))}
                </div>
                <p className="text-[13px] font-mono text-stone-300 mt-2">
                  {t('build.proposal_confidence')} {Math.round(currentProposal.triggerPattern.confidence * 100)}%
                </p>
              </div>
              
              {/* 按钮 */}
              <div className="flex gap-3">
                <button
                  onClick={rejectProposal}
                  className="flex-1 py-2.5 px-4 rounded-lg border border-stone-200 
                           text-sm font-mono text-stone-500 hover:bg-stone-100/80 transition-colors"
                >
                  {t('build.proposal_later')}
                </button>
                <button
                  onClick={handleAccept}
                  className="flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2
                           text-sm font-mono transition-colors border"
                  style={{ ...dynamicBg, ...dynamicBorder, ...dynamicText }}
                  onMouseOver={(e) => Object.assign(e.currentTarget.style, dynamicBgHover)}
                  onMouseOut={(e) => Object.assign(e.currentTarget.style, dynamicBg)}
                >
                  <Building2 className="w-4 h-4" />
                  {t('build.proposal_build')}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
