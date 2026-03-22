/**
 * SkillsInspectorPanel - 右侧全局督查抽屉 (V2)
 *
 * DD-OS 视觉:
 * - 从右侧划入, w-[400px], rounded-[32px]
 * - 96px 状态头像圈
 * - 休眠态: 灰色提示框 + "配置并激活" 按钮
 * - 正常态: 彩色健康度条 + Tag 云
 */

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  X, Key, Terminal, Tag,
  Activity, TrendingUp, Shield, Settings,
  KeyRound, Eye, EyeOff,
  Home, Globe, User, Package,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { ABILITY_DOMAIN_CONFIGS } from '@/services/skillStatsService'
import type { UISkillModel } from '@/utils/skillsHouseMapper'

interface SkillsInspectorPanelProps {
  skill: UISkillModel
  envValues: Record<string, string>
  onEnvChange: (key: string, value: string) => void
  onClose: () => void
}

// DD-OS 缓动
const ddosEase = [0.23, 1, 0.32, 1]

// 状态头像圈样式 (96px 版)
function getLargeRingClass(skill: UISkillModel): string {
  if (skill.isDormant) {
    return 'border-stone-300 border-[3px] border-dashed bg-stone-50'
  }
  if (skill.type === 'instruction') {
    return 'border-[#7EC8E3] border-[3px] bg-white'
  }
  return 'border-[#AEE1CC] border-[3px] bg-white'
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

// 休眠原因详细描述
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

export function SkillsInspectorPanel({ skill, envValues, onEnvChange, onClose }: SkillsInspectorPanelProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

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

  const sourceConfig = {
    builtin:   { icon: Home,  label: '系统内置', color: 'text-blue-500' },
    community: { icon: Globe, label: '社区下载', color: 'text-violet-500' },
    user:      { icon: User,  label: '用户自建', color: 'text-amber-500' },
  } as const
  const sourceCfg = sourceConfig[skill.source]
  const SourceIcon = sourceCfg.icon

  const dormantReasons = skill.isDormant ? getDormantReasons(skill) : []
  const requiredEnvs = skill._raw.requires?.env || []

  return (
    <motion.div
      initial={{ x: '100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '100%', opacity: 0 }}
      transition={{ duration: 0.4, ease: ddosEase }}
      className="absolute top-4 right-4 bottom-4 w-[400px] z-50 flex flex-col bg-white rounded-[32px] shadow-[0_20px_60px_rgba(0,0,0,0.08)] border border-stone-100 overflow-hidden"
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-6 pt-5 pb-2 shrink-0">
        <p className="text-[10px] font-black text-stone-400 uppercase tracking-[0.15em]">
          Inspector
        </p>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 滚动内容 */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
        {/* 96px 头像 + 名称 */}
        <div className={cn('flex flex-col items-center pt-2', skill.isDormant && 'grayscale-[0.4]')}>
          <div
            className={cn(
              'w-24 h-24 rounded-full flex items-center justify-center',
              getLargeRingClass(skill),
            )}
          >
            <span className="text-4xl">{skill.emoji}</span>
          </div>
          <h3 className={cn('mt-3 text-base font-bold', skill.isDormant ? 'text-stone-500' : 'text-stone-800')}>
            {skill.name}
          </h3>
          <p className="text-xs text-stone-400 mt-1 text-center max-w-[280px] leading-relaxed">
            {skill.desc || '暂无描述'}
          </p>

          {/* 域标签 */}
          {domainConfig && (
            <span
              className={cn(
                'mt-2 px-3 py-1 rounded-full text-[10px] font-bold text-white',
                skill.isDormant && 'opacity-60',
              )}
              style={{ backgroundColor: domainConfig.color }}
            >
              {domainConfig.name}
            </span>
          )}
          {/* 子组归属标签 */}
          {skill.subGroupLabel && (
            <span className="mt-1 px-2 py-0.5 rounded-md text-[9px] font-mono text-stone-400 bg-stone-50 border border-stone-200/60">
              {skill.subGroupLabel}
            </span>
          )}
        </div>

        {/* 休眠态: 激活需求提示 (灰色, 非粉色) */}
        {skill.isDormant && dormantReasons.length > 0 && (
          <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200">
            <div className="flex items-center gap-2 text-stone-500 mb-2">
              <Settings className="w-4 h-4" />
              <span className="text-xs font-bold">激活需求 (Activation Requirements)</span>
            </div>
            {dormantReasons.map((reason, i) => (
              <p key={i} className="text-[11px] text-stone-400 font-mono ml-6 mt-1">
                {reason}
              </p>
            ))}
          </div>
        )}

        {/* 正常态 API 提示 (非休眠时才用彩色) */}
        {!skill.isDormant && skill.requiresAPI && (
          <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200">
            <div className="flex items-center gap-2 text-amber-600">
              <Key className="w-4 h-4" />
              <span className="text-xs font-bold">需要 API 授权</span>
            </div>
            <p className="text-[11px] text-amber-500 mt-1 ml-6 font-mono">
              {skill.apiName}
            </p>
          </div>
        )}

        {/* 属性行 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Terminal className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">机制</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{typeLabel}</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Shield className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">安全</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{dangerLabel}</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Package className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">来源</span>
            </div>
            <p className={cn('text-xs font-bold flex items-center gap-1', sourceCfg.color)}>
              <SourceIcon className="w-3 h-3" />
              {sourceCfg.label}
            </p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Activity className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">调用</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{skill.usageCount} 次</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <TrendingUp className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">版本</span>
            </div>
            <p className="text-xs font-bold text-stone-700 font-mono">
              {skill._raw.version || 'n/a'}
            </p>
          </div>
        </div>

        {/* 健康度进度条 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
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
          <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
            <motion.div
              className={cn('h-full rounded-full', getHealthColor(skill.healthScore, skill.isDormant))}
              initial={{ width: 0 }}
              animate={{ width: `${skill.healthScore}%` }}
              transition={{ duration: 0.6, ease: ddosEase }}
            />
          </div>
        </div>

        {/* ToolNames 云 */}
        {skill.toolNames.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Terminal className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Registered Tools
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skill.toolNames.map((t) => (
                <span
                  key={t}
                  className={cn(
                    'px-2 py-1 rounded-lg text-[10px] font-mono border',
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

        {/* Semantic Tags 云 */}
        {skill.tags.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Tag className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Tags
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skill.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-1 rounded-lg text-[10px] font-mono bg-stone-50 text-stone-500 border border-stone-200"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 环境变量配置 (API Key 输入) */}
        {requiredEnvs.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-3">
              <Key className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                API 配置
              </span>
            </div>
            <div className="space-y-3">
              {requiredEnvs.map(envKey => {
                const hasValue = !!envValues[envKey]
                const visible = showKeys[envKey]
                return (
                  <div key={envKey} className="flex flex-col gap-1.5">
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
                          'w-full text-xs rounded-xl pl-3 pr-9 py-2.5 outline-none transition-all font-mono placeholder:text-stone-300 placeholder:font-sans',
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
          </div>
        )}

        {/* 运行环境 */}
        {skill._raw.primaryEnv && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Terminal className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Runtime
              </span>
            </div>
            <span className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-mono border',
              skill.isDormant
                ? 'bg-stone-50 text-stone-400 border-stone-200'
                : 'bg-emerald-50 text-emerald-600 border-emerald-200',
            )}>
              {skill._raw.primaryEnv}
            </span>
          </div>
        )}
      </div>
    </motion.div>
  )
}
