import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, X, Trash2, Play, ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { useStore } from '@/store'
import type { TaskItem } from '@/types'

export function InterruptedTasksWarning() {
  const hasInterruptedTasks = useStore((s) => s.hasInterruptedTasks)
  const activeExecutions = useStore((s) => s.activeExecutions)
  const markInterruptedTasksAsFailed = useStore((s) => s.markInterruptedTasksAsFailed)
  const dismissInterruptedTasksWarning = useStore((s) => s.dismissInterruptedTasksWarning)
  const retryInterruptedTask = useStore((s) => s.retryInterruptedTask)
  const sendChat = useStore((s) => s.sendChat)
  
  const [expanded, setExpanded] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)

  // 获取中断的任务（执行中状态 = 刷新时被中断）
  const interruptedTasks = activeExecutions.filter(t => t.status === 'executing')
  const interruptedCount = interruptedTasks.length

  if (!hasInterruptedTasks || interruptedCount === 0) return null

  const handleRetry = async (task: TaskItem) => {
    if (retrying) return
    setRetrying(task.id)
    
    try {
      // 标记原任务为 interrupted
      const taskInfo = retryInterruptedTask(task.id)
      if (taskInfo && taskInfo.description) {
        // 重新执行任务 (使用 task 视图)
        await sendChat(taskInfo.description, 'task')
      }
    } finally {
      setRetrying(null)
      // 如果没有更多中断任务，关闭警告
      const remaining = activeExecutions.filter(t => t.status === 'executing').length
      if (remaining <= 1) {
        dismissInterruptedTasksWarning()
      }
    }
  }

  const handleRetryAll = async () => {
    if (retrying) return
    
    for (const task of interruptedTasks) {
      setRetrying(task.id)
      try {
        const taskInfo = retryInterruptedTask(task.id)
        if (taskInfo && taskInfo.description) {
          await sendChat(taskInfo.description, 'task')
        }
      } finally {
        setRetrying(null)
      }
    }
    dismissInterruptedTasksWarning()
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="fixed top-4 left-1/2 -translate-x-1/2 z-[100]
                   bg-amber-900/95 backdrop-blur-xl border border-amber-500/30
                   rounded-xl shadow-[0_8px_32px_rgba(245,158,11,0.3)]
                   p-4 max-w-lg w-[90vw]"
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>
          
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-mono font-semibold text-amber-200 mb-1">
              检测到中断的任务
            </h3>
            <p className="text-xs text-amber-200/70 mb-3">
              发现 {interruptedCount} 个任务在页面刷新时被中断。
            </p>
            
            {/* 任务列表展开/折叠 */}
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 text-xs text-amber-300/80 hover:text-amber-200 mb-2 transition-colors"
            >
              {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              {expanded ? '收起任务列表' : '查看任务详情'}
            </button>
            
            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden mb-3"
                >
                  <div className="space-y-2 max-h-[200px] overflow-y-auto pr-1">
                    {interruptedTasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-center gap-2 p-2 bg-stone-100/60 rounded-lg border border-amber-500/10"
                      >
                        <Clock className="w-3.5 h-3.5 text-amber-400/60 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-amber-100 truncate font-mono">
                            {task.title || task.description?.slice(0, 50) || '未命名任务'}
                          </p>
                          <p className="text-[10px] text-amber-200/50">
                            {new Date(task.timestamp).toLocaleString('zh-CN')}
                          </p>
                        </div>
                        <button
                          onClick={() => handleRetry(task)}
                          disabled={retrying === task.id}
                          className="flex items-center gap-1 px-2 py-1 
                                   bg-emerald-500/20 border border-emerald-500/30 
                                   text-emerald-300 text-[10px] font-mono rounded
                                   hover:bg-emerald-500/30 transition-colors
                                   disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Play className="w-2.5 h-2.5" />
                          {retrying === task.id ? '执行中...' : '重新执行'}
                        </button>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            
            <div className="flex items-center gap-2 flex-wrap">
              {interruptedCount > 1 && (
                <button
                  onClick={handleRetryAll}
                  disabled={!!retrying}
                  className="flex items-center gap-1.5 px-3 py-1.5 
                           bg-emerald-500/20 border border-emerald-500/30 
                           text-emerald-300 text-xs font-mono rounded-lg
                           hover:bg-emerald-500/30 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-3.5 h-3.5" />
                  全部重新执行
                </button>
              )}
              
              <button
                onClick={markInterruptedTasksAsFailed}
                disabled={!!retrying}
                className="flex items-center gap-1.5 px-3 py-1.5 
                         bg-amber-500/20 border border-amber-500/30 
                         text-amber-200 text-xs font-mono rounded-lg
                         hover:bg-amber-500/30 transition-colors
                         disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                标记为已中断
              </button>
              
              <button
                onClick={dismissInterruptedTasksWarning}
                className="flex items-center gap-1.5 px-3 py-1.5 
                         bg-stone-100/80 border border-stone-200 
                         text-stone-500 text-xs font-mono rounded-lg
                         hover:bg-stone-100 transition-colors"
              >
                稍后处理
              </button>
            </div>
          </div>
          
          <button
            onClick={dismissInterruptedTasksWarning}
            className="p-1 hover:bg-stone-100 rounded transition-colors flex-shrink-0"
          >
            <X className="w-4 h-4 text-stone-400" />
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
