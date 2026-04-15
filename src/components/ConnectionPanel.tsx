import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Wifi, WifiOff, RefreshCw, AlertCircle, ChevronUp, ChevronDown,
  PowerOff, Activity, Monitor
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { localClawService } from '@/services/LocalClawService'
import { useT } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/zh'

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
  
  const status = useStore((s) => s.connectionStatus)
  const reconnectAttempt = useStore((s) => s.reconnectAttempt)
  const reconnectCountdown = useStore((s) => s.reconnectCountdown)
  const connectionError = useStore((s) => s.connectionError)
  const agentStatus = useStore((s) => s.agentStatus)
  const logs = useStore((s) => s.logs)

  const config = statusConfig[status]
  const Icon = config.icon

  const handleDisconnect = () => {
    localClawService.disconnect()
  }

  const handleRetry = () => {
    localClawService.retry()
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
          'flex items-center gap-2 px-3 py-2 bg-white/90 backdrop-blur-xl rounded-xl border border-stone-200 cursor-pointer hover:bg-white/95 transition-colors',
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
            <div className="w-80 bg-white/90 backdrop-blur-xl rounded-b-xl border border-t-0 border-stone-200 p-4 space-y-4">

              {/* 诊断信息 (仅 error/disconnected 时显示) */}
              {(status === 'error' || status === 'disconnected') && connectionError && (
                <div className="space-y-2">
                  <div className="p-3 bg-red-500/10 rounded-lg border border-red-500/20 space-y-2">
                    <p className="text-xs font-mono text-red-400 font-medium">
                      {connectionError}
                    </p>
                    <div className="text-[11px] font-mono text-stone-400 space-y-1">
                      <p>{t('conn.native_desc')}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* 连接控制 */}
              <div className="flex gap-2">
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
                      <RefreshCw className="w-3 h-3" /> Heartbeat
                    </span>
                    <span className="text-stone-500">15s / auto-reconnect</span>
                  </div>
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
