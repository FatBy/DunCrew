import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Trash2, Clock, CheckCircle2, ChevronRight,
  Calendar, Activity, MessageSquare, Hash, StopCircle, AlertTriangle, Play, RotateCcw, Pause,
} from 'lucide-react'
import { GlassCard } from '@/components/GlassCard'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import type { TaskItem, TaskStatus } from '@/types'
import { localClawService } from '@/services/LocalClawService'

const statusConfig: Record<TaskStatus, { icon: typeof Clock; color: string; label: string }> = {
  pending: { icon: Clock, color: 'amber', label: '等待' },
  queued: { icon: Clock, color: 'blue', label: '排队中' },
  executing: { icon: Clock, color: 'cyan', label: '执行中' },
  done: { icon: CheckCircle2, color: 'emerald', label: '完成' },
  error: { icon: AlertTriangle, color: 'red', label: '出错' },
  terminated: { icon: StopCircle, color: 'red', label: '已终止' },
  interrupted: { icon: AlertTriangle, color: 'amber', label: '已中断' },
  retrying: { icon: RotateCcw, color: 'violet', label: '重试中' },
  paused: { icon: Pause, color: 'slate', label: '已暂停' },
}

interface HistoryDrawerProps {
  isOpen: boolean
  onClose: () => void
  /** 内嵌模式，不显示抽屉效果 */
  inline?: boolean
  /** 自定义任务列表，不传则从 store 获取 */
  tasks?: TaskItem[]
}

export function HistoryDrawer({ isOpen, onClose, inline = false, tasks: customTasks }: HistoryDrawerProps) {
  const activeExecutions = useStore((s) => s.activeExecutions)
  const removeActiveExecution = useStore((s) => s.removeActiveExecution)
  const clearTaskHistory = useStore((s) => s.clearTaskHistory)
  const retryInterruptedTask = useStore((s) => s.retryInterruptedTask)
  const updateActiveExecution = useStore((s) => s.updateActiveExecution)
  const addActiveExecution = useStore((s) => s.addActiveExecution)
  const saveCheckpoint = useStore((s) => s.saveCheckpoint)
  const sendChat = useStore((s) => s.sendChat)

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)

  // 使用自定义任务列表或从 store 获取
  const historyTasks = customTasks 
    ? customTasks.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : activeExecutions
        .filter(t => t.status !== 'executing')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  const handleDelete = (id: string) => {
    removeActiveExecution(id)
    if (expandedId === id) setExpandedId(null)
  }

  const handleRetry = async (task: TaskItem) => {
    if (retrying) return
    setRetrying(task.id)
    
    try {
      // 检查是否有断点可以恢复
      if (task.checkpoint && task.checkpoint.traceTools.length > 0) {
        console.log(`[HistoryDrawer] Resuming from checkpoint: ${task.checkpoint.stepIndex} steps completed`)
        
        // 创建新的执行任务
        const newTaskId = `resume-${Date.now()}`
        addActiveExecution({
          id: newTaskId,
          title: `恢复: ${task.title}`,
          description: task.description,
          status: 'executing',
          priority: 'high',
          timestamp: new Date().toISOString(),
          executionSteps: [],
          startedAt: Date.now(),
        })
        
        // 标记原任务为已重试
        updateActiveExecution(task.id, { 
          status: 'interrupted',
          executionError: '任务已从断点恢复执行',
        })
        
        // 从断点恢复执行
        await localClawService.resumeFromCheckpoint(
          task.checkpoint,
          undefined,
          (step) => {
            // 更新执行步骤
            const current = activeExecutions.find(t => t.id === newTaskId)
            if (current) {
              updateActiveExecution(newTaskId, {
                executionSteps: [...(current.executionSteps || []), step],
              })
            }
          },
          (checkpoint) => {
            // 保存新的 checkpoint
            saveCheckpoint(newTaskId, checkpoint)
          }
        )
        
        // 完成
        updateActiveExecution(newTaskId, { 
          status: 'done',
          completedAt: Date.now(),
        })
      } else {
        // 无断点，使用原有的重新执行逻辑
        const taskInfo = retryInterruptedTask(task.id)
        if (taskInfo && taskInfo.description) {
          await sendChat(taskInfo.description, 'task')
        }
      }
    } catch (error: any) {
      console.error('[HistoryDrawer] Retry failed:', error)
    } finally {
      setRetrying(null)
    }
  }

  // 内嵌模式：直接渲染任务列表
  if (inline) {
    return (
      <div className="space-y-2">
        {historyTasks.map((task) => (
          <HistoryTaskCard
            key={task.id}
            task={task}
            isExpanded={expandedId === task.id}
            onToggle={() => setExpandedId(prev => prev === task.id ? null : task.id)}
            onDelete={() => handleDelete(task.id)}
            onRetry={task.status === 'interrupted' ? () => handleRetry(task) : undefined}
            isRetrying={retrying === task.id}
          />
        ))}
      </div>
    )
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* 遮罩层 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="absolute inset-0 bg-stone-900/10 z-30"
            onClick={onClose}
          />

          {/* 抽屉 */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className="absolute top-0 right-0 h-full w-[384px] max-w-[90%] bg-[#0a0f1e]/95 backdrop-blur-xl
                       border-l border-stone-200 z-40 flex flex-col"
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between p-4 border-b border-stone-200 flex-shrink-0">
              <h3 className="text-sm font-mono text-stone-700">
                历史任务
                <span className="ml-2 text-xs text-stone-300 bg-stone-100/80 px-2 py-0.5 rounded">
                  {historyTasks.length}
                </span>
              </h3>
              <button
                onClick={onClose}
                className="p-1 text-stone-300 hover:text-stone-600 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 任务列表 */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {historyTasks.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-stone-300">
                  <Clock className="w-8 h-8 mb-2" />
                  <span className="text-xs font-mono">暂无历史记录</span>
                </div>
              ) : (
                historyTasks.map((task) => (
                  <HistoryTaskCard
                    key={task.id}
                    task={task}
                    isExpanded={expandedId === task.id}
                    onToggle={() => setExpandedId(prev => prev === task.id ? null : task.id)}
                    onDelete={() => handleDelete(task.id)}
                  />
                ))
              )}
            </div>

            {/* 底部操作栏 */}
            {historyTasks.length > 0 && (
              <div className="p-3 border-t border-stone-200 flex-shrink-0">
                <button
                  onClick={() => {
                    if (window.confirm('确定清空所有历史任务？')) {
                      clearTaskHistory()
                    }
                  }}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-mono
                             text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  清空全部
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

function HistoryTaskCard({ task, isExpanded, onToggle, onDelete, onRetry, isRetrying }: {
  task: TaskItem
  isExpanded: boolean
  onToggle: () => void
  onDelete: () => void
  onRetry?: () => void
  isRetrying?: boolean
}) {
  const config = statusConfig[task.status] || statusConfig.done
  const Icon = config.icon

  return (
    <div className="group relative">
      <GlassCard
        themeColor={config.color}
        className="p-3 cursor-pointer hover:scale-[1.005] transition-transform"
        onClick={onToggle}
      >
        <div className="flex items-start gap-2.5">
          <div className={cn(
            'w-6 h-6 rounded flex items-center justify-center flex-shrink-0',
            `bg-${config.color}-500/20`
          )}>
            <Icon className={cn('w-3.5 h-3.5', `text-${config.color}-400`)} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-xs font-medium text-stone-700 truncate flex-1">
                {task.title}
              </h4>
              <span className={cn(
                'text-[10px] font-mono px-1 py-0.5 rounded flex-shrink-0',
                `bg-${config.color}-500/15 text-${config.color}-400`
              )}>
                {config.label}
              </span>
            </div>

            {!isExpanded && (
              <p className="text-[11px] text-stone-400 mt-0.5 line-clamp-1">
                {task.description}
              </p>
            )}

            {/* 展开详情 */}
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="mt-2 p-2 bg-stone-100/80 rounded border border-stone-200">
                    <p className="text-[11px] text-stone-500 whitespace-pre-wrap leading-relaxed">
                      {task.description || '-'}
                    </p>
                  </div>

                  {task.executionOutput && (
                    <div className="mt-2 p-2 bg-emerald-500/5 rounded border border-emerald-500/15">
                      <pre className="text-[11px] text-stone-500 whitespace-pre-wrap max-h-40 overflow-y-auto font-mono">
                        {task.executionOutput}
                      </pre>
                    </div>
                  )}

                  {task.executionError && (
                    <div className="mt-2 p-2 bg-red-500/5 rounded border border-red-500/15">
                      <p className="text-[11px] text-red-300/80 font-mono">{task.executionError}</p>
                    </div>
                  )}

                  {/* 中断任务的重试按钮 */}
                  {task.status === 'interrupted' && onRetry && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onRetry() }}
                      disabled={isRetrying}
                      className="mt-2 flex items-center gap-1.5 px-3 py-1.5 
                               bg-emerald-500/20 border border-emerald-500/30 
                               text-emerald-300 text-xs font-mono rounded-lg
                               hover:bg-emerald-500/30 transition-colors
                               disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Play className="w-3 h-3" />
                      {isRetrying ? '重新执行中...' : '重新执行此任务'}
                    </button>
                  )}

                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono text-stone-300">
                    <span className="flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5" />
                      {new Date(task.timestamp).toLocaleString('zh-CN')}
                    </span>
                    {task.executionDuration !== undefined && (
                      <span className="flex items-center gap-1">
                        <Activity className="w-2.5 h-2.5" />
                        {(task.executionDuration / 1000).toFixed(1)}s
                      </span>
                    )}
                    {task.messageCount !== undefined && (
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-2.5 h-2.5" />
                        {task.messageCount}
                      </span>
                    )}
                    {task.sessionKey && (
                      <span className="flex items-center gap-1">
                        <Hash className="w-2.5 h-2.5" />
                        <span className="truncate max-w-[80px]">{task.sessionKey}</span>
                      </span>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {!isExpanded && (
              <div className="flex items-center gap-2 mt-1 text-[10px] font-mono text-stone-300">
                {task.executionDuration !== undefined && (
                  <span>{(task.executionDuration / 1000).toFixed(1)}s</span>
                )}
                <span>{new Date(task.timestamp).toLocaleDateString('zh-CN')}</span>
              </div>
            )}
          </div>

          <motion.div animate={{ rotate: isExpanded ? 90 : 0 }} transition={{ duration: 0.2 }}>
            <ChevronRight className="w-3 h-3 text-stone-300 flex-shrink-0" />
          </motion.div>
        </div>
      </GlassCard>

      {/* 删除按钮 - hover 显示 */}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete() }}
        className="absolute top-2 right-2 p-1 rounded bg-red-500/0 text-red-400/0
                   group-hover:bg-red-500/15 group-hover:text-red-400 transition-all z-10"
        title="删除任务"
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  )
}
