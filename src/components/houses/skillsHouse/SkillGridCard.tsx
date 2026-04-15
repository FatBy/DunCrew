/**
 * SkillGridCard V4 - 评分突出版
 *
 * 布局:
 * - 右上角: rankScore 评分徽标 (最显眼位置)
 * - 左上角: emoji + 名称
 * - 中间: 描述
 * - 右下角: 来源 + 机制标签
 * - 左下角: 标签 + 热度
 * - 休眠态: 灰度低透明
 */

import { motion } from 'framer-motion'
import { Brain, Zap, Key, Home, Globe, User } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { UISkillModel } from '@/utils/skillsHouseMapper'
import type { SkillSource } from '@/types'

interface SkillGridCardProps {
  skill: UISkillModel
  onClick: () => void
  onToggleEnabled?: (skillName: string, enabled: boolean) => void
}

// 机制角标颜色
function getBadgeStyle(skill: UISkillModel) {
  if (skill.isDormant) {
    return { bg: 'bg-stone-50', text: 'text-stone-400', border: 'border-stone-200' }
  }
  if (skill.type === 'instruction') {
    return { bg: 'bg-sky-50', text: 'text-sky-500', border: 'border-sky-200' }
  }
  return { bg: 'bg-emerald-50', text: 'text-emerald-500', border: 'border-emerald-200' }
}

// 休眠原因
function getDormantReason(skill: UISkillModel): string | null {
  if (skill.status === 'error') return '异常'
  if (skill.requiresAPI && skill.missingReqs.some((r) => r.startsWith('env:'))) return '待配 API'
  if (skill.missingReqs.length > 0) return '缺依赖'
  if (skill.status === 'inactive') return '未激活'
  return null
}

// 来源标签配置
const SOURCE_BADGE_CONFIG: Record<SkillSource, { icon: typeof Home; label: string; color: string; border: string; bg: string }> = {
  builtin:   { icon: Home,  label: '内置', color: 'text-blue-500',   border: 'border-blue-200',   bg: 'bg-blue-50' },
  community: { icon: Globe, label: '社区', color: 'text-violet-500', border: 'border-violet-200', bg: 'bg-violet-50' },
  user:      { icon: User,  label: '自建', color: 'text-amber-500',  border: 'border-amber-200',  bg: 'bg-amber-50' },
}

// emoji 背景色 (柔和渐变底色, 基于类型)
function getEmojiBg(skill: UISkillModel): string {
  if (skill.isDormant) return 'bg-stone-100/80'
  if (skill.type === 'instruction') return 'bg-sky-50'
  return 'bg-emerald-50'
}

// 评分颜色
function getScoreStyle(score: number, isDormant: boolean) {
  if (isDormant) return { bg: 'bg-stone-100', text: 'text-stone-400', border: 'border-stone-200' }
  if (score >= 70) return { bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200' }
  if (score >= 45) return { bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200' }
  return { bg: 'bg-stone-50', text: 'text-stone-400', border: 'border-stone-200' }
}

const ddosEase = [0.23, 1, 0.32, 1]

export function SkillGridCard({
  skill,
  onClick,
  onToggleEnabled,
}: SkillGridCardProps) {
  const badgeStyle = getBadgeStyle(skill)
  const dormantReason = skill.isDormant ? getDormantReason(skill) : null
  const MechIcon = skill.type === 'instruction' ? Brain : Zap
  const scoreStyle = getScoreStyle(skill.rankScore, skill.isDormant)
  const isDisabled = skill.status === 'inactive'

  return (
    <motion.div
      layout
      onClick={onClick}
      className={cn(
        'group relative p-3.5 rounded-2xl cursor-pointer',
        'border transition-all duration-300',
        // 休眠态
        skill.isDormant && 'opacity-70 grayscale-[0.5]',
        // 正常态
        !skill.isDormant && 'bg-white border-stone-200/60 hover:shadow-lg hover:border-stone-300',
        skill.isDormant && 'bg-stone-50/80 border-stone-200/40',
      )}
      whileHover={!skill.isDormant ? { y: -2 } : undefined}
      transition={{ duration: 0.3, ease: ddosEase }}
    >
      {/* 第一行: emoji + 名称 + 评分(右上角) */}
      <div className="flex items-start gap-2.5">
        {/* Emoji 方块 */}
        <div className={cn(
          'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
          'transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'group-hover:scale-110 group-hover:rotate-[-4deg]',
          getEmojiBg(skill),
        )}>
          <span className="text-xl leading-none">{skill.emoji}</span>
        </div>

        {/* 名称 + 机制图标 */}
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            <h4 className={cn(
              'text-sm font-bold truncate',
              skill.isDormant ? 'text-stone-500' : 'text-stone-800',
            )}>
              {skill.name}
            </h4>
            <MechIcon className={cn(
              'w-3 h-3 shrink-0',
              skill.isDormant ? 'text-stone-300' :
              skill.type === 'instruction' ? 'text-sky-400' : 'text-emerald-400',
            )} />
          </div>
          {/* 休眠原因 */}
          {dormantReason && (
            <span className="text-[9px] font-mono text-stone-400 bg-stone-100 px-1 py-px rounded mt-0.5 inline-block">
              {dormantReason}
            </span>
          )}
        </div>

        {/* 右上角: 评分徽标 (最显眼位置) */}
        <div className={cn(
          'shrink-0 px-2 py-1 rounded-xl text-xs font-black font-mono border min-w-[36px] text-center',
          scoreStyle.bg, scoreStyle.text, scoreStyle.border,
        )}>
          {skill.rankScore}
        </div>
      </div>

      {/* 描述 */}
      <p className={cn(
        'text-[11px] mt-2 line-clamp-2 leading-relaxed',
        skill.isDormant ? 'text-stone-300' : 'text-stone-400',
      )}>
        {skill.desc || '暂无描述'}
      </p>

      {/* 底部: 左=开关+标签  右=来源+机制 */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-stone-100/80">
        {/* 左下角: 开关 + 标签 + 热度 */}
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {/* 滑动开关 */}
          {onToggleEnabled && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggleEnabled(skill.name, isDisabled)
              }}
              className={cn(
                'relative shrink-0 w-7 h-4 rounded-full transition-colors duration-200',
                isDisabled ? 'bg-stone-300' : 'bg-emerald-400',
              )}
              title={isDisabled ? '点击启用' : '点击停用'}
            >
              <span
                className={cn(
                  'absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-transform duration-200',
                  isDisabled ? 'left-0.5' : 'translate-x-3.5 left-0',
                )}
              />
            </button>
          )}
          {skill.requiresAPI && (
            <span className={cn(
              'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono shrink-0 border',
              skill.isDormant
                ? 'bg-stone-50 text-stone-400 border-stone-200'
                : 'bg-amber-50 text-amber-500 border-amber-200',
            )}>
              <Key className="w-2.5 h-2.5" />
              {skill.apiName}
            </span>
          )}
          {skill._raw.primaryEnv && (
            <span className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-stone-50 text-stone-400 border border-stone-200 shrink-0">
              {skill._raw.primaryEnv}
            </span>
          )}
          {skill.tags.slice(0, 1).map((tag) => (
            <span
              key={tag}
              className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-stone-50 text-stone-400 border border-stone-100 truncate max-w-[80px]"
            >
              {tag}
            </span>
          ))}
          <span className="text-[10px] font-mono text-stone-300 shrink-0">
            {skill.usageCount > 0 ? `x${skill.usageCount}` : '--'}
          </span>
        </div>

        {/* 右下角: 来源 + 机制 */}
        <div className="flex items-center gap-1 shrink-0">
          {(() => {
            const sourceCfg = SOURCE_BADGE_CONFIG[skill.source]
            const SourceIcon = sourceCfg.icon
            return (
              <div className={cn(
                'flex items-center gap-0.5 px-1.5 py-0.5 rounded-lg text-[9px] font-bold border',
                skill.isDormant ? 'bg-stone-50 text-stone-400 border-stone-200' : `${sourceCfg.bg} ${sourceCfg.color} ${sourceCfg.border}`,
              )}>
                <SourceIcon className="w-2.5 h-2.5" />
                {sourceCfg.label}
              </div>
            )
          })()}
          <div className={cn(
            'px-1.5 py-0.5 rounded-lg text-[9px] font-bold border',
            badgeStyle.bg, badgeStyle.text, badgeStyle.border,
          )}>
            {skill.type === 'instruction' ? '指令' : '执行'}
          </div>
        </div>
      </div>
    </motion.div>
  )
}
