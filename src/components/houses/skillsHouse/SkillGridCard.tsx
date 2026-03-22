/**
 * SkillGridCard V3 - Emoji-forward 卡片
 *
 * 改造: 去掉"大脑袋"圆圈头像, emoji 直接做视觉主角
 * - 左上角大 emoji (无圆圈框)
 * - 右上角机制角标
 * - 紧凑型标题+描述
 * - 底部标签+热度
 * - 休眠态: 灰度低透明
 * - Glow Sync: 共享高亮
 */

import { motion } from 'framer-motion'
import { Brain, Zap, Key, Home, Globe, User } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { UISkillModel } from '@/utils/skillsHouseMapper'
import type { SkillSource } from '@/types'

interface SkillGridCardProps {
  skill: UISkillModel
  isGlowing?: 'shared-tool' | 'shared-env' | null
  isDimmed?: boolean
  onClick: () => void
  onHoverStart: () => void
  onHoverEnd: () => void
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

const ddosEase = [0.23, 1, 0.32, 1]

export function SkillGridCard({
  skill,
  isGlowing,
  isDimmed,
  onClick,
  onHoverStart,
  onHoverEnd,
}: SkillGridCardProps) {
  const badgeStyle = getBadgeStyle(skill)
  const dormantReason = skill.isDormant ? getDormantReason(skill) : null
  const MechIcon = skill.type === 'instruction' ? Brain : Zap

  return (
    <motion.div
      layout
      onClick={onClick}
      onHoverStart={onHoverStart}
      onHoverEnd={onHoverEnd}
      className={cn(
        'group relative p-3.5 rounded-2xl cursor-pointer',
        'border transition-all duration-300',
        // 休眠态
        skill.isDormant && 'opacity-70 grayscale-[0.5]',
        // Glow Sync
        isDimmed && 'opacity-20 scale-[0.97]',
        isGlowing === 'shared-tool' && 'ring-2 ring-sky-400/60 shadow-[0_0_20px_rgba(126,200,227,0.3)]',
        isGlowing === 'shared-env' && 'ring-2 ring-purple-400/60 shadow-[0_0_20px_rgba(167,139,250,0.3)]',
        // 正常态
        !isDimmed && !isGlowing && !skill.isDormant && 'bg-white border-stone-200/60 hover:shadow-lg hover:border-stone-300',
        !isDimmed && !isGlowing && skill.isDormant && 'bg-stone-50/80 border-stone-200/40',
      )}
      whileHover={!isDimmed && !skill.isDormant ? { y: -2 } : undefined}
      transition={{ duration: 0.3, ease: ddosEase }}
    >
      {/* 第一行: emoji + 名称 + 机制图标 */}
      <div className="flex items-center gap-2.5">
        {/* Emoji 方块 (无圆圈, 用圆角方块底色) */}
        <div className={cn(
          'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
          'transition-transform duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]',
          'group-hover:scale-110 group-hover:rotate-[-4deg]',
          getEmojiBg(skill),
        )}>
          <span className="text-xl leading-none">{skill.emoji}</span>
        </div>

        {/* 名称 + 机制 */}
        <div className="min-w-0 flex-1">
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

        {/* 右上角: 来源 + 机制角标 */}
        <div className="flex items-center gap-1 shrink-0 self-start">
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

      {/* 描述 */}
      <p className={cn(
        'text-[11px] mt-2 line-clamp-2 leading-relaxed',
        skill.isDormant ? 'text-stone-300' : 'text-stone-400',
      )}>
        {skill.desc || '暂无描述'}
      </p>

      {/* 底部: 标签 + 热度 */}
      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-stone-100/80">
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {/* API 角标 */}
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
          {/* Env 标签 */}
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
        </div>

        {/* 热度值 */}
        <span className="text-[10px] font-mono text-stone-300 shrink-0">
          {skill.usageCount > 0 ? `x${skill.usageCount}` : '--'}
        </span>
      </div>
    </motion.div>
  )
}
