import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Puzzle, Search, Loader2, Download, Globe, HardDrive, Check, AlertCircle } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { searchSkills, type MatchResult } from '@/services/smartMatchService'
import { searchOnlineSkills, getAllOnlineSkills, type RegistrySkillResult } from '@/services/onlineSearchService'
import { installSkill } from '@/services/installService'
import { MatchResultCard } from './MatchResultCard'

type TabType = 'local' | 'online'

interface AddSkillModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (skillName: string) => void
}

export function AddSkillModal({ isOpen, onClose, onConfirm }: AddSkillModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>('local')
  const [input, setInput] = useState('')
  const [searchResults, setSearchResults] = useState<MatchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  
  // 在线搜索状态
  const [onlineResults, setOnlineResults] = useState<RegistrySkillResult[]>([])
  const [isOnlineSearching, setIsOnlineSearching] = useState(false)
  const [hasOnlineSearched, setHasOnlineSearched] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installStatus, setInstallStatus] = useState<{ id: string; success: boolean; message: string } | null>(null)
  
  const openClawSkills = useStore((s) => s.openClawSkills)
  const activeSkills = openClawSkills.filter(s => s.status === 'active')

  // 切换标签页时加载在线推荐
  useEffect(() => {
    if (activeTab === 'online' && !hasOnlineSearched && onlineResults.length === 0) {
      loadOnlineRecommendations()
    }
  }, [activeTab])

  const loadOnlineRecommendations = async () => {
    setIsOnlineSearching(true)
    try {
      const results = await getAllOnlineSkills()
      setOnlineResults(results.slice(0, 12))
    } catch {
      setOnlineResults([])
    } finally {
      setIsOnlineSearching(false)
    }
  }

  const handleSearch = async () => {
    const q = input.trim()
    if (!q) return
    setIsSearching(true)
    setHasSearched(true)
    try {
      const candidates = activeSkills.map(s => ({
        name: s.name,
        description: s.description,
        keywords: s.keywords,
      }))
      const results = await searchSkills(q, candidates)
      setSearchResults(results)
    } catch {
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }

  const handleOnlineSearch = useCallback(async () => {
    const q = input.trim()
    if (!q) return
    setIsOnlineSearching(true)
    setHasOnlineSearched(true)
    try {
      const results = await searchOnlineSkills(q)
      setOnlineResults(results)
    } catch {
      setOnlineResults([])
    } finally {
      setIsOnlineSearching(false)
    }
  }, [input])

  const handleInstall = async (skill: RegistrySkillResult) => {
    setInstallingId(skill.id)
    setInstallStatus(null)
    try {
      const result = await installSkill(skill)
      setInstallStatus({ id: skill.id, success: result.success, message: result.message })
      if (result.success) {
        // 安装成功后自动选择
        setTimeout(() => {
          onConfirm(skill.name)
          resetAndClose()
        }, 1000)
      }
    } catch (error) {
      setInstallStatus({ id: skill.id, success: false, message: '安装失败' })
    } finally {
      setInstallingId(null)
    }
  }

  const handleSelectResult = (name: string) => {
    onConfirm(name)
    resetAndClose()
  }

  const handleSelectSkill = (name: string) => {
    onConfirm(name)
    resetAndClose()
  }

  const resetAndClose = () => {
    setInput('')
    setSearchResults([])
    setHasSearched(false)
    setOnlineResults([])
    setHasOnlineSearched(false)
    setInstallStatus(null)
    setActiveTab('local')
    onClose()
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[200] flex items-center justify-center p-4"
        onClick={resetAndClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md bg-white/95 backdrop-blur-3xl backdrop-blur-xl border border-stone-200 
                     rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.5)] overflow-hidden max-h-[85vh] flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200 flex-shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center">
                <Puzzle className="w-4 h-4 text-amber-400" />
              </div>
              <h2 className="text-sm font-mono font-semibold text-stone-800">
                添加 SKILL
              </h2>
            </div>
            <button onClick={resetAndClose} className="p-1 text-stone-300 hover:text-stone-500 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tab Switcher */}
          <div className="flex px-6 pt-4 gap-2 flex-shrink-0">
            <button
              onClick={() => setActiveTab('local')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all',
                activeTab === 'local'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-stone-100/80 text-stone-400 border border-stone-200 hover:bg-stone-100'
              )}
            >
              <HardDrive className="w-3.5 h-3.5" />
              已安装
            </button>
            <button
              onClick={() => setActiveTab('online')}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all',
                activeTab === 'online'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                  : 'bg-stone-100/80 text-stone-400 border border-stone-200 hover:bg-stone-100'
              )}
            >
              <Globe className="w-3.5 h-3.5" />
              在线搜索
            </button>
          </div>

          {/* Content - scrollable */}
          <div className="px-6 py-5 space-y-5 overflow-y-auto flex-1">
            {/* 概念说明 */}
            <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
              <p className="text-xs text-stone-500 leading-relaxed">
                <span className="text-amber-400 font-semibold">SKILL</span> 是 DD-OS 
                的能力模块，每个 SKILL 定义了一套专业工作流程。
                {activeTab === 'online' && ' 在线搜索无需 AI 调用，响应速度极快。'}
              </p>
            </div>

            {/* ===== 本地标签页 ===== */}
            {activeTab === 'local' && (
              <>
                {/* 搜索输入框 */}
                <div>
                  <label className="block text-xs font-mono text-stone-400 mb-2">
                    描述你想要的功能
                  </label>
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="如：操作Word文档、深度调研、代码审查"
                      className="flex-1 px-4 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                               text-sm font-mono text-stone-700 placeholder-stone-300
                               focus:border-amber-500/40 focus:outline-none transition-colors"
                    />
                    <button
                      onClick={handleSearch}
                      disabled={!input.trim() || isSearching}
                      className="px-3 py-2.5 bg-amber-500/20 border border-amber-500/30 rounded-lg
                               text-amber-300 hover:bg-amber-500/30 transition-colors
                               disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      {isSearching
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Search className="w-4 h-4" />
                      }
                    </button>
                  </div>
                </div>

                {/* 搜索结果 */}
                {isSearching && (
                  <div className="flex items-center justify-center gap-2 py-4 text-stone-300">
                    <Loader2 className="w-4 h-4 animate-spin text-amber-400/60" />
                    <span className="text-xs font-mono">AI 正在匹配...</span>
                  </div>
                )}

                {!isSearching && hasSearched && searchResults.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-mono text-stone-300">
                      推荐结果 (点击选择)
                    </p>
                    {searchResults.map((result, i) => (
                      <MatchResultCard
                        key={result.name}
                        result={result}
                        accentColor="amber"
                        onClick={() => handleSelectResult(result.name)}
                        index={i}
                      />
                    ))}
                  </div>
                )}

                {!isSearching && hasSearched && searchResults.length === 0 && (
                  <div className="text-center py-3">
                    <p className="text-xs font-mono text-stone-300">
                      未找到匹配技能，可从下方列表选择
                    </p>
                  </div>
                )}

                {/* 已加载的技能列表 */}
                {activeSkills.length > 0 && (
                  <div>
                    <p className="text-[11px] font-mono text-stone-300 mb-2">
                      {hasSearched ? '全部已加载 SKILL' : '已加载的 SKILL (点击选择)'}
                    </p>
                    <div className="flex flex-wrap gap-2 max-h-[160px] overflow-y-auto">
                      {activeSkills.slice(0, 20).map((skill) => (
                        <button
                          key={skill.name}
                          onClick={() => handleSelectSkill(skill.name)}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono border transition-all',
                            'bg-amber-500/10 border-amber-500/15 text-amber-300 hover:bg-amber-500/20'
                          )}
                          title={skill.description || skill.name}
                        >
                          <Puzzle className="w-3 h-3" />
                          <span className="max-w-[120px] truncate">{skill.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 帮助提示 */}
                <p className="text-[10px] text-stone-300 leading-relaxed">
                  SKILL 通过 <code className="text-amber-300/60">skills/*/SKILL.md</code> 文件定义。
                  可以在「技能屋」中浏览和管理已安装的 SKILL。
                </p>
              </>
            )}

            {/* ===== 在线标签页 ===== */}
            {activeTab === 'online' && (
              <>
                {/* 在线搜索输入框 */}
                <div>
                  <label className="block text-xs font-mono text-stone-400 mb-2">
                    搜索在线 SKILL
                  </label>
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleOnlineSearch()}
                      placeholder="如：代码审查、文档生成、调研"
                      className="flex-1 px-4 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                               text-sm font-mono text-stone-700 placeholder-stone-300
                               focus:border-cyan-500/40 focus:outline-none transition-colors"
                    />
                    <button
                      onClick={handleOnlineSearch}
                      disabled={!input.trim() || isOnlineSearching}
                      className="px-3 py-2.5 bg-cyan-500/20 border border-cyan-500/30 rounded-lg
                               text-cyan-300 hover:bg-cyan-500/30 transition-colors
                               disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      {isOnlineSearching
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : <Search className="w-4 h-4" />
                      }
                    </button>
                  </div>
                </div>

                {/* 在线搜索结果 */}
                {isOnlineSearching && (
                  <div className="flex items-center justify-center gap-2 py-4 text-stone-300">
                    <Loader2 className="w-4 h-4 animate-spin text-cyan-400/60" />
                    <span className="text-xs font-mono">搜索中...</span>
                  </div>
                )}

                {!isOnlineSearching && onlineResults.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-mono text-stone-300">
                      {hasOnlineSearched ? '搜索结果' : '推荐 SKILL'} (点击安装)
                    </p>
                    {onlineResults.map((skill) => (
                      <div
                        key={skill.id}
                        className="p-3 rounded-lg bg-stone-100/80 border border-stone-200 hover:border-cyan-500/30 transition-all"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-mono text-cyan-300">{skill.name}</span>
                              {skill.category && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-400">
                                  {skill.category}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-stone-400 mt-1 line-clamp-2">{skill.description}</p>
                            {skill.author && (
                              <p className="text-[10px] text-stone-300 mt-1">by {skill.author}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleInstall(skill)}
                            disabled={installingId === skill.id}
                            className={cn(
                              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex-shrink-0',
                              installStatus?.id === skill.id && installStatus.success
                                ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                                : installStatus?.id === skill.id && !installStatus.success
                                ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                                : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30'
                            )}
                          >
                            {installingId === skill.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : installStatus?.id === skill.id && installStatus.success ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : installStatus?.id === skill.id && !installStatus.success ? (
                              <AlertCircle className="w-3.5 h-3.5" />
                            ) : (
                              <Download className="w-3.5 h-3.5" />
                            )}
                            {installingId === skill.id
                              ? '安装中'
                              : installStatus?.id === skill.id
                              ? (installStatus.success ? '已安装' : '失败')
                              : '安装'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {!isOnlineSearching && hasOnlineSearched && onlineResults.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-xs font-mono text-stone-300">未找到匹配的在线 SKILL</p>
                    <p className="text-[10px] text-stone-300 mt-1">尝试换个关键词搜索</p>
                  </div>
                )}

                {/* 帮助提示 */}
                <p className="text-[10px] text-stone-300 leading-relaxed">
                  在线搜索使用关键词匹配（TF-IDF），无需 AI 调用，响应速度极快。
                  安装后的 SKILL 会自动加载到「已安装」列表中。
                </p>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-stone-200 bg-stone-100/60 flex-shrink-0">
            <button
              onClick={resetAndClose}
              className="px-4 py-2 text-xs font-mono text-stone-400 hover:text-stone-600 transition-colors"
            >
              取消
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
