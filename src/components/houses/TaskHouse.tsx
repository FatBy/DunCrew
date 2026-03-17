/**
 * TaskHouse - Blueprint 重构版
 *
 * 设计宪法:
 * - bg-white/bg-stone-50 亮色主体
 * - 三 Tab：执行中 / 实时 / 监控矩阵
 * - text-[10px] font-black uppercase tracking-widest 表头
 */

import { useState } from 'react'
import { Loader2, Activity, Clock, BarChart3 } from 'lucide-react'
import { useStore } from '@/store'
import { TaskMonitorView } from '@/components/blueprint/TaskMonitorView'
import { AgentRunStatePanel } from './task/AgentRunStatePanel'
import { ExecutionFocusView } from './task/ExecutionFocusView'
import { SilentAnalysisView } from './task/SilentAnalysisView'

type TabType = 'executing' | 'live' | 'matrix'

const TABS: { id: TabType; label: string; icon: typeof Activity }[] = [
  { id: 'executing', label: '执行中', icon: Clock },
  { id: 'live', label: '实时', icon: Activity },
  { id: 'matrix', label: '监控矩阵', icon: BarChart3 },
]

export function TaskHouse() {
  const activeExecutions = useStore((s) => s.activeExecutions)
  const loading = useStore((s) => s.sessionsLoading)
  const connectionStatus = useStore((s) => s.connectionStatus)
  const updateActiveExecution = useStore((s) => s.updateActiveExecution)
  const abortChat = useStore((s) => s.abortChat)

  const isConnected = connectionStatus === 'connected'
  const [activeTab, setActiveTab] = useState<TabType>('executing')

  const executingTasks = activeExecutions.filter((t) => t.status === 'executing')

  const handleTerminate = (taskId: string) => {
    abortChat()
    updateActiveExecution(taskId, { status: 'terminated' })
  }

  if (loading && isConnected) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative flex flex-col h-full">
      {/* ── Tab 栏 (亮色主题) ── */}
      <div className="flex items-center gap-1 px-4 py-3 border-b border-stone-200 bg-stone-50/60">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all
                ${isActive
                  ? 'bg-white border border-stone-200 text-stone-800 shadow-sm'
                  : 'border border-transparent text-stone-400 hover:bg-white/60 hover:text-stone-600'
                }
              `}
            >
              <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-amber-500' : ''}`} />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>

      {/* ── 主视图 ── */}
      <div className="flex-1 overflow-y-auto bg-[#fefaf6]">
        {activeTab === 'matrix' && <TaskMonitorView />}

        {activeTab === 'live' && <AgentRunStatePanel />}

        {activeTab === 'executing' && (
          <>
            {executingTasks.length > 0 ? (
              <div className="p-4 space-y-4">
                {executingTasks.map((task) => (
                  <ExecutionFocusView
                    key={task.id}
                    task={task}
                    onTerminate={handleTerminate}
                  />
                ))}
              </div>
            ) : (
              <SilentAnalysisView />
            )}
          </>
        )}
      </div>
    </div>
  )
}
