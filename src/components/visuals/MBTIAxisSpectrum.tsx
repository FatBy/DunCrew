/**
 * MBTIAxisSpectrum - MBTI 四轴频谱可视化
 * 显示 E/I, S/N, T/F, J/P 四轴的基础值 vs 表达值
 */
import { motion } from 'framer-motion'
import type { MBTIAxisScores } from '@/types'

interface MBTIAxisSpectrumProps {
  baseAxes: MBTIAxisScores | null
  expressedAxes: MBTIAxisScores | null
  className?: string
}

interface AxisBarProps {
  label: string
  leftLabel: string
  rightLabel: string
  baseValue: number    // -1 ~ +1
  expressedValue: number
  delay: number
}

function AxisBar({ label, leftLabel, rightLabel, baseValue, expressedValue, delay }: AxisBarProps) {
  // 将 -1~+1 映射到 0~100%
  const toPercent = (v: number) => ((v + 1) / 2) * 100

  const basePct = toPercent(baseValue)
  const exprPct = toPercent(expressedValue)
  const hasDrift = Math.abs(expressedValue - baseValue) > 0.05

  return (
    <motion.div
      className="space-y-1"
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.4 }}
    >
      <div className="flex justify-between items-center text-[10px] font-mono">
        <span className="text-skin-text-secondary/50">{label}</span>
        {hasDrift && (
          <span className="text-skin-accent-amber/60 text-[9px]">
            {expressedValue > baseValue ? '+' : ''}{((expressedValue - baseValue) * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="relative h-3 bg-skin-bg-secondary/30 rounded-full overflow-hidden">
        {/* 中线 */}
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-skin-text-secondary/20 z-10" />

        {/* Base 标记 (半透明) */}
        <motion.div
          className="absolute top-0.5 bottom-0.5 w-1.5 rounded-full bg-skin-accent-cyan/30 z-20"
          initial={{ left: '50%' }}
          animate={{ left: `calc(${basePct}% - 3px)` }}
          transition={{ delay: delay + 0.2, duration: 0.6 }}
        />

        {/* Expressed 标记 (实心) */}
        <motion.div
          className="absolute top-0 bottom-0 w-2 rounded-full bg-skin-accent-cyan z-30 shadow-[0_0_6px_rgba(0,200,255,0.4)]"
          initial={{ left: '50%' }}
          animate={{ left: `calc(${exprPct}% - 4px)` }}
          transition={{ delay: delay + 0.3, duration: 0.6, type: 'spring', stiffness: 120 }}
        />
      </div>
      <div className="flex justify-between text-[9px] font-mono text-skin-text-secondary/35">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </motion.div>
  )
}

export function MBTIAxisSpectrum({ baseAxes, expressedAxes, className = '' }: MBTIAxisSpectrumProps) {
  if (!baseAxes) return null

  const axes = expressedAxes || baseAxes

  const axisConfigs = [
    { key: 'ei' as const, label: 'E / I', left: 'I', right: 'E', i18nKey: 'soul.axis_ei' },
    { key: 'sn' as const, label: 'S / N', left: 'N', right: 'S', i18nKey: 'soul.axis_sn' },
    { key: 'tf' as const, label: 'T / F', left: 'F', right: 'T', i18nKey: 'soul.axis_tf' },
    { key: 'jp' as const, label: 'J / P', left: 'P', right: 'J', i18nKey: 'soul.axis_jp' },
  ]

  return (
    <div className={`space-y-2.5 ${className}`}>
      {axisConfigs.map((cfg, i) => (
        <AxisBar
          key={cfg.key}
          label={cfg.label}
          leftLabel={cfg.left}
          rightLabel={cfg.right}
          baseValue={baseAxes[cfg.key]}
          expressedValue={axes[cfg.key]}
          delay={0.1 * i}
        />
      ))}
    </div>
  )
}
