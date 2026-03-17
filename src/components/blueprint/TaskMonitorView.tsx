/**
 * TaskMonitorView - Blueprint 任务监控矩阵
 *
 * 设计宪法:
 * - bg-white 表格 + bg-stone-50/50 表头
 * - text-[10px] font-black uppercase tracking-widest 表头
 * - 实时秒表 (useEffect + setInterval + startTime)
 * - 推流 reasoningBuffer
 */

import { useState, useEffect, useRef } from 'react'
import {
  Activity, CheckCircle2, AlertCircle, Clock, XCircle,
} from 'lucide-react'
import { useStore } from '@/store'
import { agentEventBus } from '@/services/agentEventBus'
import type { AgentRunState, AgentPhase, TaskItem } from '@/types'
import { SectionHeader } from './SectionHeader'
import { TaskDetailModal } from './TaskDetailModal'

// ── Phase 状态显示映射 ──
const STATUS_MAP: Record<string, {
  label: string
  icon: typeof Activity
  className: string
}> = {
  running: {
    label: '运行中',
    icon: Activity,
    className: 'bg-amber-50 text-amber-600 border-amber-200',
  },
  success: {
    label: '完成',
    icon: CheckCircle2,
    className: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  },
  error: {
    label: '失败',
    icon: AlertCircle,
    className: 'bg-red-50 text-red-500 border-red-200',
  },
  pending: {
    label: '等待',
    icon: Clock,
    className: 'bg-stone-50 text-stone-400 border-stone-200',
  },
}

export function TaskMonitorView() {
  const activeExecutions = useStore((s) => s.activeExecutions)
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null)

  // ── 订阅 agentEventBus 实时状态 ──
  const [runState, setRunState] = useState<AgentRunState>(agentEventBus.getState())

  useEffect(() => {
    const unsub = agentEventBus.subscribe(() => {
      setRunState({ ...agentEventBus.getState() })
    })
    return unsub
  }, [])

  // ── 跳动秒表: 当 currentTool 活跃时每 100ms 更新 ──
  const [toolElapsed, setToolElapsed] = useState(0)
  const toolRef = useRef(runState.currentTool)
  toolRef.current = runState.currentTool

  useEffect(() => {
    if (!runState.currentTool) {
      setToolElapsed(0)
      return
    }
    const startTime = runState.currentTool.startTime
    const tick = () => setToolElapsed(Date.now() - startTime)
    tick()
    const id = setInterval(tick, 100)
    return () => clearInterval(id)
  }, [runState.currentTool?.callId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 映射 activeExecutions → 表格行 (倒序，最新在前) ──
  const reversed = [...activeExecutions].reverse()
  const rows = reversed.map((exec, idx) => {
    const isExec = exec.status === 'executing'
    const isDone = exec.status === 'done'
    const isErr = exec.status === 'terminated' || exec.status === 'interrupted'

    let action = exec.description || '处理中...'
    if (isExec && runState.currentTool) {
      action = `${runState.currentTool.name}(${Object.keys(runState.currentTool.args).join(', ')})`
    }

    let time = '-'
    if (isExec) {
      time = `${(toolElapsed / 1000).toFixed(1)}s`
    } else if (exec.executionDuration) {
      time = `${(exec.executionDuration / 1000).toFixed(0)}s`
    }

    const tokens =
      isExec && runState.tokenUsed > 0
        ? `${(runState.tokenUsed / 1000).toFixed(1)}k`
        : '-'

    return {
      id: `TSK-${String(idx + 1).padStart(3, '0')}`,
      agent: exec.title || 'Agent',
      action,
      status: isExec ? 'running' : isDone ? 'success' : isErr ? 'error' : 'pending',
      time,
      tokens,
    }
  })

  // ── 渲染 ──
  return (
    <div className="p-6">
      <SectionHeader
        title="任务监控矩阵"
        subtitle="实时追踪全域 Agent 的心跳与任务流"
      />

      {/* ── 推流 reasoningBuffer ── */}
      {runState.reasoningBuffer &&
        runState.phase !== ('idle' as AgentPhase) &&
        runState.phase !== ('done' as AgentPhase) && (
          <div className="mb-4 p-4 bg-stone-50 border border-stone-200 rounded-2xl">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              <span className="text-[10px] font-black uppercase tracking-widest text-stone-400">
                REASONING
              </span>
            </div>
            <p className="text-sm text-stone-600 font-mono leading-relaxed whitespace-pre-wrap">
              {runState.reasoningBuffer.slice(-500)}
            </p>
          </div>
        )}

      {/* ── 主表格 ── */}
      <div className="bg-white border border-stone-200 rounded-2xl overflow-hidden shadow-sm">
        {/* 表头 */}
        <div className="grid grid-cols-12 gap-4 p-4 border-b border-stone-100 bg-stone-50/50 text-[10px] font-black text-stone-400 uppercase tracking-widest">
          <div className="col-span-2">Task ID</div>
          <div className="col-span-3">执行体 (Agent)</div>
          <div className="col-span-4">当前动作</div>
          <div className="col-span-1 text-center">状态</div>
          <div className="col-span-1 text-right">耗时</div>
          <div className="col-span-1 text-right">Tokens</div>
        </div>

        {/* 行 */}
        <div className="divide-y divide-stone-100">
          {rows.length === 0 ? (
            <div className="p-8 text-center text-stone-400 text-sm">
              暂无任务记录
            </div>
          ) : (
            rows.map((task, rowIdx) => {
              const cfg =
                STATUS_MAP[task.status] ?? STATUS_MAP.pending
              const StatusIcon = cfg.icon
              return (
                <div
                  key={task.id}
                  className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-stone-50 transition-colors cursor-pointer"
                  onClick={() => setSelectedTask(reversed[rowIdx])}
                >
                  <div className="col-span-2 text-xs font-mono font-bold text-stone-500">
                    {task.id}
                  </div>
                  <div className="col-span-3 font-bold text-sm text-stone-800">
                    {task.agent}
                  </div>
                  <div className="col-span-4 text-sm text-stone-600 truncate">
                    {task.action}
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <span
                      className={`flex items-center gap-1 px-2 py-1 border rounded-full text-[10px] font-bold ${cfg.className}`}
                    >
                      <StatusIcon
                        className={`w-3 h-3 ${task.status === 'running' ? 'animate-pulse' : ''}`}
                      />
                      {cfg.label}
                    </span>
                  </div>
                  <div className="col-span-1 text-right text-xs font-mono text-stone-500">
                    {task.time}
                  </div>
                  <div className="col-span-1 text-right text-xs font-mono font-bold text-stone-400">
                    {task.tokens}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── 工具执行时间线 ── */}
      {runState.toolHistory.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-bold text-stone-800 mb-3">工具执行时间线</h3>
          <div className="space-y-2">
            {runState.toolHistory
              .slice(-10)
              .reverse()
              .map((tool) => (
                <div
                  key={tool.callId}
                  className="flex items-center gap-3 p-3 bg-white border border-stone-200 rounded-xl"
                >
                  {tool.status === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500 shrink-0" />
                  )}
                  <span className="text-sm font-mono font-bold text-stone-700">
                    {tool.toolName}
                  </span>
                  <span className="text-xs text-stone-400 ml-auto">
                    {tool.durationMs}ms
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ── 任务详情弹窗 ── */}
      {selectedTask && (
        <TaskDetailModal task={selectedTask} onClose={() => setSelectedTask(null)} />
      )}
    </div>
  )
}
