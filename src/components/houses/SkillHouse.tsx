/**
 * SkillHouse - Blueprint 重构版
 *
 * 设计宪法:
 * - 赛博青色神经元网络 (SkillTreeView) 替代黑洞星球
 * - bg-[#fefaf6] + 点阵全域亮色
 * - 保留市场搜索和详情面板
 */

import { useMemo, useState, useCallback } from 'react'
import { Loader2, Store, X, ChevronUp } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '@/store'
import { skillStatsService } from '@/services/skillStatsService'
import { SkillTreeView } from '@/components/blueprint/SkillTreeView'
import { SkillDetailPanel } from './skill/SkillDetailPanel'
import type { ClawHubSkillSummary } from '@/types'
import { Search, Download } from 'lucide-react'

// ── MarketplaceTab ──────────────────────

function MarketplaceTab() {
  const searchResults = useStore((s) => s.clawHubSearchResults)
  const searchLoading = useStore((s) => s.clawHubSearchLoading)
  const clawHubSearch = useStore((s) => s.clawHubSearch)
  const clawHubInstallSkill = useStore((s) => s.clawHubInstallSkill)
  const installing = useStore((s) => s.clawHubInstalling)
  const storeSkills = useStore((s) => s.skills)
  const [query, setQuery] = useState('')

  const handleSearch = useCallback(() => {
    if (query.trim()) clawHubSearch(query.trim())
  }, [query, clawHubSearch])

  const handleInstall = async (skill: ClawHubSkillSummary) => {
    const archiveUrl = `https://clawhub.ai/api/v1/download/${encodeURIComponent(skill.slug)}`
    await clawHubInstallSkill(skill.slug, archiveUrl)
  }

  const isInstalled = (skillName: string) =>
    storeSkills.some(
      (s) => s.name.toLowerCase() === skillName.toLowerCase() || s.id?.toLowerCase() === skillName.toLowerCase(),
    )

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      {/* 搜索栏 */}
      <div className="flex gap-2">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-300" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索 ClawHub 技能..."
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-stone-200 rounded-lg text-sm text-stone-800 placeholder:text-stone-300 focus:border-cyan-400 focus:outline-none"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={searchLoading || !query.trim()}
          className="px-4 py-2 text-sm font-bold bg-cyan-50 text-cyan-600 border border-cyan-200 rounded-lg hover:bg-cyan-100 disabled:opacity-50 transition-colors"
        >
          {searchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : '搜索'}
        </button>
      </div>

      {/* 结果列表 */}
      {searchLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-cyan-500 animate-spin" />
        </div>
      )}
      {!searchLoading && searchResults.length > 0 && (
        <div className="space-y-2">
          {searchResults.map((skill) => {
            const installed = isInstalled(skill.name)
            const isInstalling = !!installing[skill.slug]
            return (
              <div
                key={skill.slug}
                className="flex items-center justify-between p-3 bg-white rounded-lg border border-stone-200 hover:border-stone-300 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {skill.emoji && <span className="text-xl shrink-0">{skill.emoji}</span>}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-stone-800">{skill.name}</span>
                      <span className="text-xs text-stone-400">v{skill.version}</span>
                    </div>
                    <p className="text-xs text-stone-400 truncate">{skill.description}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-3">
                  {installed ? (
                    <span className="px-3 py-1.5 text-xs text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-md">
                      已安装
                    </span>
                  ) : (
                    <button
                      onClick={() => handleInstall(skill)}
                      disabled={isInstalling}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-cyan-50 text-cyan-600 border border-cyan-200 rounded-md hover:bg-cyan-100 disabled:opacity-50 transition-colors"
                    >
                      {isInstalling ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Download className="w-3 h-3" />
                      )}
                      {isInstalling ? '安装中' : '安装'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {!searchLoading && searchResults.length === 0 && query && (
        <div className="text-center py-8 text-stone-400 text-sm">未找到匹配的技能</div>
      )}
      {!query && searchResults.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-stone-400">
          <Store className="w-10 h-10 mb-3" />
          <p className="text-sm">输入关键词搜索 ClawHub 技能市场</p>
        </div>
      )}
    </div>
  )
}

// ── SkillHouse 主组件 ──────────────────────

export function SkillHouse() {
  const storeSkills = useStore((s) => s.skills)
  const openClawSkills = useStore((s) => s.openClawSkills)
  const loading = useStore((s) => s.channelsLoading)
  const connectionStatus = useStore((s) => s.connectionStatus)
  const storeSnapshot = useStore((s) => s.skillStatsSnapshot)
  const statsVersion = useStore((s) => s.skillStatsVersion)

  const isConnected = connectionStatus === 'connected'
  const [activeTab, setActiveTab] = useState<'local' | 'marketplace'>('local')
  const [isDetailExpanded, setIsDetailExpanded] = useState(false)

  const snapshot = useMemo(() => {
    return storeSnapshot ?? skillStatsService.computeSnapshot(openClawSkills)
  }, [storeSnapshot, openClawSkills])

  const activeSkills = useMemo(
    () => storeSkills.filter((s) => s.unlocked || s.status === 'active'),
    [storeSkills],
  )

  if (loading && isConnected) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#fefaf6]">
      {/* ── Layer 0: 全屏神经元网络 ── */}
      <div className="absolute inset-0 overflow-y-auto">
        <SkillTreeView />
      </div>

      {/* ── Layer 1: 浮动 Tab (左上) ── */}
      <div className="absolute top-4 left-4 z-20 pointer-events-auto">
        <div className="flex gap-1 p-1 bg-white/90 backdrop-blur-xl border border-stone-200 rounded-lg shadow-sm">
          <button
            onClick={() => setActiveTab('local')}
            className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${
              activeTab === 'local'
                ? 'bg-cyan-50 text-cyan-600 border border-cyan-200'
                : 'text-stone-400 hover:text-stone-600 border border-transparent'
            }`}
          >
            神经元
          </button>
          <button
            onClick={() => setActiveTab('marketplace')}
            className={`flex items-center gap-1 px-3 py-1 text-xs font-bold rounded-md transition-colors ${
              activeTab === 'marketplace'
                ? 'bg-cyan-50 text-cyan-600 border border-cyan-200'
                : 'text-stone-400 hover:text-stone-600 border border-transparent'
            }`}
          >
            <Store className="w-3 h-3" />
            市场
          </button>
        </div>
      </div>

      {/* ── Layer 1: Stats HUD (右上) ── */}
      <div className="absolute top-4 right-4 z-20 pointer-events-none">
        <div className="bg-white/90 backdrop-blur-xl border border-stone-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="space-y-2 min-w-[80px]">
            <div>
              <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Skills</p>
              <p className="text-lg font-bold text-cyan-600">{storeSkills.length}</p>
            </div>
            <div>
              <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Active</p>
              <p className="text-lg font-bold text-emerald-600">{activeSkills.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Layer 3: Marketplace 浮层 ── */}
      <AnimatePresence>
        {activeTab === 'marketplace' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-[#fefaf6]/95 backdrop-blur-xl overflow-y-auto p-6 pt-16"
          >
            <button
              onClick={() => setActiveTab('local')}
              className="absolute top-4 right-4 p-2 rounded-lg hover:bg-stone-100 transition-colors z-40"
            >
              <X className="w-5 h-5 text-stone-500" />
            </button>
            <MarketplaceTab />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Layer 4: 底部展开按钮 ── */}
      {!isDetailExpanded && activeTab === 'local' && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-auto">
          <button
            onClick={() => setIsDetailExpanded(true)}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-white/90 backdrop-blur-xl border border-stone-200 rounded-full text-xs font-bold text-stone-500 hover:text-stone-700 hover:bg-white shadow-sm transition-all"
          >
            <ChevronUp className="w-3.5 h-3.5" />
            能力详情
          </button>
        </div>
      )}

      {/* ── Layer 5: 详情面板 (从底部滑入) ── */}
      <AnimatePresence>
        {isDetailExpanded && activeTab === 'local' && (
          <motion.div
            initial={{ opacity: 0, y: '100%' }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="absolute inset-0 z-40 bg-[#fefaf6]/95 backdrop-blur-xl overflow-y-auto"
          >
            <div className="max-w-4xl mx-auto p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-[10px] font-black text-stone-400 uppercase tracking-widest">
                  Agent Abilities
                </h3>
                <button
                  onClick={() => setIsDetailExpanded(false)}
                  className="p-1.5 rounded-lg hover:bg-stone-100 transition-colors"
                >
                  <X className="w-4 h-4 text-stone-500" />
                </button>
              </div>
              <SkillDetailPanel
                snapshot={snapshot}
                skills={storeSkills}
                openClawSkills={openClawSkills}
                isExpanded={true}
                onToggle={() => setIsDetailExpanded(false)}
                statsVersion={statsVersion}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
