/**
 * AgentRunStatePanel - V2 实时 Agent 状态面板
 *
 * 订阅 agentEventBus，实时展示：
 * - 运行阶段 (phase) 和轮次
 * - 工具执行时间轴
 * - Token 使用率
 * - Reflexion/Approval 事件
 * - 子智能体状态
 */

import { useEffect, useState, useRef, useCallback, forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity, Wrench, Brain, Shield, AlertTriangle,
  CheckCircle2, XCircle, Clock, Cpu, Gauge,
  GitBranch, Zap, MessageSquare, RefreshCw,
  Pause, ShieldAlert, RotateCcw, StopCircle,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import type { AgentRunState, AgentEventEnvelope, AgentPhase } from '@/types'
import { agentEventBus } from '@/services/agentEventBus'

// ============================================
// Phase 配置 (覆盖所有 AgentPhase)
// ============================================

const PHASE_CONFIG: Record<AgentPhase, { label: string; color: string; icon: typeof Activity }> = {
  idle:              { label: '空闲',     color: 'slate',   icon: Clock },
  planning:          { label: '规划中',   color: 'purple',  icon: Brain },
  executing:         { label: '执行中',   color: 'cyan',    icon: Wrench },
  reflecting:        { label: '反思中',   color: 'amber',   icon: RefreshCw },
  compacting:        { label: '压缩中',   color: 'blue',    icon: Pause },
  waiting_approval:  { label: '待审批',   color: 'yellow',  icon: ShieldAlert },
  recovering:        { label: '恢复中',   color: 'orange',  icon: RotateCcw },
  done:              { label: '完成',     color: 'emerald', icon: CheckCircle2 },
  error:             { label: '错误',     color: 'red',     icon: XCircle },
  aborted:           { label: '已终止',   color: 'gray',    icon: StopCircle },
}

// ============================================
// 工具事件卡片
// ============================================

interface ToolEvent {
  callId: string
  name: string
  status: 'running' | 'success' | 'error'
  startTime: number
  endTime?: number
  latencyMs?: number
  isMutating: boolean
}

const ToolEventCard = forwardRef<HTMLDivElement, { tool: ToolEvent }>(
  function ToolEventCard({ tool }, ref) {
    const isRunning = tool.status === 'running'
    const isError = tool.status === 'error'

    return (
      <motion.div
        ref={ref}
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        className={cn(
          'flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-mono',
          isRunning && 'bg-cyan-500/10 border-cyan-500/30 text-cyan-300',
          tool.status === 'success' && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300',
          isError && 'bg-red-500/10 border-red-500/20 text-red-300',
        )}
      >
        {isRunning ? (
          <Wrench className="w-3.5 h-3.5 animate-spin" />
        ) : isError ? (
          <XCircle className="w-3.5 h-3.5" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5" />
        )}
        <span className="flex-1 truncate">{tool.name}</span>
        {tool.isMutating && (
          <Shield className="w-3 h-3 text-amber-400" />
        )}
        {tool.latencyMs !== undefined && (
          <span className="text-stone-400">{tool.latencyMs}ms</span>
        )}
      </motion.div>
    )
  },
)

// ============================================
// Token 使用率条
// ============================================

function TokenBar({ used, budget }: { used: number; budget: number }) {
  if (budget <= 0) return null
  const ratio = Math.min(1, used / budget)
  const pct = Math.round(ratio * 100)
  const isWarning = ratio > 0.7
  const isDanger = ratio > 0.9

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono text-stone-400">
        <span className="flex items-center gap-1">
          <Gauge className="w-3 h-3" /> Token 使用率
        </span>
        <span className={cn(
          isDanger && 'text-red-400',
          isWarning && !isDanger && 'text-amber-400',
        )}>
          ~{(used / 1000).toFixed(1)}K / {(budget / 1000).toFixed(0)}K ({pct}%)
        </span>
      </div>
      <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.3 }}
          className={cn(
            'h-full rounded-full',
            isDanger ? 'bg-red-500' : isWarning ? 'bg-amber-500' : 'bg-cyan-500',
          )}
        />
      </div>
    </div>
  )
}

// ============================================
// 主面板
// ============================================

export function AgentRunStatePanel() {
  const [state, setState] = useState<AgentRunState | null>(null)
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([])
  const [recentEvents, setRecentEvents] = useState<AgentEventEnvelope[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  // ── RAF 攒批 refs ──
  const pendingToolStartsRef = useRef<ToolEvent[]>([])
  const pendingToolUpdatesRef = useRef<Map<string, Partial<ToolEvent>>>(new Map())
  const pendingRecentEventsRef = useRef<AgentEventEnvelope[]>([])
  const shouldClearRef = useRef(false)
  const rafIdRef = useRef<number>(0)

  const flushBatch = useCallback(() => {
    rafIdRef.current = 0

    // 状态同步（始终取最新快照）
    setState({ ...agentEventBus.getState() })

    // run_start 清空
    if (shouldClearRef.current) {
      setToolEvents([])
      setRecentEvents([])
      shouldClearRef.current = false
      pendingToolStartsRef.current = []
      pendingToolUpdatesRef.current.clear()
      pendingRecentEventsRef.current = []
      return
    }

    // 合并 tool 事件
    const newStarts = pendingToolStartsRef.current
    const updates = pendingToolUpdatesRef.current
    if (newStarts.length > 0 || updates.size > 0) {
      setToolEvents(prev => {
        let result = [...prev, ...newStarts]
        if (updates.size > 0) {
          result = result.map(t => {
            const patch = updates.get(t.callId)
            return patch ? { ...t, ...patch } : t
          })
        }
        return result
      })
      pendingToolStartsRef.current = []
      pendingToolUpdatesRef.current.clear()
    }

    // 合并 recent events
    const newRecent = pendingRecentEventsRef.current
    if (newRecent.length > 0) {
      setRecentEvents(prev => [...prev, ...newRecent].slice(-30))
      pendingRecentEventsRef.current = []
    }
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current === 0) {
      rafIdRef.current = requestAnimationFrame(flushBatch)
    }
  }, [flushBatch])

  useEffect(() => {
    const unsub = agentEventBus.subscribe((event: AgentEventEnvelope) => {
      // 工具事件 → 收集到 ref
      if (event.stream === 'tool') {
        if (event.type === 'tool_start') {
          const data = event.data as any
          pendingToolStartsRef.current.push({
            callId: data.callId,
            name: data.toolName,
            status: 'running',
            startTime: Date.now(),
            isMutating: data.isMutating || false,
          })
        } else if (event.type === 'tool_end') {
          const data = event.data as any
          pendingToolUpdatesRef.current.set(data.callId, {
            status: data.success ? 'success' as const : 'error' as const,
            endTime: Date.now(),
            latencyMs: data.latencyMs,
          })
        } else if (event.type === 'tool_error') {
          const data = event.data as any
          pendingToolUpdatesRef.current.set(data.callId, {
            status: 'error' as const,
            endTime: Date.now(),
          })
        }
      }

      // run_start 清空标记
      if (event.stream === 'lifecycle' && event.type === 'run_start') {
        shouldClearRef.current = true
      }

      // 收集 recent events
      pendingRecentEventsRef.current.push(event)

      scheduleFlush()
    })

    // 初始状态
    setState({ ...agentEventBus.getState() })

    return () => {
      unsub()
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
    }
  }, [scheduleFlush])

  // idle 状态下显示空状态
  const isIdle = !state || state.phase === 'idle'

  if (isIdle) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 text-stone-300">
        <Activity className="w-10 h-10 mb-3 opacity-50" />
        <p className="text-sm font-mono">等待 Agent 运行</p>
        <p className="text-xs font-mono mt-1 text-stone-300">
          发送消息后，实时状态将显示在这里
        </p>
      </div>
    )
  }

  const phaseConf = PHASE_CONFIG[state.phase] || PHASE_CONFIG.idle
  const PhaseIcon = phaseConf.icon
  const isActive = !['done', 'error', 'aborted'].includes(state.phase)

  // 计算统计
  const completedTools = toolEvents.filter(t => t.status !== 'running').length
  const successTools = toolEvents.filter(t => t.status === 'success').length
  const errorTools = toolEvents.filter(t => t.status === 'error').length
  const runningTools = toolEvents.filter(t => t.status === 'running').length

  // 从 toolHistory 获取轮次信息
  const turnCount = state.toolHistory.length > 0 ? state.toolHistory.length : 0

  return (
    <div className="p-4 space-y-4 overflow-y-auto h-full" ref={scrollRef}>
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <motion.div
            animate={isActive ? { scale: [1, 1.2, 1] } : {}}
            transition={{ repeat: Infinity, duration: 2 }}
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              `bg-${phaseConf.color}-500/20`,
            )}
          >
            <PhaseIcon className={cn(
              'w-4 h-4',
              `text-${phaseConf.color}-400`,
              isActive && 'animate-pulse',
            )} />
          </motion.div>
          <div>
            <div className="text-sm font-mono text-stone-800">{phaseConf.label}</div>
            <div className="text-[10px] font-mono text-stone-400">
              Tools: {turnCount} | Run: {state.runId.slice(0, 12)}...
            </div>
          </div>
        </div>

        {/* 模型标签 */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-stone-100/80 border border-stone-200">
          <Cpu className="w-3 h-3 text-stone-400" />
          <span className="text-[10px] font-mono text-stone-400">{state.currentModel}</span>
        </div>
      </div>

      {/* Token 使用率 */}
      <TokenBar used={state.tokenUsed} budget={state.tokenBudget} />

      {/* 统计数字 */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: '完成', value: completedTools, icon: RefreshCw, color: 'cyan' },
          { label: '成功', value: successTools, icon: CheckCircle2, color: 'emerald' },
          { label: '错误', value: errorTools, icon: XCircle, color: 'red' },
          { label: '运行中', value: runningTools, icon: Zap, color: 'amber' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="text-center px-2 py-2 rounded-lg bg-stone-100/80 border border-stone-100">
            <Icon className={cn('w-3.5 h-3.5 mx-auto mb-1', `text-${color}-400`)} />
            <div className="text-sm font-mono text-stone-700">{value}</div>
            <div className="text-[9px] font-mono text-stone-300">{label}</div>
          </div>
        ))}
      </div>

      {/* 工具执行时间轴 */}
      {toolEvents.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-stone-400">
            <Wrench className="w-3 h-3" />
            <span>工具执行 ({toolEvents.length})</span>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            <AnimatePresence mode="popLayout">
              {toolEvents.slice(-10).map(tool => (
                <ToolEventCard key={tool.callId} tool={tool} />
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Reflexion 指示器 */}
      {state.reflexionCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <Brain className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-mono text-amber-300">
            Reflexion {state.reflexionCount}x
          </span>
          {state.phase === 'reflecting' && (
            <span className="text-[10px] text-amber-400/60 animate-pulse ml-auto">反思中...</span>
          )}
        </div>
      )}

      {/* 审批指示器 */}
      {state.approvalPending && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/30"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 animate-pulse" />
          <span className="text-xs font-mono text-yellow-300">需要用户审批</span>
        </motion.div>
      )}

      {/* 子智能体 */}
      {state.activeChildren.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-stone-400">
            <GitBranch className="w-3 h-3" />
            <span>子智能体 ({state.activeChildren.length})</span>
          </div>
          {state.activeChildren.map((id: string) => (
            <div key={id} className="flex items-center gap-2 px-3 py-1.5 rounded bg-stone-100/80 border border-stone-200 text-[10px] font-mono text-stone-400">
              <Cpu className="w-3 h-3" />
              <span className="truncate">{id}</span>
            </div>
          ))}
        </div>
      )}

      {/* 最近事件流 */}
      {recentEvents.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-stone-400">
            <MessageSquare className="w-3 h-3" />
            <span>事件流 (最近)</span>
          </div>
          <div className="max-h-32 overflow-y-auto space-y-0.5">
            {recentEvents.slice(-8).map(ev => (
              <div
                key={`${ev.seq}-${ev.ts}`}
                className="flex items-center gap-2 px-2 py-1 text-[9px] font-mono text-stone-300 rounded bg-stone-50"
              >
                <span className="text-stone-300 w-5 text-right">#{ev.seq}</span>
                <span className={cn(
                  'px-1 rounded text-[8px]',
                  ev.stream === 'lifecycle' && 'bg-purple-500/20 text-purple-300',
                  ev.stream === 'tool' && 'bg-cyan-500/20 text-cyan-300',
                  ev.stream === 'assistant' && 'bg-blue-500/20 text-blue-300',
                  ev.stream === 'recovery' && 'bg-red-500/20 text-red-300',
                  ev.stream === 'reflexion' && 'bg-amber-500/20 text-amber-300',
                  ev.stream === 'approval' && 'bg-yellow-500/20 text-yellow-300',
                  ev.stream === 'child' && 'bg-green-500/20 text-green-300',
                )}>
                  {ev.stream}
                </span>
                <span className="truncate">{ev.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
