import { motion } from 'framer-motion'
import { Puzzle, Server, Sparkles } from 'lucide-react'
import { cn } from '@/utils/cn'
import type { MatchResult } from '@/services/smartMatchService'

interface MatchResultCardProps {
  result: MatchResult
  accentColor: 'amber' | 'purple'
  onClick: () => void
  index: number
}

const scoreColor = (score: number) => {
  if (score >= 80) return 'bg-emerald-500/20 text-emerald-400'
  if (score >= 50) return 'bg-blue-500/20 text-blue-400'
  return 'bg-stone-100 text-stone-400'
}

export function MatchResultCard({ result, accentColor, onClick, index }: MatchResultCardProps) {
  const isAmber = accentColor === 'amber'
  const Icon = isAmber ? Puzzle : Server

  return (
    <motion.button
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.08, duration: 0.25, ease: 'easeOut' }}
      whileHover={{ scale: 1.02 }}
      onClick={onClick}
      className={cn(
        'w-full text-left p-3.5 rounded-xl border transition-colors',
        isAmber
          ? 'bg-amber-500/5 border-amber-500/15 hover:border-amber-500/40 hover:bg-amber-500/10'
          : 'bg-purple-500/5 border-purple-500/15 hover:border-purple-500/40 hover:bg-purple-500/10',
      )}
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <Icon className={cn('w-3.5 h-3.5', isAmber ? 'text-amber-400' : 'text-purple-400')} />
          <span className={cn('text-sm font-mono font-semibold', isAmber ? 'text-amber-300' : 'text-purple-300')}>
            {result.name}
          </span>
          {result.matchType === 'llm' && (
            <Sparkles className="w-3 h-3 text-yellow-400/60" />
          )}
        </div>
        <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded', scoreColor(result.score))}>
          {result.score}
        </span>
      </div>

      {/* 描述 */}
      {result.description && (
        <p className="text-[11px] text-stone-400 mb-1.5 line-clamp-2 leading-relaxed">
          {result.description}
        </p>
      )}

      {/* 匹配原因 */}
      <div className={cn(
        'text-[11px] px-2 py-1 rounded inline-flex items-center gap-1',
        isAmber ? 'bg-amber-500/10 text-amber-300/80' : 'bg-purple-500/10 text-purple-300/80',
      )}>
        <span className="text-[10px]">推荐:</span> {result.matchReason}
      </div>

      {/* extras 标签 */}
      {result.extras && result.extras.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {result.extras.map((tag) => (
            <span
              key={tag}
              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stone-100/80 text-stone-300"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </motion.button>
  )
}
