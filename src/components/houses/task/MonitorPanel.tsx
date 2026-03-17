import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { 
  Activity, CheckCircle2, XCircle, Clock, 
  Pause, Play, RotateCcw, Trash2, ChevronDown, ChevronUp
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { executionLogger, type ExecutionLogEntry, type ExecutionStats } from '@/services/executionLogger'
import type { TaskItem } from '@/types'

// 状态颜色映射
const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  executing: { bg: 'bg-cyan-500/20', text: 'text-cyan-300', border: 'border-cyan-500/30' },
  queued: { bg: 'bg-amber-500/20', text: 'text-amber-300', border: 'border-amber-500/30' },
  done: { bg: 'bg-emerald-500/20', text: 'text-emerald-300', border: 'border-emerald-500/30' },
  terminated: { bg: 'bg-red-500/20', text: 'text-red-300', border: 'border-red-500/30' },
  interrupted: { bg: 'bg-orange-500/20', text: 'text-orange-300', border: 'border-orange-500/30' },
  retrying: { bg: 'bg-violet-500/20', text: 'text-violet-300', border: 'border-violet-500/30' },
  paused: { bg: 'bg-stone-100', text: 'text-stone-400', border: 'border-stone-200' },
  pending: { bg: 'bg-stone-100', text: 'text-stone-400', border: 'border-stone-200' },
}

// 日志事件图标和颜色
const EVENT_STYLES: Record<string, { icon: string; color: string }> = {
  task_started: { icon: 'play', color: 'text-cyan-400' },
  task_completed: { icon: 'check', color: 'text-emerald-400' },
  task_failed: { icon: 'x', color: 'text-red-400' },
  task_paused: { icon: 'pause', color: 'text-stone-400' },
  task_resumed: { icon: 'play', color: 'text-cyan-400' },
  task_retrying: { icon: 'rotate', color: 'text-violet-400' },
  tool_called: { icon: 'arrow', color: 'text-stone-400' },
  tool_succeeded: { icon: 'check', color: 'text-emerald-400' },
  tool_failed: { icon: 'x', color: 'text-amber-400' },
}

// 统计卡片组件
function StatCard({ 
  label, 
  value, 
  icon: Icon, 
  color 
}: { 
  label: string
  value: number
  icon: typeof Activity
  color: string 
}) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center p-3 rounded-lg border',
      `bg-${color}-500/10 border-${color}-500/20`
    )}>
      <Icon className={cn('w-4 h-4 mb-1', `text-${color}-400`)} />
      <span className="text-xl font-mono font-bold text-stone-800">{value}</span>
      <span className="text-xs font-mono text-stone-400 uppercase tracking-wide">{label}</span>
    </div>
  )
}

// 任务进度条组件
function TaskProgressItem({ 
  task, 
  onPause, 
  onResume, 
  onRetry, 
  onRemove 
}: { 
  task: TaskItem
  onPause: () => void
  onResume: () => void
  onRetry: () => void
  onRemove: () => void
}) {
  const statusStyle = STATUS_COLORS[task.status] || STATUS_COLORS.pending
  const progress = task.taskPlan?.progress ?? 0
  const duration = task.startedAt 
    ? Math.floor((Date.now() - task.startedAt) / 1000) 
    : 0
  const formatDuration = (s: number) => {
    if (s < 60) return `${s}s`
    return `${Math.floor(s / 60)}m ${s % 60}s`
  }

  return (
    <div className={cn(
      'rounded-lg border p-3 transition-all',
      statusStyle.bg,
      statusStyle.border
    )}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-mono text-stone-800 truncate flex-1">
          {task.title || task.description?.slice(0, 40) || '未命名任务'}
        </span>
        <span className={cn('text-xs font-mono px-2 py-0.5 rounded', statusStyle.bg, statusStyle.text)}>
          {task.status}
        </span>
      </div>

      {/* 进度条 */}
      {(task.status === 'executing' || task.status === 'retrying') && (
        <div className="mb-2">
          <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-cyan-400"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-xs font-mono text-stone-400">
              {task.taskPlan?.subTasks?.filter(s => s.status === 'done').length || 0} / {task.taskPlan?.subTasks?.length || '-'} 步骤
            </span>
            <span className="text-xs font-mono text-stone-400">
              {progress}%
            </span>
          </div>
        </div>
      )}

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-mono text-stone-400">
          <Clock className="w-3.5 h-3.5" />
          <span>{formatDuration(duration)}</span>
          {task.retryCount && task.retryCount > 0 && (
            <span className="text-violet-400">重试 #{task.retryCount}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {task.status === 'executing' && (
            <button
              onClick={onPause}
              className="p-1 text-stone-300 hover:text-amber-400 transition-colors"
              title="暂停"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
          )}
          {task.status === 'paused' && (
            <button
              onClick={onResume}
              className="p-1 text-stone-300 hover:text-cyan-400 transition-colors"
              title="恢复"
            >
              <Play className="w-3.5 h-3.5" />
            </button>
          )}
          {(task.status === 'interrupted' || task.status === 'terminated') && (
            <button
              onClick={onRetry}
              className="p-1 text-stone-300 hover:text-violet-400 transition-colors"
              title="重试"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          {task.status !== 'executing' && task.status !== 'retrying' && (
            <button
              onClick={onRemove}
              className="p-1 text-stone-300 hover:text-red-400 transition-colors"
              title="移除"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// 日志条目组件
function LogEntry({ log }: { log: ExecutionLogEntry }) {
  const style = EVENT_STYLES[log.event] || { icon: 'dot', color: 'text-stone-300' }
  const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })
  
  // 简化显示的数据
  const displayData = log.data?.toolName 
    ? `${log.data.toolName}` 
    : log.message?.slice(0, 30) || ''

  return (
    <div className="flex items-center gap-2 text-[13px] font-mono py-1.5 border-b border-stone-100 last:border-0">
      <span className="text-stone-300 w-16 flex-shrink-0">{time}</span>
      <span className={cn('w-3.5 h-3.5 flex items-center justify-center', style.color)}>
        {style.icon === 'check' && <CheckCircle2 className="w-3.5 h-3.5" />}
        {style.icon === 'x' && <XCircle className="w-3.5 h-3.5" />}
        {style.icon === 'play' && <Play className="w-3.5 h-3.5" />}
        {style.icon === 'pause' && <Pause className="w-3.5 h-3.5" />}
        {style.icon === 'rotate' && <RotateCcw className="w-3.5 h-3.5" />}
        {style.icon === 'arrow' && <span className="text-sm">→</span>}
        {style.icon === 'dot' && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      </span>
      <span className="text-stone-500 truncate flex-1">{log.event.replace(/_/g, ' ')}</span>
      {displayData && (
        <span className="text-stone-300 truncate max-w-[120px]">{displayData}</span>
      )}
    </div>
  )
}

export function MonitorPanel() {
  const activeExecutions = useStore((s) => s.activeExecutions)
  const pauseTask = useStore((s) => s.pauseTask)
  const resumeTask = useStore((s) => s.resumeTask)
  const retryFailedTask = useStore((s) => s.retryFailedTask)
  const removeActiveExecution = useStore((s) => s.removeActiveExecution)

  const [logs, setLogs] = useState<ExecutionLogEntry[]>([])
  const [stats, setStats] = useState<ExecutionStats | null>(null)
  const [logsExpanded, setLogsExpanded] = useState(true)

  // 按状态分类任务
  const runningTasks = activeExecutions.filter(t => t.status === 'executing' || t.status === 'retrying')
  const queuedTasks = activeExecutions.filter(t => t.status === 'queued' || t.status === 'pending')
  const doneTasks = activeExecutions.filter(t => t.status === 'done')
  const failedTasks = activeExecutions.filter(t => 
    t.status === 'terminated' || t.status === 'interrupted'
  )

  // 订阅日志更新
  useEffect(() => {
    const unsubscribe = executionLogger.subscribe((newLogs) => {
      setLogs(newLogs.slice(-30))
    })
    // 初始加载
    setLogs(executionLogger.getRecentLogs(30))
    return unsubscribe
  }, [])

  // 更新统计
  useEffect(() => {
    const runningIds = runningTasks.map(t => t.id)
    const queuedIds = queuedTasks.map(t => t.id)
    setStats(executionLogger.getStats(runningIds, queuedIds))
  }, [activeExecutions])

  // 活动任务（运行中、暂停、重试中）
  const activeTasks = activeExecutions.filter(t => 
    ['executing', 'retrying', 'paused', 'queued', 'pending'].includes(t.status)
  )

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-2 p-4 border-b border-stone-200">
        <StatCard label="运行" value={runningTasks.length} icon={Activity} color="cyan" />
        <StatCard label="队列" value={queuedTasks.length} icon={Clock} color="amber" />
        <StatCard label="完成" value={doneTasks.length} icon={CheckCircle2} color="emerald" />
        <StatCard label="失败" value={failedTasks.length} icon={XCircle} color="red" />
      </div>

      {/* 性能指标条 */}
      {stats && (
        <div className="flex items-center justify-between px-4 py-2 bg-stone-100/80 border-b border-stone-200 text-[13px] font-mono">
          <span className="text-stone-400">
            成功率: <span className="text-emerald-400">{stats.successRate}%</span>
          </span>
          <span className="text-stone-400">
            平均耗时: <span className="text-cyan-400">{(stats.avgDuration / 1000).toFixed(1)}s</span>
          </span>
          <span className="text-stone-400">
            总任务: <span className="text-stone-500">{stats.totalTasks}</span>
          </span>
        </div>
      )}

      {/* 活动任务列表 */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {activeTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-stone-300">
            <Activity className="w-8 h-8 mb-2 opacity-30" />
            <span className="text-sm font-mono">无活动任务</span>
          </div>
        ) : (
          activeTasks.map(task => (
            <TaskProgressItem
              key={task.id}
              task={task}
              onPause={() => pauseTask(task.id)}
              onResume={() => resumeTask(task.id)}
              onRetry={() => retryFailedTask(task.id)}
              onRemove={() => removeActiveExecution(task.id)}
            />
          ))
        )}

        {/* 失败/中断任务（可重试） */}
        {failedTasks.length > 0 && (
          <div className="mt-4">
            <div className="text-[13px] font-mono text-stone-400 uppercase tracking-wide mb-2">
              需要关注 ({failedTasks.length})
            </div>
            {failedTasks.slice(0, 3).map(task => (
              <TaskProgressItem
                key={task.id}
                task={task}
                onPause={() => {}}
                onResume={() => {}}
                onRetry={() => retryFailedTask(task.id)}
                onRemove={() => removeActiveExecution(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 最近日志 (可折叠) */}
      <div className="border-t border-stone-200">
        <button
          onClick={() => setLogsExpanded(!logsExpanded)}
          className="w-full flex items-center justify-between px-4 py-2 text-sm font-mono text-stone-400 hover:bg-stone-100/80 transition-colors"
        >
          <span>最近事件 ({logs.length})</span>
          {logsExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
        {logsExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="max-h-40 overflow-y-auto px-4 pb-2"
          >
            {logs.length === 0 ? (
              <div className="text-center text-[13px] font-mono text-stone-300 py-4">
                暂无执行日志
              </div>
            ) : (
              logs.slice().reverse().map(log => (
                <LogEntry key={log.id} log={log} />
              ))
            )}
          </motion.div>
        )}
      </div>
    </div>
  )
}
