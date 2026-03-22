import { motion } from 'framer-motion'
import { MessageSquare } from 'lucide-react'
import { useStore } from '@/store'
import { houseRegistry } from '@/houses/registry'
import { dockIconVariants } from '@/utils/animations'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'
import type { TranslationKey } from '@/i18n/locales/zh'

const dockNameKeys: Record<string, TranslationKey> = {
  world: 'app.menu.world',
  task: 'app.menu.task',
  skill: 'app.menu.skill',
  memory: 'app.menu.memory',
  soul: 'app.menu.soul',
  settings: 'app.menu.settings',
}

const themeColorMap: Record<string, string> = {
  cyan: 'text-cyan-400',
  emerald: 'text-emerald-400',
  amber: 'text-amber-400',
  purple: 'text-purple-400',
  slate: 'text-stone-400',
}

const activeBgMap: Record<string, string> = {
  cyan: 'bg-cyan-400/20',
  emerald: 'bg-emerald-400/20',
  amber: 'bg-amber-400/20',
  purple: 'bg-purple-400/20',
  slate: 'bg-stone-100',
}

const dotColorMap: Record<string, string> = {
  cyan: 'bg-cyan-400',
  emerald: 'bg-emerald-400',
  amber: 'bg-amber-400',
  purple: 'bg-purple-400',
  slate: 'bg-stone-400',
}

export function Dock() {
  const currentView = useStore((s) => s.currentView)
  const setView = useStore((s) => s.setView)
  const isChatOpen = useStore((s) => s.isChatOpen)
  const setChatOpen = useStore((s) => s.setChatOpen)
  const t = useT()

  return (
    <div className="h-full flex flex-col justify-center py-4 pl-3 pr-1 z-40 shrink-0">
      <motion.div
        className="flex flex-col items-center gap-1.5 py-4 px-2.5 bg-white border border-stone-200/60 backdrop-blur-2xl rounded-2xl shadow-2xl"
        initial={{ x: -80, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20, delay: 0.3 }}
      >
        {houseRegistry.map((house) => {
          const Icon = house.icon
          const isActive = currentView === house.id
          const textColor = themeColorMap[house.themeColor] ?? 'text-white'
          const activeBg = activeBgMap[house.themeColor] ?? 'bg-stone-100'
          const dotColor = dotColorMap[house.themeColor] ?? 'bg-white'

          return (
            <div key={house.id} className="relative group">
              {/* Tooltip - 右侧滑出 (z-50 防遮挡) */}
              <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-white/95 backdrop-blur-xl rounded-lg text-xs font-mono text-stone-600 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-stone-200 shadow-lg z-50">
                {dockNameKeys[house.id] ? t(dockNameKeys[house.id]) : house.name}
              </div>

              <motion.button
                onClick={() => setView(house.id)}
                className={cn(
                  'relative flex items-center justify-center p-2.5 rounded-xl transition-colors',
                  isActive ? activeBg : 'hover:bg-stone-100/80'
                )}
                variants={dockIconVariants}
                whileHover="hover"
                whileTap="tap"
                transition={{ type: 'spring', stiffness: 400, damping: 15 }}
              >
                <Icon
                  className={cn(
                    'w-5 h-5 transition-colors',
                    isActive ? textColor : 'text-stone-500'
                  )}
                />

                {/* Active indicator - 左侧竖条 */}
                {isActive && (
                  <motion.div
                    className={cn(
                      'absolute -left-1.5 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full',
                      dotColor
                    )}
                    layoutId="dock-active-indicator"
                    transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                  />
                )}
              </motion.button>
            </div>
          )
        })}

        {/* ── 分隔线 ── */}
        <div className="w-6 h-px bg-stone-200 my-1" />

        {/* ── AI Chat 按钮 ── */}
        <div className="relative group">
          <div className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-white/95 backdrop-blur-xl rounded-lg text-xs font-mono text-stone-600 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none border border-stone-200 shadow-lg z-50">
            AI Assistant
          </div>
          <motion.button
            onClick={() => setChatOpen(!isChatOpen)}
            className={cn(
              'relative flex items-center justify-center p-2.5 rounded-xl transition-colors',
              isChatOpen ? 'bg-amber-400/20' : 'hover:bg-stone-100/80'
            )}
            variants={dockIconVariants}
            whileHover="hover"
            whileTap="tap"
            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
          >
            <MessageSquare
              className={cn(
                'w-5 h-5 transition-colors',
                isChatOpen ? 'text-amber-500' : 'text-stone-500'
              )}
            />
            {isChatOpen && (
              <motion.div
                className="absolute -left-1.5 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-amber-400"
                layoutId="dock-chat-indicator"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
          </motion.button>
        </div>
      </motion.div>
    </div>
  )
}
