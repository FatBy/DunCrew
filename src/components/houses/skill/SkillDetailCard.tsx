import { memo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  X, Eye, EyeOff, KeyRound, ChevronRight,
  Terminal, Globe, Cpu, FileCode2,
} from 'lucide-react'
import { skillStatsService } from '@/services/skillStatsService'
import type { OpenClawSkill } from '@/types'

interface SkillDetailCardProps {
  skill: OpenClawSkill
  x: number
  y: number
  envValues: Record<string, string>
  onEnvChange: (key: string, value: string) => void
  onOpenDrawer: () => void
  onClose: () => void
}

const statusConfig: Record<string, { label: string; cls: string }> = {
  active: { label: '活跃', cls: 'bg-emerald-50 border-emerald-200 text-emerald-600' },
  inactive: { label: '未激活', cls: 'bg-stone-50 border-stone-200 text-stone-500' },
  error: { label: '异常', cls: 'bg-red-50 border-red-200 text-red-500' },
}

const envIcons: Record<string, React.ReactNode> = {
  python: <FileCode2 size={11} />,
  node: <Cpu size={11} />,
  shell: <Terminal size={11} />,
  browser: <Globe size={11} />,
}

const CARD_W = 320
const CARD_MAX_H = 460

function SkillDetailCardInner({
  skill, x, y, envValues, onEnvChange, onOpenDrawer, onClose,
}: SkillDetailCardProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})

  const stats = skillStatsService.getSkillStats(skill.name) || skillStatsService.getSkillStats(skill.toolName || '')
  const callCount = stats?.callCount || 0
  const successRate = stats && stats.callCount > 0
    ? Math.round((stats.successCount / stats.callCount) * 100)
    : null

  const requiredEnvs = skill.requires?.env || []
  const statusCfg = statusConfig[skill.status] || statusConfig.inactive

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
      <div className="bg-white/95 backdrop-blur-xl border border-stone-200/80 rounded-[20px] shadow-[0_20px_50px_rgba(0,0,0,0.12)] overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-xl bg-stone-50 border border-stone-100 flex items-center justify-center text-2xl shrink-0">
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
              {skill.description && (
                <p className="text-[11px] text-stone-500 leading-relaxed mt-1 line-clamp-2">{skill.description}</p>
              )}
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className="px-4 pb-2.5 flex flex-wrap items-center gap-1.5">
          <span className={`inline-flex items-center px-1.5 py-0.5 border rounded text-[10px] font-bold ${statusCfg.cls}`}>
            {statusCfg.label}
          </span>
          {skill.primaryEnv && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 rounded text-[10px] font-bold text-indigo-600">
              {envIcons[skill.primaryEnv] || <Terminal size={11} />}
              {skill.primaryEnv}
            </span>
          )}
          {skill.location && (
            <span className="inline-flex items-center px-1.5 py-0.5 bg-sky-50 border border-sky-200 rounded text-[10px] font-bold text-sky-600">
              {skill.location}
            </span>
          )}
          {skill.tags?.slice(0, 2).map(tag => (
            <span key={tag} className="inline-flex items-center px-1.5 py-0.5 bg-stone-50 border border-stone-200 rounded text-[10px] text-stone-500">
              {tag}
            </span>
          ))}
        </div>

        {/* Stats */}
        <div className="px-4 pb-2.5 flex items-center gap-3 border-t border-stone-100 pt-2.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-stone-400">调用</span>
            <span className="text-xs font-mono font-bold text-stone-700">{callCount}</span>
          </div>
          {successRate !== null && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-stone-400">成功率</span>
              <span className={`text-xs font-mono font-bold ${successRate >= 80 ? 'text-emerald-500' : successRate >= 50 ? 'text-amber-500' : 'text-red-400'}`}>
                {successRate}%
              </span>
            </div>
          )}
          {skill.version && (
            <div className="ml-auto flex items-center gap-1">
              <span className="text-[10px] text-stone-400">v</span>
              <span className="text-[10px] font-mono text-stone-500">{skill.version}</span>
            </div>
          )}
        </div>

        {/* API Key 提权区 */}
        {requiredEnvs.length > 0 && (
          <div className="px-4 pb-3 pt-1 border-t border-stone-100 space-y-2.5">
            {requiredEnvs.map(envKey => {
              const hasValue = !!envValues[envKey]
              const visible = showKeys[envKey]
              return (
                <div key={envKey} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 text-[11px] text-stone-700 font-mono font-medium">
                      <KeyRound size={12} className={hasValue ? 'text-indigo-500' : 'text-amber-500'} />
                      {envKey}
                    </div>
                    <span className="text-[9px] bg-stone-50 border border-stone-200 px-1.5 py-0.5 rounded text-stone-400 uppercase tracking-widest">
                      Required
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type={visible ? 'text' : 'password'}
                      value={envValues[envKey] || ''}
                      onChange={e => onEnvChange(envKey, e.target.value)}
                      placeholder={`Enter ${envKey}...`}
                      className={`w-full text-xs rounded-lg pl-3 pr-8 py-2 outline-none transition-all font-mono placeholder:text-stone-300 placeholder:font-sans
                        ${hasValue
                          ? 'bg-indigo-50/50 border border-indigo-200 text-indigo-700 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
                          : 'bg-stone-50 border border-stone-200 text-stone-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-100/50'
                        }`}
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

        {/* Footer */}
        <div className="px-4 pb-4 pt-1">
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
