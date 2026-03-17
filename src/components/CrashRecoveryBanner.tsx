import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, Bug, RefreshCw } from 'lucide-react'
import { crashMonitor } from '@/services/crashMonitor'

/**
 * 崩溃恢复横幅
 * 检测到最近崩溃时显示，帮助用户了解问题
 */
export function CrashRecoveryBanner() {
  const [show, setShow] = useState(false)
  const [crashInfo, setCrashInfo] = useState<{ message: string; time: string } | null>(null)
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    // 检查最近 2 分钟内是否有崩溃
    if (crashMonitor.hasRecentCrash(2 * 60 * 1000)) {
      const latest = crashMonitor.getLatestCrash()
      if (latest) {
        setCrashInfo({
          message: latest.message,
          time: new Date(latest.timestamp).toLocaleTimeString(),
        })
        setShow(true)
      }
    }
  }, [])

  const handleDismiss = () => {
    setShow(false)
    // 清除崩溃日志，避免下次还显示
    crashMonitor.clearCrashLogs()
  }

  const handleViewLogs = () => {
    setShowDetails(!showDetails)
  }

  const logs = crashMonitor.getCrashLogs()

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[90vw] max-w-lg"
        >
          <div className="bg-amber-950/90 backdrop-blur-sm border border-amber-500/30 rounded-xl p-4 shadow-2xl">
            {/* 主横幅 */}
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-amber-200">
                  检测到应用异常
                </p>
                <p className="text-xs text-amber-300/70 mt-1">
                  上次会话可能因错误而中断 ({crashInfo?.time})
                </p>
                {crashInfo && (
                  <p className="text-xs text-stone-400 mt-1.5 font-mono truncate">
                    {crashInfo.message.slice(0, 80)}
                    {crashInfo.message.length > 80 && '...'}
                  </p>
                )}
              </div>
              <button
                onClick={handleDismiss}
                className="text-amber-400/60 hover:text-amber-300 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 操作按钮 */}
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-amber-500/20">
              <button
                onClick={handleViewLogs}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                         bg-stone-100/80 border border-stone-200 rounded-lg
                         text-amber-300/80 hover:text-amber-200 hover:border-amber-500/30 transition-colors"
              >
                <Bug className="w-3 h-3" />
                {showDetails ? '隐藏详情' : '查看日志'}
              </button>
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                         bg-stone-100/80 border border-stone-200 rounded-lg
                         text-stone-500 hover:text-stone-800 hover:border-stone-300 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                刷新页面
              </button>
              <button
                onClick={handleDismiss}
                className="ml-auto px-3 py-1.5 text-xs font-mono
                         text-stone-400 hover:text-stone-500 transition-colors"
              >
                忽略
              </button>
            </div>

            {/* 详情展开 */}
            <AnimatePresence>
              {showDetails && logs.length > 0 && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden"
                >
                  <div className="mt-3 pt-3 border-t border-amber-500/20">
                    <p className="text-xs text-stone-400 mb-2">最近错误日志:</p>
                    <div className="max-h-40 overflow-auto space-y-2">
                      {logs.slice(0, 5).map((log, i) => (
                        <div
                          key={i}
                          className="text-[11px] font-mono bg-stone-100/80 rounded p-2"
                        >
                          <div className="flex items-center gap-2 text-stone-300 mb-1">
                            <span className={
                              log.type === 'error' ? 'text-red-400' :
                              log.type === 'unhandledrejection' ? 'text-orange-400' :
                              'text-yellow-400'
                            }>
                              [{log.type}]
                            </span>
                            <span>{new Date(log.timestamp).toLocaleString()}</span>
                          </div>
                          <p className="text-stone-500 break-all">
                            {log.message}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
