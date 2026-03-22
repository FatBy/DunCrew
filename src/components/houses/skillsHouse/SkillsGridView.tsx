/**
 * SkillsGridView - 网格商店模式
 *
 * 紧凑卡片网格, 支持 Glow Sync 交互:
 * hover 时屏幕变暗, 共享资源的技能发光
 */

import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SkillGridCard } from './SkillGridCard'
import type { UISkillModel } from '@/utils/skillsHouseMapper'
import { findGlowRelations, type GlowRelation } from '@/utils/skillsHouseMapper'

interface SkillsGridViewProps {
  skills: UISkillModel[]
  allSkills: UISkillModel[]   // 全量, Glow 查找用
  onSelectSkill: (skill: UISkillModel) => void
}

export function SkillsGridView({ skills, allSkills, onSelectSkill }: SkillsGridViewProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)

  // 计算当前 hover 技能的 Glow 关系
  const glowRelations = useMemo<GlowRelation[]>(() => {
    if (!hoveredId) return []
    const target = allSkills.find((s) => s.id === hoveredId)
    if (!target) return []
    return findGlowRelations(target, allSkills)
  }, [hoveredId, allSkills])

  const glowMap = useMemo(() => {
    const m = new Map<string, 'shared-tool' | 'shared-env'>()
    for (const r of glowRelations) {
      m.set(r.skillId, r.type)
    }
    return m
  }, [glowRelations])

  const hasGlow = hoveredId !== null && glowRelations.length > 0

  const handleHoverStart = useCallback((id: string) => {
    setHoveredId(id)
  }, [])

  const handleHoverEnd = useCallback(() => {
    setHoveredId(null)
  }, [])

  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stone-400">
        <span className="text-4xl mb-3">📭</span>
        <p className="text-sm">该分类下暂无技能</p>
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-y-auto p-5">
      {/* Glow Sync 遮罩 */}
      <AnimatePresence>
        {hasGlow && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 bg-black/5 pointer-events-none z-10"
          />
        )}
      </AnimatePresence>

      {/* 网格 */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 relative z-20">
        {skills.map((skill) => {
          const glowType = glowMap.get(skill.id) ?? null
          const isDimmed = hasGlow && skill.id !== hoveredId && !glowType
          return (
            <SkillGridCard
              key={skill.id}
              skill={skill}
              isGlowing={skill.id === hoveredId ? null : glowType}
              isDimmed={isDimmed}
              onClick={() => onSelectSkill(skill)}
              onHoverStart={() => handleHoverStart(skill.id)}
              onHoverEnd={handleHoverEnd}
            />
          )
        })}
      </div>
    </div>
  )
}
