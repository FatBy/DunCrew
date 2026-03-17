import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'

interface HudPanelProps {
  children: React.ReactNode
  title: string
  icon: LucideIcon
  side?: 'left' | 'right'
  delay?: number
}

export function HudPanel({ 
  children, 
  title, 
  icon: Icon, 
  side = 'left',
  delay = 0 
}: HudPanelProps) {
  return (
    <motion.div
      initial={{ opacity: 0, x: side === 'left' ? -30 : 30 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.6, ease: "easeOut" }}
      className={`pointer-events-auto backdrop-blur-md bg-skin-bg-panel/40 border border-stone-200/60 rounded-xl overflow-hidden shadow-[0_0_30px_rgba(0,0,0,0.3)] hover:bg-skin-bg-panel/60 hover:border-stone-200 transition-all ${side === 'left' ? 'mr-auto' : 'ml-auto'}`}
    >
      <div className="px-4 py-2 bg-skin-bg-secondary/20 border-b border-skin-border/5 flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-skin-accent-cyan" />
        <span className="text-[13px] font-mono uppercase tracking-widest text-skin-text-secondary/70">
          {title}
        </span>
      </div>
      <div className="p-4">
        {children}
      </div>
    </motion.div>
  )
}
