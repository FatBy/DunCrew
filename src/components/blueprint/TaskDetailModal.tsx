/**
 * TaskDetailModal - 任务执行详情气泡框
 *
 * 点击任务行后弹出，完整展示 ReAct 执行时间线:
 * - thinking  → 灰色气泡
 * - tool_call → 蓝色卡片 (工具名 + 参数 JSON)
 * - tool_result → 绿色/红色卡片 (折叠长文本)
 * - output    → 最终回复
 * - error     → 红色错误块
 */

import {
  X, Brain, Wrench, CheckCircle2, XCircle, MessageSquare, AlertTriangle,
  Clock,
} from 'lucide-react'
import type { TaskItem, ExecutionStep } from '@/types'

interface TaskDetailModalProps {
  task: TaskItem
  onClose: () => void
}

// ── 状态配色 ──
const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  executing: { label: '执行中', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
  done:      { label: '已完成', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  terminated:{ label: '已终止', cls: 'bg-red-50 text-red-500 border-red-200' },
  interrupted:{ label: '已中断', cls: 'bg-red-50 text-red-500 border-red-200' },
  pending:   { label: '等待中', cls: 'bg-stone-50 text-stone-400 border-stone-200' },
  queued:    { label: '排队中', cls: 'bg-stone-50 text-stone-400 border-stone-200' },
  retrying:  { label: '重试中', cls: 'bg-amber-50 text-amber-600 border-amber-200' },
  paused:    { label: '已暂停', cls: 'bg-stone-50 text-stone-500 border-stone-200' },
}

// ── 时间格式化 ──
function fmtTime(ts?: number): string {
  if (!ts) return '-'
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function fmtDuration(ms?: number): string {
  if (!ms) return '-'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`
}

// ── 可折叠文本块 ──
function CollapsibleText({ text }: { text: string }) {
  return (
    <pre className="text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
      {text}
    </pre>
  )
}

// ── 单个执行步骤 ──
function StepCard({ step, index }: { step: ExecutionStep; index: number }) {
  const t = step.type

  if (t === 'thinking') {
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-7 h-7 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center shrink-0">
            <Brain className="w-3.5 h-3.5 text-stone-500" />
          </div>
          <div className="w-px flex-1 bg-stone-200 mt-1" />
        </div>
        <div className="flex-1 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-stone-400">Thinking</span>
            {step.duration != null && (
              <span className="text-[10px] text-stone-300">{step.duration}ms</span>
            )}
          </div>
          <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl">
            <CollapsibleText text={step.content} />
          </div>
        </div>
      </div>
    )
  }

  if (t === 'tool_call') {
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-7 h-7 rounded-full bg-blue-50 border border-blue-200 flex items-center justify-center shrink-0">
            <Wrench className="w-3.5 h-3.5 text-blue-500" />
          </div>
          <div className="w-px flex-1 bg-stone-200 mt-1" />
        </div>
        <div className="flex-1 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-blue-500">Tool Call</span>
            {step.toolName && (
              <span className="px-1.5 py-0.5 bg-blue-50 border border-blue-200 rounded text-[10px] font-mono font-bold text-blue-600">
                {step.toolName}
              </span>
            )}
          </div>
          <div className="p-3 bg-blue-50/50 border border-blue-200 rounded-xl">
            <CollapsibleText
              text={step.toolArgs ? JSON.stringify(step.toolArgs, null, 2) : step.content}
            />
          </div>
        </div>
      </div>
    )
  }

  if (t === 'tool_result') {
    const isError = step.content.toLowerCase().includes('error') || step.content.toLowerCase().includes('fail')
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${
            isError ? 'bg-red-50 border border-red-200' : 'bg-emerald-50 border border-emerald-200'
          }`}>
            {isError
              ? <XCircle className="w-3.5 h-3.5 text-red-500" />
              : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            }
          </div>
          <div className="w-px flex-1 bg-stone-200 mt-1" />
        </div>
        <div className="flex-1 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-black uppercase tracking-widest ${isError ? 'text-red-400' : 'text-emerald-500'}`}>
              Tool Result
            </span>
            {step.duration != null && (
              <span className="text-[10px] text-stone-300">{step.duration}ms</span>
            )}
          </div>
          <div className={`p-3 border rounded-xl ${
            isError ? 'bg-red-50/50 border-red-200' : 'bg-emerald-50/50 border-emerald-200'
          }`}>
            <CollapsibleText text={step.content} />
          </div>
        </div>
      </div>
    )
  }

  if (t === 'output') {
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-7 h-7 rounded-full bg-indigo-50 border border-indigo-200 flex items-center justify-center shrink-0">
            <MessageSquare className="w-3.5 h-3.5 text-indigo-500" />
          </div>
          <div className="w-px flex-1 bg-stone-200 mt-1" />
        </div>
        <div className="flex-1 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500">Output</span>
          </div>
          <div className="p-3 bg-indigo-50/50 border border-indigo-200 rounded-xl">
            <CollapsibleText text={step.content} />
          </div>
        </div>
      </div>
    )
  }

  if (t === 'error') {
    return (
      <div className="flex gap-3">
        <div className="flex flex-col items-center">
          <div className="w-7 h-7 rounded-full bg-red-50 border border-red-200 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
          </div>
          <div className="w-px flex-1 bg-stone-200 mt-1" />
        </div>
        <div className="flex-1 pb-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-black uppercase tracking-widest text-red-500">Error</span>
          </div>
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl">
            <pre className="text-xs font-mono text-red-600 whitespace-pre-wrap break-words">{step.content}</pre>
          </div>
        </div>
      </div>
    )
  }

  // fallback
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className="w-7 h-7 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center shrink-0">
          <span className="text-[9px] font-bold text-stone-400">{index + 1}</span>
        </div>
        <div className="w-px flex-1 bg-stone-200 mt-1" />
      </div>
      <div className="flex-1 pb-4">
        <div className="p-3 bg-stone-50 border border-stone-200 rounded-xl">
          <CollapsibleText text={step.content} />
        </div>
      </div>
    </div>
  )
}

// ── 主组件 ──
export function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
  const statusCfg = STATUS_STYLE[task.status] ?? STATUS_STYLE.pending
  const steps = task.executionSteps ?? []

  return (
    // 遮罩
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-stone-900/10 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* 气泡框 */}
      <div
        className="relative w-full max-w-3xl max-h-[85vh] bg-white/95 backdrop-blur-3xl border border-stone-200 rounded-3xl shadow-[0_30px_80px_rgba(0,0,0,0.1)] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── 顶部: 标题 + 状态 + 时间 ── */}
        <div className="p-6 border-b border-stone-100 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-black text-stone-800 truncate">{task.title || '任务详情'}</h2>
              <p className="text-sm text-stone-500 mt-1 line-clamp-2">{task.description}</p>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors shrink-0"
            >
              <X className="w-4 h-4 text-stone-500" />
            </button>
          </div>

          {/* 元信息条 */}
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <span className={`flex items-center gap-1 px-2.5 py-1 border rounded-full text-[10px] font-bold ${statusCfg.cls}`}>
              {statusCfg.label}
            </span>

            {task.executionDuration != null && (
              <span className="flex items-center gap-1 px-2.5 py-1 bg-stone-50 border border-stone-200 rounded-full text-[10px] font-bold text-stone-500">
                <Clock className="w-3 h-3" />
                {fmtDuration(task.executionDuration)}
              </span>
            )}

            {task.startedAt && (
              <span className="text-[10px] text-stone-400">
                开始: {fmtTime(task.startedAt)}
              </span>
            )}

            {task.completedAt && (
              <span className="text-[10px] text-stone-400">
                结束: {fmtTime(task.completedAt)}
              </span>
            )}

            {steps.length > 0 && (
              <span className="text-[10px] text-stone-400 ml-auto">
                共 {steps.length} 步
              </span>
            )}
          </div>
        </div>

        {/* ── 主体: 执行时间线 ── */}
        <div className="flex-1 overflow-y-auto p-6">
          {steps.length > 0 ? (
            <div>
              {steps.map((step, i) => (
                <StepCard key={step.id || `step-${i}`} step={step} index={i} />
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <Brain className="w-10 h-10 text-stone-300 mx-auto mb-3" />
              <p className="text-sm text-stone-400">暂无执行步骤记录</p>
              {task.executionOutput && (
                <div className="mt-4 p-4 bg-stone-50 border border-stone-200 rounded-xl text-left max-w-lg mx-auto">
                  <span className="text-[10px] font-black uppercase tracking-widest text-stone-400 block mb-2">执行输出</span>
                  <CollapsibleText text={task.executionOutput} />
                </div>
              )}
              {task.executionError && (
                <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-xl text-left max-w-lg mx-auto">
                  <span className="text-[10px] font-black uppercase tracking-widest text-red-500 block mb-2">错误信息</span>
                  <pre className="text-xs font-mono text-red-600 whitespace-pre-wrap">{task.executionError}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 底部: 工具统计 ── */}
        {steps.length > 0 && (
          <div className="p-4 border-t border-stone-100 bg-stone-50/50 shrink-0">
            <div className="flex items-center gap-6 text-[10px] font-bold text-stone-400 uppercase tracking-widest">
              <span>
                工具调用: {steps.filter(s => s.type === 'tool_call').length} 次
              </span>
              <span>
                成功: {steps.filter(s => s.type === 'tool_result' && !s.content.toLowerCase().includes('error')).length}
              </span>
              <span>
                失败: {steps.filter(s => s.type === 'tool_result' && s.content.toLowerCase().includes('error')).length}
              </span>
              {task.executionDuration != null && (
                <span className="ml-auto">
                  总耗时: {fmtDuration(task.executionDuration)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
