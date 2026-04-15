import { useState, useMemo, forwardRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  AlertTriangle, Info, ChevronDown,
  Lightbulb, Check, X, Loader2,
} from 'lucide-react'
import { cn } from '@/utils/cn'

// ============================================
// 类型定义（与 BaseAnalysisPanel 共享）
// ============================================

export interface Suggestion {
  id: string
  type: string
  severity: 'warning' | 'info'
  title: string
  description: string
  metric: Record<string, unknown>
  origin: string
}

export interface Rule {
  id: string
  name: string
  rule: string
  status: 'active' | 'disabled'
  origin: 'governor' | 'auto' | 'manual'
  hitCount: number
  effectPP: number | null
  hitSuccessRate: number | null
  noHitSuccessRate: number | null
  description: string
}

// ============================================
// Suggestion → Rule 转换
// ============================================

export function suggestionToRule(suggestion: Suggestion): Rule {
  const m = suggestion.metric
  let effectPP: number | null = null
  if (typeof m.successRate === 'number' && typeof m.overallRate === 'number') {
    effectPP = Math.round((m.successRate - m.overallRate) * 1000) / 10
  }

  return {
    id: suggestion.id,
    name: suggestion.title,
    rule: suggestion.id.replace(/^auto_/, ''),
    status: 'active',
    origin: 'auto',
    hitCount: typeof m.count === 'number' ? m.count : 0,
    effectPP,
    hitSuccessRate: typeof m.successRate === 'number' ? m.successRate : null,
    noHitSuccessRate: typeof m.overallRate === 'number' ? m.overallRate : null,
    description: suggestion.description,
  }
}

// ============================================
// 工具函数
// ============================================

/** 将碱基字母代码转为可读中文 */
function humanizeTitle(name: string): string {
  const baseNames: Record<string, string> = { E: '执行', P: '规划', V: '验证', X: '探索' }
  return name.replace(/\b([EPVX](?:-[EPVX])+)\b/g, (match) =>
    match.split('-').map(l => baseNames[l] || l).join('→')
  )
}

/** 从 metric 提取有标签的可读指标 */
function formatMetrics(metric: Record<string, unknown>): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = []
  if (typeof metric.successRate === 'number') {
    items.push({ label: '成功率', value: `${(metric.successRate as number * 100).toFixed(0)}%` })
  }
  if (typeof metric.count === 'number') {
    items.push({ label: '样本', value: `${metric.count} 次` })
  }
  if (typeof metric.overallRate === 'number' && typeof metric.successRate === 'number') {
    const diff = ((metric.successRate as number) - (metric.overallRate as number)) * 100
    items.push({
      label: '差异',
      value: `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%`,
    })
  }
  if (typeof metric.vRatio === 'number') {
    items.push({ label: '验证比例', value: `${((metric.vRatio as number) * 100).toFixed(1)}%` })
  }
  if (typeof metric.xRatio === 'number') {
    items.push({ label: '探索比例', value: `${((metric.xRatio as number) * 100).toFixed(1)}%` })
  }
  return items
}

// ============================================
// SuggestionCard（升级版：按钮外露 + 指标有标签）
// ============================================

const SuggestionCard = forwardRef<HTMLDivElement, {
  suggestion: Suggestion
  onAdopt: (suggestion: Suggestion) => Promise<void>
  onDismiss: (id: string) => void
  saving: boolean
  canAdopt: boolean
  tip?: string
}>(function SuggestionCard({ suggestion, onAdopt, onDismiss, saving, canAdopt, tip }, ref) {
  const [expanded, setExpanded] = useState(false)
  const isWarning = suggestion.severity === 'warning'
  const metrics = useMemo(() => formatMetrics(suggestion.metric), [suggestion.metric])
  const title = humanizeTitle(suggestion.title)

  return (
    <motion.div
      ref={ref}
      layout
      initial={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0, marginBottom: 0 }}
      transition={{ duration: 0.25 }}
      className={cn(
        'rounded-2xl border overflow-hidden',
        isWarning
          ? 'border-amber-200/80 bg-amber-50/30'
          : 'border-stone-200/60 bg-white',
      )}
    >
      {/* 头部区域 */}
      <div className="px-3.5 py-3">
        <div className="flex items-start gap-2.5">
          {isWarning
            ? <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            : <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          }
          <div className="flex-1 min-w-0">
            {/* 标题 + 指标标签 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-stone-700">{title}</span>
              {metrics.slice(0, 2).map(m => (
                <span key={m.label} className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-stone-100 text-stone-500 border border-stone-100">
                  <span className="text-stone-400">{m.label}</span>
                  <span className="font-semibold">{m.value}</span>
                </span>
              ))}
            </div>

            {/* LLM 通俗解释 */}
            {tip && (
              <p className="text-xs text-stone-400 mt-1 leading-snug">{tip}</p>
            )}
          </div>
        </div>

        {/* 操作栏：按钮 + 展开 */}
        <div className="flex items-center gap-2 mt-2.5 ml-6.5">
          {canAdopt && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); onAdopt(suggestion) }}
                disabled={saving}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                  saving
                    ? 'bg-stone-100 text-stone-400 cursor-not-allowed'
                    : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100',
                )}
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                {saving ? '保存中...' : '采纳'}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDismiss(suggestion.id) }}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors disabled:opacity-40"
              >
                <X className="w-3 h-3" />
                忽略
              </button>
            </>
          )}
          <div className="flex-1" />
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
          >
            <span>详情</span>
            <ChevronDown className={cn('w-3 h-3 transition-transform', expanded && 'rotate-180')} />
          </button>
        </div>
      </div>

      {/* 展开：技术详情 + 完整指标 */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 border-t border-stone-100/80">
              <p className="text-xs text-stone-500 leading-relaxed mt-2.5">{suggestion.description}</p>
              {metrics.length > 0 && (
                <div className="flex items-center gap-3 mt-2.5 pt-2 border-t border-stone-100/60">
                  {metrics.map(m => (
                    <div key={m.label} className="flex items-center gap-1.5">
                      <span className="text-[10px] text-stone-400">{m.label}</span>
                      <span className={cn(
                        'text-xs font-mono font-semibold',
                        m.label === '差异'
                          ? (m.value.startsWith('+') ? 'text-emerald-600' : m.value.startsWith('-') ? 'text-red-500' : 'text-stone-600')
                          : 'text-stone-600',
                      )}>{m.value}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
})

// ============================================
// CandidateRules 容器组件
// ============================================

interface CandidateRulesProps {
  suggestions: Suggestion[]
  adoptedIds: Set<string>
  dismissedIds: Set<string>
  onAdopt: (suggestion: Suggestion) => Promise<void>
  onDismiss: (id: string) => void
  saving: boolean
  tipMap: Record<string, string>
}

export function CandidateRules({
  suggestions, adoptedIds, dismissedIds,
  onAdopt, onDismiss, saving, tipMap,
}: CandidateRulesProps) {
  const candidates = useMemo(() =>
    suggestions.filter(s =>
      (s.type === 'rule_candidate' || s.type === 'pattern_warning') &&
      !adoptedIds.has(s.id) &&
      !dismissedIds.has(s.id)
    ),
    [suggestions, adoptedIds, dismissedIds],
  )

  if (candidates.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 }}
      className="mb-5"
    >
      <div className="flex items-center gap-1.5 mb-2.5">
        <span className="text-stone-400"><Lightbulb className="w-3.5 h-3.5" /></span>
        <h3 className="text-sm font-semibold text-stone-600 tracking-wide">候选规则</h3>
        <span className="text-xs font-mono text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded-full ml-auto">
          {candidates.length}
        </span>
      </div>
      <div className="space-y-2.5">
        <AnimatePresence mode="popLayout">
          {candidates.map(s => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onAdopt={onAdopt}
              onDismiss={onDismiss}
              saving={saving}
              canAdopt
              tip={tipMap[s.id]}
            />
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
