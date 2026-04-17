/**
 * LibrarianPanel - LLM 图书馆员审计面板
 * 请求 LLM 审计知识库，展示操作计划，一键执行
 */

import { useState } from 'react'
import { Bot, Play, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import {
  INK, INK_DIM, INK_MUTED,
  BG, BG_WARM, BORDER, BORDER_LIGHT, ACCENT, GREEN,
  FONT_SERIF, FONT_MONO,
} from '@/components/shared/wiki-ui/constants'
import { chatBackground, isLLMConfigured } from '@/services/llmService'
import type { LibrarianContext } from './useLibraryData'

interface LibrarianPanelProps {
  context: LibrarianContext | null
  loading: boolean
  onStart: (scope?: string, category?: string) => void
  onExecute: (actions: Record<string, unknown>[]) => Promise<{ executed: number; errors: string[] } | undefined>
  onClose: () => void
}

interface LibrarianAction {
  op: string
  entity_ids?: string[]
  source_id?: string
  target_id?: string
  claim_ids?: string[]
  value?: string
  reason?: string
}

export function LibrarianPanel({ context, loading, onStart, onExecute, onClose }: LibrarianPanelProps) {
  const [actions, setActions] = useState<LibrarianAction[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [result, setResult] = useState<{ executed: number; errors: string[] } | null>(null)
  const [llmError, setLlmError] = useState<string | null>(null)

  const handleAnalyze = async () => {
    if (!context || !isLLMConfigured()) return
    setAnalyzing(true)
    setLlmError(null)
    setActions([])
    try {
      const messages = [
        { role: 'system' as const, content: context.prompt },
        { role: 'user' as const, content: context.entityOverview },
      ]
      const resp = await chatBackground(messages, { priority: 8 })
      if (!resp) throw new Error('LLM 无响应')
      // 提取 JSON 数组
      const text = typeof resp === 'string' ? resp : (resp as { content?: string }).content || ''
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as LibrarianAction[]
        setActions(Array.isArray(parsed) ? parsed : [])
      } else {
        setActions([])
      }
    } catch (e) {
      setLlmError('分析失败: ' + (e as Error).message)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleExecute = async () => {
    if (actions.length === 0) return
    setExecuting(true)
    try {
      const res = await onExecute(actions as unknown as Record<string, unknown>[])
      if (res) setResult(res)
    } finally {
      setExecuting(false)
    }
  }

  // 未启动状态：入口按钮
  if (!context && !loading) {
    return (
      <button onClick={() => onStart()}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
              style={{ background: BG_WARM, border: `1px solid ${BORDER}`, color: INK_DIM }}>
        <Bot className="w-3.5 h-3.5" style={{ color: ACCENT }} />
        Librarian 审计
      </button>
    )
  }

  return (
    <div className="rounded-lg overflow-hidden mb-6"
         style={{ background: '#fff', border: `1px solid ${BORDER}` }}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between"
           style={{ borderBottom: `1px solid ${BORDER_LIGHT}`, background: BG_WARM }}>
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4" style={{ color: ACCENT }} />
          <span className="text-[13px] font-bold" style={{ fontFamily: FONT_SERIF, color: INK }}>
            LLM Librarian
          </span>
          {context && (
            <span className="text-[10px]" style={{ fontFamily: FONT_MONO, color: INK_MUTED }}>
              {context.entityCount} entities
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-[10px] px-2 py-1 rounded hover:bg-gray-100"
                style={{ color: INK_MUTED }}>
          关闭
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: ACCENT }} />
          <span className="text-[12px] ml-2" style={{ color: INK_DIM }}>正在加载知识库概览...</span>
        </div>
      )}

      {/* 已获取 context，等待分析 */}
      {context && !analyzing && actions.length === 0 && !result && (
        <div className="px-4 py-4">
          <p className="text-[12px] mb-3" style={{ color: INK_DIM }}>
            将审查 {context.entityCount} 个实体，识别过时内容、分类缺失、重复实体、矛盾断言。
          </p>
          {!isLLMConfigured() ? (
            <p className="text-[12px]" style={{ color: ACCENT }}>
              需要配置 LLM 才能使用 Librarian
            </p>
          ) : (
            <button onClick={handleAnalyze}
                    className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded transition-colors hover:opacity-90"
                    style={{ background: ACCENT, color: '#fff' }}>
              <Play className="w-3.5 h-3.5" /> 开始审计
            </button>
          )}
          {llmError && (
            <p className="text-[11px] mt-2" style={{ color: ACCENT }}>{llmError}</p>
          )}
        </div>
      )}

      {/* 分析中 */}
      {analyzing && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: ACCENT }} />
          <span className="text-[12px] ml-2" style={{ color: INK_DIM }}>LLM 正在审计...</span>
        </div>
      )}

      {/* 操作计划 */}
      {actions.length > 0 && !result && (
        <div className="px-4 py-3">
          <div className="text-[10px] font-bold tracking-[1px] uppercase mb-2"
               style={{ fontFamily: FONT_MONO, color: ACCENT }}>
            ACTION PLAN ({actions.length})
          </div>
          <div className="space-y-2 mb-3">
            {actions.map((a, i) => (
              <div key={i} className="text-[12px] px-3 py-2 rounded"
                   style={{ background: BG, border: `1px solid ${BORDER_LIGHT}` }}>
                <span className="font-bold mr-1.5" style={{ color: getOpColor(a.op) }}>
                  {getOpLabel(a.op)}
                </span>
                <span style={{ color: INK_DIM }}>{a.reason || ''}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={handleExecute} disabled={executing}
                    className="flex items-center gap-1.5 text-[12px] px-3 py-2 rounded transition-colors hover:opacity-90"
                    style={{ background: GREEN, color: '#fff' }}>
              {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              执行全部
            </button>
            <button onClick={() => setActions([])}
                    className="text-[12px] px-3 py-2 rounded hover:bg-gray-100"
                    style={{ color: INK_MUTED }}>
              放弃
            </button>
          </div>
        </div>
      )}

      {/* 执行结果 */}
      {result && (
        <div className="px-4 py-4">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4" style={{ color: GREEN }} />
            <span className="text-[13px] font-bold" style={{ color: INK }}>
              执行完成: {result.executed} 个操作
            </span>
          </div>
          {result.errors.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px]" style={{ color: ACCENT }}>
              <AlertTriangle className="w-3 h-3" />
              {result.errors.length} 个错误
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function getOpLabel(op: string): string {
  const map: Record<string, string> = {
    archive: 'ARCHIVE',
    set_category: 'CATEGORIZE',
    merge: 'MERGE',
    flag_conflict: 'FLAG',
  }
  return map[op] || op.toUpperCase()
}

function getOpColor(op: string): string {
  const map: Record<string, string> = {
    archive: '#8b6914',
    set_category: '#1a5276',
    merge: GREEN,
    flag_conflict: ACCENT,
  }
  return map[op] || INK_DIM
}
