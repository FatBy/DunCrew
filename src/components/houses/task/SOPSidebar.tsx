/**
 * SOPSidebar - Nexus SOP 参考面板
 *
 * 仅在 complex 任务 + 活跃 Nexus 有 sopContent 时显示。
 * 上半部分：渲染 Nexus 的 SOP Markdown 内容（参考手册）
 * 下半部分：展示当前 ReAct 循环的 turn 进度
 */

import { useState, useEffect } from 'react'
import { BookOpen, ChevronDown, Activity, Zap } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { MarkdownRenderer } from '@/components/ai/markdown/MarkdownRenderer'
import { agentEventBus } from '@/services/agentEventBus'
import { cn } from '@/utils/cn'
import type { AgentPhase, AgentEventEnvelope } from '@/types'

const MAX_REACT_TURNS = 25

interface SOPSidebarProps {
  sopContent: string
  nexusName: string
  isExecuting: boolean
}

export function SOPSidebar({ sopContent, nexusName, isExecuting }: SOPSidebarProps) {
  const [sopExpanded, setSopExpanded] = useState(true)
  const [turnCount, setTurnCount] = useState(0)
  const [currentPhase, setCurrentPhase] = useState<AgentPhase>('idle')
  const [toolsUsed, setToolsUsed] = useState(0)

  // 订阅 agentEventBus 获取实时 turn 进度
  useEffect(() => {
    if (!isExecuting) return

    // 从当前状态初始化
    const state = agentEventBus.getState()
    if (state.runId && state.runId !== 'none') {
      setCurrentPhase(state.phase)
      setToolsUsed(state.toolHistory.length)
    }

    // 只关心 lifecycle 和 tool 相关事件
    const CARED_STREAMS = ['lifecycle', 'tool']

    const unsubscribe = agentEventBus.subscribe((event: AgentEventEnvelope) => {
      // 事件类型过滤：只处理关心的 stream
      if (!CARED_STREAMS.includes(event.stream)) return

      switch (event.stream) {
        case 'lifecycle':
          if (event.type === 'phase_change') {
            const newPhase = event.data.to as AgentPhase
            setCurrentPhase(newPhase)
            // planning 阶段切换代表新的 turn 开始
            if (newPhase === 'planning') {
              setTurnCount(prev => prev + 1)
            }
          } else if (event.type === 'run_start') {
            setTurnCount(0)
            setToolsUsed(0)
            setCurrentPhase('planning')
          } else if (event.type === 'run_end') {
            setCurrentPhase(event.data.success ? 'done' : 'error')
          }
          break

        case 'tool':
          if (event.type === 'tool_end') {
            setToolsUsed(prev => prev + 1)
          }
          break
      }
    })

    return unsubscribe
  }, [isExecuting])

  const turnProgress = Math.min((turnCount / MAX_REACT_TURNS) * 100, 100)
  const isTerminal = ['done', 'error', 'aborted', 'idle'].includes(currentPhase)

  return (
    <div className="w-72 flex-shrink-0 border-l border-stone-200 bg-stone-50/40 flex flex-col overflow-hidden">
      {/* 头部 */}
      <div className="px-4 py-3 border-b border-stone-200 bg-white/60">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-amber-500" />
          <span className="text-xs font-mono font-bold text-stone-600 uppercase tracking-wider">
            SOP 参考
          </span>
        </div>
        <p className="text-[11px] font-mono text-stone-400 mt-1 truncate">
          {nexusName}
        </p>
      </div>

      {/* SOP 内容区 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="border-b border-stone-100">
          <button
            onClick={() => setSopExpanded(!sopExpanded)}
            className="w-full flex items-center gap-2 px-4 py-2 hover:bg-white/40 transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5 text-stone-400" />
            <span className="text-xs font-mono text-stone-500 font-medium">操作流程</span>
            <motion.div
              animate={{ rotate: sopExpanded ? 180 : 0 }}
              transition={{ duration: 0.2 }}
              className="ml-auto"
            >
              <ChevronDown className="w-3.5 h-3.5 text-stone-300" />
            </motion.div>
          </button>

          <AnimatePresence>
            {sopExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-4">
                  <MarkdownRenderer
                    content={sopContent}
                    className="text-xs text-stone-600 [&_h1]:text-sm [&_h2]:text-[13px] [&_h3]:text-xs [&_p]:text-xs [&_li]:text-xs [&_code]:text-[11px]"
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* 底部：ReAct Turn 进度 */}
      {isExecuting && (
        <div className="px-4 py-3 border-t border-stone-200 bg-white/60 flex-shrink-0">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="w-3.5 h-3.5 text-cyan-500" />
            <span className="text-[11px] font-mono font-bold text-stone-500 uppercase tracking-wider">
              执行进度
            </span>
          </div>

          {/* Turn 进度条 */}
          <div className="mb-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-mono text-stone-400">
                Turn {turnCount} / {MAX_REACT_TURNS}
              </span>
              <span className={cn(
                'text-[11px] font-mono font-medium',
                turnCount > MAX_REACT_TURNS * 0.8 ? 'text-red-400' :
                turnCount > MAX_REACT_TURNS * 0.5 ? 'text-amber-400' :
                'text-cyan-400',
              )}>
                {Math.round(turnProgress)}%
              </span>
            </div>
            <div className="h-1.5 bg-stone-100 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${turnProgress}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={cn(
                  'h-full rounded-full',
                  turnCount > MAX_REACT_TURNS * 0.8 ? 'bg-red-400' :
                  turnCount > MAX_REACT_TURNS * 0.5 ? 'bg-amber-400' :
                  'bg-gradient-to-r from-cyan-400 to-emerald-400',
                )}
              />
            </div>
          </div>

          {/* 工具调用统计 */}
          <div className="flex items-center gap-3 text-[11px] font-mono text-stone-400">
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-400" />
              {toolsUsed} 工具调用
            </span>
            {!isTerminal && (
              <span className={cn(
                'flex items-center gap-1',
                currentPhase === 'planning' && 'text-purple-400',
                currentPhase === 'executing' && 'text-cyan-400',
                currentPhase === 'reflecting' && 'text-amber-400',
              )}>
                <div className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                {currentPhase === 'planning' ? '思考中' :
                 currentPhase === 'executing' ? '执行中' :
                 currentPhase === 'reflecting' ? '反思中' :
                 currentPhase}
              </span>
            )}
          </div>
        </div>
      )}

      {/* 执行完成状态 */}
      {!isExecuting && turnCount > 0 && (
        <div className="px-4 py-3 border-t border-stone-200 bg-emerald-50/30 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[11px] font-mono text-emerald-500 font-medium">
              执行完成 · {turnCount} turns · {toolsUsed} 工具调用
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
