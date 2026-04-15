import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Server, Loader2, CheckCircle2, AlertCircle, Search, Download, Globe, HardDrive, Check, Key } from 'lucide-react'
import { cn } from '@/utils/cn'
import { searchMCPServers, type MatchResult, type MCPServerCandidate } from '@/services/smartMatchService'
import { searchOnlineMCP, getAllOnlineMCP, type RegistryMCPResult } from '@/services/onlineSearchService'
import { installMCP } from '@/services/installService'
import { MatchResultCard } from './MatchResultCard'
import { getServerUrl } from '@/utils/env'
import { useT } from '@/i18n'

type TabType = 'local' | 'online'

interface MCPServer {
  name: string
  connected: boolean
  tools: number
}

interface AddMCPModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: (serverName: string) => void
}

export function AddMCPModal({ isOpen, onClose, onConfirm }: AddMCPModalProps) {
  const t = useT()
  const [activeTab, setActiveTab] = useState<TabType>('local')
  const [input, setInput] = useState('')
  const [servers, setServers] = useState<MCPServer[]>([])
  const [loading, setLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<MatchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // 在线搜索状态
  const [onlineResults, setOnlineResults] = useState<RegistryMCPResult[]>([])
  const [isOnlineSearching, setIsOnlineSearching] = useState(false)
  const [hasOnlineSearched, setHasOnlineSearched] = useState(false)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installStatus, setInstallStatus] = useState<{ id: string; success: boolean; message: string } | null>(null)
  
  // 环境变量输入
  const [envInputs, setEnvInputs] = useState<Record<string, Record<string, string>>>({})
  const [showEnvInput, setShowEnvInput] = useState<string | null>(null)

  // 完整的服务器+工具信息（用于智能搜索）
  const serversWithToolsRef = useRef<MCPServerCandidate[]>([])

  // 加载已配置的 MCP 服务器列表
  useEffect(() => {
    if (!isOpen) return
    setInput('')
    setSearchResults([])
    setHasSearched(false)
    setActiveTab('local')
    setOnlineResults([])
    setHasOnlineSearched(false)
    setInstallStatus(null)
    setShowEnvInput(null)
    setLoading(true)
    const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
    fetch(`${serverUrl}/mcp/servers`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.servers) {
          const list: MCPServer[] = Object.entries(data.servers).map(([name, info]: [string, any]) => ({
            name,
            connected: info.connected ?? false,
            tools: info.tools ?? 0,
          }))
          setServers(list)

          // 构建带工具信息的候选列表
          const toolsList = Array.isArray(data.tools) ? data.tools : []
          serversWithToolsRef.current = Object.entries(data.servers).map(([name]) => ({
            name,
            tools: toolsList
              .filter((t: any) => t.server === name)
              .map((t: any) => ({ name: t.name, description: t.description || '' })),
          }))
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [isOpen])

  // 切换标签页时加载在线推荐
  useEffect(() => {
    if (activeTab === 'online' && !hasOnlineSearched && onlineResults.length === 0) {
      loadOnlineRecommendations()
    }
  }, [activeTab])

  const loadOnlineRecommendations = async () => {
    setIsOnlineSearching(true)
    try {
      const results = await getAllOnlineMCP()
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
      const results = await searchMCPServers(q, serversWithToolsRef.current)
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
      const results = await searchOnlineMCP(q)
      setOnlineResults(results)
    } catch {
      setOnlineResults([])
    } finally {
      setIsOnlineSearching(false)
    }
  }, [input])

  const handleInstall = async (mcp: RegistryMCPResult) => {
    // 如果需要环境变量，先显示输入框
    if (mcp.envRequired && mcp.envRequired.length > 0 && showEnvInput !== mcp.id) {
      setShowEnvInput(mcp.id)
      // 初始化环境变量输入
      if (!envInputs[mcp.id]) {
        const initial: Record<string, string> = {}
        mcp.envRequired.forEach(key => { initial[key] = '' })
        setEnvInputs(prev => ({ ...prev, [mcp.id]: initial }))
      }
      return
    }

    setInstallingId(mcp.id)
    setInstallStatus(null)
    try {
      const envValues = envInputs[mcp.id] || {}
      const result = await installMCP(mcp, envValues)
      setInstallStatus({ id: mcp.id, success: result.success, message: result.message })
      if (result.success) {
        setTimeout(() => {
          onConfirm(mcp.name)
          resetAndClose()
        }, 1000)
      }
    } catch {
      setInstallStatus({ id: mcp.id, success: false, message: '安装失败' })
    } finally {
      setInstallingId(null)
    }
  }

  const handleSelectResult = (name: string) => {
    onConfirm(name)
    resetAndClose()
  }

  const handleSelectServer = (name: string) => {
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
    setShowEnvInput(null)
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
              <div className="w-8 h-8 rounded-lg bg-purple-500/20 flex items-center justify-center">
                <Server className="w-4 h-4 text-purple-400" />
              </div>
              <h2 className="text-sm font-mono font-semibold text-stone-800">
                {t('mcp.title')}
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
                  ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                  : 'bg-stone-100/80 text-stone-400 border border-stone-200 hover:bg-stone-100'
              )}
            >
              <HardDrive className="w-3.5 h-3.5" />
              已配置
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
              {t('mcp.tab_online')}
            </button>
          </div>

          {/* Content - scrollable */}
          <div className="px-6 py-5 space-y-5 overflow-y-auto flex-1">
            {/* 概念说明 */}
            <div className="p-3 rounded-lg bg-purple-500/5 border border-purple-500/10">
              <p className="text-xs text-stone-500 leading-relaxed">
                <span className="text-purple-400 font-semibold">MCP</span> (Model Context Protocol) 
                是一种让 AI 连接外部工具和数据源的标准协议。
                {activeTab === 'online' && ' 在线搜索无需 AI 调用，响应速度极快。'}
              </p>
            </div>

            {/* ===== 本地标签页 ===== */}
            {activeTab === 'local' && (
              <>
                {/* 搜索输入框 */}
                <div>
                  <label className="block text-xs font-mono text-stone-400 mb-2">
                    {t('mcp.search_label')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      placeholder="如：文件管理、搜索网页、数据库查询"
                      className="flex-1 px-4 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                               text-sm font-mono text-stone-700 placeholder-stone-300
                               focus:border-purple-500/40 focus:outline-none transition-colors"
                    />
                    <button
                      onClick={handleSearch}
                      disabled={!input.trim() || isSearching}
                      className="px-3 py-2.5 bg-purple-500/20 border border-purple-500/30 rounded-lg
                               text-purple-300 hover:bg-purple-500/30 transition-colors
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
                    <Loader2 className="w-4 h-4 animate-spin text-purple-400/60" />
                    <span className="text-xs font-mono">{t('mcp.matching')}</span>
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
                        accentColor="purple"
                        onClick={() => handleSelectResult(result.name)}
                        index={i}
                      />
                    ))}
                  </div>
                )}

                {!isSearching && hasSearched && searchResults.length === 0 && (
                  <div className="text-center py-3">
                    <p className="text-xs font-mono text-stone-300">
                      {t('mcp.no_match')}
                    </p>
                  </div>
                )}

                {/* 已配置的服务器 */}
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-3 text-stone-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="text-xs font-mono">加载已配置服务器...</span>
                  </div>
                ) : servers.length > 0 && (
                  <div>
                    <p className="text-[11px] font-mono text-stone-300 mb-2">
                      {hasSearched ? t('mcp.all_servers') : t('mcp.servers_hint')}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {servers.map((s) => (
                        <button
                          key={s.name}
                          onClick={() => handleSelectServer(s.name)}
                          className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono border transition-all',
                            s.connected
                              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300 hover:bg-emerald-500/20'
                              : 'bg-stone-100/80 border-stone-200 text-stone-400 hover:bg-stone-100 hover:text-stone-600'
                          )}
                        >
                          {s.connected
                            ? <CheckCircle2 className="w-3 h-3" />
                            : <AlertCircle className="w-3 h-3 text-stone-300" />
                          }
                          {s.name}
                          {s.tools > 0 && (
                            <span className="text-[10px] text-stone-300">{s.tools} tools</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* 帮助提示 */}
                <p className="text-[10px] text-stone-300 leading-relaxed">
                  服务器需要在 <code className="text-purple-300/60">mcp-servers.json</code> 中预先配置。
                  配置格式包含 command、args 和可选的 env 字段。
                </p>
              </>
            )}

            {/* ===== 在线标签页 ===== */}
            {activeTab === 'online' && (
              <>
                {/* 在线搜索输入框 */}
                <div>
                  <label className="block text-xs font-mono text-stone-400 mb-2">
                    {t('mcp.online_search_label')}
                  </label>
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      type="text"
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleOnlineSearch()}
                      placeholder="如：GitHub、文件系统、数据库"
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
                    <span className="text-xs font-mono">{t('mcp.searching')}</span>
                  </div>
                )}

                {!isOnlineSearching && onlineResults.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-mono text-stone-300">
                      {hasOnlineSearched ? '搜索结果' : '推荐 MCP 服务'} (点击安装)
                    </p>
                    {onlineResults.map((mcp) => (
                      <div
                        key={mcp.id}
                        className="p-3 rounded-lg bg-stone-100/80 border border-stone-200 hover:border-cyan-500/30 transition-all"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-mono text-cyan-300">{mcp.name}</span>
                              {mcp.category && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-400">
                                  {mcp.category}
                                </span>
                              )}
                              {mcp.source && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300">
                                  {mcp.source}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-stone-400 mt-1 line-clamp-2">{mcp.description}</p>
                            {mcp.envRequired && mcp.envRequired.length > 0 && (
                              <div className="flex items-center gap-1 mt-1.5 text-[10px] text-amber-300/70">
                                <Key className="w-3 h-3" />
                                {t('mcp.env_needs')} {mcp.envRequired.join(', ')}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => handleInstall(mcp)}
                            disabled={installingId === mcp.id}
                            className={cn(
                              'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono transition-all flex-shrink-0',
                              installStatus?.id === mcp.id && installStatus.success
                                ? 'bg-green-500/20 text-green-300 border border-green-500/30'
                                : installStatus?.id === mcp.id && !installStatus.success
                                ? 'bg-red-500/20 text-red-300 border border-red-500/30'
                                : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 hover:bg-cyan-500/30'
                            )}
                          >
                            {installingId === mcp.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : installStatus?.id === mcp.id && installStatus.success ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : installStatus?.id === mcp.id && !installStatus.success ? (
                              <AlertCircle className="w-3.5 h-3.5" />
                            ) : showEnvInput === mcp.id ? (
                              <Check className="w-3.5 h-3.5" />
                            ) : (
                              <Download className="w-3.5 h-3.5" />
                            )}
                            {installingId === mcp.id
                              ? t('mcp.installing')
                              : installStatus?.id === mcp.id
                              ? (installStatus.success ? t('mcp.installed') : t('mcp.install_fail'))
                              : showEnvInput === mcp.id
                              ? t('mcp.confirm_install')
                              : t('mcp.install')}
                          </button>
                        </div>
                        
                        {/* 环境变量输入 */}
                        {showEnvInput === mcp.id && mcp.envRequired && (
                          <div className="mt-3 pt-3 border-t border-stone-200 space-y-2">
                            <p className="text-[10px] text-stone-400">{t('mcp.env_required')}</p>
                            {mcp.envRequired.map((envKey) => (
                              <div key={envKey} className="flex items-center gap-2">
                                <label className="text-[10px] text-stone-400 w-28 font-mono">{envKey}</label>
                                <input
                                  type="password"
                                  value={envInputs[mcp.id]?.[envKey] || ''}
                                  onChange={(e) => setEnvInputs(prev => ({
                                    ...prev,
                                    [mcp.id]: { ...prev[mcp.id], [envKey]: e.target.value }
                                  }))}
                                  placeholder={`输入 ${envKey}`}
                                  className="flex-1 px-2 py-1 bg-stone-100/80 border border-stone-200 rounded
                                           text-xs font-mono text-stone-600 placeholder-white/20
                                           focus:border-cyan-500/40 focus:outline-none"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {!isOnlineSearching && hasOnlineSearched && onlineResults.length === 0 && (
                  <div className="text-center py-6">
                    <p className="text-xs font-mono text-stone-300">{t('mcp.no_online_match')}</p>
                    <p className="text-[10px] text-stone-300 mt-1">{t('mcp.try_different')}</p>
                  </div>
                )}

                {/* 帮助提示 */}
                <p className="text-[10px] text-stone-300 leading-relaxed">
                  在线搜索使用关键词匹配（TF-IDF），无需 AI 调用，响应速度极快。
                  安装后的 MCP 服务会自动添加到配置文件中。
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
              {t('common.cancel')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
