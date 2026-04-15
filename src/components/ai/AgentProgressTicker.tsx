/**
 * AgentProgressTicker - 打字机式实时进度展示
 *
 * 订阅 agentEventBus，将 Agent 执行过程中的关键事件
 * 以打字机动画逐条展示，营造"AI 正在思考和行动"的沉浸感。
 *
 * 用于 AIChatPanel 流式消息区域，展示 Agent 当前阶段和工具执行进度。
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Brain, Wrench, Search, FileText, Terminal,
  CheckCircle2, XCircle, Loader2, Zap, RefreshCw,
  ShieldAlert, GitBranch, Sparkles, Eye,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { agentEventBus } from '@/services/agentEventBus'
import type { AgentEventEnvelope, AgentPhase } from '@/types'
import { useT } from '@/i18n'

// ============================================
// 进度条目类型
// ============================================

interface ProgressEntry {
  id: string
  icon: typeof Brain
  iconColor: string
  label: string
  detail?: string
  status: 'active' | 'done' | 'error'
  timestamp: number
}

// ============================================
// Phase → 显示配置
// ============================================

const PHASE_DISPLAY: Record<AgentPhase, { icon: typeof Brain; color: string; label: string }> = {
  idle:             { icon: Loader2,     color: 'stone',   label: 'progress.phase_idle' },
  planning:         { icon: Brain,       color: 'purple',  label: 'progress.phase_planning' },
  executing:        { icon: Wrench,      color: 'cyan',    label: 'progress.phase_executing' },
  reflecting:       { icon: RefreshCw,   color: 'amber',   label: 'progress.phase_reflecting' },
  compacting:       { icon: GitBranch,   color: 'blue',    label: 'progress.phase_compacting' },
  waiting_approval: { icon: ShieldAlert, color: 'yellow',  label: 'progress.phase_waiting_approval' },
  recovering:       { icon: RefreshCw,   color: 'orange',  label: 'progress.phase_recovering' },
  done:             { icon: CheckCircle2, color: 'emerald', label: 'progress.phase_done' },
  error:            { icon: XCircle,     color: 'red',     label: 'progress.phase_error' },
  aborted:          { icon: XCircle,     color: 'gray',    label: 'progress.phase_aborted' },
}

// ============================================
// 工具名 → 友好显示
// ============================================

function getToolDisplay(toolName: string): { icon: typeof Wrench; label: string } {
  const toolMap: Record<string, { icon: typeof Wrench; label: string }> = {
    readFile:      { icon: FileText, label: 'progress.tool_read_file' },
    writeFile:     { icon: FileText, label: 'progress.tool_write_file' },
    appendFile:    { icon: FileText, label: 'progress.tool_append_file' },
    listDir:       { icon: Eye,      label: 'progress.tool_list_dir' },
    searchFiles:   { icon: Search,   label: 'progress.tool_search_files' },
    runCmd:        { icon: Terminal,  label: 'progress.tool_run_cmd' },
    webSearch:     { icon: Search,   label: 'progress.tool_web_search' },
    webFetch:      { icon: Search,   label: 'progress.tool_web_fetch' },
    saveMemory:    { icon: Brain,     label: 'progress.tool_save_memory' },
    searchMemory:  { icon: Search,   label: 'progress.tool_search_memory' },
    generateSkill: { icon: Sparkles, label: 'progress.tool_generate_skill' },
  }
  return toolMap[toolName] || { icon: Wrench, label: toolName }
}

// ============================================
// 主组件
// ============================================

export function AgentProgressTicker() {
  const t = useT()
  const [entries, setEntries] = useState<ProgressEntry[]>([])
  const [currentPhase, setCurrentPhase] = useState<AgentPhase>(() => {
    // 挂载时立即读取 eventBus 当前状态，避免错过 run_start 事件
    const state = agentEventBus.getState()
    return state.phase || 'idle'
  })
  const [phaseElapsed, setPhaseElapsed] = useState(0)
  const phaseStartRef = useRef(Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)

  // 挂载时从 eventBus 当前状态初始化（解决时序问题：组件挂载晚于 startRun 调用）
  useEffect(() => {
    const state = agentEventBus.getState()
    if (state.runId && state.runId !== 'none' && state.phase !== 'idle') {
      setCurrentPhase(state.phase)
      phaseStartRef.current = Date.now()

      // 从已有的工具历史构建初始条目
      const initialEntries: ProgressEntry[] = []

      // 添加当前阶段条目
      const phaseDisplay = PHASE_DISPLAY[state.phase]
      const terminalPhases: AgentPhase[] = ['done', 'error', 'aborted']
      initialEntries.push({
        id: `init-phase-${state.phase}`,
        icon: phaseDisplay.icon,
        iconColor: phaseDisplay.color,
        label: phaseDisplay.label,
        status: terminalPhases.includes(state.phase) ? 'done' : 'active',
        timestamp: Date.now(),
      })

      // 从工具历史构建已完成的条目
      for (const tool of state.toolHistory) {
        const toolDisplay = getToolDisplay(tool.toolName)
        initialEntries.push({
          id: `init-tool-${tool.callId}`,
          icon: toolDisplay.icon,
          iconColor: tool.status === 'success' ? 'emerald' : 'red',
          label: `${t(toolDisplay.label as any)} · ${(tool.durationMs / 1000).toFixed(1)}s`,
          detail: tool.toolName,
          status: tool.status === 'success' ? 'done' : 'error',
          timestamp: tool.timestamp,
        })
      }

      // 如果当前有正在执行的工具，添加 active 条目
      if (state.currentTool) {
        const toolDisplay = getToolDisplay(state.currentTool.name)
        initialEntries.push({
          id: `init-current-${state.currentTool.callId}`,
          icon: toolDisplay.icon,
          iconColor: 'cyan',
          label: toolDisplay.label,
          detail: state.currentTool.name,
          status: 'active',
          timestamp: state.currentTool.startTime,
        })
      }

      if (initialEntries.length > 0) {
        setEntries(initialEntries)
      }
    }
  }, [])

  // 计时器：更新当前阶段的耗时
  useEffect(() => {
    const terminalPhases: AgentPhase[] = ['idle', 'done', 'error', 'aborted']
    if (terminalPhases.includes(currentPhase)) return
    const timer = setInterval(() => {
      setPhaseElapsed(Math.floor((Date.now() - phaseStartRef.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [currentPhase])

  // 标记所有 active 条目为 done
  const markAllDone = useCallback((prev: ProgressEntry[]) =>
    prev.map(entry => entry.status === 'active' ? { ...entry, status: 'done' as const } : entry),
  [])

  // 订阅 agentEventBus
  useEffect(() => {
    const unsubscribe = agentEventBus.subscribe((event: AgentEventEnvelope) => {
      const entryId = `${event.stream}-${event.type}-${event.seq}`

      switch (event.stream) {
        case 'lifecycle':
          if (event.type === 'phase_change') {
            const newPhase = event.data.to as AgentPhase
            setCurrentPhase(newPhase)
            phaseStartRef.current = Date.now()
            setPhaseElapsed(0)

            const display = PHASE_DISPLAY[newPhase]
            const terminalPhases: AgentPhase[] = ['done', 'error', 'aborted']
            setEntries(prev => [
              ...markAllDone(prev),
              {
                id: entryId,
                icon: display.icon,
                iconColor: display.color,
                label: display.label,
                status: terminalPhases.includes(newPhase) ? 'done' : 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'run_start') {
            setEntries([])
            setCurrentPhase('planning')
            phaseStartRef.current = Date.now()
            setPhaseElapsed(0)
          } else if (event.type === 'run_end') {
            const success = event.data.success as boolean
            setCurrentPhase(success ? 'done' : 'error')
            setEntries(prev => markAllDone(prev))
          }
          break

        case 'tool':
          if (event.type === 'tool_start') {
            const toolDisplay = getToolDisplay(event.data.toolName as string)
            setEntries(prev => [
              ...prev,
              {
                id: entryId,
                icon: toolDisplay.icon,
                iconColor: 'cyan',
                label: toolDisplay.label,
                detail: event.data.toolName as string,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'tool_end') {
            const toolName = event.data.toolName as string
            const toolDisplay = getToolDisplay(toolName)
            const durationMs = event.data.durationMs as number
            const success = event.data.success as boolean
            setEntries(prev => {
              // 找到最后一个匹配的 active 条目
              const lastIdx = [...prev].reverse().findIndex(
                entry => entry.detail === toolName && entry.status === 'active'
              )
              if (lastIdx === -1) return prev
              const realIdx = prev.length - 1 - lastIdx
              return prev.map((entry, idx) =>
                idx === realIdx
                  ? {
                      ...entry,
                      status: success ? 'done' as const : 'error' as const,
                      label: `${t(toolDisplay.label as any)} · ${(durationMs / 1000).toFixed(1)}s`,
                    }
                  : entry
              )
            })
          } else if (event.type === 'tool_error') {
            const toolName = event.data.toolName as string
            setEntries(prev => {
              const lastIdx = [...prev].reverse().findIndex(
                entry => entry.detail === toolName && entry.status === 'active'
              )
              if (lastIdx === -1) return prev
              const realIdx = prev.length - 1 - lastIdx
              return prev.map((entry, idx) =>
                idx === realIdx
                  ? { ...entry, status: 'error' as const, label: `${t(entry.label as any)} ${t('progress.failed_suffix')}` }
                  : entry
              )
            })
          }
          break

        case 'plan':
          if (event.type === 'step_start') {
            const stepIndex = event.data.stepIndex as number
            const totalSteps = event.data.totalSteps as number
            setEntries(prev => [
              ...prev,
              {
                id: entryId,
                icon: Zap,
                iconColor: 'amber',
                label: `${t('progress.step_label')} ${stepIndex + 1}/${totalSteps}`,
                detail: event.data.description as string,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'step_complete') {
            const stepIndex = event.data.stepIndex as number
            const success = event.data.success as boolean
            setEntries(prev =>
              prev.map(entry =>
                entry.label.startsWith(`${t('progress.step_label')} ${stepIndex + 1}/`) && entry.status === 'active'
                  ? { ...entry, status: success ? 'done' as const : 'error' as const }
                  : entry
              )
            )
          }
          break

        case 'reflexion':
          if (event.type === 'reflexion_start') {
            setEntries(prev => [
              ...prev,
              {
                id: entryId,
                icon: RefreshCw,
                iconColor: 'amber',
                label: 'progress.reflecting',
                detail: `工具 ${event.data.failedTool} ${t('progress.failed_suffix')}，重新规划...`,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'reflexion_end') {
            setEntries(prev =>
              prev.map(entry =>
                entry.label === 'progress.reflecting' && entry.status === 'active'
                  ? { ...entry, status: 'done' as const, label: 'progress.reflect_done' }
                  : entry
              )
            )
          }
          break

        case 'context':
          if (event.type === 'compaction_start') {
            setEntries(prev => [
              ...prev,
              {
                id: entryId,
                icon: GitBranch,
                iconColor: 'blue',
                label: 'progress.compacting_context',
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'compaction_end') {
            setEntries(prev =>
              prev.map(entry =>
                entry.label === 'progress.compacting_context' && entry.status === 'active'
                  ? { ...entry, status: 'done' as const }
                  : entry
              )
            )
          }
          break

        case 'approval':
          if (event.type === 'approval_required') {
            setEntries(prev => [
              ...prev,
              {
                id: entryId,
                icon: ShieldAlert,
                iconColor: 'yellow',
                label: 'progress.waiting_confirm',
                detail: event.data.reason as string,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'approval_resolved') {
            const approved = event.data.approved as boolean
            setEntries(prev =>
              prev.map(entry =>
                entry.label === 'progress.waiting_confirm' && entry.status === 'active'
                  ? { ...entry, status: 'done' as const, label: approved ? 'progress.approved' : 'progress.rejected' }
                  : entry
              )
            )
          }
          break
      }
    })

    return unsubscribe
  }, [markAllDone])

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries.length])

  // 空状态不渲染
  if (entries.length === 0 && currentPhase === 'idle') return null

  const phaseDisplay = PHASE_DISPLAY[currentPhase]
  const terminalPhases: AgentPhase[] = ['idle', 'done', 'error', 'aborted']
  const isActivePhase = !terminalPhases.includes(currentPhase)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="max-w-3xl mx-auto mb-3"
    >
      {/* 当前阶段指示器 */}
      {isActivePhase && (
        <div className="flex items-center gap-2 mb-2 px-1">
          <div className={cn(
            'w-2 h-2 rounded-full animate-pulse',
            phaseDisplay.color === 'purple' && 'bg-purple-400',
            phaseDisplay.color === 'cyan' && 'bg-cyan-400',
            phaseDisplay.color === 'amber' && 'bg-amber-400',
            phaseDisplay.color === 'blue' && 'bg-blue-400',
            phaseDisplay.color === 'yellow' && 'bg-yellow-400',
            phaseDisplay.color === 'orange' && 'bg-orange-400',
          )} />
          <span className={cn(
            'text-xs font-mono font-medium',
            phaseDisplay.color === 'purple' && 'text-purple-500',
            phaseDisplay.color === 'cyan' && 'text-cyan-500',
            phaseDisplay.color === 'amber' && 'text-amber-500',
            phaseDisplay.color === 'blue' && 'text-blue-500',
            phaseDisplay.color === 'yellow' && 'text-yellow-500',
            phaseDisplay.color === 'orange' && 'text-orange-500',
          )}>
            {t(phaseDisplay.label as any)}
          </span>
          {phaseElapsed > 0 && (
            <span className="text-xs font-mono text-stone-400">
              · {phaseElapsed}s
            </span>
          )}
        </div>
      )}

      {/* 进度条目列表 */}
      <div
        ref={scrollRef}
        className="space-y-0.5 max-h-[200px] overflow-y-auto px-1"
      >
        <AnimatePresence mode="popLayout">
          {entries.slice(-10).map((entry) => {
            const Icon = entry.icon
            return (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, x: -12, height: 0 }}
                animate={{ opacity: 1, x: 0, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="flex items-center gap-2 py-1"
              >
                {/* 状态图标 */}
                <div className={cn(
                  'w-5 h-5 rounded flex items-center justify-center flex-shrink-0',
                  entry.status === 'active' && 'bg-stone-100',
                  entry.status === 'done' && 'bg-emerald-50',
                  entry.status === 'error' && 'bg-red-50',
                )}>
                  {entry.status === 'active' ? (
                    <Loader2 className="w-3 h-3 text-cyan-500 animate-spin" />
                  ) : entry.status === 'done' ? (
                    <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                  ) : (
                    <XCircle className="w-3 h-3 text-red-500" />
                  )}
                </div>

                {/* 操作图标 */}
                <Icon className={cn(
                  'w-3.5 h-3.5 flex-shrink-0',
                  entry.status === 'active' && 'text-stone-500',
                  entry.status === 'done' && 'text-stone-400',
                  entry.status === 'error' && 'text-red-400',
                )} />

                {/* 文字 */}
                <span className={cn(
                  'text-xs font-mono',
                  entry.status === 'active' && 'text-stone-600',
                  entry.status === 'done' && 'text-stone-400',
                  entry.status === 'error' && 'text-red-400',
                )}>
                  {t(entry.label as any)}
                </span>

                {/* 详情 */}
                {entry.detail && (
                  <span className="text-xs font-mono text-stone-300 truncate max-w-[200px]">
                    {entry.detail}
                  </span>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}