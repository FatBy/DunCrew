import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bell, CheckCheck, Trash2, CheckCircle2, XCircle, AlertTriangle, Info } from 'lucide-react'
import { useStore } from '@/store'
import { useT } from '@/i18n'
import { cn } from '@/utils/cn'
import type { NotificationRecord } from '@/types'

const TYPE_CONFIG = {
  success: { icon: CheckCircle2, iconColor: 'text-emerald-400', dotColor: 'bg-emerald-400' },
  error:   { icon: XCircle,     iconColor: 'text-red-400',     dotColor: 'bg-red-400' },
  warning: { icon: AlertTriangle, iconColor: 'text-amber-400', dotColor: 'bg-amber-400' },
  info:    { icon: Info,         iconColor: 'text-cyan-400',    dotColor: 'bg-cyan-400' },
}

function formatRelativeTime(timestamp: number, t: (key: any) => string): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000)
  if (diff < 5) return t('common.just_now')
  if (diff < 60) return `${diff}${t('common.seconds_ago')}`
  const minutes = Math.floor(diff / 60)
  if (minutes < 60) return `${minutes}${t('common.minutes_ago')}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}${t('common.hours_ago')}`
  const days = Math.floor(hours / 24)
  return `${days}${t('common.days_ago')}`
}

function NotifItem({ record, t }: { record: NotificationRecord, t: (key: any) => string }) {
  const config = TYPE_CONFIG[record.type]
  const Icon = config.icon

  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-white/5 transition-colors rounded-lg">
      <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', config.iconColor)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-stone-200 truncate">{record.title}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-stone-500">{formatRelativeTime(record.timestamp, t)}</span>
            {!record.read && (
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />
            )}
          </div>
        </div>
        {record.message && (
          <p className="mt-0.5 text-[11px] text-stone-400 leading-relaxed line-clamp-2">{record.message}</p>
        )}
      </div>
    </div>
  )
}

export function NotificationCenter() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const notificationHistory = useStore((s) => s.notificationHistory)
  const unreadNotifCount = useStore((s) => s.unreadNotifCount)
  const markAllNotifsRead = useStore((s) => s.markAllNotifsRead)
  const clearNotifHistory = useStore((s) => s.clearNotifHistory)

  // Auto mark all as read when panel opens
  useEffect(() => {
    if (open && unreadNotifCount > 0) {
      markAllNotifsRead()
    }
  }, [open, unreadNotifCount, markAllNotifsRead])

  // Click outside to close
  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (
      panelRef.current && !panelRef.current.contains(e.target as Node) &&
      buttonRef.current && !buttonRef.current.contains(e.target as Node)
    ) {
      setOpen(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [open, handleClickOutside])

  return (
    <>
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'relative p-2 rounded-xl transition-all',
          'text-stone-400 hover:text-stone-200 hover:bg-white/10',
          open && 'bg-white/10 text-stone-200',
        )}
      >
        <Bell className="w-4.5 h-4.5" />
        {unreadNotifCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
            {unreadNotifCount > 99 ? '99+' : unreadNotifCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="absolute top-full right-0 mt-2 w-80 rounded-xl border border-stone-700/50 bg-stone-900/95 backdrop-blur-xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-700/40">
              <span className="text-sm font-medium text-stone-200">{t('notify.title')}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={markAllNotifsRead}
                  title={t('common.mark_all_read')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-stone-200 hover:bg-white/10 transition-colors"
                >
                  <CheckCheck className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={clearNotifHistory}
                  title={t('common.clear_all')}
                  className="p-1.5 rounded-lg text-stone-400 hover:text-red-400 hover:bg-white/10 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Notification list */}
            <div className="max-h-[420px] overflow-y-auto overscroll-contain">
              {notificationHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-stone-500">
                  <Bell className="w-8 h-8 mb-2 opacity-30" />
                  <span className="text-xs">{t('common.no_messages')}</span>
                </div>
              ) : (
                <div className="py-1">
                  {notificationHistory.map((record) => (
                    <NotifItem key={record.id} record={record} t={t} />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
