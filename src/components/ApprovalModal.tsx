import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, ShieldAlert, ShieldCheck, Terminal } from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'

/**
 * P3: 危险操作审批弹窗
 * 当 Agent 尝试执行危险命令时，暂停执行并让用户确认
 */
export function ApprovalModal() {
  const t = useT()
  const pendingApproval = useStore((s) => s.pendingApproval)
  const respondToApproval = useStore((s) => s.respondToApproval)

  const isOpen = pendingApproval !== null

  if (!pendingApproval) return null

  const isCritical = pendingApproval.dangerLevel === 'critical'

  // 格式化命令显示
  const formatArgs = () => {
    const args = pendingApproval.args
    if (pendingApproval.toolName === 'runCmd' && args.command) {
      return String(args.command)
    }
    return JSON.stringify(args, null, 2)
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => respondToApproval(false)}
            className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-50"
          />

          {/* 弹窗 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className={cn(
              'fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50',
              'w-[90%] max-w-lg bg-white/95 backdrop-blur-3xl rounded-xl shadow-2xl overflow-hidden',
              isCritical 
                ? 'border-2 border-red-500/50' 
                : 'border border-amber-500/30'
            )}
          >
            {/* 头部 */}
            <div className={cn(
              'relative flex items-center justify-between p-4 border-b',
              isCritical ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/20 bg-amber-500/5'
            )}>
              <motion.div
                animate={{ opacity: [0.3, 0.6, 0.3] }}
                transition={{ duration: 2, repeat: Infinity }}
                className={cn(
                  'absolute inset-0',
                  isCritical ? 'bg-red-500/10' : 'bg-amber-500/5'
                )}
              />

              <div className="relative flex items-center gap-2">
                {isCritical ? (
                  <ShieldAlert className="w-5 h-5 text-red-400" />
                ) : (
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                )}
                <span className={cn(
                  'font-mono text-sm font-semibold',
                  isCritical ? 'text-red-400' : 'text-amber-400'
                )}>
                  {isCritical ? t('approval.critical') : t('approval.normal')}
                </span>
              </div>

              <button
                onClick={() => respondToApproval(false)}
                className="relative p-1 hover:bg-stone-100 rounded transition-colors"
              >
                <X className="w-4 h-4 text-stone-400" />
              </button>
            </div>

            {/* 内容 */}
            <div className="p-6 space-y-4">
              <div className="flex items-start gap-3">
                <div className={cn(
                  'p-2 rounded-lg',
                  isCritical ? 'bg-red-500/20' : 'bg-amber-500/20'
                )}>
                  <Terminal className={cn(
                    'w-5 h-5',
                    isCritical ? 'text-red-400' : 'text-amber-400'
                  )} />
                </div>
                <div className="flex-1">
                  <p className="text-sm text-stone-800 font-medium">
                    {t('approval.request')}
                  </p>
                  <p className={cn(
                    'text-xs mt-1',
                    isCritical ? 'text-red-400' : 'text-amber-400'
                  )}>
                    {pendingApproval.reason}
                  </p>
                </div>
              </div>

              {/* 命令详情 */}
              <div className={cn(
                'p-4 rounded-lg font-mono text-xs overflow-auto max-h-40',
                isCritical 
                  ? 'bg-red-950/50 border border-red-500/30' 
                  : 'bg-amber-950/30 border border-amber-500/20'
              )}>
                <div className="flex items-center gap-2 mb-2 text-stone-400">
                  <span className="text-[13px] uppercase tracking-wider">{t('approval.tool')}</span>
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[13px]',
                    isCritical ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'
                  )}>
                    {pendingApproval.toolName}
                  </span>
                </div>
                <pre className="text-stone-700 whitespace-pre-wrap break-all">
                  {formatArgs()}
                </pre>
              </div>

              {/* 风险等级 */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">{t('approval.risk')}</span>
                <span className={cn(
                  'px-2 py-1 rounded text-xs font-mono',
                  isCritical 
                    ? 'bg-red-500/20 text-red-400 border border-red-500/30' 
                    : 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                )}>
                  {isCritical ? 'CRITICAL' : 'HIGH'}
                </span>
                <span className="text-[13px] text-stone-300 ml-auto">
                  {t('approval.auto_reject')}
                </span>
              </div>
            </div>

            {/* 按钮 */}
            <div className="flex gap-3 p-4 border-t border-stone-100 bg-stone-50">
              <button
                onClick={() => respondToApproval(false)}
                className="flex-1 py-3 px-4 rounded-lg border border-stone-200 
                         text-sm font-mono text-stone-500 hover:bg-stone-100/80 
                         transition-colors flex items-center justify-center gap-2"
              >
                <X className="w-4 h-4" />
                {t('approval.reject')}
              </button>
              <button
                onClick={() => respondToApproval(true)}
                className={cn(
                  'flex-1 py-3 px-4 rounded-lg flex items-center justify-center gap-2',
                  'text-sm font-mono font-semibold transition-all',
                  isCritical
                    ? 'bg-red-500/20 border-2 border-red-500/50 text-red-400 hover:bg-red-500/30'
                    : 'bg-amber-500/20 border border-amber-500/30 text-amber-400 hover:bg-amber-500/30'
                )}
              >
                <ShieldCheck className="w-4 h-4" />
                {t('approval.approve')}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
