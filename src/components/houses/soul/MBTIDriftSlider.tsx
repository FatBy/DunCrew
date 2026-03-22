import { useState, useEffect } from 'react'
import { Activity, Clock } from 'lucide-react'
import type { MBTIAxisScores } from '@/types'

// ============================================
// -1~+1 → 0~100 映射
// ============================================

/** 将 store 中的 -1~+1 轴分数映射到 Demo 中的 0~100 百分比刻度 */
function toPercent(value: number): number {
  return (value + 1) * 50
}

// ============================================
// 单轴漂移滑块
// ============================================

interface DriftSliderProps {
  labelLeft: string
  labelRight: string
  baseVal: number   // 0-100 (已映射)
  expressedVal: number // 0-100 (已映射)
}

function DriftSlider({ labelLeft, labelRight, baseVal, expressedVal }: DriftSliderProps) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => setLoaded(true), [])

  // Clamp to 0-100
  const base = Math.max(0, Math.min(100, baseVal))
  const expressed = loaded ? Math.max(0, Math.min(100, expressedVal)) : base

  const minVal = Math.min(base, expressed)
  const maxVal = Math.max(base, expressed)
  const diff = maxVal - minVal

  return (
    <div className="mb-4 group">
      <div className="flex justify-between text-xs text-gray-400 font-mono mb-1.5 px-1">
        <span>{labelLeft}</span>
        <span>{labelRight}</span>
      </div>
      <div className="relative h-2 bg-gray-200/50 rounded-full w-full">
        {/* Drift Track (The difference) */}
        <div
          className="absolute h-full bg-teal-200/40 rounded-full transition-all duration-1000 ease-out"
          style={{ left: `${minVal}%`, width: `${diff}%` }}
        />
        {/* Base Point (Immutable Nature) */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-1.5 h-3 bg-gray-300 rounded-sm z-10"
          style={{ left: `calc(${base}% - 3px)` }}
          title="出厂基准点"
        />
        {/* Expressed Point (Current State) */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-teal-500 rounded-full shadow-[0_0_8px_rgba(20,184,166,0.5)] z-20 transition-all duration-1000 ease-out group-hover:scale-125"
          style={{ left: `calc(${expressed}% - 6px)` }}
          title="当前行为偏移量"
        />
      </div>
    </div>
  )
}

// ============================================
// 四轴漂移面板
// ============================================

interface MBTIDriftSliderProps {
  baseAxes: MBTIAxisScores | null
  expressedAxes: MBTIAxisScores | null
}

/**
 * 四轴配置
 * 轴方向约定 (与 types.ts MBTIAxisScores 一致):
 *   ei: -1=I extreme, +1=E extreme  → 左 I, 右 E
 *   sn: -1=N extreme, +1=S extreme  → 左 N, 右 S
 *   tf: -1=F extreme, +1=T extreme  → 左 F, 右 T
 *   jp: -1=P extreme, +1=J extreme  → 左 P, 右 J
 */
const AXES = [
  { key: 'ei' as const, left: 'I 内向', right: 'E 外向' },
  { key: 'sn' as const, left: 'N 直觉', right: 'S 实感' },
  { key: 'tf' as const, left: 'F 情感', right: 'T 理性' },
  { key: 'jp' as const, left: 'P 灵活', right: 'J 计划' },
]

export function MBTIDriftSlider({ baseAxes, expressedAxes }: MBTIDriftSliderProps) {
  if (!baseAxes) return null

  const expressed = expressedAxes || baseAxes

  return (
    <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-teal-600/80 text-xs font-semibold tracking-widest uppercase">
          <Activity className="w-4 h-4" />
          行为漂移 (L2)
        </div>
        <div className="text-[10px] text-teal-500/60 font-mono bg-teal-50 px-2 py-0.5 rounded-full flex items-center gap-1">
          <Clock className="w-3 h-3" />
          实时
        </div>
      </div>

      {AXES.map((axis) => (
        <DriftSlider
          key={axis.key}
          labelLeft={axis.left}
          labelRight={axis.right}
          baseVal={toPercent(baseAxes[axis.key])}
          expressedVal={toPercent(expressed[axis.key])}
        />
      ))}

      {/* Legend */}
      <div className="flex items-center gap-4 mt-2 pt-2 border-t border-gray-100/50 text-[10px] text-gray-400 font-mono">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-3 bg-gray-300 rounded-sm" />
          <span>出厂基准</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 bg-teal-500 rounded-full shadow-[0_0_4px_rgba(20,184,166,0.4)]" />
          <span>当前偏移</span>
        </div>
      </div>
    </div>
  )
}
