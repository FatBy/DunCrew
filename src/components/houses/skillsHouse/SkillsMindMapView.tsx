/**
 * SkillsMindMapView V3 - Clean Hub Topology
 *
 * 彻底重写:
 * - border-l / border-r 做竖向树干 (保证对齐)
 * - border-t 做水平分支 (精确连接)
 * - 虚线连接器 (更优雅)
 * - 更小的中枢 hub
 * - items-center 垂直居中 (自然对齐)
 * - 保留: 智能折叠, 休眠态
 */

import { useState, useMemo } from 'react'
import { Brain, Zap, ChevronDown } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { DomainGroup, SubGroup } from '@/utils/skillsHouseMapper'
import type { UISkillModel } from '@/utils/skillsHouseMapper'

interface SkillsMindMapViewProps {
  domains: DomainGroup[]
  allSkills: UISkillModel[]
  onSelectSkill: (skill: UISkillModel) => void
}

const LEFT_DOMAINS = new Set(['system', 'security', 'utility'])
const COLLAPSE_THRESHOLD = 4

// SubGroup source → 前缀 emoji
const SOURCE_EMOJI: Record<SubGroup['source'], string> = {
  prefix: '📦', api: '🔑', tag: '🏷️', env: '⚙️',
}

// 共享 props 类型
type BranchProps = {
  side: 'left' | 'right'
  onSelectSkill: (skill: UISkillModel) => void
}

// 单行技能渲染 (避免 DomainBranch / SubGroupBranch 重复代码)
function renderSkillRow(skill: UISkillModel, props: BranchProps) {
  const { side, onSelectSkill } = props
  const isLeft = side === 'left'
  return (
    <div
      key={skill.id}
      className={cn(
        'flex items-center',
        isLeft ? 'flex-row-reverse' : 'flex-row',
      )}
    >
      <div className="w-3 shrink-0 border-t border-stone-300/40" />
      <SkillPill
        skill={skill}
        side={side}
        onClick={() => onSelectSkill(skill)}
      />
    </div>
  )
}

// 折叠按钮 (域级 / 子组级共用)
function CollapseButton({
  expanded, hiddenCount, side, onToggle,
}: {
  expanded: boolean; hiddenCount: number; side: 'left' | 'right'
  onToggle: () => void
}) {
  const isLeft = side === 'left'
  return (
    <div className={cn('flex items-center', isLeft ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-3 shrink-0 border-t border-dashed border-stone-200/40" />
      <button
        onClick={onToggle}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold',
          'text-stone-400 hover:text-stone-600',
          'border border-dashed border-stone-200 hover:border-stone-300',
          'transition-colors duration-150',
        )}
      >
        <ChevronDown className={cn(
          'w-2.5 h-2.5 transition-transform duration-200',
          expanded && 'rotate-180',
        )} />
        {expanded ? '收起' : `+${hiddenCount} 探索`}
      </button>
    </div>
  )
}

/* ───────── Skill Pill (叶子节点) ───────── */

function SkillPill({
  skill,
  side,
  onClick,
}: {
  skill: UISkillModel
  side: 'left' | 'right'
  onClick: () => void
}) {
  const isLeft = side === 'left'

  return (
    <div
      onClick={onClick}
      className={cn(
        'group inline-flex items-center gap-1 cursor-pointer select-none',
        'transition-all duration-200 ease-out',
        isLeft ? 'flex-row-reverse' : 'flex-row',
        // 休眠
        skill.isDormant && 'opacity-55 grayscale-[0.5]',
      )}
    >
      {/* 专属 emoji 圆环 (主头像) */}
      <div className={cn(
        'w-7 h-7 rounded-full flex items-center justify-center shrink-0',
        'border-[1.5px] transition-transform duration-200',
        'group-hover:scale-110',
        !skill.isDormant && 'border-stone-200 bg-white',
        skill.isDormant && 'border-stone-200/50 bg-stone-50/60 border-dashed',
      )}>
        <span className="text-sm leading-none">{skill.emoji}</span>
      </div>

      {/* 名称胶囊 + 微型机制标记 */}
      <div className={cn(
        'flex items-center gap-0.5 px-1.5 py-0.5 rounded-md',
        'border transition-colors duration-200',
        !skill.isDormant && 'bg-white/80 border-stone-200/50 group-hover:border-stone-300',
        skill.isDormant && 'bg-stone-50/40 border-stone-200/30',
      )}>
        <span className={cn(
          'text-[10px] font-medium max-w-[72px] truncate leading-none',
          skill.isDormant ? 'text-stone-400' : 'text-stone-600',
        )}>
          {skill.name}
        </span>
        {/* 微型机制 icon (10px) */}
        {skill.type === 'instruction' ? (
          <Brain className={cn('w-2.5 h-2.5 shrink-0', skill.isDormant ? 'text-stone-300' : 'text-sky-400')} />
        ) : (
          <Zap className={cn('w-2.5 h-2.5 shrink-0', skill.isDormant ? 'text-stone-300' : 'text-emerald-400')} />
        )}
      </div>
    </div>
  )
}

/* ───────── SubGroup Branch (二级子组分支) ───────── */

function SubGroupBranch({
  subGroup,
  side,
  branchProps,
}: {
  subGroup: SubGroup
  side: 'left' | 'right'
  branchProps: BranchProps
}) {
  const [expanded, setExpanded] = useState(false)
  const isLeft = side === 'left'
  const needCollapse = subGroup.skills.length > COLLAPSE_THRESHOLD
  const visible = expanded || !needCollapse
    ? subGroup.skills
    : subGroup.skills.slice(0, COLLAPSE_THRESHOLD)
  const hiddenCount = subGroup.skills.length - COLLAPSE_THRESHOLD

  return (
    <div className={cn(
      'flex items-stretch',
      isLeft ? 'flex-row-reverse' : 'flex-row',
    )}>
      {/* 水平分支 (域树干→子组) */}
      <div className="w-3 shrink-0 flex items-center">
        <div className="w-full border-t border-stone-300/40" />
      </div>

      {/* 子组标签胶囊 */}
      <div className="flex items-center shrink-0">
        <div className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded-lg',
          'bg-stone-50/80 border border-stone-200/60',
          'hover:bg-stone-100/80 transition-colors duration-150',
        )}>
          <span className="text-[9px] leading-none">{SOURCE_EMOJI[subGroup.source]}</span>
          <span className="text-[9px] font-semibold text-stone-400 max-w-[60px] truncate">
            {subGroup.label}
          </span>
          <span className="text-[8px] font-mono text-stone-300">{subGroup.skills.length}</span>
        </div>
      </div>

      {/* 水平连接 (标签→内树干) */}
      <div className="flex items-center shrink-0">
        <div className="w-2 border-t border-dashed border-stone-200/50" />
      </div>

      {/* 内缩进树干 + 技能列表 */}
      <div className={cn(
        isLeft
          ? 'border-r border-stone-200/40'
          : 'border-l border-stone-200/40',
      )}>
        <div className="flex flex-col gap-px py-0.5">
          {visible.map((skill) => renderSkillRow(skill, branchProps))}
          {needCollapse && (
            <CollapseButton
              expanded={expanded}
              hiddenCount={hiddenCount}
              side={side}
              onToggle={() => setExpanded(!expanded)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ───────── Domain Branch (域分支) ───────── */

function DomainBranch({
  group,
  side,
  onSelectSkill,
}: {
  group: DomainGroup
  side: 'left' | 'right'
  onSelectSkill: (skill: UISkillModel) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const isLeft = side === 'left'
  const hasSubGroups = !!group.subGroups?.length

  const bp: BranchProps = { side, onSelectSkill }

  // 3 级模式: subGroups + ungrouped 混合为子项列表
  // 2 级模式: skills 扁平列表
  const flatItems = hasSubGroups
    ? [...(group.subGroups ?? []).map((sg) => ({ kind: 'sub' as const, sg })),
       ...(group.ungrouped ?? []).map((sk) => ({ kind: 'skill' as const, sk }))]
    : group.skills.map((sk) => ({ kind: 'skill' as const, sk }))

  const totalItems = flatItems.length
  const needCollapse = totalItems > COLLAPSE_THRESHOLD
  const visibleItems = expanded || !needCollapse
    ? flatItems
    : flatItems.slice(0, COLLAPSE_THRESHOLD)
  const hiddenCount = totalItems - COLLAPSE_THRESHOLD

  return (
    <div className={cn(
      'flex items-stretch',
      isLeft ? 'flex-row-reverse' : 'flex-row',
    )}>
      {/* 域标题胶囊 */}
      <div className="flex items-center shrink-0">
        <div className={cn(
          'flex items-center gap-1.5 px-3 py-2 bg-white/90 backdrop-blur-sm rounded-xl',
          'border border-stone-200/80 shadow-sm',
          'hover:shadow-md transition-shadow duration-200',
        )}>
          <span className="text-sm">{group.emoji}</span>
          <span className="text-[11px] font-bold text-stone-700">{group.name}</span>
          <span
            className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[9px] font-mono font-bold text-white leading-none px-0.5"
            style={{ backgroundColor: group.color }}
          >
            {group.skills.length}
          </span>
        </div>
      </div>

      {/* 水平连接 (域→树干) */}
      <div className="flex items-center shrink-0">
        <div className="w-4 border-t border-dashed border-stone-300/60" />
      </div>

      {/* 树干 (border-l 或 border-r) + 子项列表 */}
      <div className={cn(
        isLeft
          ? 'border-r border-stone-300/50'
          : 'border-l border-stone-300/50',
      )}>
        <div className="flex flex-col gap-px py-1">
          {visibleItems.map((item) => {
            if (item.kind === 'sub') {
              return (
                <SubGroupBranch
                  key={item.sg.key}
                  subGroup={item.sg}
                  side={side}
                  branchProps={bp}
                />
              )
            }
            return renderSkillRow(item.sk, bp)
          })}

          {needCollapse && (
            <CollapseButton
              expanded={expanded}
              hiddenCount={hiddenCount}
              side={side}
              onToggle={() => setExpanded(!expanded)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ───────── Main: SkillsMindMapView ───────── */

export function SkillsMindMapView({ domains, allSkills, onSelectSkill }: SkillsMindMapViewProps) {
  // 左右分发
  const { leftDomains, rightDomains } = useMemo(() => {
    const left: DomainGroup[] = []
    const right: DomainGroup[] = []
    for (const d of domains) {
      if (LEFT_DOMAINS.has(d.id)) left.push(d)
      else right.push(d)
    }
    return { leftDomains: left, rightDomains: right }
  }, [domains])

  return (
    <div className="relative w-full h-full overflow-auto">
      {/* 三列布局: 左域 — 中枢 — 右域 */}
      <div className="flex items-center justify-center min-h-full px-8 py-12 relative z-20">

        {/* ── 左域列 ── */}
        <div className="flex flex-col gap-5 flex-1 items-end">
          {leftDomains.map((group) => (
            <DomainBranch
              key={group.id}
              group={group}
              side="left"
              onSelectSkill={onSelectSkill}
            />
          ))}
          {leftDomains.length === 0 && (
            <div className="text-[10px] text-stone-300 italic pr-4">暂无</div>
          )}
        </div>

        {/* ── 左侧虚线 (连接左列到中枢) ── */}
        <div className="w-6 shrink-0 border-t border-dashed border-stone-300/40" />

        {/* ── 中枢 Hub ── */}
        <div className="shrink-0 flex flex-col items-center z-30 mx-2">
          <div className="w-20 h-20 rounded-2xl bg-stone-800 flex flex-col items-center justify-center shadow-xl ring-1 ring-white/10">
            <span className="text-2xl leading-none">🧬</span>
          </div>
          <p className="mt-2 text-[11px] font-bold text-stone-700 tracking-tight">Duncrew</p>
          <p className="text-[9px] text-stone-400 font-mono tracking-wide">
            {allSkills.length} skills
          </p>
        </div>

        {/* ── 右侧虚线 (连接中枢到右列) ── */}
        <div className="w-6 shrink-0 border-t border-dashed border-stone-300/40" />

        {/* ── 右域列 ── */}
        <div className="flex flex-col gap-5 flex-1 items-start">
          {rightDomains.map((group) => (
            <DomainBranch
              key={group.id}
              group={group}
              side="right"
              onSelectSkill={onSelectSkill}
            />
          ))}
          {rightDomains.length === 0 && (
            <div className="text-[10px] text-stone-300 italic pl-4">暂无</div>
          )}
        </div>
      </div>
    </div>
  )
}
