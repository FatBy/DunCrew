import { memo, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  X, Eye, EyeOff, KeyRound, ChevronRight,
  Terminal, Shield, Activity, Tag,
  Home, Globe, User, Package, Settings,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { ABILITY_DOMAIN_CONFIGS } from '@/services/skillStatsService'
import type { UISkillModel } from '@/utils/skillsHouseMapper'

interface SkillDetailCardProps {
  skill: UISkillModel
  x: number
  y: number
  envValues: Record<string, string>
  onEnvChange: (key: string, value: string) => void
  onOpenDrawer: () => void
  onClose: () => void
}

// 健康度颜色
function getHealthColor(score: number, isDormant: boolean): string {
  if (isDormant) return 'bg-stone-300'
  if (score >= 80) return 'bg-emerald-400'
  if (score >= 50) return 'bg-amber-400'
  return 'bg-stone-400'
}

function getHealthLabel(score: number, isDormant: boolean): string {
  if (isDormant) return '休眠'
  if (score >= 80) return '健康'
  if (score >= 50) return '需关注'
  return '低'
}

// 休眠原因
function getDormantReasons(skill: UISkillModel): string[] {
  const reasons: string[] = []
  if (skill.status === 'inactive') reasons.push('技能未启用')
  if (skill.status === 'error') reasons.push('技能状态异常')
  if (skill.requiresAPI) {
    const missingApi = skill.missingReqs.filter((r) => r.startsWith('env:'))
    if (missingApi.length > 0) {
      reasons.push(`需配置 ${skill.apiName ?? 'API Key'}`)
    }
  }
  const missingBins = skill.missingReqs.filter((r) => !r.startsWith('env:'))
  if (missingBins.length > 0) {
    reasons.push(`缺少依赖: ${missingBins.map((r) => r.replace('env:', '')).join(', ')}`)
  }
  return reasons
}

// 来源配置
const sourceConfig = {
  builtin:   { icon: Home,  label: '系统内置', color: 'text-blue-500' },
  community: { icon: Globe, label: '社区下载', color: 'text-violet-500' },
  user:      { icon: User,  label: '用户自建', color: 'text-amber-500' },
} as const

const CARD_W = 360
const CARD_MAX_H = 540

function SkillDetailCardInner({
  skill, x, y, envValues, onEnvChange, onOpenDrawer, onClose,
}: SkillDetailCardProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

  const requiredEnvs = skill._raw.requires?.env || []
  const dormantReasons = skill.isDormant ? getDormantReasons(skill) : []

  const domainConfig = useMemo(
    () => ABILITY_DOMAIN_CONFIGS.find((d) => d.id === skill.domain),
    [skill.domain],
  )

  const typeLabel = skill.type === 'instruction' ? '🧠 指令型' : '⚡ 执行型'
  const dangerLabel = skill.danger === 'safe'
    ? '🟢 安全'
    : skill.danger === 'high'
    ? '🟡 高风险'
    : '🔴 极高危'

  const sourceCfg = sourceConfig[skill.source]
  const SourceIcon = sourceCfg.icon

  // 智能定位
  const pad = 12
  let bx = x + 16
  let by = y - CARD_MAX_H / 3
  if (bx + CARD_W + pad > window.innerWidth) bx = x - CARD_W - 16
  if (bx < pad) bx = pad
  if (by < pad) by = pad
  if (by + CARD_MAX_H + pad > window.innerHeight) by = window.innerHeight - CARD_MAX_H - pad

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.92, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: 8 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="absolute z-[100]"
      style={{ left: bx, top: by, width: CARD_W }}
    >
      <div className="bg-white/95 backdrop-blur-xl border border-stone-200/80 rounded-[20px] shadow-[0_20px_50px_rgba(0,0,0,0.12)] overflow-hidden flex flex-col"
           style={{ maxHeight: CARD_MAX_H }}>

        {/* ── Header (固定) ── */}
        <div className="px-4 pt-4 pb-3 shrink-0">
          <div className="flex items-start gap-3">
            <div className={cn(
              'w-12 h-12 rounded-xl bg-stone-50 border border-stone-100 flex items-center justify-center text-2xl shrink-0',
              skill.isDormant && 'grayscale-[0.4]',
            )}>
              {skill.emoji || '🔧'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-black text-stone-800 truncate">{skill.name}</h3>
                <button
                  onClick={onClose}
                  className="w-6 h-6 rounded-lg bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors shrink-0 ml-2"
                >
                  <X className="w-3 h-3 text-stone-500" />
                </button>
              </div>
              {skill.desc && (
                <p className="text-[11px] text-stone-500 leading-relaxed mt-1 line-clamp-2">{skill.desc}</p>
              )}
              {/* 域标签 */}
              {domainConfig && (
                <span
                  className={cn(
                    'inline-block mt-1.5 px-2 py-0.5 rounded-full text-[9px] font-bold text-white',
                    skill.isDormant && 'opacity-60',
                  )}
                  style={{ backgroundColor: domainConfig.color }}
                >
                  {domainConfig.name}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── 滚动内容区 ── */}
        <div className="flex-1 overflow-y-auto px-4 space-y-3 min-h-0">

          {/* 属性网格 2x2 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-2 rounded-xl bg-stone-50">
              <div className="flex items-center gap-1 text-stone-400 mb-0.5">
                <Terminal className="w-3 h-3" />
                <span className="text-[8px] font-black uppercase tracking-wider">机制</span>
              </div>
              <p className="text-[11px] font-bold text-stone-700">{typeLabel}</p>
            </div>
            <div className="p-2 rounded-xl bg-stone-50">
              <div className="flex items-center gap-1 text-stone-400 mb-0.5">
                <Shield className="w-3 h-3" />
                <span className="text-[8px] font-black uppercase tracking-wider">安全</span>
              </div>
              <p className="text-[11px] font-bold text-stone-700">{dangerLabel}</p>
            </div>
            <div className="p-2 rounded-xl bg-stone-50">
              <div className="flex items-center gap-1 text-stone-400 mb-0.5">
                <Package className="w-3 h-3" />
                <span className="text-[8px] font-black uppercase tracking-wider">来源</span>
              </div>
              <p className={cn('text-[11px] font-bold flex items-center gap-1', sourceCfg.color)}>
                <SourceIcon className="w-3 h-3" />
                {sourceCfg.label}
              </p>
            </div>
            <div className="p-2 rounded-xl bg-stone-50">
              <div className="flex items-center gap-1 text-stone-400 mb-0.5">
                <Activity className="w-3 h-3" />
                <span className="text-[8px] font-black uppercase tracking-wider">调用</span>
              </div>
              <p className="text-[11px] font-bold text-stone-700">{skill.usageCount} 次</p>
            </div>
          </div>

          {/* 健康度进度条 */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[8px] font-black text-stone-400 uppercase tracking-wider">
                健康度
              </span>
              <span className={cn(
                'text-[10px] font-bold',
                skill.isDormant ? 'text-stone-400' :
                skill.healthScore >= 80 ? 'text-emerald-500' :
                skill.healthScore >= 50 ? 'text-amber-500' : 'text-stone-400',
              )}>
                {skill.healthScore}/100 · {getHealthLabel(skill.healthScore, skill.isDormant)}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden">
              <motion.div
                className={cn('h-full rounded-full', getHealthColor(skill.healthScore, skill.isDormant))}
                initial={{ width: 0 }}
                animate={{ width: `${skill.healthScore}%` }}
                transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
              />
            </div>
          </div>

          {/* 休眠态激活需求 */}
          {skill.isDormant && dormantReasons.length > 0 && (
            <div className="p-3 rounded-xl bg-stone-50 border border-stone-200">
              <div className="flex items-center gap-1.5 text-stone-500 mb-1.5">
                <Settings className="w-3.5 h-3.5" />
                <span className="text-[10px] font-bold">激活需求</span>
              </div>
              {dormantReasons.map((reason, i) => (
                <p key={i} className="text-[10px] text-stone-400 font-mono ml-5 mt-0.5">
                  {reason}
                </p>
              ))}
            </div>
          )}

          {/* ToolNames 标签云 */}
          {skill.toolNames.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <Terminal className="w-3 h-3 text-stone-400" />
                <span className="text-[8px] font-black text-stone-400 uppercase tracking-wider">
                  Registered Tools
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {skill.toolNames.map((t) => (
                  <span
                    key={t}
                    className={cn(
                      'px-1.5 py-0.5 rounded-md text-[10px] font-mono border',
                      skill.isDormant
                        ? 'bg-stone-50 text-stone-400 border-stone-200'
                        : 'bg-sky-50 text-sky-600 border-sky-200',
                    )}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Tags 标签云 */}
          {skill.tags.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <Tag className="w-3 h-3 text-stone-400" />
                <span className="text-[8px] font-black text-stone-400 uppercase tracking-wider">
                  Tags
                </span>
              </div>
              <div className="flex flex-wrap gap-1">
                {skill.tags.map((t) => (
                  <span
                    key={t}
                    className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-stone-50 text-stone-500 border border-stone-200"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* API Key 输入区 */}
          {requiredEnvs.length > 0 && (
            <div className="space-y-2.5 pt-1 border-t border-stone-100">
              {requiredEnvs.map(envKey => {
                const hasValue = !!envValues[envKey]
                const visible = showKeys[envKey]
                return (
                  <div key={envKey} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[11px] text-stone-700 font-mono font-medium">
                        <KeyRound size={12} className={hasValue ? 'text-emerald-500' : 'text-amber-500'} />
                        {envKey}
                      </div>
                      <span className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-widest font-bold',
                        hasValue
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-500'
                          : 'bg-amber-50 border-amber-200 text-amber-500',
                      )}>
                        {hasValue ? '已配置' : '待配置'}
                      </span>
                    </div>
                    <div className="relative">
                      <input
                        type={visible ? 'text' : 'password'}
                        value={envValues[envKey] || ''}
                        onChange={e => onEnvChange(envKey, e.target.value)}
                        placeholder={`输入 ${envKey}...`}
                        className={cn(
                          'w-full text-xs rounded-lg pl-3 pr-8 py-2 outline-none transition-all font-mono placeholder:text-stone-300 placeholder:font-sans',
                          hasValue
                            ? 'bg-emerald-50/50 border border-emerald-200 text-emerald-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100'
                            : 'bg-stone-50 border border-stone-200 text-stone-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-100/50',
                        )}
                      />
                      <button
                        onClick={() => setShowKeys(prev => ({ ...prev, [envKey]: !prev[envKey] }))}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
                      >
                        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Footer (固定) ── */}
        <div className="px-4 pb-4 pt-2 shrink-0">
          <button
            onClick={onOpenDrawer}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-stone-100 hover:bg-stone-200/80 text-stone-600 text-xs font-semibold transition-colors"
          >
            配置与控制台
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export const SkillDetailCard = memo(SkillDetailCardInner)
