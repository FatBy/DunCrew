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
  idle:             { icon: Loader2,     color: 'stone',   label: '待命中' },
  planning:         { icon: Brain,       color: 'purple',  label: '深度思考中' },
  executing:        { icon: Wrench,      color: 'cyan',    label: '执行中' },
  reflecting:       { icon: RefreshCw,   color: 'amber',   label: '反思中' },
  compacting:       { icon: GitBranch,   color: 'blue',    label: '压缩上下文' },
  waiting_approval: { icon: ShieldAlert, color: 'yellow',  label: '等待确认' },
  recovering:       { icon: RefreshCw,   color: 'orange',  label: '恢复中' },
  done:             { icon: CheckCircle2, color: 'emerald', label: '完成' },
  error:            { icon: XCircle,     color: 'red',     label: '出错' },
  aborted:          { icon: XCircle,     color: 'gray',    label: '已终止' },
}

// ============================================
// 工具名 → 友好显示
// ============================================

function getToolDisplay(toolName: string): { icon: typeof Wrench; label: string } {
  const toolMap: Record<string, { icon: typeof Wrench; label: string }> = {
    readFile:      { icon: FileText, label: '读取文件' },
    writeFile:     { icon: FileText, label: '写入文件' },
    appendFile:    { icon: FileText, label: '追加文件' },
    listDir:       { icon: Eye,      label: '浏览目录' },
    searchFiles:   { icon: Search,   label: '搜索文件' },
    runCmd:        { icon: Terminal,  label: '执行命令' },
    webSearch:     { icon: Search,   label: '网络搜索' },
    webFetch:      { icon: Search,   label: '抓取网页' },
    saveMemory:    { icon: Brain,     label: '保存记忆' },
    searchMemory:  { icon: Search,   label: '搜索记忆' },
    generateSkill: { icon: Sparkles, label: '生成技能' },
  }
  return toolMap[toolName] || { icon: Wrench, label: toolName }
}

// ============================================
// 主组件
// ============================================

export function AgentProgressTicker() {
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
          label: `${toolDisplay.label} · ${(tool.durationMs / 1000).toFixed(1)}s`,
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
                      label: `${toolDisplay.label} · ${(durationMs / 1000).toFixed(1)}s`,
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
                  ? { ...entry, status: 'error' as const, label: `${entry.label} 失败` }
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
                label: `步骤 ${stepIndex + 1}/${totalSteps}`,
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
                entry.label.startsWith(`步骤 ${stepIndex + 1}/`) && entry.status === 'active'
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
                label: '反思中',
                detail: `工具 ${event.data.failedTool} 失败，重新规划...`,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'reflexion_end') {
            setEntries(prev =>
              prev.map(entry =>
                entry.label === '反思中' && entry.status === 'active'
                  ? { ...entry, status: 'done' as const, label: '反思完成' }
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
                label: '压缩上下文',
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'compaction_end') {
            setEntries(prev =>
              prev.map(entry =>
                entry.label === '压缩上下文' && entry.status === 'active'
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
                label: '等待确认',
                detail: event.data.reason as string,
                status: 'active',
                timestamp: Date.now(),
              },
            ])
          } else if (event.type === 'approval_resolved') {
            const approved = event.data.approved as boolean
            setEntries(prev =>
              prev.map(entry =>
                entry.label === '等待确认' && entry.status === 'active'
                  ? { ...entry, status: 'done' as const, label: approved ? '已批准' : '已拒绝' }
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
            {phaseDisplay.label}
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
                  {entry.label}
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
