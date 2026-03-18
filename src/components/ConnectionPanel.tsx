import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Wifi, WifiOff, RefreshCw, AlertCircle, ChevronUp, ChevronDown,
  Power, PowerOff, Activity, Clock, Key, Eye, EyeOff, Globe,
  Monitor, Cloud
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { openClawService } from '@/services/OpenClawService'
import { localClawService } from '@/services/LocalClawService'
import { useT } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/zh'

// 存储 keys
const TOKEN_STORAGE_KEY = 'openclaw_auth_token'
const GATEWAY_STORAGE_KEY = 'openclaw_gateway_url'
const MODE_STORAGE_KEY = 'duncrew_connection_mode'

type ConnectionMode = 'native' | 'openclaw'

const statusConfig: Record<string, {
  color: string
  textColor: string
  icon: typeof Wifi
  labelKey: TranslationKey
  pulse: boolean
}> = {
  disconnected: {
    color: 'bg-stone-400',
    textColor: 'text-stone-400',
    icon: WifiOff,
    labelKey: 'conn.disconnected',
    pulse: false,
  },
  connecting: {
    color: 'bg-cyan-400',
    textColor: 'text-cyan-400',
    icon: Wifi,
    labelKey: 'conn.connecting',
    pulse: true,
  },
  connected: {
    color: 'bg-emerald-400',
    textColor: 'text-emerald-400',
    icon: Wifi,
    labelKey: 'conn.connected',
    pulse: true,
  },
  reconnecting: {
    color: 'bg-amber-400',
    textColor: 'text-amber-400',
    icon: RefreshCw,
    labelKey: 'conn.reconnecting',
    pulse: true,
  },
  error: {
    color: 'bg-red-400',
    textColor: 'text-red-400',
    icon: AlertCircle,
    labelKey: 'conn.error',
    pulse: false,
  },
}

export function ConnectionPanel() {
  const t = useT()
  const [isExpanded, setIsExpanded] = useState(false)
  const [token, setToken] = useState('')
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [mode, setMode] = useState<ConnectionMode>('native')
  
  const status = useStore((s) => s.connectionStatus)
  const reconnectAttempt = useStore((s) => s.reconnectAttempt)
  const reconnectCountdown = useStore((s) => s.reconnectCountdown)
  const connectionError = useStore((s) => s.connectionError)
  const agentStatus = useStore((s) => s.agentStatus)
  const logs = useStore((s) => s.logs)

  // 从 localStorage 加载配置
  useEffect(() => {
    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY)
    const savedGateway = localStorage.getItem(GATEWAY_STORAGE_KEY)
    const savedMode = localStorage.getItem(MODE_STORAGE_KEY) as ConnectionMode
    if (savedToken) setToken(savedToken)
    if (savedGateway) setGatewayUrl(savedGateway)
    if (savedMode) setMode(savedMode)
  }, [])

  const config = statusConfig[status]
  const Icon = config.icon

  const handleConnect = async () => {
    localStorage.setItem(MODE_STORAGE_KEY, mode)
    useStore.getState().setConnectionMode(mode)
    
    if (mode === 'native') {
      // 切到 Native 时，主动断开 OpenClaw（防止后台重连覆盖模式）
      openClawService.disconnect()
      useStore.getState().setConnectionStatus('connecting')
      const success = await localClawService.connect()
      if (!success) {
        useStore.getState().setConnectionStatus('error')
      }
    } else {
      if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token)
      if (gatewayUrl) localStorage.setItem(GATEWAY_STORAGE_KEY, gatewayUrl)
      openClawService.setGatewayUrl(gatewayUrl)
      openClawService.setAuthToken(token)
      openClawService.connect().catch(console.error)
    }
  }

  const handleDisconnect = () => {
    if (mode === 'native') {
      localClawService.disconnect()
    } else {
      openClawService.disconnect()
    }
  }

  const handleRetry = () => {
    if (mode === 'native') {
      localClawService.connect()
    } else {
      openClawService.setGatewayUrl(gatewayUrl)
      openClawService.setAuthToken(token)
      openClawService.retry()
    }
  }

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting' || status === 'reconnecting'

  // 最近5条日志
  const recentLogs = logs.slice(-5).reverse()

  return (
    <div className="absolute bottom-6 left-6 z-40">
      {/* 主状态栏 - 可点击展开 */}
      <motion.div
        className={cn(
          'flex items-center gap-2 px-3 py-2 bg-white/90 backdrop-blur-xl backdrop-blur-xl rounded-xl border border-stone-200 cursor-pointer hover:bg-white/95 backdrop-blur-3xl transition-colors',
          isExpanded && 'rounded-b-none border-b-0'
        )}
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.5 }}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {/* 状态指示点 */}
        <div className="relative">
          <div className={cn('w-2.5 h-2.5 rounded-full', config.color)} />
          {config.pulse && (
            <motion.div
              className={cn('absolute inset-0 w-2.5 h-2.5 rounded-full', config.color)}
              animate={{ scale: [1, 1.8, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </div>

        {/* 状态图标 */}
        <Icon
          className={cn(
            'w-3.5 h-3.5',
            config.textColor,
            status === 'reconnecting' && 'animate-spin'
          )}
        />

        {/* 状态文字 */}
        <span className={cn('text-xs font-mono', config.textColor)}>
          {t(config.labelKey)}
          {status === 'reconnecting' && reconnectAttempt > 0 && (
            <span className="ml-1 opacity-70">({reconnectAttempt}/10)</span>
          )}
          {status === 'reconnecting' && reconnectCountdown !== null && (
            <span className="ml-1 opacity-70">{reconnectCountdown}{t('conn.seconds')}</span>
          )}
        </span>

        {/* 展开/收起指示 */}
        <div className="ml-auto pl-2 border-l border-stone-200">
          {isExpanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-stone-400" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5 text-stone-400" />
          )}
        </div>
      </motion.div>

      {/* 展开面板 */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="w-80 bg-white/90 backdrop-blur-xl backdrop-blur-xl rounded-b-xl border border-t-0 border-stone-200 p-4 space-y-4">
              {/* 模式切换 */}
              {!isConnected && (
                <div className="space-y-2">
                  <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                    {t('conn.mode')}
                  </h4>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setMode('native')}
                      className={cn(
                        'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono transition-all',
                        mode === 'native'
                          ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400'
                          : 'bg-stone-100/80 border-stone-200 text-stone-400 hover:border-stone-200'
                      )}
                    >
                      <Monitor className="w-3.5 h-3.5" />
                      {t('conn.native')}
                    </button>
                    <button
                      onClick={() => setMode('openclaw')}
                      className={cn(
                        'flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono transition-all',
                        mode === 'openclaw'
                          ? 'bg-purple-500/20 border-purple-500/40 text-purple-400'
                          : 'bg-stone-100/80 border-stone-200 text-stone-400 hover:border-stone-200'
                      )}
                    >
                      <Cloud className="w-3.5 h-3.5" />
                      {t('conn.openclaw')}
                    </button>
                  </div>
                  <p className="text-[12px] text-stone-300 font-mono">
                    {mode === 'native' 
                      ? t('conn.native_desc')
                      : t('conn.openclaw_desc')}
                  </p>
                </div>
              )}

              {/* Gateway 地址输入 (仅 OpenClaw 模式) */}
              {!isConnected && mode === 'openclaw' && (
                <div className="space-y-2">
                  <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider flex items-center gap-1">
                    <Globe className="w-3 h-3" /> {t('conn.gateway')}
                  </h4>
                  <input
                    type="text"
                    value={gatewayUrl}
                    onChange={(e) => setGatewayUrl(e.target.value)}
                    placeholder={t('conn.gateway_placeholder')}
                    className="w-full bg-stone-100/80 border border-stone-200 rounded-lg px-3 py-2 text-xs font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-all"
                  />
                  <p className="text-[12px] text-stone-300 font-mono">
                    {t('conn.gateway_hint')}
                  </p>
                </div>
              )}

              {/* Token 输入 (仅 OpenClaw 模式) */}
              {!isConnected && mode === 'openclaw' && (
                <div className="space-y-2">
                  <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider flex items-center gap-1">
                    <Key className="w-3 h-3" /> {t('conn.token')}
                  </h4>
                  <div className="relative">
                    <input
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder={t('conn.token_placeholder')}
                      className="w-full bg-stone-100/80 border border-stone-200 rounded-lg px-3 py-2 pr-10 text-xs font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-cyan-500/40 focus:ring-1 focus:ring-cyan-500/20 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(!showToken)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-stone-400 hover:text-stone-600 transition-colors"
                    >
                      {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <p className="text-[12px] text-stone-300 font-mono">
                    {t('conn.token_hint')}
                  </p>
                </div>
              )}

              {/* 连接控制 */}
              <div className="space-y-3">
                <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                  {t('conn.control')}
                </h4>
                
                <div className="flex gap-2">
                  {!isConnected && !isConnecting && (
                    <button
                      onClick={handleConnect}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg border border-emerald-500/30 transition-colors text-xs font-mono"
                    >
                      <Power className="w-3.5 h-3.5" />
                      {t('conn.connect')}
                    </button>
                  )}
                  
                  {isConnected && (
                    <button
                      onClick={handleDisconnect}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg border border-red-500/30 transition-colors text-xs font-mono"
                    >
                      <PowerOff className="w-3.5 h-3.5" />
                      {t('conn.disconnect')}
                    </button>
                  )}

                  {isConnecting && (
                    <button
                      onClick={handleDisconnect}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded-lg border border-amber-500/30 transition-colors text-xs font-mono"
                    >
                      <PowerOff className="w-3.5 h-3.5" />
                      {t('common.cancel')}
                    </button>
                  )}

                  {status === 'error' && (
                    <button
                      onClick={handleRetry}
                      className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-lg border border-cyan-500/30 transition-colors text-xs font-mono"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      {t('conn.retry')}
                    </button>
                  )}
                </div>

                {/* 错误信息 */}
                {connectionError && (
                  <div className="p-2 bg-red-500/10 rounded-lg border border-red-500/20">
                    <p className="text-[13px] font-mono text-red-400">{connectionError}</p>
                  </div>
                )}
              </div>

              {/* Agent 状态 */}
              {isConnected && (
                <div className="space-y-2">
                  <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                    {t('settings.agent_status')}
                  </h4>
                  <div className="flex items-center gap-2 p-2 bg-stone-100/80 rounded-lg">
                    <Activity className={cn(
                      'w-4 h-4',
                      agentStatus === 'idle' && 'text-stone-400',
                      agentStatus === 'thinking' && 'text-cyan-400 animate-pulse',
                      agentStatus === 'executing' && 'text-amber-400 animate-pulse',
                      agentStatus === 'error' && 'text-red-400'
                    )} />
                    <span className="text-xs font-mono text-stone-600 capitalize">
                      {agentStatus === 'idle' && t('settings.agent_idle')}
                      {agentStatus === 'thinking' && t('settings.agent_thinking') + '...'}
                      {agentStatus === 'executing' && t('settings.agent_executing') + '...'}
                      {agentStatus === 'error' && t('chat.error')}
                    </span>
                  </div>
                </div>
              )}

              {/* 连接信息 */}
              <div className="space-y-2">
                <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                  {t('settings.connection_mode')}
                </h4>
                <div className="space-y-1.5 text-[13px] font-mono">
                  {mode === 'native' ? (
                    <>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <Monitor className="w-3 h-3" /> Server
                        </span>
                        <span className="text-emerald-400/80 truncate max-w-[140px]">
                          localhost:3001
                        </span>
                      </div>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <Activity className="w-3 h-3" /> Engine
                        </span>
                        <span className="text-stone-500">ReAct Loop</span>
                      </div>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <Key className="w-3 h-3" /> Token
                        </span>
                        <span className="text-emerald-400/60">N/A</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <Globe className="w-3 h-3" /> Gateway
                        </span>
                        <span className="text-stone-500 truncate max-w-[140px]">
                          {gatewayUrl || '127.0.0.1:18789'}
                        </span>
                      </div>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Heartbeat
                        </span>
                        <span className="text-stone-500">15s / 30s timeout</span>
                      </div>
                      <div className="flex justify-between text-stone-400">
                        <span className="flex items-center gap-1">
                          <RefreshCw className="w-3 h-3" /> Reconnect
                        </span>
                        <span className="text-stone-500">Exp. backoff (max 10)</span>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* 最近日志 */}
              {recentLogs.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                    Logs
                  </h4>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {recentLogs.map((log, index) => {
                      const time = log.timestamp 
                        ? new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
                        : '--:--:--'
                      return (
                        <div
                          key={`${log.id}-${index}`}
                          className={cn(
                            'text-[12px] font-mono p-1.5 rounded bg-stone-100/80 truncate',
                            log.level === 'error' && 'text-red-400',
                            log.level === 'warn' && 'text-amber-400',
                            log.level === 'info' && 'text-stone-400'
                          )}
                        >
                          [{time}] {log.message}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
