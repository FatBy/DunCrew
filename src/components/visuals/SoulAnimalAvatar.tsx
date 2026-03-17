import { useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Brain } from 'lucide-react'
import type { MBTIResult, SoulIdentity } from '@/types'
import { getAvatarPath } from '@/services/mbtiAnalyzer'

interface SoulAnimalAvatarProps {
  mbtiResult: MBTIResult | null
  identity?: SoulIdentity | null
  loading?: boolean
  className?: string
}

export function SoulAnimalAvatar({ mbtiResult, identity, loading, className = '' }: SoulAnimalAvatarProps) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  // Loading skeleton
  if (loading || !mbtiResult) {
    return (
      <div className={`flex flex-col items-center justify-center gap-4 ${className}`}>
        <div className="relative w-48 h-48">
          <div className="absolute inset-0 rounded-full bg-stone-50 animate-pulse" />
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-skin-accent-cyan/40 animate-spin" />
          </div>
        </div>
        <div className="h-4 w-32 bg-skin-bg-secondary/20 rounded animate-pulse" />
      </div>
    )
  }

  const avatarSrc = getAvatarPath(mbtiResult)

  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      {/* Avatar container with glow */}
      <div className="relative">
        {/* Bottom glow */}
        <div
          className="absolute -bottom-6 left-1/2 -translate-x-1/2 w-40 h-16 opacity-40 blur-2xl pointer-events-none"
          style={{
            background: 'radial-gradient(ellipse at center, var(--color-accent-cyan) 0%, transparent 70%)',
          }}
        />

        {/* Breathing animation wrapper */}
        <motion.div
          animate={{ scale: [1, 1.02, 1] }}
          transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
          className="relative"
        >
          {/* Outer ring glow */}
          <div className="absolute -inset-3 rounded-full opacity-20 blur-xl pointer-events-none bg-gradient-to-br from-skin-accent-cyan via-skin-accent-purple to-skin-accent-amber" />

          {/* Image container */}
          <div className="relative w-48 h-48 rounded-full overflow-hidden border-2 border-stone-200/60 shadow-[0_0_40px_rgba(0,0,0,0.4)]">
            {!imgError ? (
              <img
                src={avatarSrc}
                alt={`${mbtiResult.animalZh} - ${mbtiResult.type.toUpperCase()}`}
                className={`w-full h-full object-cover transition-opacity duration-700 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-stone-100">
                <Brain className="w-16 h-16 text-skin-accent-cyan/30" />
              </div>
            )}

            {/* Loading overlay */}
            {!imgLoaded && !imgError && (
              <div className="absolute inset-0 flex items-center justify-center bg-stone-100">
                <Loader2 className="w-8 h-8 text-skin-accent-cyan/40 animate-spin" />
              </div>
            )}
          </div>
        </motion.div>
      </div>

      {/* MBTI type badge */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.5 }}
        className="flex flex-col items-center gap-1"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold font-mono text-skin-accent-cyan tracking-widest">
            {mbtiResult.type.toUpperCase()}
          </span>
          <span className="text-sm text-skin-text-secondary/60">
            {mbtiResult.animalZh}
          </span>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono text-skin-text-secondary/40">
          <span className="px-1.5 py-0.5 rounded bg-skin-bg-secondary/20 border border-skin-border/5">
            {mbtiResult.group}
          </span>
          <span>
            {mbtiResult.source === 'llm' ? 'AI' : 'Rule'}
          </span>
          {identity?.name && (
            <span className="text-skin-text-secondary/30">
              {identity.name}
            </span>
          )}
        </div>

        <p className="text-[12px] text-skin-text-secondary/50 text-center max-w-[200px] mt-1">
          {mbtiResult.trait}
        </p>
      </motion.div>
    </div>
  )
}
