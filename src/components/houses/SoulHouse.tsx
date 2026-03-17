import { motion } from 'framer-motion'
import { Fingerprint, Shield, AlertTriangle, Sparkles, Loader2 } from 'lucide-react'
import { useStore } from '@/store'
import { SoulAnimalAvatar } from '@/components/visuals/SoulAnimalAvatar'
import { HudPanel } from '@/components/ui/HudPanel'
import { AISummaryCard } from '@/components/ai/AISummaryCard'
import { useT } from '@/i18n'

export function SoulHouse() {
  const t = useT()
  const soulIdentity = useStore((s) => s.soulIdentity)
  const soulCoreTruths = useStore((s) => s.soulCoreTruths)
  const soulBoundaries = useStore((s) => s.soulBoundaries)
  const soulVibeStatement = useStore((s) => s.soulVibeStatement)
  const soulDimensions = useStore((s) => s.soulDimensions)
  const soulMBTI = useStore((s) => s.soulMBTI)
  const soulMBTILoading = useStore((s) => s.soulMBTILoading)
  const loading = useStore((s) => s.devicesLoading)

  if (loading && !soulIdentity) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-skin-accent-cyan/50 font-mono text-sm gap-2">
        <Loader2 className="w-6 h-6 animate-spin" />
        {t('soul.initializing')}
      </div>
    )
  }

  return (
    <div className="relative w-full h-full bg-skin-bg-primary overflow-hidden flex flex-col">
      {/* 1. Top AI summary */}
      <div className="absolute top-4 left-4 right-4 z-30 pointer-events-none">
        <div className="pointer-events-auto">
          <AISummaryCard view="soul" />
        </div>
      </div>

      {/* 2. Background: subtle grid */}
      <div className="absolute inset-0 z-0">
        <div
          className="absolute inset-0 pointer-events-none opacity-[0.03]"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px',
            maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)',
          }}
        />
      </div>

      {/* 3. Center: Animal Avatar */}
      <div className="absolute inset-0 z-5 flex items-center justify-center pointer-events-none">
        <SoulAnimalAvatar
          mbtiResult={soulMBTI}
          identity={soulIdentity}
          loading={soulMBTILoading}
        />
      </div>

      {/* 4. HUD overlay layer */}
      <div className="relative z-10 w-full h-full pointer-events-none p-6 flex flex-col justify-between">
        {/* Top spacer for AISummaryCard */}
        <div className="h-16" />

        {/* Middle: left + right HUD panels */}
        <div className="flex-1 flex items-center justify-between gap-4 py-4">
          {/* Left panel group */}
          <div className="flex flex-col gap-3 max-w-[220px] w-full">
            <HudPanel title={t('soul.identity')} icon={Fingerprint} side="left" delay={0.2}>
              <div className="space-y-2">
                <div className="text-lg font-bold text-skin-text-primary/90 tracking-wide">
                  {soulIdentity?.name || 'GENESIS'}
                </div>
                <div className="text-[13px] font-mono text-skin-accent-cyan/60">
                  {soulIdentity?.essence || 'Digital Soul Core'}
                </div>
              </div>
            </HudPanel>

            {soulCoreTruths.length > 0 && (
              <HudPanel title={t('soul.core_protocols')} icon={Shield} side="left" delay={0.4}>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {soulCoreTruths.slice(0, 4).map((truth, i) => (
                    <div key={truth.id} className="flex items-start gap-2">
                      <span className="text-[12px] font-mono text-skin-accent-cyan/60 mt-0.5">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="text-[11px] text-skin-text-secondary/60 leading-tight">
                        {truth.title}
                      </span>
                    </div>
                  ))}
                </div>
              </HudPanel>
            )}
          </div>

          {/* Right panel group */}
          <div className="flex flex-col gap-3 max-w-[220px] w-full">
            {soulBoundaries.length > 0 && (
              <HudPanel title={t('soul.boundaries')} icon={AlertTriangle} side="right" delay={0.3}>
                <div className="space-y-1.5 max-h-32 overflow-y-auto">
                  {soulBoundaries.slice(0, 4).map((b, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-[12px] font-mono text-skin-accent-amber/60 mt-0.5">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="text-[11px] text-skin-text-secondary/60 leading-tight line-clamp-2">
                        {b.rule}
                      </span>
                    </div>
                  ))}
                </div>
              </HudPanel>
            )}

            {(soulVibeStatement || soulMBTI) && (
              <HudPanel title={t('soul.vibe')} icon={Sparkles} side="right" delay={0.5}>
                <div className="space-y-2">
                  {soulVibeStatement && (
                    <p className="text-[11px] text-skin-text-secondary/50 leading-relaxed line-clamp-3 italic">
                      &ldquo;{soulVibeStatement}&rdquo;
                    </p>
                  )}
                  {soulMBTI && (
                    <div className="flex items-center gap-2 pt-1 border-t border-skin-border/5">
                      <span className="text-[13px] font-mono font-bold text-skin-accent-cyan">
                        {soulMBTI.type.toUpperCase()}
                      </span>
                      <span className="text-[11px] text-skin-text-secondary/40">
                        {soulMBTI.animalZh} · {soulMBTI.group}
                      </span>
                    </div>
                  )}
                </div>
              </HudPanel>
            )}
          </div>
        </div>

        {/* Bottom: dimension bars */}
        {soulDimensions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
            className="flex justify-center pointer-events-auto"
          >
            <div className="flex gap-4 px-6 py-3 bg-skin-bg-panel/40 backdrop-blur-xl rounded-2xl border border-skin-border/5">
              {soulDimensions.slice(0, 6).map((d, i) => (
                <motion.div
                  key={d.name}
                  className="flex flex-col items-center gap-1.5 w-12"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.8 + i * 0.1 }}
                >
                  <div className="h-14 w-1.5 bg-stone-50 rounded-full relative overflow-hidden">
                    <motion.div
                      className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-skin-accent-cyan via-skin-accent-purple to-skin-accent-amber rounded-full"
                      initial={{ height: 0 }}
                      animate={{ height: `${d.value}%` }}
                      transition={{ duration: 1, delay: 0.9 + i * 0.1 }}
                    />
                  </div>
                  <span className="text-[11px] text-skin-text-secondary/40 font-mono truncate max-w-full text-center">
                    {d.name}
                  </span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </div>
  )
}
