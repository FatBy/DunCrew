import { motion } from 'framer-motion'

interface SkillParticleTooltipProps {
  skillName: string
  isActive: boolean
  x: number
  y: number
}

export function SkillParticleTooltip({ skillName, isActive, x, y }: SkillParticleTooltipProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8 }}
      transition={{ duration: 0.15 }}
      className="absolute z-40 pointer-events-none"
      style={{ left: x + 12, top: y - 16 }}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-skin-bg-panel/90 backdrop-blur-md border border-stone-200 shadow-lg">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-cyan-400' : 'bg-white/20'}`} />
        <span className="text-[11px] font-mono text-skin-text-primary whitespace-nowrap">
          {skillName}
        </span>
      </div>
    </motion.div>
  )
}
