import { useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play, Loader2, Brain, Wrench, Terminal,
  MessageSquare, AlertCircle, CheckCircle2, XCircle,
  Activity, ChevronDown, Clock, Pause, SkipForward, Zap, Code,
  Search, FileText, RefreshCw, ShieldAlert, GitBranch, Eye, Sparkles,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useStore } from '@/store'
import type { TaskItem, ExecutionStep, SubTask, TaskPlan, AgentPhase, AgentEventEnvelope } from '@/types'
import { agentEventBus } from '@/services/agentEventBus'
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

// ============================================
// 实时事件流 - 打字机式展示 Agent 正在做什么
// ============================================

interface LiveEvent {
  id: string
  icon: typeof Brain
  iconColor: string
  label: string
  detail?: string
  status: 'active' | 'done' | 'error'
  timestamp: number
  elapsedMs?: number
}

const TOOL_DISPLAY_MAP: Record<string, { icon: typeof Wrench; label: string }> = {
  readFile:      { icon: FileText,  label: '读取文件' },
  writeFile:     { icon: FileText,  label: '写入文件' },
  appendFile:    { icon: FileText,  label: '追加文件' },
  listDir:       { icon: Eye,       label: '浏览目录' },
  searchFiles:   { icon: Search,    label: '搜索文件' },
  runCmd:        { icon: Terminal,   label: '执行命令' },
  webSearch:     { icon: Search,    label: '网络搜索' },
  webFetch:      { icon: Search,    label: '抓取网页' },
  saveMemory:    { icon: Brain,      label: '保存记忆' },
  searchMemory:  { icon: Search,    label: '搜索记忆' },
  generateSkill: { icon: Sparkles,  label: '生成技能' },
}

function getToolIcon(toolName: string): { icon: typeof Wrench; label: string } {
  return TOOL_DISPLAY_MAP[toolName] || { icon: Wrench, label: toolName }
}

const PHASE_LABELS: Record<AgentPhase, { icon: typeof Brain; color: string; label: string }> = {
  idle:             { icon: Clock,        color: 'stone',   label: '待命中' },
  planning:         { icon: Brain,        color: 'purple',  label: '深度思考中' },
  executing:        { icon: Wrench,       color: 'cyan',    label: '执行中' },
  reflecting:       { icon: RefreshCw,    color: 'amber',   label: '反思中' },
  compacting:       { icon: GitBranch,    color: 'blue',    label: '压缩上下文' },
  waiting_approval: { icon: ShieldAlert,  color: 'yellow',  label: '等待确认' },
  recovering:       { icon: RefreshCw,    color: 'orange',  label: '恢复中' },
  done:             { icon: CheckCircle2, color: 'emerald', label: '完成' },
  error:            { icon: XCircle,      color: 'red',     label: '出错' },
  aborted:          { icon: XCircle,      color: 'gray',    label: '已终止' },
}

/** 事件列表上限，防止长任务内存膨胀 */
const MAX_LIVE_EVENTS = 100

/** 事件更新描述：匹配函数 + 补丁 */
interface EventUpdateEntry {
  match: (e: LiveEvent) => boolean
  patch: Partial<LiveEvent>
}

/** phase 变化批次描述 */
interface PhaseBatchEntry {
  clearThinking: boolean
  newPhase?: AgentPhase
  phaseEntry?: LiveEvent
  markAllDone?: boolean
}

function LiveEventStream({ isExecuting }: { isExecuting: boolean }) {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [currentPhase, setCurrentPhase] = useState<AgentPhase>(() => {
    const state = agentEventBus.getState()
    return state.phase || 'idle'
  })
  const [phaseElapsed, setPhaseElapsed] = useState(0)
  const [thinkingPreview, setThinkingPreview] = useState('')
  const phaseStartRef = useRef(Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── RAF 攒批 refs ──
  const thinkingBufferRef = useRef('')
  const newEntriesRef = useRef<LiveEvent[]>([])
  const eventUpdatesRef = useRef<EventUpdateEntry[]>([])
  const phaseEventsRef = useRef<PhaseBatchEntry[]>([])
  const shouldClearRef = useRef(false)
  const rafIdRef = useRef<number>(0)

  // 挂载时从 eventBus 当前状态初始化（解决时序问题）
  useEffect(() => {
    if (!isExecuting) return
    const state = agentEventBus.getState()
    if (state.runId && state.runId !== 'none' && state.phase !== 'idle') {
      setCurrentPhase(state.phase)
      phaseStartRef.current = Date.now()

      const initialEvents: LiveEvent[] = []

      // 添加当前阶段条目
      const phaseDisplay = PHASE_LABELS[state.phase]
      const terminalPhases: AgentPhase[] = ['done', 'error', 'aborted']
      initialEvents.push({
        id: `init-phase-${state.phase}`,
        icon: phaseDisplay.icon,
        iconColor: phaseDisplay.color,
        label: phaseDisplay.label,
        status: terminalPhases.includes(state.phase) ? 'done' : 'active',
        timestamp: Date.now(),
      })

      // 从工具历史构建已完成的条目
      for (const tool of state.toolHistory) {
        const toolDisplay = getToolIcon(tool.toolName)
        initialEvents.push({
          id: `init-tool-${tool.callId}`,
          icon: toolDisplay.icon,
          iconColor: tool.status === 'success' ? 'emerald' : 'red',
          label: `${toolDisplay.label} · ${(tool.durationMs / 1000).toFixed(1)}s`,
          detail: tool.toolName,
          status: tool.status === 'success' ? 'done' : 'error',
          timestamp: tool.timestamp,
        })
      }

      // 如果当前有正在执行的工具，添加 active 条目
      if (state.currentTool) {
        const toolDisplay = getToolIcon(state.currentTool.name)
        initialEvents.push({
          id: `init-current-${state.currentTool.callId}`,
          icon: toolDisplay.icon,
          iconColor: 'cyan',
          label: toolDisplay.label,
          detail: state.currentTool.name,
          status: 'active',
          timestamp: state.currentTool.startTime,
        })
      }

      if (initialEvents.length > 0) {
        setEvents(initialEvents.slice(-MAX_LIVE_EVENTS))
      }
    }
  }, [isExecuting])

  // 阶段计时器
  useEffect(() => {
    const terminalPhases: AgentPhase[] = ['idle', 'done', 'error', 'aborted']
    if (terminalPhases.includes(currentPhase) || !isExecuting) return
    const timer = setInterval(() => {
      setPhaseElapsed(Math.floor((Date.now() - phaseStartRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [currentPhase, isExecuting])

  // ── RAF flush 逻辑 ──
  const flushBatch = useCallback(() => {
    rafIdRef.current = 0

    // run_start 清空
    if (shouldClearRef.current) {
      setEvents([])
      setThinkingPreview('')
      setCurrentPhase('planning')
      phaseStartRef.current = Date.now()
      shouldClearRef.current = false
      newEntriesRef.current = []
      eventUpdatesRef.current = []
      phaseEventsRef.current = []
      thinkingBufferRef.current = ''
      return
    }

    // 处理 phase 变化
    const phaseEvents = phaseEventsRef.current
    phaseEventsRef.current = []
    for (const pe of phaseEvents) {
      if (pe.clearThinking) {
        setThinkingPreview('')
        thinkingBufferRef.current = ''
      }
      if (pe.newPhase) {
        setCurrentPhase(pe.newPhase)
        phaseStartRef.current = Date.now()
        setPhaseElapsed(0)
      }
    }

    // 合并 thinking delta
    if (thinkingBufferRef.current) {
      const buffer = thinkingBufferRef.current
      thinkingBufferRef.current = ''
      setThinkingPreview(prev => {
        const updated = prev + buffer
        return updated.length > 200 ? updated.slice(-200) : updated
      })
    }

    // 合并事件：新增 + 更新，一次 setEvents
    const newEntries = newEntriesRef.current
    const updates = eventUpdatesRef.current
    const markAllDone = phaseEvents.some(pe => pe.markAllDone)
    const phaseEntries = phaseEvents.filter(pe => pe.phaseEntry).map(pe => pe.phaseEntry!)

    if (newEntries.length > 0 || updates.length > 0 || markAllDone || phaseEntries.length > 0) {
      newEntriesRef.current = []
      eventUpdatesRef.current = []

      setEvents(prev => {
        let result = [...prev]

        // 标记所有 active 为 done（phase_change / run_end）
        if (markAllDone) {
          result = result.map(e => e.status === 'active' ? { ...e, status: 'done' as const } : e)
        }

        // 应用更新（tool_end, step_complete, reflexion_end, approval_resolved）
        for (const upd of updates) {
          const lastIdx = [...result].reverse().findIndex(upd.match)
          if (lastIdx !== -1) {
            const realIdx = result.length - 1 - lastIdx
            result = result.map((e, idx) => idx === realIdx ? { ...e, ...upd.patch } : e)
          }
        }

        // 添加新条目（phase entries + tool/plan/reflexion/approval starts）
        result = [...result, ...phaseEntries, ...newEntries]

        // 事件列表上限
        if (result.length > MAX_LIVE_EVENTS) {
          result = result.slice(-MAX_LIVE_EVENTS)
        }

        return result
      })
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current === 0) {
      rafIdRef.current = requestAnimationFrame(flushBatch)
    }
  }, [flushBatch])

  // 订阅 agentEventBus（RAF 攒批模式）
  useEffect(() => {
    if (!isExecuting) return

    const unsubscribe = agentEventBus.subscribe((event: AgentEventEnvelope) => {
      const entryId = `${event.stream}-${event.type}-${event.seq}`

      switch (event.stream) {
        case 'lifecycle':
          if (event.type === 'phase_change') {
            const newPhase = event.data.to as AgentPhase
            const display = PHASE_LABELS[newPhase]
            const terminalPhases: AgentPhase[] = ['done', 'error', 'aborted']
            phaseEventsRef.current.push({
              clearThinking: false,
              newPhase,
              markAllDone: true,
              phaseEntry: {
                id: entryId,
                icon: display.icon,
                iconColor: display.color,
                label: display.label,
                status: terminalPhases.includes(newPhase) ? 'done' : 'active',
                timestamp: Date.now(),
              },
            })
          } else if (event.type === 'run_start') {
            shouldClearRef.current = true
          } else if (event.type === 'run_end') {
            const success = event.data.success as boolean
            phaseEventsRef.current.push({
              clearThinking: false,
              newPhase: success ? 'done' : 'error',
              markAllDone: true,
            })
          }
          break

        case 'assistant':
          if (event.type === 'text_delta' || event.type === 'thinking_delta') {
            thinkingBufferRef.current += event.data.delta as string
          } else if (event.type === 'message_end') {
            phaseEventsRef.current.push({ clearThinking: true })
          }
          break

        case 'tool':
          if (event.type === 'tool_start') {
            const toolName = event.data.toolName as string
            const toolDisplay = getToolIcon(toolName)
            phaseEventsRef.current.push({ clearThinking: true })
            newEntriesRef.current.push({
              id: entryId,
              icon: toolDisplay.icon,
              iconColor: 'cyan',
              label: toolDisplay.label,
              detail: toolName,
              status: 'active',
              timestamp: Date.now(),
            })
          } else if (event.type === 'tool_end') {
            const toolName = event.data.toolName as string
            const toolDisplay = getToolIcon(toolName)
            const durationMs = event.data.durationMs as number
            const success = event.data.success as boolean
            eventUpdatesRef.current.push({
              match: (e) => e.detail === toolName && e.status === 'active',
              patch: {
                status: success ? 'done' as const : 'error' as const,
                label: `${toolDisplay.label} · ${(durationMs / 1000).toFixed(1)}s`,
                elapsedMs: durationMs,
              },
            })
          } else if (event.type === 'tool_error') {
            const toolName = event.data.toolName as string
            eventUpdatesRef.current.push({
              match: (e) => e.detail === toolName && e.status === 'active',
              patch: { status: 'error' as const },
            })
          }
          break

        case 'plan':
          if (event.type === 'step_start') {
            const stepIndex = event.data.stepIndex as number
            const totalSteps = event.data.totalSteps as number
            newEntriesRef.current.push({
              id: entryId,
              icon: Zap,
              iconColor: 'amber',
              label: `步骤 ${stepIndex + 1}/${totalSteps}`,
              detail: event.data.description as string,
              status: 'active',
              timestamp: Date.now(),
            })
          } else if (event.type === 'step_complete') {
            const stepIndex = event.data.stepIndex as number
            const success = event.data.success as boolean
            eventUpdatesRef.current.push({
              match: (e) => e.label.startsWith(`步骤 ${stepIndex + 1}/`) && e.status === 'active',
              patch: { status: success ? 'done' as const : 'error' as const },
            })
          }
          break

        case 'reflexion':
          if (event.type === 'reflexion_start') {
            newEntriesRef.current.push({
              id: entryId,
              icon: RefreshCw,
              iconColor: 'amber',
              label: '反思中',
              detail: `工具 ${event.data.failedTool} 失败，重新规划...`,
              status: 'active',
              timestamp: Date.now(),
            })
          } else if (event.type === 'reflexion_end') {
            eventUpdatesRef.current.push({
              match: (e) => e.label === '反思中' && e.status === 'active',
              patch: { status: 'done' as const, label: '反思完成' },
            })
          }
          break

        case 'approval':
          if (event.type === 'approval_required') {
            newEntriesRef.current.push({
              id: entryId,
              icon: ShieldAlert,
              iconColor: 'yellow',
              label: '等待确认',
              detail: event.data.reason as string,
              status: 'active',
              timestamp: Date.now(),
            })
          } else if (event.type === 'approval_resolved') {
            const approved = event.data.approved as boolean
            eventUpdatesRef.current.push({
              match: (e) => e.label === '等待确认' && e.status === 'active',
              patch: { status: 'done' as const, label: approved ? '已批准' : '已拒绝' },
            })
          }
          break
      }

      scheduleFlush()
    })

    return () => {
      unsubscribe()
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
    }
  }, [isExecuting, scheduleFlush])

  // 自动滚动
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [events.length, thinkingPreview])

  if (events.length === 0 && !thinkingPreview && currentPhase === 'idle') return null

  const phaseConfig = PHASE_LABELS[currentPhase]
  const terminalPhases: AgentPhase[] = ['idle', 'done', 'error', 'aborted']
  const isActivePhase = !terminalPhases.includes(currentPhase)

  return (
    <div className="rounded-xl border border-stone-200 overflow-hidden mb-3 bg-white">
      {/* 阶段指示器头部 */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-stone-50/80 border-b border-stone-100">
        <div className={cn(
          'w-2 h-2 rounded-full',
          isActivePhase && 'animate-pulse',
          phaseConfig.color === 'purple' && 'bg-purple-400',
          phaseConfig.color === 'cyan' && 'bg-cyan-400',
          phaseConfig.color === 'amber' && 'bg-amber-400',
          phaseConfig.color === 'blue' && 'bg-blue-400',
          phaseConfig.color === 'yellow' && 'bg-yellow-400',
          phaseConfig.color === 'orange' && 'bg-orange-400',
          phaseConfig.color === 'emerald' && 'bg-emerald-400',
          phaseConfig.color === 'red' && 'bg-red-400',
          phaseConfig.color === 'stone' && 'bg-stone-400',
          phaseConfig.color === 'gray' && 'bg-gray-400',
        )} />
        <span className="text-xs font-mono font-bold text-stone-600">
          实时进度
        </span>
        <span className={cn(
          'text-xs font-mono font-medium ml-1',
          phaseConfig.color === 'purple' && 'text-purple-500',
          phaseConfig.color === 'cyan' && 'text-cyan-500',
          phaseConfig.color === 'amber' && 'text-amber-500',
          phaseConfig.color === 'emerald' && 'text-emerald-500',
          phaseConfig.color === 'red' && 'text-red-500',
          phaseConfig.color === 'stone' && 'text-stone-400',
        )}>
          {phaseConfig.label}
        </span>
        {isActivePhase && phaseElapsed > 0 && (
          <span className="text-xs font-mono text-stone-400 ml-auto">
            {phaseElapsed}s
          </span>
        )}
        {!isActivePhase && events.length > 0 && (
          <span className="text-xs font-mono text-stone-300 ml-auto">
            {events.filter(e => e.status === 'done').length} 步完成
          </span>
        )}
      </div>

      {/* 事件流列表 */}
      <div ref={scrollRef} className="max-h-[300px] overflow-y-auto">
        <AnimatePresence mode="popLayout">
          {events.map((event) => {
            const Icon = event.icon
            return (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: -8, height: 0 }}
                animate={{ opacity: 1, x: 0, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="flex items-center gap-2.5 px-4 py-2 border-b border-stone-50 last:border-0"
              >
                {/* 状态指示 */}
                <div className={cn(
                  'w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
                  event.status === 'active' && 'bg-cyan-50',
                  event.status === 'done' && 'bg-emerald-50',
                  event.status === 'error' && 'bg-red-50',
                )}>
                  {event.status === 'active' ? (
                    <Loader2 className="w-3 h-3 text-cyan-500 animate-spin" />
                  ) : event.status === 'done' ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-500" />
                  )}
                </div>

                {/* 操作图标 */}
                <Icon className={cn(
                  'w-3.5 h-3.5 flex-shrink-0',
                  event.status === 'done' && 'text-stone-400',
                  event.status === 'active' && 'text-stone-600',
                  event.status === 'error' && 'text-red-400',
                )} />

                {/* 标签 */}
                <span className={cn(
                  'text-xs font-mono font-medium',
                  event.status === 'active' && 'text-stone-700',
                  event.status === 'done' && 'text-stone-400',
                  event.status === 'error' && 'text-red-500',
                )}>
                  {event.label}
                </span>

                {/* 详情 */}
                {event.detail && (
                  <span className="text-xs font-mono text-stone-300 truncate max-w-[180px] ml-auto">
                    {event.detail}
                  </span>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>

        {/* 思考预览 (流式文字) */}
        {thinkingPreview && isActivePhase && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="px-4 py-2.5 border-t border-stone-100 bg-purple-50/30"
          >
            <div className="flex items-start gap-2">
              <Brain className="w-3.5 h-3.5 text-purple-400 mt-0.5 flex-shrink-0 animate-pulse" />
              <p className="text-xs font-mono text-purple-400/80 leading-relaxed line-clamp-3">
                {thinkingPreview}
                <span className="inline-block w-1 h-3 bg-purple-400/50 ml-0.5 animate-pulse" />
              </p>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}

// --- 执行步骤查看器 ---
function ExecutionStepsViewer({ steps, output, error, duration, isExecuting }: {
  steps?: ExecutionStep[]
  output?: string
  error?: string
  duration?: number
  isExecuting?: boolean
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

  return (
    <div className="space-y-2">
      {/* 实时事件流 (仅执行中显示) */}
      {isExecuting && <LiveEventStream isExecuting={isExecuting} />}

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

      {/* 无内容且非执行中时的空状态 */}
      {!isExecuting && !steps?.length && !output && !error && (
        <div className="p-3 bg-stone-100/80 rounded-lg border border-stone-200">
          <p className="text-xs text-stone-400 font-mono">暂无执行记录</p>
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
            isExecuting={task.status === 'executing'}
          />
        )}
      </div>
    </div>
  )
}
