/**
 * RunStateSummaryBar - 紧凑的 Agent 运行状态摘要条
 *
 * 从 AgentRunStatePanel 提取的关键指标，以单行形式嵌入 ExecutionFocusView 顶部。
 * 展示：模型名称、Token 用量、工具统计、Reflexion 计数、审批状态
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import {
  Cpu, Gauge, CheckCircle2, XCircle, Zap,
  Brain, AlertTriangle,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import type { AgentRunState, AgentPhase } from '@/types'
import { agentEventBus } from '@/services/agentEventBus'

export function RunStateSummaryBar() {
  const [state, setState] = useState<AgentRunState | null>(null)
  const rafIdRef = useRef<number>(0)

  const flushBatch = useCallback(() => {
    rafIdRef.current = 0
    setState({ ...agentEventBus.getState() })
  }, [])

  const scheduleFlush = useCallback(() => {
    if (rafIdRef.current === 0) {
      rafIdRef.current = requestAnimationFrame(flushBatch)
    }
  }, [flushBatch])

  useEffect(() => {
    setState({ ...agentEventBus.getState() })

    const unsub = agentEventBus.subscribe(() => {
      scheduleFlush()
    })

    return () => {
      unsub()
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
    }
  }, [scheduleFlush])

  const hiddenPhases: AgentPhase[] = ['idle', 'done', 'error', 'aborted']
  if (!state || hiddenPhases.includes(state.phase)) return null

  const successTools = state.toolHistory.filter(t => t.status === 'success').length
  const errorTools = state.toolHistory.filter(t => t.status !== 'success').length
  const runningCount = state.currentTool ? 1 : 0

  const hasToken = state.tokenBudget > 0
  const tokenRatio = hasToken ? Math.min(1, state.tokenUsed / state.tokenBudget) : 0
  const tokenPct = Math.round(tokenRatio * 100)
  const tokenWarning = tokenRatio > 0.9
  const tokenCaution = tokenRatio > 0.7 && !tokenWarning

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-stone-50/80 border border-stone-200 rounded-lg mb-3 flex-wrap">
      {/* 模型名称 */}
      <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-stone-100 border border-stone-200">
        <Cpu className="w-3 h-3 text-stone-400" />
        <span className="text-[10px] font-mono text-stone-500 max-w-[120px] truncate">
          {state.currentModel}
        </span>
      </div>

      {/* Token 用量 */}
      {hasToken && (
        <div className="flex items-center gap-1.5">
          <Gauge className="w-3 h-3 text-stone-400" />
          <div className="w-16 h-1.5 bg-stone-200 rounded-full overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                tokenWarning ? 'bg-red-500' : tokenCaution ? 'bg-amber-500' : 'bg-cyan-500',
              )}
              style={{ width: `${tokenPct}%` }}
            />
          </div>
          <span className={cn(
            'text-[10px] font-mono',
            tokenWarning ? 'text-red-500' : tokenCaution ? 'text-amber-500' : 'text-stone-400',
          )}>
            {tokenPct}%
          </span>
        </div>
      )}

      {/* 工具统计 */}
      <div className="flex items-center gap-2 text-[10px] font-mono">
        {successTools > 0 && (
          <span className="flex items-center gap-0.5 text-emerald-500">
            <CheckCircle2 className="w-3 h-3" />{successTools}
          </span>
        )}
        {errorTools > 0 && (
          <span className="flex items-center gap-0.5 text-red-500">
            <XCircle className="w-3 h-3" />{errorTools}
          </span>
        )}
        {runningCount > 0 && (
          <span className="flex items-center gap-0.5 text-amber-500">
            <Zap className="w-3 h-3" />{runningCount}
          </span>
        )}
      </div>

      {/* Reflexion 计数 */}
      {state.reflexionCount > 0 && (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-[10px] font-mono text-amber-600">
          <Brain className="w-3 h-3" />
          Reflexion {state.reflexionCount}x
        </span>
      )}

      {/* 审批等待 */}
      {state.approvalPending && (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-yellow-50 border border-yellow-300 text-[10px] font-mono text-yellow-700 animate-pulse">
          <AlertTriangle className="w-3 h-3" />
          待审批
        </span>
      )}
    </div>
  )
}
