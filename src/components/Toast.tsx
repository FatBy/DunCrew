import { useEffect, forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'

const toastConfig = {
  success: {
    icon: CheckCircle2,
    bgColor: 'bg-emerald-500/20',
    borderColor: 'border-emerald-500/30',
    iconColor: 'text-emerald-400',
    titleColor: 'text-emerald-300',
  },
  error: {
    icon: XCircle,
    bgColor: 'bg-red-500/20',
    borderColor: 'border-red-500/30',
    iconColor: 'text-red-400',
    titleColor: 'text-red-300',
  },
  warning: {
    icon: AlertTriangle,
    bgColor: 'bg-amber-500/20',
    borderColor: 'border-amber-500/30',
    iconColor: 'text-amber-400',
    titleColor: 'text-amber-300',
  },
  info: {
    icon: Info,
    bgColor: 'bg-cyan-500/20',
    borderColor: 'border-cyan-500/30',
    iconColor: 'text-cyan-400',
    titleColor: 'text-cyan-300',
  },
}

interface ToastItemProps {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message?: string
  duration?: number
  onClose: (id: string) => void
  onClick?: () => void
  persistent?: boolean
}

const ToastItem = forwardRef<HTMLDivElement, ToastItemProps>(function ToastItem(
  { id, type, title, message, duration = 4000, onClose, onClick, persistent },
  ref,
) {
  const config = toastConfig[type]
  const Icon = config.icon
  const isClickable = !!onClick
  const effectiveDuration = persistent ? 0 : duration

  useEffect(() => {
    if (effectiveDuration > 0) {
      const timer = setTimeout(() => {
        onClose(id)
      }, effectiveDuration)
      return () => clearTimeout(timer)
    }
  }, [id, effectiveDuration, onClose])

  const handleClick = () => {
    if (onClick) {
      onClick()
      onClose(id)
    }
  }

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 0, x: 50, scale: 0.9 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 50, scale: 0.9 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
      onClick={isClickable ? handleClick : undefined}
      className={cn(
        'relative w-80 p-4 rounded-xl border backdrop-blur-xl shadow-2xl',
        config.bgColor,
        config.borderColor,
        isClickable && 'cursor-pointer hover:scale-[1.02] hover:brightness-110 transition-all'
      )}
    >
      <button
        onClick={() => onClose(id)}
        className="absolute top-2 right-2 p-1 rounded-lg hover:bg-stone-100 transition-colors text-stone-400 hover:text-stone-600"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="flex gap-3">
        <Icon className={cn('w-5 h-5 shrink-0 mt-0.5', config.iconColor)} />
        <div className="flex-1 min-w-0 pr-4">
          <h4 className={cn('text-sm font-mono font-medium', config.titleColor)}>
            {title}
          </h4>
          {message && (
            <p className="mt-1 text-xs text-stone-400 leading-relaxed">
              {message}
            </p>
          )}
          {isClickable && (
            <p className="mt-1 text-xs text-stone-300 italic">
              点击查看详情
            </p>
          )}
        </div>
      </div>

      {/* 进度条 */}
      {effectiveDuration > 0 && (
        <motion.div
          className={cn(
            'absolute bottom-0 left-0 h-0.5 rounded-b-xl',
            config.iconColor.replace('text-', 'bg-')
          )}
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: effectiveDuration / 1000, ease: 'linear' }}
        />
      )}
    </motion.div>
  )
})

export function ToastContainer() {
  const toasts = useStore((s) => s.toasts)
  const removeToast = useStore((s) => s.removeToast)

  return (
    <div className="fixed top-14 right-4 z-50 flex flex-col gap-3">
      <AnimatePresence mode="popLayout">
        {toasts.map((toast) => (
          <ToastItem
            key={toast.id}
            id={toast.id}
            type={toast.type}
            title={toast.title}
            message={toast.message}
            duration={toast.duration}
            onClose={removeToast}
            onClick={toast.onClick}
            persistent={toast.persistent}
          />
        ))}
      </AnimatePresence>
    </div>
  )
}
