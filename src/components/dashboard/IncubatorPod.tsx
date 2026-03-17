// ============================================
// IncubatorPod - 萌宠圆环设计
// 严格复刻原型：圆形头像 + hover:z-[100] + 右侧白底 Tooltip
// ============================================

import React, { useState, useEffect } from 'react'
import { Sparkles, Heart, Zap, Activity } from 'lucide-react'
import type { NexusRole } from './roleInference'

// ==========================================
// 数据接口
// ==========================================

export interface AgentData {
  id: string
  name: string
  role: NexusRole
  animalEmoji: string
  level: number
  xp: number
  maxXp: number
  status: 'idle' | 'working'
  stage: 'dormant' | 'awakening' | 'evolved'
  offsetX: number
  offsetY: number
}

interface IncubatorPodProps {
  data: AgentData
  isSelected: boolean
  onClick: (id: string) => void
}

// ==========================================
// 视觉映射：stage → 颜色主题 (使用内联样式避免 Tailwind purge)
// ==========================================

interface StageTheme {
  borderColor: string
  borderStyle: string
  bgColor: string
  textColor: string
  barColor: string
  shadow: string
  badgeBg: string
  badgeText: string
  badgeBorder: string
}

const STAGE_THEMES: Record<string, StageTheme> = {
  evolved: {
    borderColor: '#6ee7b7',  // emerald-300
    borderStyle: 'solid',
    bgColor: '#ecfdf5',      // emerald-50
    textColor: '#22c55e',    // emerald-500
    barColor: '#34d399',     // emerald-400
    shadow: '0 8px 20px rgba(16,185,129,0.2)',
    badgeBg: '#d1fae5',      // emerald-100
    badgeText: '#059669',    // emerald-600
    badgeBorder: '#a7f3d0',  // emerald-200
  },
  awakening: {
    borderColor: '#7dd3fc',  // sky-300
    borderStyle: 'solid',
    bgColor: '#f0f9ff',      // sky-50
    textColor: '#0ea5e9',    // sky-500
    barColor: '#38bdf8',     // sky-400
    shadow: '0 8px 20px rgba(14,165,233,0.2)',
    badgeBg: '#e0f2fe',      // sky-100
    badgeText: '#0284c7',    // sky-600
    badgeBorder: '#bae6fd',  // sky-200
  },
  dormant: {
    borderColor: '#fda4af',  // rose-300
    borderStyle: 'dashed',
    bgColor: '#fff1f2',      // rose-50
    textColor: '#f43f5e',    // rose-500
    barColor: '#fb7185',     // rose-400
    shadow: '0 8px 20px rgba(243,64,105,0.15)',
    badgeBg: '#ffe4e6',      // rose-100
    badgeText: '#e11d48',    // rose-600
    badgeBorder: '#fecdd3',  // rose-200
  },
}

function getTheme(stage: string): StageTheme {
  return STAGE_THEMES[stage] ?? STAGE_THEMES.dormant
}

// ==========================================
// 单个萌宠节点组件
// ==========================================

export const IncubatorPod: React.FC<IncubatorPodProps> = ({ data, isSelected, onClick }) => {
  const [elapsed, setElapsed] = useState(0)
  const theme = getTheme(data.stage)
  const isWorking = data.status === 'working'
  const percent = Math.round((data.xp / data.maxXp) * 100)

  useEffect(() => {
    if (isWorking) {
      const startTime = Date.now() - Math.random() * 5000
      const timer = setInterval(() => {
        setElapsed(Number(((Date.now() - startTime) / 1000).toFixed(1)))
      }, 100)
      return () => clearInterval(timer)
    }
  }, [isWorking])

  return (
    // 【核心修复】hover:z-[100] 彻底解决遮挡问题，配合绝对居中与偏移量
    <div
      className="absolute group hover:z-[100] z-10"
      style={{
        top: '50%', left: '50%',
        transform: `translate(calc(-50% + ${data.offsetX}px), calc(-50% + ${data.offsetY}px))`,
      }}
    >

      {/* 核心节点容器 */}
      <div
        className="relative flex flex-col items-center justify-center cursor-pointer"
        onClick={() => onClick(data.id)}
      >

        {/* 圆形动物头像框 - w-20 h-20 rounded-full bg-white border-4 */}
        <div
          className={`relative w-20 h-20 rounded-full bg-white flex items-center justify-center z-10 transition-transform duration-300 group-hover:scale-110 group-hover:-translate-y-2 ${isSelected ? 'ring-2 ring-amber-400 ring-offset-2' : ''}`}
          style={{
            borderWidth: '4px',
            borderColor: theme.borderColor,
            borderStyle: theme.borderStyle,
            boxShadow: theme.shadow,
            animation: isWorking
              ? 'wiggle 1s ease-in-out infinite'
              : 'gentleBounce 3s ease-in-out infinite',
          }}
        >
          <span className="text-4xl filter drop-shadow-sm transition-transform duration-300 group-hover:scale-110">
            {data.animalEmoji}
          </span>

          {/* 底部微型进度条 */}
          <div className="absolute bottom-1.5 w-10 h-1.5 bg-stone-100 rounded-full overflow-hidden">
            <div
              style={{ width: `${percent}%`, backgroundColor: theme.barColor }}
              className="h-full"
            />
          </div>
        </div>

        {/* 独立名牌贴纸 */}
        <div
          className="mt-2 bg-white px-3 py-1 rounded-full shadow-sm z-10 transition-all duration-300 group-hover:-translate-y-1"
          style={{ borderWidth: '2px', borderColor: theme.borderColor, borderStyle: theme.borderStyle }}
        >
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-bold text-stone-600 whitespace-nowrap overflow-hidden text-ellipsis max-w-[80px]">
              {data.name}
            </span>
            {isWorking && <Sparkles className="w-3 h-3 text-amber-400 animate-pulse" />}
          </div>
        </div>
      </div>

      {/* --- 悬浮面板 (Tooltip) --- */}
      {/* 右侧弹出 (left-[110%]) 防止挡住本体，层级绝对置顶 */}
      <div className="absolute left-[110%] top-1/2 -translate-y-1/2 w-[320px] bg-white/95 backdrop-blur-xl rounded-[2rem] shadow-[0_30px_60px_rgba(0,0,0,0.15)] p-5 opacity-0 pointer-events-none group-hover:opacity-100 transition-all duration-300 z-50 translate-x-4 group-hover:translate-x-0"
        style={{ borderWidth: '2px', borderColor: '#f5f5f4' }}
      >
        {/* 左侧指示小箭头 */}
        <div className="absolute top-1/2 -left-2 -translate-y-1/2 w-4 h-4 bg-white/95 rotate-45"
          style={{ borderBottom: '2px solid #f5f5f4', borderLeft: '2px solid #f5f5f4' }}
        />

        {/* 顶部 Header */}
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-2xl"
              style={{ backgroundColor: theme.bgColor, borderWidth: '1px', borderColor: theme.borderColor }}
            >
              {data.animalEmoji}
            </div>
            <div>
              <div className="font-bold text-sm text-stone-700">{data.name}</div>
              <div className="text-stone-400 text-[10px] mt-0.5 uppercase tracking-wider">Model: GPT-4o</div>
            </div>
          </div>
          <div className="text-right flex flex-col items-end">
            <div className="text-2xl font-black leading-none" style={{ color: theme.textColor }}>
              LV.{data.level}
            </div>
            <div className="text-[10px] text-stone-400 mt-1 font-medium">
              {data.stage === 'evolved' ? '状态极佳' : data.stage === 'awakening' ? '活跃中' : '休眠中'}
            </div>
          </div>
        </div>

        {/* 状态标签 */}
        <div className="flex items-center justify-between mb-4">
          <span
            className="text-[11px] font-bold px-3 py-1.5 rounded-full flex items-center gap-1"
            style={{
              backgroundColor: theme.badgeBg,
              color: theme.badgeText,
              borderWidth: '1px',
              borderColor: theme.badgeBorder,
            }}
          >
            {isWorking ? <Activity className="w-3 h-3 animate-pulse" /> : <Zap className="w-3 h-3" />}
            {data.status.toUpperCase()}
          </span>
          {isWorking && (
            <span className="text-[11px] font-bold text-sky-500 bg-sky-50 px-3 py-1.5 rounded-full"
              style={{ borderWidth: '1px', borderColor: '#e0f2fe' }}
            >
              任务执行中
            </span>
          )}
        </div>

        {/* 思考流与工具 (聊天气泡) */}
        <div className="bg-stone-50 rounded-2xl p-4 mb-4 relative shadow-inner"
          style={{ borderWidth: '1px', borderColor: '#f5f5f4' }}
        >
          <div className="absolute -top-2 left-6 w-4 h-4 bg-stone-50 rotate-45"
            style={{ borderTop: '1px solid #f5f5f4', borderLeft: '1px solid #f5f5f4' }}
          />

          {isWorking ? (
            <>
              <div className="mb-3 bg-white p-2.5 rounded-xl shadow-sm flex items-center justify-between"
                style={{ borderWidth: '1px', borderColor: '#f5f5f4' }}
              >
                <div className="flex items-center gap-2">
                  <Sparkles className="animate-spin h-4 w-4 text-amber-400" />
                  <span className="text-stone-600 text-xs font-bold">fetch_data_api</span>
                </div>
                <span className="text-amber-500 font-bold text-xs">{elapsed}s</span>
              </div>
              <div className="text-stone-600 text-xs leading-relaxed font-medium">
                正在分析目标网页结构...<br />等我抓取一下数据哦！
              </div>
            </>
          ) : (
            <div className="text-stone-500 text-xs leading-relaxed font-medium text-center py-2">
              待命中... 随时准备出发！
            </div>
          )}
        </div>

        {/* 进度条 */}
        <div>
          <div className="flex justify-between text-[11px] font-bold mb-2">
            <span className="text-stone-400 flex items-center gap-1">
              <Heart className="w-3 h-3 text-rose-400" /> 进化能量
            </span>
            <span className={percent > 90 ? 'text-rose-500 animate-pulse' : 'text-stone-500'}>
              {data.xp} / {data.maxXp}
            </span>
          </div>
          <div className="w-full bg-stone-100 rounded-full h-2.5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${percent}%`, backgroundColor: theme.barColor }}
            />
          </div>
        </div>
      </div>

    </div>
  )
}
