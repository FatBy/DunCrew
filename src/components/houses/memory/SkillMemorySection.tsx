import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Activity, Brain, ChevronDown, Lightbulb,
  Sparkles, EyeOff, Loader2, CheckCircle2, Zap,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useStore } from '@/store'
import { getServerUrl } from '@/utils/env'
import { simpleChat } from '@/services/llmService'
import type { OpenClawSkill } from '@/types'
import type { Suggestion } from './CandidateRulesSection'

const SERVER_URL = getServerUrl()

// ============================================
// 类型定义
// ============================================

export interface InjectionQuality {
  hasData: boolean
  traceCount: number
  memory?: {
    avgScoreOnSuccess: number
    avgScoreOnFailure: number
    scoreDelta: number
    avgBudgetUtilization: number
    avgL0Count: number
  }
  skills?: {
    avgInjectedCount: number
    avgSemanticScore: number
  }
}

export interface SkillAnalysis {
  totalSkillsTracked: number
  skills: Array<{
    skillId: string
    injectedCount: number
    triggeredCount: number
    triggerRate: number
    successRate: number
  }>
}

// 合并分析指标 + 原始技能数据的富类型
interface EnrichedSkill {
  skillId: string
  injectedCount: number
  triggeredCount: number
  triggerRate: number
  successRate: number
  emoji: string
  description: string
  tags: string[]
  primaryEnv?: string
  source: string
  mechType: 'instruction' | 'executable'
}

// ============================================
// 共享 SectionHeader
// ============================================

export function SectionHeader({ icon, title, badge }: {
  icon: React.ReactNode
  title: string
  badge?: string
}) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5">
      <span className="text-stone-400">{icon}</span>
      <h3 className="text-sm font-semibold text-stone-600 tracking-wide">{title}</h3>
      {badge && (
        <span className="text-xs font-mono text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded-full ml-auto">
          {badge}
        </span>
      )}
    </div>
  )
}

// ============================================
// 工具函数
// ============================================

function enrichSkill(
  skill: SkillAnalysis['skills'][number],
  rawSkills: OpenClawSkill[],
): EnrichedSkill {
  const raw = rawSkills.find(s => s.name === skill.skillId)
  return {
    ...skill,
    emoji: raw?.emoji || '🔧',
    description: raw?.description || '',
    tags: raw?.tags || [],
    primaryEnv: raw?.primaryEnv,
    source: raw?.source || 'builtin',
    mechType: (raw?.toolType === 'executable' || raw?.executable || raw?.toolName || (raw?.toolNames && raw.toolNames.length > 0))
      ? 'executable' : 'instruction',
  }
}

function isSkillHealthy(skill: EnrichedSkill): boolean {
  if (skill.injectedCount === 0) return false
  if (skill.triggerRate < 0.2) return false
  if (skill.triggeredCount > 0 && skill.successRate < 0.5) return false
  return true
}

function getSkillHints(skill: EnrichedSkill): string[] {
  const hints: string[] = []
  if (skill.injectedCount === 0) {
    hints.push('此技能从未被注入，检查触发条件是否太严格')
  } else if (skill.triggerRate < 0.1) {
    hints.push('触发率很低，考虑放宽触发条件或优化技能描述')
  }
  if (skill.triggeredCount > 0 && skill.successRate < 0.5) {
    hints.push('触发后成功率不高，检查技能指令是否清晰、完整')
  }
  if (skill.triggerRate > 0.8 && skill.successRate > 0.8) {
    hints.push('表现优秀，可以考虑扩展此技能的覆盖范围')
  }
  if (hints.length === 0) {
    hints.push('运行状态正常，暂无特别优化建议')
  }
  return hints
}

function getRateStyle(rate: number) {
  if (rate >= 0.5) return { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' }
  if (rate >= 0.2) return { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200' }
  return { bg: 'bg-red-50', text: 'text-red-500', border: 'border-red-200' }
}

const SOURCE_LABEL: Record<string, { label: string; color: string; bg: string; border: string }> = {
  builtin:   { label: '内置', color: 'text-blue-500',   bg: 'bg-blue-50',   border: 'border-blue-200' },
  community: { label: '社区', color: 'text-violet-500', bg: 'bg-violet-50', border: 'border-violet-200' },
  user:      { label: '自建', color: 'text-amber-500',  bg: 'bg-amber-50',  border: 'border-amber-200' },
}

// ============================================
// 单个技能卡片（富卡片，借鉴技能学院风格）
// ============================================

function SkillCard({ skill, onOptimize, onDisable, loading }: {
  skill: EnrichedSkill
  onOptimize?: (skillId: string) => void
  onDisable?: (skillId: string) => void
  loading?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const hints = getSkillHints(skill)
  const rateStyle = getRateStyle(skill.triggerRate)
  const MechIcon = skill.mechType === 'instruction' ? Brain : Zap

  return (
    <div className={cn(
      'rounded-2xl border border-stone-200/60 bg-white overflow-hidden transition-shadow',
      loading ? 'opacity-60 pointer-events-none' : 'hover:shadow-md',
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3.5 text-left"
      >
        {/* 第一行: emoji + 名称 + 机制图标 + 采纳率徽标 */}
        <div className="flex items-start gap-2.5">
          {/* Emoji 方块 */}
          <div className={cn(
            'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
            skill.mechType === 'instruction' ? 'bg-sky-50' : 'bg-emerald-50',
          )}>
            <span className="text-xl leading-none">{skill.emoji}</span>
          </div>

          {/* 名称 + 描述 */}
          <div className="flex-1 min-w-0 pt-0.5">
            <div className="flex items-center gap-1.5">
              <h4 className="text-sm font-bold text-stone-800 truncate">
                {skill.skillId}
              </h4>
              <MechIcon className={cn(
                'w-3 h-3 shrink-0',
                skill.mechType === 'instruction' ? 'text-sky-400' : 'text-emerald-400',
              )} />
            </div>
            {skill.description && (
              <p className="text-xs text-stone-400 mt-0.5 line-clamp-1 leading-relaxed">
                {skill.description}
              </p>
            )}
          </div>

          {/* 右上角: 采纳率徽标 */}
          {loading ? (
            <Loader2 className="w-5 h-5 text-stone-300 animate-spin shrink-0 mt-1" />
          ) : (
            <div className={cn(
              'shrink-0 px-2 py-1 rounded-xl text-xs font-black font-mono border min-w-[42px] text-center',
              rateStyle.bg, rateStyle.text, rateStyle.border,
            )}>
              {(skill.triggerRate * 100).toFixed(0)}%
            </div>
          )}
        </div>

        {/* 底部: 标签 + 简洁指标 */}
        <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-stone-100/80">
          {skill.tags.slice(0, 1).map(tag => (
            <span key={tag} className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-stone-50 text-stone-400 border border-stone-100 truncate max-w-[80px]">
              {tag}
            </span>
          ))}
          {skill.primaryEnv && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-stone-50 text-stone-400 border border-stone-200 shrink-0">
              {skill.primaryEnv}
            </span>
          )}
          {SOURCE_LABEL[skill.source] && (() => {
            const cfg = SOURCE_LABEL[skill.source]
            return (
              <span className={cn(
                'px-1.5 py-0.5 rounded-md text-[10px] font-mono border shrink-0',
                cfg.bg, cfg.color, cfg.border,
              )}>
                {cfg.label}
              </span>
            )
          })()}

          <div className="flex-1" />

          <span className="text-[10px] text-stone-400 font-mono">
            注入 {skill.injectedCount}
          </span>
          <span className="text-[10px] text-stone-400 font-mono">
            采纳 {skill.triggeredCount}
          </span>

          <ChevronDown className={cn(
            'w-3 h-3 text-stone-300 transition-transform shrink-0',
            expanded && 'rotate-180',
          )} />
        </div>
      </button>

      {/* 展开: 详细指标 + 优化建议 + 操作按钮 */}
      <AnimatePresence>
        {expanded && !loading && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3.5 border-t border-stone-100">
              <div className="grid grid-cols-3 gap-2 mt-3 mb-3">
                <div className="text-center">
                  <div className="text-base font-mono font-semibold text-stone-700">
                    {skill.injectedCount}
                  </div>
                  <div className="text-xs text-stone-400">注入次数</div>
                </div>
                <div className="text-center">
                  <div className="text-base font-mono font-semibold text-stone-700">
                    {skill.triggeredCount}
                  </div>
                  <div className="text-xs text-stone-400">被采纳</div>
                </div>
                <div className="text-center">
                  <div className={cn(
                    'text-base font-mono font-semibold',
                    skill.successRate >= 0.8 ? 'text-emerald-600' :
                    skill.successRate >= 0.5 ? 'text-amber-600' : 'text-red-500',
                  )}>
                    {(skill.successRate * 100).toFixed(0)}%
                  </div>
                  <div className="text-xs text-stone-400">成功率</div>
                </div>
              </div>

              <div className="rounded-lg bg-amber-50/60 border border-amber-100/80 px-2.5 py-2">
                <div className="flex items-center gap-1.5 mb-1">
                  <Lightbulb className="w-3 h-3 text-amber-500" />
                  <span className="text-xs font-semibold text-amber-700">优化建议</span>
                </div>
                {hints.map((hint, i) => (
                  <p key={i} className="text-xs text-amber-700/80 leading-relaxed">
                    {hints.length > 1 ? `${i + 1}. ` : ''}{hint}
                  </p>
                ))}
              </div>

              <div className="flex items-center gap-2 mt-3">
                {onOptimize && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onOptimize(skill.skillId) }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
                  >
                    <Sparkles className="w-3 h-3" />
                    自动优化
                  </button>
                )}
                {onDisable && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDisable(skill.skillId) }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-stone-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  >
                    <EyeOff className="w-3 h-3" />
                    禁用
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// 运行良好技能概览
// ============================================

function HealthySkillsSummary({ skills }: { skills: EnrichedSkill[] }) {
  const [expanded, setExpanded] = useState(false)
  if (skills.length === 0) return null

  return (
    <div className="rounded-2xl border border-emerald-100/80 bg-emerald-50/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3.5 py-2.5 text-left hover:bg-emerald-50/50 transition-colors"
      >
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        <span className="text-sm font-medium text-emerald-700">
          {skills.length} 个技能运行良好
        </span>
        <ChevronDown className={cn(
          'w-3.5 h-3.5 text-emerald-400 ml-auto transition-transform',
          expanded && 'rotate-180',
        )} />
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-3.5 pb-3 border-t border-emerald-100/80 pt-1">
              {skills.map(skill => (
                <div key={skill.skillId} className="flex items-center gap-2.5 py-2">
                  <span className="text-base leading-none">{skill.emoji}</span>
                  <span className="text-sm text-stone-600 flex-1 truncate">{skill.skillId}</span>
                  {skill.tags[0] && (
                    <span className="text-[10px] font-mono text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded-md">
                      {skill.tags[0]}
                    </span>
                  )}
                  <span className="text-xs font-mono font-semibold text-emerald-600">
                    {(skill.triggerRate * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// 技能与记忆
// ============================================

export function SkillMemorySection({ suggestions, quality, skillAnalysis, processedSkillIds, onSkillProcessed }: {
  suggestions: Suggestion[]
  quality: InjectionQuality
  skillAnalysis?: SkillAnalysis
  processedSkillIds: Set<string>
  onSkillProcessed: (skillId: string) => void
}) {
  const [loadingId, setLoadingId] = useState<string | null>(null)

  const openClawSkills = useStore(s => s.openClawSkills)
  const toggleSkillEnabled = useStore(s => s.toggleSkillEnabled)
  const refreshSkills = useStore(s => s.refreshSkills)
  const addToast = useStore(s => s.addToast)

  const skillMemSuggestions = suggestions.filter(
    s => s.type === 'injection_warning' || s.type === 'skill_warning'
  )

  const mem = quality.memory
  const skills = quality.skills
  const hasData = quality.hasData
  const trackedSkills = skillAnalysis?.skills ?? []

  // 将分析数据与原始技能数据合并为富类型
  const enrichedSkills = useMemo(() =>
    trackedSkills.map(s => enrichSkill(s, openClawSkills)),
    [trackedSkills, openClawSkills],
  )

  // 过滤已处理的技能，然后按健康状态分类
  const activeSkills = enrichedSkills.filter(s => !processedSkillIds.has(s.skillId))
  const needsAttention = activeSkills.filter(s => !isSkillHealthy(s))
  const healthy = activeSkills.filter(s => isSkillHealthy(s))

  // ---- 禁用技能 ----
  const handleDisable = async (skillId: string) => {
    setLoadingId(skillId)
    try {
      await toggleSkillEnabled(skillId, false)
      addToast({ type: 'success', title: '技能已禁用', message: skillId })
      setTimeout(() => {
        onSkillProcessed(skillId)
      }, 300)
    } catch {
      addToast({ type: 'error', title: '禁用失败', message: '无法连接后端服务' })
    } finally {
      setLoadingId(null)
    }
  }

  // ---- 自动优化技能 ----
  const handleOptimize = async (skillId: string) => {
    setLoadingId(skillId)
    try {
      const res = await fetch(`${SERVER_URL}/skills/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillId }),
      })
      const analyzeData = await res.json()
      if (!res.ok) throw new Error(analyzeData.error || '分析失败')

      if (analyzeData.alreadyOptimal) {
        addToast({ type: 'info', title: '技能已达标', message: `${skillId} 无需优化` })
        onSkillProcessed(skillId)
        return
      }

      const llmResult = await simpleChat([{ role: 'user', content: analyzeData.optimizePrompt }])
      if (!llmResult) throw new Error('LLM 调用失败，请检查 LLM 配置')

      let newContent = llmResult.trim()
      if (newContent.startsWith('```')) {
        newContent = newContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      }

      const saveRes = await fetch(`${SERVER_URL}/skills/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skillId, content: newContent }),
      })
      if (!saveRes.ok) throw new Error('保存优化结果失败')

      addToast({ type: 'success', title: '技能已优化', message: `${skillId} 已自动优化并保存` })
      onSkillProcessed(skillId)
      await refreshSkills()
    } catch (err) {
      addToast({
        type: 'error',
        title: '优化失败',
        message: err instanceof Error ? err.message : '未知错误',
      })
    } finally {
      setLoadingId(null)
    }
  }

  if (skillMemSuggestions.length === 0 && !hasData && trackedSkills.length === 0) return null

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.15 }}
      className="mb-5"
    >
      <SectionHeader
        icon={<Brain className="w-3.5 h-3.5" />}
        title="技能与记忆"
        badge={trackedSkills.length > 0 ? `${trackedSkills.length} 个技能` : undefined}
      />

      {hasData ? (
        <div className="grid grid-cols-2 gap-2 mb-3">
          {mem && (
            <>
              <InjectionMetricCard
                label="L0 记忆命中"
                value={mem.avgL0Count.toFixed(1)}
                unit="条/次"
                accent="border-l-blue-400"
              />
              <InjectionMetricCard
                label="成功/失败 Score 差"
                value={`${mem.scoreDelta > 0 ? '+' : ''}${(mem.scoreDelta * 100).toFixed(1)}%`}
                accent="border-l-blue-400"
                status={
                  mem.scoreDelta > 0.05 ? 'good' :
                  mem.scoreDelta < 0 ? 'bad' : 'neutral'
                }
              />
            </>
          )}
          {skills && (
            <>
              <InjectionMetricCard
                label="技能注入"
                value={skills.avgInjectedCount.toFixed(0)}
                unit="个/次"
                accent="border-l-purple-400"
              />
              <InjectionMetricCard
                label="语义匹配度"
                value={`${(skills.avgSemanticScore * 100).toFixed(0)}%`}
                accent="border-l-purple-400"
                status={
                  skills.avgSemanticScore > 0.6 ? 'good' :
                  skills.avgSemanticScore < 0.3 ? 'bad' : 'neutral'
                }
              />
            </>
          )}
        </div>
      ) : (
        <div className="rounded-xl border-2 border-dashed border-stone-200 p-4 mb-3 flex items-center gap-3">
          <Activity className="w-5 h-5 text-stone-300 shrink-0" />
          <div>
            <p className="text-sm text-stone-500">等待数据积累</p>
            <p className="text-xs text-stone-400 mt-0.5">
              现有 trace 不含注入元数据，新执行后自动采集
            </p>
          </div>
        </div>
      )}

      {/* 需关注的技能 - 富卡片 + 操作按钮 + 滑走动画 */}
      {needsAttention.length > 0 && (
        <div className="mb-3">
          <div className="flex items-center gap-1.5 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <span className="text-xs font-semibold text-amber-700">
              需关注 ({needsAttention.length})
            </span>
          </div>
          <div className="space-y-2.5">
            <AnimatePresence>
              {needsAttention.map(skill => (
                <motion.div
                  key={skill.skillId}
                  layout
                  exit={{ opacity: 0, x: -80, height: 0, marginBottom: 0 }}
                  transition={{ duration: 0.35, ease: 'easeInOut' }}
                >
                  <SkillCard
                    skill={skill}
                    onOptimize={handleOptimize}
                    onDisable={handleDisable}
                    loading={loadingId === skill.skillId}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* 运行良好的技能 - 折叠展示 */}
      {healthy.length > 0 && (
        <HealthySkillsSummary skills={healthy} />
      )}
    </motion.div>
  )
}

function InjectionMetricCard({ label, value, unit, accent, status }: {
  label: string
  value: string
  unit?: string
  accent: string
  status?: 'good' | 'bad' | 'neutral'
}) {
  return (
    <div className={cn(
      'rounded-lg border border-stone-200/60 border-l-[3px] p-2.5',
      accent,
    )}>
      <div className="text-xs text-stone-400 mb-1">{label}</div>
      <div className={cn(
        'text-base font-mono font-semibold leading-none',
        status === 'good' ? 'text-emerald-600' :
        status === 'bad' ? 'text-red-500' : 'text-stone-700',
      )}>
        {value}
        {unit && <span className="text-xs text-stone-400 font-normal ml-0.5">{unit}</span>}
      </div>
    </div>
  )
}
