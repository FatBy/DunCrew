import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { 
  Monitor, Info, Check, Sparkles, Eye, EyeOff, Type, Wifi, WifiOff, Globe, Languages, Zap, ExternalLink, Copy, Store, LogOut, Loader2
} from 'lucide-react'
import { GlassCard } from '@/components/GlassCard'
import { staggerContainer, staggerItem } from '@/utils/animations'
import { useStore } from '@/store'
import { testConnection, resolveApiFormat } from '@/services/llmService'
import { evoMapService, type EvoMapState } from '@/services/evoMapService'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/zh'
import type { WorldTheme } from '@/rendering/types'

const WORLD_THEME_OPTIONS: Array<{
  id: WorldTheme
  labelKey: TranslationKey
  descKey: TranslationKey
  color: string
}> = [
  { id: 'dashboard', labelKey: 'settings.world_dashboard', descKey: 'settings.world_dashboard_desc', color: 'rgb(232, 168, 56)' },
  { id: 'minimalist', labelKey: 'settings.world_minimalist', descKey: 'settings.world_minimalist_desc', color: 'rgb(168, 162, 158)' },
]

const settingsData: Array<{
  id: string
  labelKey: TranslationKey
  descKey: TranslationKey
  enabled: boolean
}> = [
  { id: 'particles', labelKey: 'settings.particles', descKey: 'settings.particles_desc', enabled: true },
  { id: 'glow', labelKey: 'settings.glow', descKey: 'settings.glow_desc', enabled: true },
]

function ClawHubAccountSection() {
  const isAuthenticated = useStore(s => s.clawHubAuthenticated)
  const user = useStore(s => s.clawHubUser)
  const authLoading = useStore(s => s.clawHubAuthLoading)
  const login = useStore(s => s.clawHubLogin)
  const logout = useStore(s => s.clawHubLogout)
  const validateToken = useStore(s => s.clawHubValidateToken)

  // 启动时验证 token
  useEffect(() => {
    validateToken()
  }, [])

  if (authLoading) {
    return (
      <div className="flex items-center gap-2 text-stone-400 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        验证中...
      </div>
    )
  }

  if (isAuthenticated && user) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {user.avatar && (
              <img src={user.avatar} alt="" className="w-8 h-8 rounded-full" />
            )}
            <div>
              <p className="text-sm text-stone-800 font-medium">{user.username}</p>
              <p className="text-xs text-stone-400">{user.email}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="flex items-center gap-1 px-2 py-0.5 text-xs bg-emerald-500/10 text-emerald-400 rounded-full">
              <Check className="w-3 h-3" />
              已连接
            </span>
          </div>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-400 hover:text-stone-600 border border-stone-200 rounded-lg hover:bg-stone-100/80 transition-colors"
        >
          <LogOut className="w-3 h-3" />
          断开连接
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-stone-400">
        连接 ClawHub 账户以发布和管理你的技能。
      </p>
      <button
        onClick={() => login()}
        disabled={authLoading}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-cyan-500/20 text-cyan-400 rounded-lg hover:bg-cyan-500/30 disabled:opacity-50 transition-colors"
      >
        <Store className="w-4 h-4" />
        连接 ClawHub
      </button>
    </div>
  )
}

export function SettingsHouse() {
  const t = useT()

  // Store 状态
  const connectionStatus = useStore((s) => s.connectionStatus)
  const connectionMode = useStore((s) => s.connectionMode)
  const agentStatus = useStore((s) => s.agentStatus)
  const skills = useStore((s) => s.skills)
  const memories = useStore((s) => s.memories)
  const soulCoreTruths = useStore((s) => s.soulCoreTruths)

  // LLM 配置
  const llmConfig = useStore((s) => s.llmConfig)
  const setLlmConfig = useStore((s) => s.setLlmConfig)
  const setLlmConnected = useStore((s) => s.setLlmConnected)
  const [llmApiKey, setLlmApiKey] = useState(llmConfig.apiKey || '')
  const [llmBaseUrl, setLlmBaseUrl] = useState(llmConfig.baseUrl || '')
  const [llmModel, setLlmModel] = useState(llmConfig.model || '')
  const [llmTestStatus, setLlmTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [showApiKey, setShowApiKey] = useState(false)
  const [llmApiFormat, setLlmApiFormat] = useState<'auto' | 'openai' | 'anthropic'>(llmConfig.apiFormat || 'auto')
  
  // Embedding API 配置（独立于主 LLM）
  const [embedApiKey, setEmbedApiKey] = useState(llmConfig.embedApiKey || '')
  const [embedBaseUrl, setEmbedBaseUrl] = useState(llmConfig.embedBaseUrl || '')
  const [embedModel, setEmbedModel] = useState(llmConfig.embedModel || '')
  const [showEmbedKey, setShowEmbedKey] = useState(false)
  const [showEmbedConfig, setShowEmbedConfig] = useState(!!(llmConfig.embedApiKey || llmConfig.embedBaseUrl))
  
  // UI 设置
  const [fontScale, setFontScale] = useState(() => {
    const saved = localStorage.getItem('ddos_font_scale')
    return saved ? parseFloat(saved) : 1
  })
  
  // 世界主题
  const worldTheme = useStore((s) => s.worldTheme)
  const setWorldTheme = useStore((s) => s.setWorldTheme)

  // 语言设置
  const locale = useStore((s) => s.locale)
  const setLocale = useStore((s) => s.setLocale)
  
  // EvoMap 连接状态
  const [evoMapState, setEvoMapState] = useState<EvoMapState>(evoMapService.getState())
  const [evoMapConnecting, setEvoMapConnecting] = useState(false)
  
  // 订阅 EvoMap 状态变化
  useEffect(() => {
    const unsubscribe = evoMapService.subscribe(setEvoMapState)
    return unsubscribe
  }, [])
  
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(fontScale))
    localStorage.setItem('ddos_font_scale', String(fontScale))
  }, [fontScale])

  // 自动保存 LLM 配置
  useEffect(() => {
    if (llmApiKey || llmBaseUrl || llmModel) {
      setLlmConfig({ apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel, apiFormat: llmApiFormat })
    }
  }, [llmApiKey, llmBaseUrl, llmModel, llmApiFormat])
  
  // 自动保存 Embedding 配置
  useEffect(() => {
    setLlmConfig({ embedApiKey: embedApiKey, embedBaseUrl: embedBaseUrl, embedModel: embedModel })
  }, [embedApiKey, embedBaseUrl, embedModel])
  
  const saveLlmSettings = () => {
    setLlmConfig({ apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel, apiFormat: llmApiFormat })
  }
  
  const saveEmbedSettings = () => {
    setLlmConfig({ embedApiKey, embedBaseUrl, embedModel })
  }

  const handleTestLlm = async () => {
    saveLlmSettings()
    setLlmTestStatus('testing')
    try {
      const ok = await testConnection({ apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel })
      setLlmTestStatus(ok ? 'success' : 'error')
      setLlmConnected(ok)
      setTimeout(() => setLlmTestStatus('idle'), 3000)
    } catch {
      setLlmTestStatus('error')
      setLlmConnected(false)
      setTimeout(() => setLlmTestStatus('idle'), 3000)
    }
  }

  const isConnected = connectionStatus === 'connected'

  return (
    <div className="p-6 h-full overflow-y-auto space-y-6">

      {/* 连接状态概览 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          {isConnected ? (
            <Wifi className="w-4 h-4 text-emerald-400" />
          ) : (
            <WifiOff className="w-4 h-4 text-stone-300" />
          )}
          <h3 className="font-mono text-sm text-stone-400 tracking-wider">
            {t('settings.system_status')}
          </h3>
        </div>

        <GlassCard className="p-4">
          <div className="space-y-2 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-stone-400">{t('settings.connection_mode')}</span>
              <span className={cn(
                isConnected ? 'text-emerald-400' : 'text-stone-300'
              )}>
                {connectionMode === 'native' ? 'Native' : 'DD-OS Cloud'} · {isConnected ? t('settings.connected') : t('settings.disconnected')}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-400">{t('settings.agent_status')}</span>
              <span className={cn(
                agentStatus === 'idle' ? 'text-stone-400' :
                agentStatus === 'thinking' ? 'text-cyan-400' :
                agentStatus === 'executing' ? 'text-amber-400' :
                'text-red-400'
              )}>
                {agentStatus === 'idle' ? t('settings.agent_idle') :
                 agentStatus === 'thinking' ? t('settings.agent_thinking') :
                 agentStatus === 'executing' ? t('settings.agent_executing') :
                 agentStatus}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-stone-400">{t('settings.loaded_data')}</span>
              <span className="text-stone-500">
                Soul {soulCoreTruths.length > 0 ? '✓' : '–'} · 
                Skills {skills.length} · 
                Memories {memories.length}
              </span>
            </div>
          </div>
          {isConnected && (
            <p className="text-[13px] text-stone-300 font-mono mt-3 border-t border-stone-100 pt-2">
              {t('settings.auto_sync_hint')}
            </p>
          )}
        </GlassCard>
      </div>

      {/* AI 能力配置 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Sparkles className="w-4 h-4 text-amber-400" />
          <h3 className="font-mono text-sm text-amber-300 tracking-wider">
            {t('settings.ai_config')}
          </h3>
        </div>
        
        <GlassCard className="p-4 space-y-3">
          <div>
            <label className="text-xs font-mono text-stone-400 mb-1 block">{t('settings.api_base_url')}</label>
            <input
              type="text"
              value={llmBaseUrl}
              onChange={(e) => setLlmBaseUrl(e.target.value)}
              onBlur={saveLlmSettings}
              placeholder="https://api.deepseek.com/v1"
              className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg 
                         text-xs font-mono text-stone-600 placeholder-stone-400
                         focus:border-amber-500/50 focus:outline-none"
            />
          </div>
          
          <div>
            <label className="text-xs font-mono text-stone-400 mb-1 block">{t('settings.api_key')}</label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={llmApiKey}
                  onChange={(e) => setLlmApiKey(e.target.value)}
                  onBlur={saveLlmSettings}
                  placeholder="sk-..."
                  className="w-full px-3 py-2 pr-8 bg-stone-100/80 border border-stone-200 rounded-lg 
                             text-xs font-mono text-stone-600 placeholder-stone-400
                             focus:border-amber-500/50 focus:outline-none"
                />
                <button
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-300 hover:text-stone-500"
                >
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>
          
          <div>
            <label className="text-xs font-mono text-stone-400 mb-1 block">{t('settings.model')}</label>
            <input
              type="text"
              value={llmModel}
              onChange={(e) => setLlmModel(e.target.value)}
              onBlur={saveLlmSettings}
              placeholder="deepseek-chat"
              className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg 
                         text-xs font-mono text-stone-600 placeholder-stone-400
                         focus:border-amber-500/50 focus:outline-none"
            />
          </div>
          
          {/* API 格式选择器 */}
          <div>
            <label className="text-xs font-mono text-stone-400 mb-1.5 block">{t('settings.api_format')}</label>
            <div className="grid grid-cols-3 gap-2">
              {(['auto', 'openai', 'anthropic'] as const).map((fmt) => (
                <button
                  key={fmt}
                  onClick={() => { setLlmApiFormat(fmt); saveLlmSettings() }}
                  className={cn(
                    'px-3 py-1.5 rounded-lg text-[11px] font-mono transition-colors border',
                    llmApiFormat === fmt
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-stone-100/60 border-stone-200 text-stone-400 hover:border-stone-200 hover:text-stone-500'
                  )}
                >
                  {fmt === 'auto' ? t('settings.api_format_auto') : fmt === 'openai' ? 'OpenAI' : 'Anthropic'}
                </button>
              ))}
            </div>
            {llmApiFormat === 'auto' && llmBaseUrl && (
              <p className="text-[11px] text-stone-300 font-mono mt-1.5">
                {t('settings.api_format_detected').replace('{0}', resolveApiFormat({ apiKey: llmApiKey, baseUrl: llmBaseUrl, model: llmModel, apiFormat: 'auto' }).toUpperCase())}
              </p>
            )}
          </div>
          
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={handleTestLlm}
              disabled={llmTestStatus === 'testing' || !llmApiKey || !llmBaseUrl || !llmModel}
              className={cn(
                'px-4 py-2 rounded-lg text-xs font-mono transition-colors',
                llmTestStatus === 'testing'
                  ? 'bg-amber-500/20 border border-amber-500/30 text-amber-400 animate-pulse'
                  : llmTestStatus === 'success'
                  ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
                  : llmTestStatus === 'error'
                  ? 'bg-red-500/20 border border-red-500/30 text-red-400'
                  : !llmApiKey || !llmBaseUrl || !llmModel
                  ? 'bg-stone-100/80 border border-stone-200 text-stone-300 cursor-not-allowed'
                  : 'bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30'
              )}
            >
              {llmTestStatus === 'testing' ? t('settings.testing') : 
               llmTestStatus === 'success' ? t('settings.test_success') : 
               llmTestStatus === 'error' ? t('settings.test_failed') : t('settings.test_connection')}
            </button>
            
            {llmTestStatus === 'success' && (
              <span className="text-[13px] text-emerald-400 font-mono flex items-center gap-1">
                <Check className="w-3 h-3" /> {t('settings.ai_ready')}
              </span>
            )}
          </div>
          
          <p className="text-[13px] text-stone-300 font-mono">
            {t('settings.api_compat_hint')}
          </p>
          
          {/* Embedding API 配置（可折叠） */}
          <div className="border-t border-stone-200 pt-3 mt-3">
            <button
              onClick={() => setShowEmbedConfig(!showEmbedConfig)}
              className="flex items-center gap-2 text-xs font-mono text-stone-400 hover:text-stone-600 transition-colors"
            >
              <span className={`transition-transform ${showEmbedConfig ? 'rotate-90' : ''}`}>▶</span>
              Embedding API（可选，用于语义搜索）
            </button>
            
            {showEmbedConfig && (
              <div className="mt-3 space-y-3 pl-4 border-l border-stone-200">
                <p className="text-[11px] text-stone-300 font-mono">
                  如果主 API 不支持 /embeddings 接口，可在此配置独立的 Embedding API（如 OpenAI）
                </p>
                
                <div>
                  <label className="text-xs font-mono text-stone-400 mb-1 block">Embed API Base URL</label>
                  <input
                    type="text"
                    value={embedBaseUrl}
                    onChange={(e) => setEmbedBaseUrl(e.target.value)}
                    onBlur={saveEmbedSettings}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg 
                               text-xs font-mono text-stone-600 placeholder-stone-400
                               focus:border-cyan-500/50 focus:outline-none"
                  />
                </div>
                
                <div>
                  <label className="text-xs font-mono text-stone-400 mb-1 block">Embed API Key</label>
                  <div className="relative">
                    <input
                      type={showEmbedKey ? 'text' : 'password'}
                      value={embedApiKey}
                      onChange={(e) => setEmbedApiKey(e.target.value)}
                      onBlur={saveEmbedSettings}
                      placeholder="sk-..."
                      className="w-full px-3 py-2 pr-8 bg-stone-100/80 border border-stone-200 rounded-lg 
                                 text-xs font-mono text-stone-600 placeholder-stone-400
                                 focus:border-cyan-500/50 focus:outline-none"
                    />
                    <button
                      onClick={() => setShowEmbedKey(!showEmbedKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-300 hover:text-stone-500"
                    >
                      {showEmbedKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                
                <div>
                  <label className="text-xs font-mono text-stone-400 mb-1 block">Embed Model</label>
                  <input
                    type="text"
                    value={embedModel}
                    onChange={(e) => setEmbedModel(e.target.value)}
                    onBlur={saveEmbedSettings}
                    placeholder="text-embedding-3-small"
                    className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg 
                               text-xs font-mono text-stone-600 placeholder-stone-400
                               focus:border-cyan-500/50 focus:outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </GlassCard>
      </div>

      {/* EvoMap 云端协作 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-4 h-4 text-purple-400" />
          <h3 className="font-mono text-sm text-purple-300 tracking-wider">
            EvoMap 云端协作
          </h3>
        </div>
        
        <GlassCard className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className={cn(
                'w-2 h-2 rounded-full',
                evoMapState.connected ? 'bg-emerald-400 animate-pulse' : 'bg-white/30'
              )} />
              <span className="text-xs font-mono text-stone-500">
                {evoMapState.connected ? '已连接' : '未连接'}
              </span>
            </div>
            
            <button
              onClick={async () => {
                if (evoMapState.connected) {
                  evoMapService.disconnect()
                } else {
                  setEvoMapConnecting(true)
                  try {
                    await evoMapService.hello()
                  } catch (err) {
                    console.error('[EvoMap] Connect failed:', err)
                  } finally {
                    setEvoMapConnecting(false)
                  }
                }
              }}
              disabled={evoMapConnecting}
              className={cn(
                'px-3 py-1.5 rounded-lg text-xs font-mono transition-colors',
                evoMapConnecting
                  ? 'bg-purple-500/20 border border-purple-500/30 text-purple-400 animate-pulse'
                  : evoMapState.connected
                  ? 'bg-red-500/20 border border-red-500/30 text-red-400 hover:bg-red-500/30'
                  : 'bg-purple-500/20 border border-purple-500/30 text-purple-400 hover:bg-purple-500/30'
              )}
            >
              {evoMapConnecting ? '连接中...' : evoMapState.connected ? '断开' : '连接 EvoMap'}
            </button>
          </div>
          
          {evoMapState.connected && (
            <>
              <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                <div className="bg-stone-100/60 rounded-lg p-2">
                  <span className="text-stone-400">积分</span>
                  <div className="text-lg text-purple-400">{evoMapState.credits}</div>
                </div>
                <div className="bg-stone-100/60 rounded-lg p-2">
                  <span className="text-stone-400">声誉</span>
                  <div className="text-lg text-cyan-400">{evoMapState.reputation}</div>
                </div>
              </div>
              
              {evoMapState.nodeId && (
                <div className="text-xs font-mono">
                  <span className="text-stone-400">Node ID: </span>
                  <span className="text-stone-500">{evoMapState.nodeId}</span>
                </div>
              )}
              
              {evoMapState.claimUrl && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-stone-400">认领链接:</span>
                  <a
                    href={evoMapState.claimUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-mono text-purple-400 hover:text-purple-300 flex items-center gap-1"
                  >
                    {evoMapState.claimCode} <ExternalLink className="w-3 h-3" />
                  </a>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(evoMapState.claimUrl || '')
                    }}
                    className="text-stone-300 hover:text-stone-500"
                    title="复制链接"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                </div>
              )}
              
              {evoMapState.survivalStatus && (
                <div className="text-xs font-mono">
                  <span className="text-stone-400">状态: </span>
                  <span className={cn(
                    evoMapState.survivalStatus === 'alive' ? 'text-emerald-400' :
                    evoMapState.survivalStatus === 'dormant' ? 'text-amber-400' : 'text-red-400'
                  )}>
                    {evoMapState.survivalStatus === 'alive' ? '活跃' :
                     evoMapState.survivalStatus === 'dormant' ? '休眠' : '失效'}
                  </span>
                </div>
              )}
              
              {evoMapState.error && (
                <div className="text-xs font-mono text-red-400 bg-red-500/10 rounded-lg p-2">
                  {evoMapState.error}
                </div>
              )}
            </>
          )}
          
          <p className="text-[11px] text-stone-300 font-mono">
            连接 EvoMap 协作市场，共享 AI 经验并赚取积分。
            <a href="https://evomap.ai" target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:underline ml-1">
              了解更多
            </a>
          </p>
        </GlassCard>
      </div>

      {/* 视觉设置 */}
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
      >
        <div className="flex items-center gap-2 mb-4">
          <Monitor className="w-4 h-4 text-stone-400" />
          <h3 className="font-mono text-sm text-stone-400 tracking-wider">
            {t('settings.visual')}
          </h3>
        </div>

        <div className="space-y-3">
          {settingsData.map((setting) => (
            <motion.div key={setting.id} variants={staggerItem}>
              <GlassCard className="p-4 flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-mono text-stone-700">
                    {t(setting.labelKey)}
                  </h4>
                  <p className="text-xs text-stone-400 mt-0.5">
                    {t(setting.descKey)}
                  </p>
                </div>
                <div className="w-10 h-5 bg-stone-100 rounded-full relative cursor-pointer border border-stone-200">
                  <div
                    className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
                      setting.enabled
                        ? 'left-5 bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]'
                        : 'left-0.5 bg-white/30'
                    }`}
                  />
                </div>
              </GlassCard>
            </motion.div>
          ))}
          
          {/* 字体缩放 */}
          <motion.div variants={staggerItem}>
            <GlassCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Type className="w-4 h-4 text-cyan-400" />
                <h4 className="text-sm font-mono text-stone-700">{t('settings.font_size')}</h4>
                <span className="ml-auto text-xs font-mono text-cyan-400">
                  {Math.round(fontScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min="0.8"
                max="1.5"
                step="0.1"
                value={fontScale}
                onChange={(e) => setFontScale(parseFloat(e.target.value))}
                className="w-full h-2 bg-stone-100 rounded-lg appearance-none cursor-pointer
                           [&::-webkit-slider-thumb]:appearance-none
                           [&::-webkit-slider-thumb]:w-4
                           [&::-webkit-slider-thumb]:h-4
                           [&::-webkit-slider-thumb]:rounded-full
                           [&::-webkit-slider-thumb]:bg-cyan-400
                           [&::-webkit-slider-thumb]:shadow-[0_0_6px_rgba(34,211,238,0.5)]
                           [&::-webkit-slider-thumb]:cursor-pointer"
              />
              <div className="flex justify-between text-[13px] font-mono text-stone-300 mt-1">
                <span>80%</span>
                <span>100%</span>
                <span>150%</span>
              </div>
            </GlassCard>
          </motion.div>

          {/* 世界主题 */}
          <motion.div variants={staggerItem}>
            <GlassCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Globe className="w-4 h-4 text-skin-accent-cyan" />
                <h4 className="text-sm font-mono text-skin-text-secondary">{t('settings.world_theme')}</h4>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {WORLD_THEME_OPTIONS.map((option) => {
                  const isActive = worldTheme === option.id
                  return (
                    <button
                      key={option.id}
                      onClick={() => setWorldTheme(option.id)}
                      className={cn(
                        'relative p-3 rounded-lg border transition-all',
                        isActive
                          ? 'border-skin-accent-cyan bg-skin-accent-cyan/10'
                          : 'border-stone-200 hover:border-skin-border/40 bg-skin-bg-secondary/20'
                      )}
                    >
                      <div 
                        className="w-4 h-4 rounded-full mx-auto mb-2"
                        style={{ backgroundColor: option.color }}
                      />
                      <span className={cn(
                        'text-[13px] font-mono block text-center',
                        isActive ? 'text-skin-accent-cyan' : 'text-skin-text-tertiary'
                      )}>
                        {t(option.labelKey)}
                      </span>
                      <span className="text-[11px] font-mono block text-center text-skin-text-tertiary mt-0.5">
                        {t(option.descKey)}
                      </span>
                      {isActive && (
                        <div className="absolute top-1 right-1">
                          <Check className="w-3 h-3 text-skin-accent-cyan" />
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
              <p className="text-[13px] text-skin-text-tertiary font-mono mt-3">
                {t('settings.world_theme_hint')}
              </p>
            </GlassCard>
          </motion.div>

          {/* 语言切换 */}
          <motion.div variants={staggerItem}>
            <GlassCard className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Languages className="w-4 h-4 text-skin-accent-cyan" />
                <h4 className="text-sm font-mono text-skin-text-secondary">{t('settings.language')}</h4>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setLocale('zh')}
                  className={cn(
                    'relative p-3 rounded-lg border transition-all',
                    locale === 'zh'
                      ? 'border-skin-accent-cyan bg-skin-accent-cyan/10'
                      : 'border-stone-200 hover:border-skin-border/40 bg-skin-bg-secondary/20'
                  )}
                >
                  <span className={cn(
                    'text-[13px] font-mono block text-center',
                    locale === 'zh' ? 'text-skin-accent-cyan' : 'text-skin-text-tertiary'
                  )}>
                    中文
                  </span>
                  {locale === 'zh' && (
                    <div className="absolute top-1 right-1">
                      <Check className="w-3 h-3 text-skin-accent-cyan" />
                    </div>
                  )}
                </button>
                <button
                  onClick={() => setLocale('en')}
                  className={cn(
                    'relative p-3 rounded-lg border transition-all',
                    locale === 'en'
                      ? 'border-skin-accent-cyan bg-skin-accent-cyan/10'
                      : 'border-stone-200 hover:border-skin-border/40 bg-skin-bg-secondary/20'
                  )}
                >
                  <span className={cn(
                    'text-[13px] font-mono block text-center',
                    locale === 'en' ? 'text-skin-accent-cyan' : 'text-skin-text-tertiary'
                  )}>
                    English
                  </span>
                  {locale === 'en' && (
                    <div className="absolute top-1 right-1">
                      <Check className="w-3 h-3 text-skin-accent-cyan" />
                    </div>
                  )}
                </button>
              </div>
              <p className="text-[13px] text-skin-text-tertiary font-mono mt-3">
                {t('settings.language_hint')}
              </p>
            </GlassCard>
          </motion.div>
        </div>
      </motion.div>

      {/* 关于 */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Info className="w-4 h-4 text-stone-400" />
          <h3 className="font-mono text-sm text-stone-400 tracking-wider">
            {t('settings.about')}
          </h3>
        </div>
        <GlassCard className="p-4">
          <div className="space-y-2 font-mono text-xs text-stone-400">
            <div className="flex justify-between">
              <span>{t('settings.version')}</span>
              <span className="text-stone-600">DD-OS v1.0.0</span>
            </div>
            <div className="flex justify-between">
              <span>{t('settings.run_mode')}</span>
              <span className="text-cyan-400">
                {connectionMode === 'native' ? t('settings.native_local') : t('settings.openclaw_network')}
              </span>
            </div>
          </div>
        </GlassCard>
      </div>

      {/* ClawHub 账户 */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Store className="w-4 h-4 text-cyan-400" />
          <h3 className="font-mono text-sm text-cyan-300 tracking-wider">
            ClawHub 账户
          </h3>
        </div>
        <GlassCard className="p-4">
          <ClawHubAccountSection />
        </GlassCard>
      </div>
    </div>
  )
}
