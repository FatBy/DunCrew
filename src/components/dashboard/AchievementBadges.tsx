// ============================================
// AchievementBadges - 成就徽章展示组件
// ============================================

import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { nexusAchievementService } from '@/services/nexusAchievementService'
import { ACHIEVEMENTS, type AchievementId, type AchievementDef } from './nexusGrowth'

interface AchievementBadgesProps {
  nexusId: string
}

const TIER_COLORS: Record<string, string> = {
  gold: '#fbbf24',
  silver: '#94a3b8',
  bronze: '#d97706',
}

export function AchievementBadges({ nexusId }: AchievementBadgesProps) {
  const [earned, setEarned] = useState<AchievementId[]>([])
  const [selectedBadge, setSelectedBadge] = useState<AchievementDef | null>(null)

  useEffect(() => {
    setEarned(nexusAchievementService.getAchievements(nexusId))
  }, [nexusId])

  if (earned.length === 0 && ACHIEVEMENTS.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-skin-text-muted font-mono uppercase tracking-wider">
        Achievements ({earned.length}/{ACHIEVEMENTS.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ACHIEVEMENTS.map((ach) => {
          const isEarned = earned.includes(ach.id)
          const tierColor = TIER_COLORS[ach.tier] ?? '#94a3b8'
          return (
            <button
              key={ach.id}
              onClick={() => setSelectedBadge(selectedBadge?.id === ach.id ? null : ach)}
              className="relative group transition-all duration-200"
              title={ach.label}
            >
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-base transition-all"
                style={{
                  background: isEarned ? `${tierColor}20` : 'rgba(100,100,100,0.08)',
                  border: `1px solid ${isEarned ? `${tierColor}40` : 'rgba(100,100,100,0.1)'}`,
                  filter: isEarned ? 'none' : 'grayscale(1) opacity(0.3)',
                }}
              >
                {ach.emoji}
              </div>
            </button>
          )
        })}
      </div>
      <AnimatePresence>
        {selectedBadge && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-skin-bg-elevated/30 border border-skin-border/5">
              <span className="text-lg">{selectedBadge.emoji}</span>
              <div>
                <div className="text-xs font-medium text-skin-text-primary">
                  {selectedBadge.label}
                  {earned.includes(selectedBadge.id) && (
                    <span className="ml-1.5 text-[9px] text-emerald-400">Earned</span>
                  )}
                </div>
                <div className="text-[10px] text-skin-text-muted">{selectedBadge.description}</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
