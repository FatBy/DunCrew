import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Download, CheckCircle2, X, ExternalLink } from 'lucide-react'
import { useStore } from '@/store'
import { useT } from '@/i18n'

interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  version?: string
  releaseNotes?: string
  releaseDate?: string
  macOSManualOnly?: boolean
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  message?: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${bps} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateStatus>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const lastProgressUpdate = useRef(0)
  const addToast = useStore((s) => s.addToast)
  const t = useT()

  const handleStatus = useCallback((data: Record<string, unknown>) => {
    const status = data.status as UpdateStatus['status']

    // 错误状态用 Toast 显示，不占横幅
    if (status === 'error') {
      addToast({
        type: 'error',
        title: t('update.check_failed'),
        message: String(data.message || ''),
        duration: 5000,
      })
      return
    }

    // 下载进度节流: 500ms 更新一次
    if (status === 'downloading') {
      const now = Date.now()
      if (now - lastProgressUpdate.current < 500) return
      lastProgressUpdate.current = now
    }

    // 有新状态进来时取消 dismissed
    if (status === 'available' || status === 'downloaded') {
      setDismissed(false)
    }

    setInfo(data as unknown as UpdateStatus)
  }, [addToast, t])

  useEffect(() => {
    const cleanup = window.electronAPI?.updater?.onStatus(handleStatus)
    return () => { cleanup?.() }
  }, [handleStatus])

  const handleDownload = () => {
    window.electronAPI?.updater?.download()
  }

  const handleInstall = () => {
    window.electronAPI?.updater?.install()
  }

  const handleOpenReleases = () => {
    window.electronAPI?.updater?.openReleases()
  }

  const handleDismiss = () => {
    setDismissed(true)
  }

  // 不显示横幅的状态
  const visible = !dismissed && (
    info.status === 'available' ||
    info.status === 'downloading' ||
    info.status === 'downloaded'
  )

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[90vw] max-w-md"
        >
          {/* ── 发现新版本 ── */}
          {info.status === 'available' && (
            <div className="bg-cyan-950/90 backdrop-blur-sm border border-cyan-500/30 rounded-xl p-4 shadow-2xl">
              <div className="flex items-start gap-3">
                <Download className="w-5 h-5 text-cyan-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-cyan-200">
                    {t('update.available', [info.version || ''])}
                  </p>
                  {info.releaseNotes && (
                    <p className="text-xs text-cyan-300/60 mt-1 line-clamp-2">
                      {info.releaseNotes}
                    </p>
                  )}
                </div>
                <button
                  onClick={handleDismiss}
                  className="text-cyan-400/60 hover:text-cyan-300 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-cyan-500/20">
                {info.macOSManualOnly ? (
                  <button
                    onClick={handleOpenReleases}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                             bg-cyan-500/20 border border-cyan-500/40 rounded-lg
                             text-cyan-200 hover:bg-cyan-500/30 transition-colors"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {t('update.goto_download')}
                  </button>
                ) : (
                  <button
                    onClick={handleDownload}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                             bg-cyan-500/20 border border-cyan-500/40 rounded-lg
                             text-cyan-200 hover:bg-cyan-500/30 transition-colors"
                  >
                    <Download className="w-3 h-3" />
                    {t('update.download_btn')}
                  </button>
                )}
                <button
                  onClick={handleDismiss}
                  className="ml-auto px-3 py-1.5 text-xs font-mono
                           text-cyan-400/60 hover:text-cyan-300 transition-colors"
                >
                  {t('update.later_btn')}
                </button>
              </div>
            </div>
          )}

          {/* ── 下载中 ── */}
          {info.status === 'downloading' && (
            <div className="bg-cyan-950/90 backdrop-blur-sm border border-cyan-500/30 rounded-xl p-4 shadow-2xl">
              <div className="flex items-center gap-3">
                <Download className="w-5 h-5 text-cyan-400 flex-shrink-0 animate-pulse" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-cyan-200">
                    {t('update.downloading', [info.version || ''])}
                  </p>
                  <p className="text-xs text-cyan-300/60 mt-0.5 font-mono">
                    {(info.percent ?? 0).toFixed(1)}%
                    {info.transferred != null && info.total != null && (
                      <> · {formatBytes(info.transferred)} / {formatBytes(info.total)}</>
                    )}
                    {info.bytesPerSecond != null && info.bytesPerSecond > 0 && (
                      <> · {formatSpeed(info.bytesPerSecond)}</>
                    )}
                  </p>
                </div>
              </div>
              {/* 进度条 */}
              <div className="mt-3 h-1.5 bg-cyan-900/50 rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-cyan-400 rounded-full"
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(info.percent ?? 0, 100)}%` }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                />
              </div>
            </div>
          )}

          {/* ── 下载完成 ── */}
          {info.status === 'downloaded' && (
            <div className="bg-emerald-950/90 backdrop-blur-sm border border-emerald-500/30 rounded-xl p-4 shadow-2xl">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-emerald-200">
                    {t('update.downloaded', [info.version || ''])}
                  </p>
                </div>
                <button
                  onClick={handleDismiss}
                  className="text-emerald-400/60 hover:text-emerald-300 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-2 mt-3 pt-3 border-t border-emerald-500/20">
                <button
                  onClick={handleInstall}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono
                           bg-emerald-500/20 border border-emerald-500/40 rounded-lg
                           text-emerald-200 hover:bg-emerald-500/30 transition-colors"
                >
                  {t('update.restart_btn')}
                </button>
                <button
                  onClick={handleDismiss}
                  className="ml-auto px-3 py-1.5 text-xs font-mono
                           text-emerald-400/60 hover:text-emerald-300 transition-colors"
                >
                  {t('update.later_btn')}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
