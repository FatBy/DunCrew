import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'
import { GlassCard } from './GlassCard'
import { useStore } from '@/store'
import { houseVariants, springTransition } from '@/utils/animations'
import type { HouseConfig } from '@/types'

const themeTextMap: Record<string, string> = {
  cyan: 'text-cyan-600',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  purple: 'text-purple-600',
  slate: 'text-stone-600',
}

interface HouseContainerProps {
  house: HouseConfig
  children: ReactNode
}

export function HouseContainer({ house, children }: HouseContainerProps) {
  const setView = useStore((s) => s.setView)
  const Icon = house.icon
  const textColor = themeTextMap[house.themeColor] ?? 'text-stone-700'

  return (
    <motion.div
      className="absolute inset-0 z-10 flex items-center justify-center p-4 md:p-8"
      variants={houseVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={springTransition}
    >
      <GlassCard
        themeColor={house.themeColor}
        className="w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden"
      >
        {/* Title bar - Blueprint 亮色风格 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200/60 bg-white/50 shrink-0">
          <div className="flex items-center gap-3">
            <Icon className={`w-5 h-5 ${textColor}`} />
            <h2 className="font-black text-lg tracking-wide text-stone-800">
              {house.name}
            </h2>
          </div>
          <button
            onClick={() => setView('world')}
            className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative">
          {children}
        </div>
      </GlassCard>
    </motion.div>
  )
}
