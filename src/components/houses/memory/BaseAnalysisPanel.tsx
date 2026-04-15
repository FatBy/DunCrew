import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity, AlertTriangle, RefreshCw,
  Zap, Shield, X as XIcon, ChevronDown,
  CheckCircle2, Lightbulb, Loader2,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { getServerUrl } from '@/utils/env'
import { useStore } from '@/store'
import { chat, isLLMConfigured } from '@/services/llmService'
import {
  CandidateRules,
  suggestionToRule,
  type Suggestion,
  type Rule,
} from './CandidateRulesSection'
import {
  SkillMemorySection,
  SectionHeader,
  type InjectionQuality,
  type SkillAnalysis,
} from './SkillMemorySection'

const SERVER_URL = getServerUrl()

// ---- 类型定义 ----
interface BaseStats {
  distribution: { E: number; P: number; V: number; X: number }
  totalBases: number; successRate: number; avgSeqLength: number
  traceCount: number; avgTokens: number
  avgTokensOnSuccess?: number; avgTokensOnFailure?: number
  maxTokens?: number; minTokens?: number; medianTokens?: number
}
interface NgramPattern {
  pattern: string; count: number; successRate: number
  gram: number; avgTokens?: number
}
interface TokenAnalysis {
  avgTokensOnSuccess: number; avgTokensOnFailure: number
  maxTokens: number; minTokens: number; medianTokens: number
  topTokenPatterns: NgramPattern[]
  efficientPatterns: NgramPattern[]
}
interface ActiveRule {
  rule: string; label: string; hitCount: number
  hitSuccessRate: number | null; noHitSuccessRate: number | null
  effectPP: number | null; status: 'active' | 'disabled'
  origin?: 'legacy' | 'discovered'
}
interface DiscoveredRuleDisplay {
  id: string; name: string; lifecycle: 'candidate' | 'validated' | 'retired'
  condition: { operator: string; clauses: Array<{ feature: string; op: string; value: number }> }
  action: { promptTemplate: string; severity: string }
  stats: { effectSizePP: number; pValue: number; hitCount: number; hitSuccessRate: number; noHitSuccessRate: number; sampleSize: number }
  origin: string
}
interface AnalysisData {
  traceCount: number; baseStats: BaseStats; ngramPatterns: NgramPattern[]
  injectionQuality: InjectionQuality; skillAnalysis: SkillAnalysis
  activeRules: ActiveRule[]; rules: Rule[]; suggestions: Suggestion[]
  tokenAnalysis?: TokenAnalysis
  discoveredRules?: DiscoveredRuleDisplay[]
}
interface ModelInfo {
  model: string; provider: string; count: number
}

// ---- 碱基颜色映射 ----

const BASE_META: Record<string, { label: string; stroke: string; text: string; bg: string; bgLight: string; hex: string; desc: string }> = {
  E: { label: '执行', stroke: '#3b82f6', text: 'text-blue-600', bg: 'bg-blue-500', bgLight: 'bg-blue-50', hex: '#3b82f6', desc: '调用工具、完成具体操作' },
  P: { label: '规划', stroke: '#f59e0b', text: 'text-amber-600', bg: 'bg-amber-500', bgLight: 'bg-amber-50', hex: '#f59e0b', desc: '分析任务、制定下一步计划' },
  V: { label: '验证', stroke: '#10b981', text: 'text-emerald-600', bg: 'bg-emerald-500', bgLight: 'bg-emerald-50', hex: '#10b981', desc: '检查结果是否符合预期' },
  X: { label: '探索', stroke: '#8b5cf6', text: 'text-purple-600', bg: 'bg-purple-500', bgLight: 'bg-purple-50', hex: '#8b5cf6', desc: '尝试不同方案、收集信息' },
}

const BASE_CLASSIFY: Record<string, string> = {
  E: '写文件、运行命令、修改代码等主动操作',
  P: '由 AI 自主标记的思考和决策步骤',
  V: '跑测试、编译检查、eslint 等验证操作',
  X: '搜索信息、浏览网页、查看目录等信息收集',
}

const BASE_ORDER = ['E', 'P', 'V', 'X'] as const

// ---- 工具函数 ----

function formatTokens(n: number): string {
  if (!n || n <= 0) return '0'
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}

// ---- SVG 环形图 ----

function RateRing({ rate, size = 112 }: { rate: number; size?: number }) {
  const R = (size / 2) - 8, STROKE = 7, C = 2 * Math.PI * R
  const filled = rate * C, pct = (rate * 100).toFixed(0)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full -rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={R}
          fill="none" stroke="#e7e5e4" strokeWidth={STROKE} opacity={0.5}
        />
        <circle
          cx={size / 2} cy={size / 2} r={R}
          fill="none"
          stroke={rate >= 0.9 ? '#10b981' : rate >= 0.7 ? '#f59e0b' : '#ef4444'}
          strokeWidth={STROKE}
          strokeDasharray={`${filled} ${C - filled}`}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn(
          'text-xl font-bold font-mono leading-none',
          rate >= 0.9 ? 'text-emerald-600' :
          rate >= 0.7 ? 'text-amber-600' : 'text-red-500',
        )}>
          {pct}%
        </span>
        <span className="text-xs text-stone-400 mt-0.5">成功率</span>
      </div>
    </div>
  )
}

function TokenRing({ avgTokens, size = 112 }: { avgTokens: number; size?: number }) {
  const R = (size / 2) - 8, STROKE = 7
  const display = formatTokens(avgTokens)

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} className="w-full h-full">
        <circle
          cx={size / 2} cy={size / 2} r={R}
          fill="none" stroke="#dbeafe" strokeWidth={STROKE}
        />
        <circle
          cx={size / 2} cy={size / 2} r={R}
          fill="none" stroke="#3b82f6" strokeWidth={STROKE}
          opacity={0.15}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-bold font-mono leading-none text-blue-600">
          {display}
        </span>
        <span className="text-xs text-stone-400 mt-0.5">平均消耗</span>
      </div>
    </div>
  )
}

// ---- Section 1: 英雄区 ----

// ---- 碱基标签气泡 ----

function BaseChip({ base, ratio }: { base: string; ratio: number }) {
  const meta = BASE_META[base]
  return (
    <div className="relative group">
      <div className={cn(
        'flex items-center gap-1 px-2 py-0.5 rounded-full cursor-default transition-colors',
        meta.bgLight,
      )}>
        <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', meta.bg)} />
        <span className={cn('text-xs font-medium', meta.text)}>
          {meta.label} {(ratio * 100).toFixed(0)}%
        </span>
      </div>
      {/* Tooltip */}
      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 w-52 opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 z-30">
        <div className="bg-stone-800 text-white text-[11px] rounded-lg px-3 py-2 shadow-lg leading-relaxed">
          <p className="font-medium mb-0.5">{meta.desc}</p>
          <p className="text-stone-300">{BASE_CLASSIFY[base]}</p>
        </div>
        <div className="w-2 h-2 bg-stone-800 rotate-45 mx-auto -mt-1" />
      </div>
    </div>
  )
}

// ---- Section 1: 英雄区 ----

function HeroSection({ stats, onRefresh, models, selectedModel, onModelChange, onClickSuccessRate, onClickTokens }: {
  stats: BaseStats; onRefresh: () => void
  models: ModelInfo[]; selectedModel: string; onModelChange: (m: string) => void
  onClickSuccessRate: () => void; onClickTokens: () => void
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-stone-200/60 bg-gradient-to-br from-white to-stone-50/80 p-5 mb-5"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-emerald-500" />
          <span className="text-base font-semibold text-stone-700">执行分析</span>
          <span className="text-xs font-mono text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded-full">
            {stats.traceCount} 条执行记录
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {models.length > 1 && (
            <select
              value={selectedModel}
              onChange={e => onModelChange(e.target.value)}
              className="text-xs bg-stone-50 border border-stone-200 rounded-lg px-2 py-1.5 text-stone-600 outline-none focus:border-stone-300 transition-colors cursor-pointer max-w-[160px] truncate"
              title="按模型筛选"
            >
              <option value="all">全部模型</option>
              {models.map(m => (
                <option key={m.model} value={m.model}>
                  {m.model} ({m.count})
                </option>
              ))}
            </select>
          )}
          <button
            onClick={onRefresh}
            className="p-1.5 rounded-lg text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
            title="刷新分析"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-center gap-8">
        <div
          onClick={onClickSuccessRate}
          className="bg-white/60 rounded-xl border border-stone-100 shadow-sm p-3 cursor-pointer hover:shadow-md hover:border-stone-200 transition-all"
        >
          <RateRing rate={stats.successRate} />
        </div>
        <div
          onClick={onClickTokens}
          className="bg-white/60 rounded-xl border border-stone-100 shadow-sm p-3 cursor-pointer hover:shadow-md hover:border-stone-200 transition-all"
        >
          <TokenRing avgTokens={stats.avgTokens} />
        </div>
      </div>

      {/* 碱基分布：堆叠进度条 + 标签 */}
      <div className="border-t border-stone-100 mt-4 pt-4 space-y-2">
        <div className="flex h-2.5 rounded-full overflow-hidden bg-stone-100">
          {BASE_ORDER.map(base => {
            const ratio = stats.distribution[base] || 0
            if (ratio < 0.005) return null
            return (
              <div key={base} style={{ width: `${ratio * 100}%`, backgroundColor: BASE_META[base].hex }}
                className="transition-all duration-700" />
            )
          })}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {BASE_ORDER.map(base => (
            <BaseChip key={base} base={base} ratio={stats.distribution[base] || 0} />
          ))}
        </div>
      </div>
    </motion.div>
  )
}

// ---- 成功率详情 Modal ----

function PatternRow({ p, idx }: { p: NgramPattern; idx: number }) {
  const label = humanizePattern(p.pattern)
  const pct = (p.successRate * 100).toFixed(0)
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="text-xs text-stone-400 w-4 shrink-0">{idx + 1}.</span>
      <span className="text-xs text-stone-700 flex-1 truncate">{label}</span>
      <span className="text-xs font-mono text-stone-400">{p.count}次</span>
      <span className={cn(
        'text-xs font-mono font-semibold px-1.5 py-0.5 rounded-full',
        p.successRate >= 0.7 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600',
      )}>
        {pct}%
      </span>
    </div>
  )
}

function humanizePattern(pattern: string): string {
  const baseNames: Record<string, string> = { E: '执行', P: '规划', V: '验证', X: '探索' }
  return pattern.split('-').map(l => baseNames[l] || l).join('\u2192')
}

function SuccessRateModal({ isOpen, onClose, stats, ngramPatterns }: {
  isOpen: boolean; onClose: () => void; stats: BaseStats; ngramPatterns: NgramPattern[]
}) {
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const successCount = Math.round(stats.traceCount * stats.successRate)
  const failureCount = stats.traceCount - successCount
  const sorted = [...ngramPatterns].filter(p => p.count >= 5)
  const topSuccess = [...sorted].sort((a, b) => b.successRate - a.successRate).slice(0, 3)
  const topFail = [...sorted].sort((a, b) => a.successRate - b.successRate).slice(0, 3)

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[200] flex items-center justify-center p-4"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-md bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.12)] overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              </div>
              <h2 className="text-sm font-semibold text-stone-800">成功率分析</h2>
            </div>
            <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 transition-colors">
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-5 space-y-5 max-h-[65vh] overflow-y-auto">
            {/* 成功/失败概览 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-emerald-50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-emerald-600">{successCount}</div>
                <div className="text-xs text-emerald-500 mt-0.5">次成功</div>
              </div>
              <div className="bg-red-50 rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-red-500">{failureCount}</div>
                <div className="text-xs text-red-400 mt-0.5">次失败</div>
              </div>
            </div>

            {/* 高成功率模式 */}
            {topSuccess.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-stone-500 mb-2">高成功率模式</h3>
                <div className="bg-stone-50 rounded-lg px-3 py-1 divide-y divide-stone-100">
                  {topSuccess.map((p, i) => <PatternRow key={p.pattern} p={p} idx={i} />)}
                </div>
              </div>
            )}

            {/* 低成功率模式 */}
            {topFail.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-stone-500 mb-2">需要关注的模式</h3>
                <div className="bg-stone-50 rounded-lg px-3 py-1 divide-y divide-stone-100">
                  {topFail.map((p, i) => <PatternRow key={p.pattern} p={p} idx={i} />)}
                </div>
              </div>
            )}

            {sorted.length === 0 && (
              <p className="text-xs text-stone-400 text-center py-4">数据量不足，暂无模式分析</p>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

// ---- Token 消耗详情 Modal ----

function TokenBar({ label, value, maxVal, color }: { label: string; value: number; maxVal: number; color: string }) {
  const width = maxVal > 0 ? (value / maxVal) * 100 : 0
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-stone-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-stone-100 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${width}%` }} />
      </div>
      <span className="text-xs font-mono font-semibold text-stone-600 w-14 text-right">{formatTokens(value)}</span>
    </div>
  )
}

function TokenPatternTable({ patterns, title }: { patterns: NgramPattern[]; title: string }) {
  if (!patterns || patterns.length === 0) return null
  return (
    <div>
      <h3 className="text-xs font-semibold text-stone-500 mb-2">{title}</h3>
      <div className="bg-stone-50 rounded-lg overflow-hidden">
        <div className="grid grid-cols-[1fr_60px_52px_40px] gap-1 px-3 py-1.5 text-[10px] text-stone-400 border-b border-stone-100">
          <span>模式</span><span className="text-right">消耗</span><span className="text-right">成功率</span><span className="text-right">次数</span>
        </div>
        {patterns.map(p => (
          <div key={p.pattern} className="grid grid-cols-[1fr_60px_52px_40px] gap-1 px-3 py-1.5 text-xs border-b border-stone-50 last:border-0">
            <span className="text-stone-700 truncate">{humanizePattern(p.pattern)}</span>
            <span className="text-right font-mono text-stone-500">{formatTokens(p.avgTokens || 0)}</span>
            <span className={cn(
              'text-right font-mono font-semibold',
              (p.successRate >= 0.7) ? 'text-emerald-600' : 'text-red-500',
            )}>
              {(p.successRate * 100).toFixed(0)}%
            </span>
            <span className="text-right font-mono text-stone-400">{p.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TokenDetailModal({ isOpen, onClose, stats, tokenAnalysis, ngramPatterns }: {
  isOpen: boolean; onClose: () => void; stats: BaseStats
  tokenAnalysis?: TokenAnalysis; ngramPatterns: NgramPattern[]
}) {
  const [llmInsight, setLlmInsight] = useState<string | null>(null)
  const [llmLoading, setLlmLoading] = useState(false)
  const insightGenRef = useRef(false)

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  // LLM 洞察生成
  useEffect(() => {
    if (!isOpen || insightGenRef.current || !isLLMConfigured()) return
    const ta = tokenAnalysis
    if (!ta || (ta.topTokenPatterns.length < 1 && ta.efficientPatterns.length < 1)) return
    insightGenRef.current = true
    setLlmLoading(true)

    const run = async () => {
      const topList = ta.topTokenPatterns.map(p =>
        `${humanizePattern(p.pattern)}: 平均${formatTokens(p.avgTokens || 0)}, 成功率${(p.successRate * 100).toFixed(0)}%`
      ).join('\n')
      const effList = ta.efficientPatterns.map(p =>
        `${humanizePattern(p.pattern)}: 平均${formatTokens(p.avgTokens || 0)}, 成功率${(p.successRate * 100).toFixed(0)}%`
      ).join('\n')
      const dist = stats.distribution
      try {
        const result = await chat([
          { role: 'system', content: '你是一个 AI 执行效率分析师。' },
          {
            role: 'user',
            content: `以下是 AI Agent 执行任务的消耗统计数据，请用简单中文分析哪些步骤组合消耗高且值得（高成功率说明有价值）、哪些消耗高但可能浪费（低成功率说明无效消耗）。

数据概览：
- 整体平均消耗: ${formatTokens(stats.avgTokens)}
- 成功任务平均: ${formatTokens(ta.avgTokensOnSuccess)}
- 失败任务平均: ${formatTokens(ta.avgTokensOnFailure)}
- 步骤分布: 执行${(dist.E * 100).toFixed(0)}% 规划${(dist.P * 100).toFixed(0)}% 验证${(dist.V * 100).toFixed(0)}% 探索${(dist.X * 100).toFixed(0)}%

高消耗步骤组合:
${topList || '暂无数据'}

高效步骤组合:
${effList || '暂无数据'}

要求：
- 不超过 120 字
- 不使用"碱基""序列""n-gram""token"等技术术语，用"步骤组合""消耗"等通俗表达
- 指出哪种组合消耗高但值得，哪种可能浪费
- 给出 1 条具体可行的优化建议`
          },
        ])
        setLlmInsight(result)
      } catch {
        setLlmInsight(null)
      } finally {
        setLlmLoading(false)
      }
    }
    run()
  }, [isOpen, tokenAnalysis, stats, ngramPatterns])

  // 重置 LLM insight 缓存
  useEffect(() => {
    if (!isOpen) {
      insightGenRef.current = false
    }
  }, [isOpen])

  if (!isOpen) return null

  const ta = tokenAnalysis
  const avgSuccess = ta?.avgTokensOnSuccess ?? stats.avgTokensOnSuccess ?? 0
  const avgFail = ta?.avgTokensOnFailure ?? stats.avgTokensOnFailure ?? 0
  const maxTokens = ta?.maxTokens ?? stats.maxTokens ?? 0
  const minTokens = ta?.minTokens ?? stats.minTokens ?? 0
  const medianTokens = ta?.medianTokens ?? stats.medianTokens ?? 0
  const barMax = Math.max(avgSuccess, avgFail, 1)

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[200] flex items-center justify-center p-4"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          onClick={e => e.stopPropagation()}
          className="w-full max-w-lg bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.12)] overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center">
                <Zap className="w-4 h-4 text-blue-500" />
              </div>
              <h2 className="text-sm font-semibold text-stone-800">Token 消耗分析</h2>
            </div>
            <button onClick={onClose} className="p-1 text-stone-400 hover:text-stone-600 transition-colors">
              <XIcon className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-5 space-y-5 max-h-[65vh] overflow-y-auto">
            {/* 核心指标 */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-blue-50 rounded-xl p-3 text-center">
                <div className="text-lg font-bold font-mono text-blue-600">{formatTokens(stats.avgTokens)}</div>
                <div className="text-[10px] text-blue-400 mt-0.5">平均消耗</div>
              </div>
              <div className="bg-stone-50 rounded-xl p-3 text-center">
                <div className="text-lg font-bold font-mono text-stone-600">{formatTokens(medianTokens)}</div>
                <div className="text-[10px] text-stone-400 mt-0.5">中位数</div>
              </div>
              <div className="bg-stone-50 rounded-xl p-3 text-center">
                <div className="text-xs font-mono text-stone-500 mt-1">{formatTokens(minTokens)} ~ {formatTokens(maxTokens)}</div>
                <div className="text-[10px] text-stone-400 mt-1">消耗范围</div>
              </div>
            </div>

            {/* 成功 vs 失败对比 */}
            {(avgSuccess > 0 || avgFail > 0) && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-stone-500">成功 vs 失败对比</h3>
                <TokenBar label="成功任务平均" value={avgSuccess} maxVal={barMax} color="bg-emerald-400" />
                <TokenBar label="失败任务平均" value={avgFail} maxVal={barMax} color="bg-red-400" />
                {avgFail > avgSuccess * 1.3 && avgFail > 0 && (
                  <p className="text-[11px] text-amber-600 bg-amber-50 rounded-lg px-3 py-1.5">
                    失败任务的消耗明显高于成功任务，可能存在无效重试
                  </p>
                )}
              </div>
            )}

            {/* 高消耗模式 */}
            <TokenPatternTable patterns={ta?.topTokenPatterns || []} title="高消耗步骤组合 Top 5" />

            {/* 高效模式 */}
            <TokenPatternTable patterns={ta?.efficientPatterns || []} title="高效步骤组合 Top 5" />

            {/* LLM 洞察 */}
            {llmLoading && (
              <div className="flex items-center gap-2 px-3 py-3 bg-blue-50 rounded-lg">
                <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                <span className="text-xs text-blue-500">正在分析消耗模式...</span>
              </div>
            )}
            {llmInsight && !llmLoading && (
              <div className="flex items-start gap-2 px-3 py-3 bg-blue-50 rounded-lg">
                <Lightbulb className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                <p className="text-xs text-blue-700 leading-relaxed">{llmInsight}</p>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

// ---- Section 2: 守护规则表（含已采纳规则） ----

/** 将碱基字母代码转为可读中文，如 "P-E-X" → "规划→执行→探索" */
function humanizeRuleName(name: string): string {
  const baseNames: Record<string, string> = { E: '执行', P: '规划', V: '验证', X: '探索' }
  return name.replace(/\b([EPVX](?:-[EPVX])+)\b/g, (match) =>
    match.split('-').map(l => baseNames[l] || l).join('→')
  )
}

// ---- 成功率对比条 & 规则展开详情 ----

function RateBar({ label, rate, color }: { label: string; rate: number | null; color: string }) {
  if (rate === null) return null
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-stone-500 w-24 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-stone-100 overflow-hidden">
        <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${rate * 100}%` }} />
      </div>
      <span className="text-xs font-mono font-semibold text-stone-600 w-12 text-right">{(rate * 100).toFixed(1)}%</span>
    </div>
  )
}

// ---- 规则展开详情 ----

function RuleDetails({ rule, traceCount }: {
  rule: { hitCount: number; hitSuccessRate: number | null; noHitSuccessRate: number | null; effectPP: number | null }
  traceCount: number
}) {
  const hitRate = traceCount > 0 ? rule.hitCount / traceCount : 0
  const effectText = rule.effectPP !== null
    ? (rule.effectPP < 0
      ? { label: `避免可提升 ${Math.abs(rule.effectPP).toFixed(1)}%`, color: 'text-emerald-600' }
      : { label: `+${rule.effectPP.toFixed(1)}%`, color: rule.effectPP > 2 ? 'text-emerald-600' : 'text-stone-500' })
    : null
  return (
    <div className="px-3.5 pb-3.5 pt-2 border-t border-stone-100/60 bg-stone-50/30">
      <div className="space-y-2">
        <RateBar label="命中时成功率" rate={rule.hitSuccessRate} color="bg-emerald-400" />
        <RateBar label="未命中时成功率" rate={rule.noHitSuccessRate} color="bg-stone-300" />
      </div>
      <div className="flex items-center gap-4 mt-3 pt-2.5 border-t border-stone-100/60">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-stone-400">触发频率</span>
          <span className="text-xs font-mono font-semibold text-stone-600">{rule.hitCount}/{traceCount}</span>
          <span className="text-[10px] text-stone-400">({(hitRate * 100).toFixed(0)}%)</span>
        </div>
        {effectText && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-400">影响</span>
            <span className={cn('text-xs font-mono font-semibold', effectText.color)}>
              {effectText.label}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

function ActiveRulesTable({ activeRules, adoptedRules, onRemoveAdopted, onToggleRule, tipMap, traceCount }: {
  activeRules: ActiveRule[]
  adoptedRules: Rule[]
  onRemoveAdopted: (id: string) => void
  onToggleRule: (ruleName: string, currentStatus: string) => void
  tipMap: Record<string, string>
  traceCount: number
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const hasGovernor = activeRules && activeRules.length > 0
  const hasAdopted = adoptedRules.length > 0
  if (!hasGovernor && !hasAdopted) return null

  const activeCount = (activeRules?.filter(r => r.status === 'active').length ?? 0) + adoptedRules.length

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 }}
      className="mb-5"
    >
      <SectionHeader
        icon={<Shield className="w-3.5 h-3.5" />}
        title="守护规则"
        badge={`${activeCount} 活跃`}
      />
      <div className="rounded-xl border border-stone-200/60 overflow-hidden">
        {/* 守护内置规则 */}
        {activeRules?.map((rule, i) => {
          const isDisabled = rule.status === 'disabled'
          const isExpanded = expandedId === rule.rule
          const effect = rule.effectPP !== null
            ? formatEffect(rule.effectPP, rule.hitSuccessRate ?? 0, rule.noHitSuccessRate ?? 0)
            : null
          return (
            <div
              key={rule.rule}
              className={cn(
                'transition-colors',
                i > 0 && 'border-t border-stone-100/80',
                isDisabled ? 'bg-white/60 opacity-50' : 'bg-emerald-50/60',
              )}
            >
              <button
                onClick={() => setExpandedId(isExpanded ? null : rule.rule)}
                className={cn(
                  'w-full flex items-center gap-3 px-3.5 py-2.5 text-sm text-left',
                  'hover:bg-stone-50/30 transition-colors',
                )}
              >
                <div className="flex-1 min-w-0">
                  <span className={cn('text-stone-700 font-medium', isDisabled && 'line-through')}>
                    {rule.label}
                  </span>
                  {tipMap[rule.rule] ? (
                    <p className="text-xs text-stone-400 mt-0.5 leading-snug">{tipMap[rule.rule]}</p>
                  ) : (
                    <p className="text-xs text-stone-300 italic mt-0.5">说明生成中…</p>
                  )}
                </div>

                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm text-stone-500">{rule.hitCount}</div>
                  <div className="text-[10px] text-stone-400 leading-none">触发</div>
                </div>

                {effect && (
                  <span className={cn('text-xs whitespace-nowrap shrink-0', effect.color)}>
                    {effect.text}
                  </span>
                )}

                <ChevronDown className={cn(
                  'w-3.5 h-3.5 text-stone-300 shrink-0 transition-transform',
                  isExpanded && 'rotate-180',
                )} />

                {/* 开关按钮 */}
                <span
                  role="button"
                  onClick={(e) => { e.stopPropagation(); onToggleRule?.(rule.rule, rule.status) }}
                  className={cn(
                    'relative w-9 h-5 rounded-full transition-colors shrink-0 border',
                    isDisabled ? 'bg-stone-300 border-stone-400' : 'bg-emerald-500 border-emerald-600',
                  )}
                  title={isDisabled ? '点击启用此规则' : '点击禁用此规则'}
                >
                  <span className={cn(
                    'absolute top-[3px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                    isDisabled ? 'left-[2px]' : 'left-[18px]',
                  )} />
                </span>
              </button>

              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <RuleDetails rule={rule} traceCount={traceCount} />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}

        {/* 已采纳的数据驱动规则 */}
        {hasAdopted && (
          <>
            {hasGovernor && (
              <div className="border-t border-stone-200/60 px-3.5 py-1.5 bg-stone-50/50">
                <span className="text-xs font-medium text-stone-400">已采纳规则</span>
              </div>
            )}
            {adoptedRules.map((rule, i) => {
              const isExpanded = expandedId === `adopted:${rule.id}`
              const hasRates = rule.hitSuccessRate !== null || rule.noHitSuccessRate !== null
              const effect = rule.effectPP !== null
                ? formatEffect(rule.effectPP, rule.hitSuccessRate ?? 0, rule.noHitSuccessRate ?? 0)
                : null
              return (
                <div key={rule.id} className={cn(
                  'bg-emerald-50/60',
                  (hasGovernor || i > 0) && 'border-t border-stone-100/80',
                )}>
                  <button
                    onClick={() => hasRates && setExpandedId(isExpanded ? null : `adopted:${rule.id}`)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3.5 py-2.5 text-sm text-left group',
                      hasRates && 'hover:bg-stone-50/30 transition-colors',
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-stone-700">{humanizeRuleName(rule.name)}</span>
                      {tipMap[rule.id] && (
                        <p className="text-xs text-stone-400 mt-0.5 leading-snug">{tipMap[rule.id]}</p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm text-stone-500">{rule.hitCount}</div>
                      <div className="text-[10px] text-stone-400 leading-none">触发</div>
                    </div>
                    {effect && (
                      <span className={cn('text-xs whitespace-nowrap shrink-0', effect.color)}>
                        {effect.text}
                      </span>
                    )}
                    {hasRates && (
                      <ChevronDown className={cn(
                        'w-3.5 h-3.5 text-stone-300 shrink-0 transition-transform',
                        isExpanded && 'rotate-180',
                      )} />
                    )}
                    <span
                      role="button"
                      onClick={(e) => { e.stopPropagation(); onRemoveAdopted(rule.id) }}
                      className="w-5 h-5 flex items-center justify-center rounded text-stone-300 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-50 transition-all shrink-0"
                      title="移除此规则"
                    >
                      <XIcon className="w-3 h-3" />
                    </span>
                  </button>
                  <AnimatePresence>
                    {isExpanded && hasRates && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <RuleDetails rule={rule} traceCount={traceCount} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )
            })}
          </>
        )}
      </div>
    </motion.div>
  )
}

// ---- 数据驱动发现规则 ----

const LIFECYCLE_LABELS: Record<string, { text: string; color: string }> = {
  candidate: { text: '候选', color: 'text-amber-600 bg-amber-50' },
  validated: { text: '已验证', color: 'text-emerald-600 bg-emerald-50' },
  retired: { text: '已禁用', color: 'text-stone-400 bg-stone-50' },
}

/** 将负效应量转为用户友好的正面表述 */
function formatEffect(effectPP: number, _hitSR: number, _noHitSR: number): { text: string; color: string } {
  const absPP = Math.abs(effectPP)
  if (effectPP < 0) {
    // 命中时成功率更低 → 避免此模式可提升成功率
    return {
      text: `避免可提升 ${absPP.toFixed(1)}%`,
      color: absPP >= 10 ? 'text-emerald-600 font-medium' : 'text-emerald-500',
    }
  }
  // 正效应（理论上不应该出现在这里，因为发现管线只产出负效应规则）
  return { text: `+${absPP.toFixed(1)}%`, color: 'text-stone-500' }
}

function DiscoveredRulesSection({ rules, discovering, onRunDiscovery, onToggleRule, tipMap }: {
  rules: DiscoveredRuleDisplay[]
  discovering: boolean
  onRunDiscovery: () => void
  onToggleRule: (ruleId: string, currentLifecycle: string) => void
  tipMap: Record<string, string>
}) {
  const [showRetired, setShowRetired] = useState(false)
  const activeRules = rules.filter(r => r.lifecycle !== 'retired')
  const retiredRules = rules.filter(r => r.lifecycle === 'retired')
  const displayRules = showRetired ? rules : activeRules

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="mb-6"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap className="w-4 h-4 text-violet-500" />
          <h3 className="font-semibold text-stone-700 text-sm">
            数据驱动规则
          </h3>
          {rules.length > 0 && (
            <span className="text-xs text-stone-400">
              {activeRules.length} 条启用
              {retiredRules.length > 0 && (
                <button
                  onClick={() => setShowRetired(!showRetired)}
                  className="ml-1 text-stone-400 hover:text-stone-600 underline decoration-dotted"
                >
                  {showRetired ? '隐藏' : `+${retiredRules.length} 已禁用`}
                </button>
              )}
            </span>
          )}
        </div>
        <button
          onClick={onRunDiscovery}
          disabled={discovering}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors',
            discovering
              ? 'bg-stone-100 text-stone-400 cursor-not-allowed'
              : 'bg-violet-50 text-violet-600 hover:bg-violet-100'
          )}
        >
          {discovering ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Activity className="w-3.5 h-3.5" />
          )}
          {discovering ? '发现中...' : '运行发现'}
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="rounded-xl bg-stone-50/80 border border-stone-100 p-4 text-center">
          <p className="text-sm text-stone-400">
            尚未发现数据驱动规则。点击"运行发现"从历史 trace 中自动提取统计显著的规则。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {displayRules.map(rule => {
            const lc = LIFECYCLE_LABELS[rule.lifecycle] || LIFECYCLE_LABELS.candidate
            const clause = rule.condition.clauses[0]
            const isEnabled = rule.lifecycle !== 'retired'
            const effect = formatEffect(rule.stats.effectSizePP, rule.stats.hitSuccessRate, rule.stats.noHitSuccessRate)
            const tip = tipMap[rule.id]

            return (
              <div
                key={rule.id}
                className={cn(
                  'rounded-xl border p-3 transition-colors',
                  isEnabled ? 'bg-emerald-50/60 border-emerald-200/50' : 'bg-stone-50/50 border-stone-100/50 opacity-60',
                )}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0', lc.color)}>
                      {lc.text}
                    </span>
                    <span className={cn('text-sm font-medium truncate', isEnabled ? 'text-stone-700' : 'text-stone-400')}>
                      {clause ? `${clause.feature} ${clause.op} ${clause.value}` : rule.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    {/* 效应量 — 正面表述 */}
                    <span className={cn('text-xs whitespace-nowrap', effect.color)}>
                      {effect.text}
                    </span>
                    {/* 开关按钮 */}
                    <button
                      onClick={() => onToggleRule?.(rule.id, rule.lifecycle)}
                      className={cn(
                        'relative w-9 h-5 rounded-full transition-colors shrink-0 border',
                        isEnabled ? 'bg-emerald-500 border-emerald-600' : 'bg-stone-300 border-stone-400',
                      )}
                      title={isEnabled ? '点击禁用此规则' : '点击启用此规则'}
                    >
                      <span className={cn(
                        'absolute top-[3px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform',
                        isEnabled ? 'left-[18px]' : 'left-[2px]',
                      )} />
                    </button>
                  </div>
                </div>

                {/* 通俗解释（LLM 生成） */}
                {tip ? (
                  <p className="text-xs text-stone-500 mb-1.5 leading-relaxed">{tip}</p>
                ) : (
                  <p className="text-xs text-stone-300 italic mb-1.5">说明生成中…</p>
                )}

                {/* 统计详情 */}
                <div className="flex items-center gap-3 text-[11px] text-stone-400 mt-1">
                  <span>命中 {rule.stats.hitCount} 次</span>
                  <span className="text-stone-300">|</span>
                  <span>命中成功率 {(rule.stats.hitSuccessRate * 100).toFixed(1)}%</span>
                  <span>→</span>
                  <span>未命中 {(rule.stats.noHitSuccessRate * 100).toFixed(1)}%</span>
                  <span className="text-stone-300">|</span>
                  <span>p={rule.stats.pValue < 0.001 ? '<0.001' : rule.stats.pValue.toFixed(3)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </motion.div>
  )
}

// ---- 主组件 ----

export function BaseAnalysisPanel() {
  const [data, setData] = useState<AnalysisData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // V5: 模型筛选
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('all')

  // 规则管理状态
  const [rules, setRules] = useState<Rule[]>([])
  const [adoptedIds, setAdoptedIds] = useState<Set<string>>(new Set())
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set())
  const [processedSkillIds, setProcessedSkillIds] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const addToast = useStore(s => s.addToast)

  // ---- Modal 状态 ----
  const [showSuccessModal, setShowSuccessModal] = useState(false)
  const [showTokenModal, setShowTokenModal] = useState(false)

  // ---- 规则发现状态 ----
  // ---- 规则发现状态 ----
  const [discovering, setDiscovering] = useState(false)

  // ---- 规则通俗解释 (tipMap) ----
  const [tipMap, setTipMap] = useState<Record<string, string>>({})
  const tipGenRef = useRef(false) // 防止重复生成

  // ---- 加载已处理/忽略项 ----
  const fetchDismissedItems = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/dismissed-items`)
      if (res.ok) {
        const json = await res.json()
        if (json.suggestions?.length) setDismissedIds(new Set(json.suggestions))
        if (json.skills?.length) setProcessedSkillIds(new Set(json.skills))
      }
    } catch { /* ignore */ }
  }, [])

  // V5: 加载可用模型列表
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`${SERVER_URL}/api/base-analysis/models?days=90`)
      if (res.ok) {
        const json = await res.json()
        setModels(json.models || [])
      }
    } catch { /* ignore */ }
  }, [])

  const fetchAnalysis = useCallback(async (model?: string) => {
    setLoading(true)
    setError(null)
    const modelParam = model ?? selectedModel
    try {
      const params = new URLSearchParams({ days: '90' })
      if (modelParam && modelParam !== 'all') params.set('model', modelParam)
      const res = await fetch(`${SERVER_URL}/api/base-analysis?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: AnalysisData = await res.json()
      setData(json)
      // 初始化规则状态
      setRules(json.rules || [])
      // 从已保存规则中重建 adoptedIds（origin === 'auto' 的是用户采纳的）
      const adopted = new Set(
        (json.rules || []).filter(r => r.origin === 'auto').map(r => r.id)
      )
      setAdoptedIds(adopted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [selectedModel])

  useEffect(() => {
    fetchAnalysis()
    fetchModels()
    fetchDismissedItems()
  }, [fetchAnalysis, fetchModels, fetchDismissedItems])

  // V5: 模型切换时重新加载分析数据
  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model)
    tipGenRef.current = false  // 允许新模型重新生成 tips
    fetchAnalysis(model)
  }, [fetchAnalysis])

  // ---- LLM tip 生成核心函数（可被多处调用） ----
  const generateTipsForRules = useCallback(async (
    needTip: Array<{ key: string; label: string; desc: string }>,
    existingTips: Record<string, string>,
  ) => {
    if (needTip.length === 0 || !isLLMConfigured()) return existingTips

    const ruleList = needTip.map((r, i) =>
      `${i + 1}. 标识: "${r.key}" | 名称: "${r.label}" | 技术描述: "${r.desc}"`
    ).join('\n')

    try {
      const result = await chat([
        { role: 'system', content: '你是一个 AI 助手产品的 UX 文案专家。' },
        {
          role: 'user',
          content: `以下是一些 AI Agent 执行引擎的内部规则。请为每条规则写一句通俗易懂的中文解释（面向完全不懂技术的普通用户），让他们知道这条规则在做什么、对他们有什么影响。

要求：
- 每条解释控制在 15-30 字
- 用日常用语，不要用任何技术术语（不要出现"碱基"、"序列"、"n-gram"、"token"等词）
- 语气亲和，像在向朋友解释

规则列表：
${ruleList}

请严格按 JSON 格式返回，key 是规则标识，value 是通俗解释：
{"规则标识1": "通俗解释1", "规则标识2": "通俗解释2", ...}`
        },
      ])

      const jsonMatch = result.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const generated: Record<string, string> = JSON.parse(jsonMatch[0])
        const merged = { ...existingTips, ...generated }
        setTipMap(merged)

        // 持久化到后端
        await fetch(`${SERVER_URL}/api/rule-tips`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tips: generated }),
        }).catch(() => {})

        return merged
      }
    } catch (err) {
      console.warn('[BaseAnalysis] Failed to generate rule tips:', err)
    }
    return existingTips
  }, [])

  // ---- 规则发现管线 ----
  const handleRunDiscovery = useCallback(async () => {
    setDiscovering(true)
    try {
      const res = await fetch(`${SERVER_URL}/api/rule-discovery/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 90 }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as {
        newRules: DiscoveredRuleDisplay[]
        existingRules: DiscoveredRuleDisplay[]
        stats: { tracesAnalyzed: number; newRulesFound: number }
      }

      // 发现新规则后，先为新规则生成 LLM 说明
      if (json.newRules.length > 0 && isLLMConfigured()) {
        const newTipNeeds: Array<{ key: string; label: string; desc: string }> = []
        for (const r of json.newRules) {
          if (!tipMap[r.id]) {
            const clause = r.condition.clauses[0]
            const condStr = clause ? `${clause.feature} ${clause.op} ${clause.value}` : r.name
            const effectDesc = r.stats.effectSizePP < 0
              ? `命中时成功率降低 ${Math.abs(r.stats.effectSizePP)}pp（${(r.stats.hitSuccessRate * 100).toFixed(0)}% vs ${(r.stats.noHitSuccessRate * 100).toFixed(0)}%）`
              : `命中时成功率提升 ${r.stats.effectSizePP}pp`
            newTipNeeds.push({
              key: r.id,
              label: condStr,
              desc: `统计发现规则: 当 ${condStr} 时，${effectDesc}。提示内容: ${r.action.promptTemplate.slice(0, 60)}`,
            })
          }
        }
        // 生成说明（异步但不阻塞展示）
        generateTipsForRules(newTipNeeds, tipMap)
      }

      // 更新 data 中的 discoveredRules
      if (data) {
        setData({ ...data, discoveredRules: json.existingRules })
      }
      addToast(
        json.stats.newRulesFound > 0
          ? { type: 'success', title: '规则发现', message: `发现 ${json.stats.newRulesFound} 条新规则，正在生成说明…` }
          : { type: 'info', title: '规则发现', message: `未发现新规则（分析 ${json.stats.tracesAnalyzed} 条 trace）` },
      )
    } catch (err) {
      addToast({ type: 'error', title: '规则发现失败', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setDiscovering(false)
    }
  }, [data, addToast, tipMap, generateTipsForRules])

  // ---- 规则启用/禁用切换 ----
  const handleToggleRule = useCallback(async (ruleId: string, currentLifecycle: string) => {
    const action = currentLifecycle === 'retired' ? 'validate' : 'retire'
    try {
      const res = await fetch(`${SERVER_URL}/api/discovered-rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ruleId, reason: 'user_toggle' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { rules: DiscoveredRuleDisplay[] }
      if (data) {
        setData({ ...data, discoveredRules: json.rules })
      }
    } catch (err) {
      addToast({ type: 'error', title: '切换失败', message: err instanceof Error ? err.message : String(err) })
    }
  }, [data, addToast])

  // ---- 守护规则（legacy）启用/禁用切换 ----
  const handleToggleLegacyRule = useCallback(async (ruleName: string, currentStatus: string) => {
    const enabled = currentStatus === 'disabled' // disabled → enable, active → disable
    try {
      const res = await fetch(`${SERVER_URL}/api/governor/rule-toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule: ruleName, enabled }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // 乐观更新本地 data
      if (data) {
        const updatedRules = data.activeRules.map(r =>
          r.rule === ruleName ? { ...r, status: (enabled ? 'active' : 'disabled') as 'active' | 'disabled' } : r,
        )
        setData({ ...data, activeRules: updatedRules })
      }
    } catch (err) {
      addToast({ type: 'error', title: '切换失败', message: err instanceof Error ? err.message : String(err) })
    }
  }, [data, addToast])

  // ---- 收集需要 tip 的规则标识 ----
  const collectNeedTip = useCallback((
    analysisData: AnalysisData,
    cached: Record<string, string>,
  ) => {
    const needTip: Array<{ key: string; label: string; desc: string }> = []

    for (const r of analysisData.activeRules || []) {
      if (!cached[r.rule]) {
        needTip.push({ key: r.rule, label: r.label, desc: `守护内置规则: ${r.label}` })
      }
    }
    for (const s of analysisData.suggestions || []) {
      if (!cached[s.id]) {
        needTip.push({ key: s.id, label: s.title, desc: s.description })
      }
    }
    for (const r of analysisData.rules || []) {
      if (r.origin === 'auto' && !cached[r.id]) {
        needTip.push({ key: r.id, label: r.name, desc: `数据驱动规则: ${r.name}` })
      }
    }
    for (const r of analysisData.discoveredRules || []) {
      if (!cached[r.id]) {
        const clause = r.condition.clauses[0]
        const condStr = clause ? `${clause.feature} ${clause.op} ${clause.value}` : r.name
        const effectDesc = r.stats.effectSizePP < 0
          ? `命中时成功率降低 ${Math.abs(r.stats.effectSizePP)}pp（${(r.stats.hitSuccessRate * 100).toFixed(0)}% vs ${(r.stats.noHitSuccessRate * 100).toFixed(0)}%）`
          : `命中时成功率提升 ${r.stats.effectSizePP}pp`
        needTip.push({
          key: r.id,
          label: condStr,
          desc: `统计发现规则: 当 ${condStr} 时，${effectDesc}。提示内容: ${r.action.promptTemplate.slice(0, 60)}`,
        })
      }
    }
    return needTip
  }, [])

  // ---- 自动加载 & 生成规则通俗解释 ----
  useEffect(() => {
    if (!data || tipGenRef.current) return
    tipGenRef.current = true

    const run = async () => {
      // 1) 加载已缓存的 tips
      let cached: Record<string, string> = {}
      try {
        const res = await fetch(`${SERVER_URL}/api/rule-tips`)
        if (res.ok) cached = await res.json()
      } catch { /* ignore */ }
      setTipMap(cached)

      // 2) 收集并生成
      const needTip = collectNeedTip(data, cached)
      await generateTipsForRules(needTip, cached)
    }

    run()
  }, [data])

  // ---- 采纳候选规则 ----
  const handleAdopt = useCallback(async (suggestion: Suggestion) => {
    if (saving) return
    // 防重复
    if (rules.some(r => r.id === suggestion.id)) {
      setAdoptedIds(prev => new Set(prev).add(suggestion.id))
      return
    }

    setSaving(true)
    const newRule = suggestionToRule(suggestion)
    const updatedRules = [...rules, newRule]

    try {
      const res = await fetch(`${SERVER_URL}/api/base-analysis/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: updatedRules }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      setRules(updatedRules)
      setAdoptedIds(prev => new Set(prev).add(suggestion.id))
      addToast({ type: 'success', title: '规则已采纳', message: newRule.name })
    } catch {
      addToast({ type: 'error', title: '保存失败', message: '无法连接后端服务' })
    } finally {
      setSaving(false)
    }
  }, [saving, rules, addToast])

  // ---- 忽略候选规则（持久化到后端）----
  const handleDismiss = useCallback((id: string) => {
    setDismissedIds(prev => new Set(prev).add(id))
    fetch(`${SERVER_URL}/api/dismissed-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestions: [id] }),
    }).catch(() => {})
  }, [])

  // ---- 技能已处理（持久化到后端）----
  const handleSkillProcessed = useCallback((skillId: string) => {
    setProcessedSkillIds(prev => new Set(prev).add(skillId))
    fetch(`${SERVER_URL}/api/dismissed-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skills: [skillId] }),
    }).catch(() => {})
  }, [])

  // ---- 撤销已采纳规则 ----
  const handleRemoveAdopted = useCallback(async (ruleId: string) => {
    const updatedRules = rules.filter(r => r.id !== ruleId)

    try {
      const res = await fetch(`${SERVER_URL}/api/base-analysis/rules`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: updatedRules }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      setRules(updatedRules)
      setAdoptedIds(prev => {
        const next = new Set(prev)
        next.delete(ruleId)
        return next
      })
      addToast({ type: 'info', title: '规则已移除' })
    } catch {
      addToast({ type: 'error', title: '移除失败', message: '无法连接后端服务' })
    }
  }, [rules, addToast])

  // 已采纳的规则列表
  const adoptedRules = useMemo(() =>
    rules.filter(r => r.origin === 'auto'),
    [rules],
  )

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-7 h-7 text-stone-300 animate-spin" />
          <p className="text-sm text-stone-400">加载分析数据...</p>
        </div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center">
          <AlertTriangle className="w-10 h-10 text-stone-200" />
          <p className="text-base text-stone-500">分析引擎连接失败</p>
          <p className="text-sm text-stone-400 max-w-48">{error || '请确认后端服务正在运行'}</p>
          <button onClick={() => fetchAnalysis()}
            className="mt-2 px-3 py-1.5 text-sm rounded-lg bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors">
            重试
          </button>
        </div>
      </div>
    )
  }
  if (data.traceCount === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center">
          <Activity className="w-12 h-12 text-stone-200" />
          <p className="text-base text-stone-500">暂无执行数据</p>
          <p className="text-sm text-stone-400">Agent 执行任务后，分析结果将显示在这里</p>
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto px-5 py-4 h-full">
      <HeroSection
        stats={data.baseStats}
        onRefresh={() => fetchAnalysis()}
        models={models}
        selectedModel={selectedModel}
        onModelChange={handleModelChange}
        onClickSuccessRate={() => setShowSuccessModal(true)}
        onClickTokens={() => setShowTokenModal(true)}
      />
      <ActiveRulesTable
        activeRules={data.activeRules}
        adoptedRules={adoptedRules}
        onRemoveAdopted={handleRemoveAdopted}
        onToggleRule={handleToggleLegacyRule}
        tipMap={tipMap}
        traceCount={data.baseStats.traceCount}
      />
      <DiscoveredRulesSection
        rules={data.discoveredRules || []}
        discovering={discovering}
        onRunDiscovery={handleRunDiscovery}
        onToggleRule={handleToggleRule}
        tipMap={tipMap}
      />
      <CandidateRules
        suggestions={data.suggestions}
        adoptedIds={adoptedIds}
        dismissedIds={dismissedIds}
        onAdopt={handleAdopt}
        onDismiss={handleDismiss}
        saving={saving}
        tipMap={tipMap}
      />
      <SkillMemorySection
        suggestions={data.suggestions}
        quality={data.injectionQuality}
        skillAnalysis={data.skillAnalysis}
        processedSkillIds={processedSkillIds}
        onSkillProcessed={handleSkillProcessed}
      />
      <SuccessRateModal
        isOpen={showSuccessModal}
        onClose={() => setShowSuccessModal(false)}
        stats={data.baseStats}
        ngramPatterns={data.ngramPatterns}
      />
      <TokenDetailModal
        isOpen={showTokenModal}
        onClose={() => setShowTokenModal(false)}
        stats={data.baseStats}
        tokenAnalysis={data.tokenAnalysis}
        ngramPatterns={data.ngramPatterns}
      />
    </div>
  )
}
