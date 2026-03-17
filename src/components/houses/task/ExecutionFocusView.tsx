import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play, Loader2, Brain, Wrench, Terminal,
  MessageSquare, AlertCircle, CheckCircle2, XCircle,
  Activity, ChevronDown, Clock, Pause, SkipForward, Zap, Code,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useStore } from '@/store'
import type { TaskItem, ExecutionStep, SubTask, TaskPlan } from '@/types'
import { useState } from 'react'

// --- 执行步骤图标 ---
const stepTypeConfig = {
  thinking: { icon: Brain, color: 'purple' },
  tool_call: { icon: Wrench, color: 'cyan' },
  tool_result: { icon: Terminal, color: 'emerald' },
  output: { icon: MessageSquare, color: 'amber' },
  error: { icon: AlertCircle, color: 'red' },
}

const stepTypeLabels: Record<string, string> = {
  thinking: '思考',
  tool_call: '工具调用',
  tool_result: '工具结果',
  output: '输出',
  error: '错误',
}

// --- 子任务状态 ---
const subTaskStatusConfig = {
  pending: { icon: Clock, color: 'slate', label: '等待' },
  ready: { icon: Play, color: 'green', label: '就绪' },
  executing: { icon: Loader2, color: 'cyan', label: '执行中' },
  done: { icon: CheckCircle2, color: 'emerald', label: '完成' },
  failed: { icon: XCircle, color: 'red', label: '失败' },
  blocked: { icon: Pause, color: 'amber', label: '阻塞' },
  skipped: { icon: SkipForward, color: 'slate', label: '跳过' },
  paused_for_approval: { icon: AlertCircle, color: 'yellow', label: '待确认' },
}

// --- 进度条 ---
function TaskProgressBar({ plan }: { plan: TaskPlan }) {
  const subTasks = plan.subTasks || []
  const completed = subTasks.filter(t => t.status === 'done' || t.status === 'skipped').length
  const failed = subTasks.filter(t => t.status === 'failed').length
  const blocked = subTasks.filter(t => t.status === 'blocked').length
  const executing = subTasks.filter(t => t.status === 'executing').length
  const total = subTasks.length
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="mb-3">
      <div className="h-2 bg-stone-100 rounded-full overflow-hidden mb-2">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className={cn(
            'h-full rounded-full',
            failed > 0 ? 'bg-gradient-to-r from-emerald-500 to-red-500' : 'bg-gradient-to-r from-cyan-500 to-emerald-500'
          )}
        />
      </div>
      <div className="flex items-center gap-3 text-[13px] font-mono">
        <span className="text-stone-400">{completed}/{total} 完成</span>
        {executing > 0 && (
          <span className="flex items-center gap-1 text-cyan-400">
            <Play className="w-3.5 h-3.5" /> {executing} 执行中
          </span>
        )}
        {blocked > 0 && (
          <span className="flex items-center gap-1 text-amber-400">
            <Pause className="w-3.5 h-3.5" /> {blocked} 阻塞
          </span>
        )}
        {failed > 0 && (
          <span className="flex items-center gap-1 text-red-400">
            <XCircle className="w-3.5 h-3.5" /> {failed} 失败
          </span>
        )}
      </div>
    </div>
  )
}

// --- 子任务树 ---
function getTaskLayers(subTasks: SubTask[]): SubTask[][] {
  if (!subTasks || !Array.isArray(subTasks) || subTasks.length === 0) {
    return []
  }
  const layers: SubTask[][] = []
  const completed = new Set<string>()
  const remaining = [...subTasks]

  while (remaining.length > 0) {
    const ready = remaining.filter(task =>
      task.dependsOn.every(dep => completed.has(dep))
    )
    if (ready.length === 0) {
      layers.push(remaining)
      break
    }
    layers.push(ready)
    ready.forEach(t => completed.add(t.id))
    ready.forEach(t => {
      const idx = remaining.findIndex(r => r.id === t.id)
      if (idx >= 0) remaining.splice(idx, 1)
    })
  }
  return layers
}

function SubTaskTreeView({ plan }: { plan: TaskPlan }) {
  const [expanded, setExpanded] = useState(true)
  const subTasks = plan.subTasks || []
  const layers = getTaskLayers(subTasks)

  return (
    <div className="rounded-lg border border-stone-200 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-stone-100/80 hover:bg-white/8 transition-colors"
      >
        <Activity className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-mono text-stone-500">
          子任务 ({subTasks.length})
        </span>
        <motion.div animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="ml-auto">
          <ChevronDown className="w-3.5 h-3.5 text-stone-300" />
        </motion.div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="p-3 space-y-2 max-h-[50vh] overflow-y-auto">
              {layers.map((layer, layerIdx) => (
                <div key={layerIdx} className="space-y-1.5">
                  {layers.length > 1 && (
                    <div className="flex items-center gap-2 text-xs font-mono text-stone-300 mb-1">
                      <div className="h-px flex-1 bg-stone-100" />
                      <span>Layer {layerIdx}</span>
                      <div className="h-px flex-1 bg-stone-100" />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {layer.map(task => {
                      const config = subTaskStatusConfig[task.status] || subTaskStatusConfig.pending
                      const StatusIcon = config.icon
                      const isExec = task.status === 'executing'
                      return (
                        <div key={task.id} className={cn(
                          'flex-1 min-w-[200px] p-3 rounded-lg border transition-all',
                          task.status === 'done' && 'bg-emerald-500/5 border-emerald-500/20',
                          task.status === 'failed' && 'bg-red-500/5 border-red-500/20',
                          task.status === 'executing' && 'bg-cyan-500/5 border-cyan-500/30 animate-pulse',
                          task.status === 'blocked' && 'bg-amber-500/5 border-amber-500/20',
                          task.status === 'paused_for_approval' && 'bg-yellow-500/10 border-yellow-500/30',
                          task.status === 'pending' && 'bg-white/3 border-stone-200',
                          task.status === 'ready' && 'bg-green-500/5 border-green-500/20',
                          task.status === 'skipped' && 'bg-white/3 border-stone-200 opacity-50',
                        )}>
                          <div className="flex items-start gap-2">
                            <div className={cn('w-6 h-6 rounded flex items-center justify-center flex-shrink-0', `bg-${config.color}-500/20`)}>
                              <StatusIcon className={cn('w-3.5 h-3.5', `text-${config.color}-400`, isExec && 'animate-spin')} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[13px] font-mono text-stone-400">[{task.id}]</span>
                                <span className={cn('text-[13px] font-mono', `text-${config.color}-400`)}>{config.label}</span>
                              </div>
                              <p className="text-sm text-stone-600 mt-0.5 leading-relaxed line-clamp-2">{task.description}</p>
                              {task.dependsOn.length > 0 && (
                                <div className="flex items-center gap-1 mt-1 text-xs text-stone-300">
                                  <span>依赖:</span>
                                  {task.dependsOn.map(dep => (
                                    <span key={dep} className="bg-stone-100 px-1 rounded">{dep}</span>
                                  ))}
                                </div>
                              )}
                              {task.result && task.status === 'done' && (
                                <p className="text-[13px] text-emerald-400/70 mt-1 line-clamp-1">+ {task.result.slice(0, 50)}...</p>
                              )}
                              {task.error && (
                                <p className="text-[13px] text-red-400/70 mt-1 line-clamp-1">x {task.error}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// --- 工具参数展示块 ---
function ToolArgsBlock({ args }: { args: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)
  const entries = Object.entries(args)
  if (entries.length === 0) return null

  // 简短预览 (折叠状态)
  const preview = entries
    .slice(0, 3)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v)
      return `${k}: ${String(val).slice(0, 60)}`
    })
    .join(' | ')

  return (
    <div className="mt-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-xs font-mono text-cyan-400/50 hover:text-cyan-400/80 transition-colors"
      >
        <Code className="w-3 h-3" />
        <span>{expanded ? '收起参数' : '查看参数'}</span>
        {!expanded && entries.length > 3 && <span className="text-stone-300">+{entries.length - 3}</span>}
      </button>
      {expanded ? (
        <pre className="mt-1 p-2 bg-stone-100/80 rounded text-xs text-stone-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-y-auto border border-stone-100">
          {JSON.stringify(args, null, 2)}
        </pre>
      ) : (
        <p className="text-xs text-stone-300 font-mono mt-0.5 truncate">{preview}</p>
      )}
    </div>
  )
}

// --- 执行步骤查看器 ---
function ExecutionStepsViewer({ steps, output, error, duration }: {
  steps?: ExecutionStep[]
  output?: string
  error?: string
  duration?: number
}) {
  const [stepsExpanded, setStepsExpanded] = useState(true) // 执行视图中默认展开
  const scrollRef = useRef<HTMLDivElement>(null)
  
  // 一键修复功能
  const openNexusPanelWithInput = useStore((s) => s.openNexusPanelWithInput)
  const addToast = useStore((s) => s.addToast)
  
  const handleOneClickFix = () => {
    const prompt = `我在执行任务时遇到了错误，请帮我分析并修复：\n\n\`\`\`\n${error}\n\`\`\`\n\n请分析错误原因并给出解决方案。`
    openNexusPanelWithInput('skill-scout', prompt)
    addToast({ type: 'info', title: '已填入修复需求，请按回车执行' })
  }

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current && stepsExpanded) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [steps?.length, stepsExpanded])

  if (!steps?.length && !output && !error) {
    return (
      <div className="p-3 bg-stone-100/80 rounded-lg border border-stone-200">
        <p className="text-xs text-stone-400 font-mono">暂无执行记录</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {output && (
        <div className="p-4 bg-emerald-500/5 rounded-lg border border-emerald-500/15">
          <div className="flex items-center gap-1.5 mb-1.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-mono text-emerald-400 font-medium">执行结果</span>
            {duration !== undefined && (
              <span className="text-[13px] font-mono text-stone-300 ml-auto">{(duration / 1000).toFixed(1)}s</span>
            )}
          </div>
          <pre className="text-sm text-stone-600 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto font-mono">{output}</pre>
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-500/5 rounded-lg border border-red-500/15">
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertCircle className="w-4 h-4 text-red-400" />
            <span className="text-sm font-mono text-red-400 font-medium">执行错误</span>
            <button
              onClick={handleOneClickFix}
              className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/15 text-amber-400 text-[13px] font-mono hover:bg-amber-500/25 transition-colors"
            >
              <Zap className="w-3.5 h-3.5" />
              一键修复
            </button>
          </div>
          <p className="text-sm text-red-300/80 font-mono">{error}</p>
        </div>
      )}

      {steps && steps.length > 0 && (
        <div className="rounded-lg border border-stone-200 overflow-hidden">
          <button
            onClick={() => setStepsExpanded(!stepsExpanded)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-stone-100/80 hover:bg-white/8 transition-colors"
          >
            <Activity className="w-4 h-4 text-stone-400" />
            <span className="text-sm font-mono text-stone-400">执行步骤 ({steps.length})</span>
            <motion.div animate={{ rotate: stepsExpanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="ml-auto">
              <ChevronDown className="w-3.5 h-3.5 text-stone-300" />
            </motion.div>
          </button>

          <AnimatePresence>
            {stepsExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div ref={scrollRef} className="max-h-[50vh] overflow-y-auto">
                  {steps.map((step, i) => {
                    const sConfig = stepTypeConfig[step.type] || stepTypeConfig.output
                    const StepIcon = sConfig.icon
                    const label = stepTypeLabels[step.type] || '输出'
                    const hasToolArgs = step.type === 'tool_call' && step.toolArgs && Object.keys(step.toolArgs).length > 0
                    return (
                      <div key={step.id || i} className="flex gap-2.5 px-3 py-2.5 border-t border-stone-100 hover:bg-white/3">
                        <div className={cn('w-6 h-6 rounded flex items-center justify-center flex-shrink-0 mt-0.5', `bg-${sConfig.color}-500/15`)}>
                          <StepIcon className={cn('w-3.5 h-3.5', `text-${sConfig.color}-400`)} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn('text-sm font-mono font-medium', `text-${sConfig.color}-400`)}>{label}</span>
                            {step.toolName && (
                              <span className="text-[13px] font-mono text-stone-300 bg-stone-100/80 px-1.5 rounded">{step.toolName}</span>
                            )}
                            {step.duration !== undefined && (
                              <span className="text-[13px] font-mono text-stone-300 ml-auto">{step.duration}ms</span>
                            )}
                          </div>
                          <p className="text-[13px] text-stone-500 font-mono mt-0.5 whitespace-pre-wrap break-all leading-relaxed line-clamp-6">
                            {step.content}
                          </p>
                          {hasToolArgs && (
                            <ToolArgsBlock args={step.toolArgs!} />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}

// ============================================
// ExecutionFocusView 主组件
// ============================================

interface ExecutionFocusViewProps {
  task: TaskItem
  onTerminate: (taskId: string) => void
}

export function ExecutionFocusView({ task, onTerminate }: ExecutionFocusViewProps) {
  // 获取最新步骤摘要
  const latestStep = task.executionSteps?.length
    ? task.executionSteps[task.executionSteps.length - 1]
    : null

  const latestSummary = latestStep
    ? `${stepTypeLabels[latestStep.type] || '处理中'}${latestStep.toolName ? `: ${latestStep.toolName}` : ''}`
    : '正在准备...'

  return (
    <div className="flex flex-col p-6 min-h-0 max-h-[80vh]">
      {/* 顶部状态栏 */}
      <div className="flex items-center gap-3 p-4 bg-cyan-500/5 border border-cyan-500/20 rounded-lg mb-4 flex-shrink-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-base font-mono text-cyan-600 truncate">
              {task.title}
            </h2>
            <p className="text-sm font-mono text-stone-400 truncate mt-0.5">
              {latestSummary}
            </p>
          </div>
        </div>

        {/* 终止按钮 */}
        <button
          onClick={() => onTerminate(task.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/15 text-red-400 text-sm font-mono
                     rounded-lg hover:bg-red-500/25 transition-colors flex-shrink-0 border border-red-500/20"
        >
          <XCircle className="w-4 h-4" />
          终止
        </button>
      </div>

      {/* 执行详情区域 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {task.taskPlan ? (
          <div className="space-y-3">
            <TaskProgressBar plan={task.taskPlan} />
            <SubTaskTreeView plan={task.taskPlan} />
          </div>
        ) : (
          <ExecutionStepsViewer
            steps={task.executionSteps}
            output={task.executionOutput}
            error={task.executionError}
            duration={task.executionDuration}
          />
        )}
      </div>
    </div>
  )
}
