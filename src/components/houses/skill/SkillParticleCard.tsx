import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { skillStatsService } from '@/services/skillStatsService'

interface SkillParticleCardProps {
  skillId: string
  skillName: string
  description?: string
  isActive: boolean
  x: number
  y: number
  onClose: () => void
}

export function SkillParticleCard({
  skillId, skillName, description, isActive, x, y, onClose,
}: SkillParticleCardProps) {
  const stats = skillStatsService.getSkillStats(skillId) || skillStatsService.getSkillStats(skillName)
  const callCount = stats?.callCount || 0
  const successRate = stats && stats.callCount > 0
    ? Math.round((stats.successCount / stats.callCount) * 100)
    : null

  // 卡片位置：在粒子旁边，避免超出屏幕
  const cardStyle: React.CSSProperties = {
    left: Math.min(x + 16, window.innerWidth - 280),
    top: Math.max(y - 60, 8),
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.85, y: 10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, y: 10 }}
      transition={{ duration: 0.2 }}
      className="absolute z-50"
      style={cardStyle}
    >
      <div className="w-60 backdrop-blur-xl bg-skin-bg-panel/90 border border-stone-200 rounded-xl shadow-2xl overflow-hidden">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-3 py-2 bg-stone-50 border-b border-stone-200/60">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${isActive ? 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.5)]' : 'bg-white/20'}`} />
            <span className="text-xs font-mono font-semibold text-skin-text-primary truncate">
              {skillName}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-stone-100 transition-colors shrink-0"
          >
            <X className="w-3.5 h-3.5 text-skin-text-secondary" />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-3 py-2.5 space-y-2">
          {description && (
            <p className="text-[11px] text-skin-text-secondary leading-relaxed line-clamp-2">
              {description}
            </p>
          )}

          {/* 统计指标 */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-skin-text-secondary/60">调用</span>
              <span className="text-xs font-mono font-bold text-skin-accent-cyan">{callCount}</span>
            </div>
            {successRate !== null && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-skin-text-secondary/60">成功率</span>
                <span className={`text-xs font-mono font-bold ${successRate >= 80 ? 'text-emerald-400' : successRate >= 50 ? 'text-amber-400' : 'text-red-400'}`}>
                  {successRate}%
                </span>
              </div>
            )}
            <div className="ml-auto">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-mono ${isActive ? 'bg-cyan-500/15 text-cyan-400' : 'bg-stone-100/80 text-stone-300'}`}>
                {isActive ? 'ACTIVE' : 'IDLE'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  )
}
