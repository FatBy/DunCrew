/**
 * SkillTreeView - 暗物质引擎 + 极光光晕 + Canvas 彩色星尘
 *
 * 核心: 深色毛玻璃暗物质球体，承载 LLM 生成的能力总结
 * 光晕: 紫青色弥散极光 (fuchsia → indigo → cyan)
 * 星尘: Canvas 粒子系统，彩色星点宽幅椭圆轨道环绕
 * 交互: hover 停止旋转 + 点击弹出详情气泡
 */

import { useEffect, useMemo, useRef, useState, useLayoutEffect, useCallback } from 'react'
import { Network, Sparkles, X, Loader2, RefreshCw, Info } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useStore } from '@/store'
import { useT, tt } from '@/i18n'
import { SkillDetailCard } from '@/components/houses/skill/SkillDetailCard'
import { SkillDetailsDrawer } from '@/components/houses/skill/SkillDetailsDrawer'
import { mapSkillToUIModel } from '@/utils/skillsHouseMapper'
import type { SkillNode, DunEntity } from '@/types'
import type { StructuredSkillAnalysis } from '@/store/slices/channelsSlice'

// ── 粒子数据结构 ──
interface Particle {
  id: string
  name: string
  description?: string
  category?: string
  status?: string
  angle: number
  speed: number
  baseSpeed: number
  radiusX: number
  radiusY: number
  tilt: number
  color: string
  size: number
  alpha: number
  active: boolean
}

interface ParticleScreenPos {
  id: string
  name: string
  description?: string
  category?: string
  status?: string
  sx: number
  sy: number
}

// 基于技能名生成 hue
function skillHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return Math.abs(hash % 360)
}

// 静态回退摘要（LLM 未配置或调用失败时使用）
function fallbackSummary(skills: SkillNode[]): string {
  if (skills.length === 0) return tt('skill.engine_idle')
  const active = skills.filter(s => s.unlocked || s.status === 'active')
  if (active.length === 0) return tt('skill.loaded_inactive').replace('{0}', String(skills.length))
  return tt('skill.mounted_active').replace('{0}', String(active.length)).replace('{1}', String(skills.length))
}

// 域覆盖颜色映射
function coverageColor(coverage: string): string {
  switch (coverage) {
    case 'strong': return 'bg-emerald-400'
    case 'moderate': return 'bg-amber-400'
    case 'weak': return 'bg-orange-400'
    default: return 'bg-stone-300'
  }
}

function coverageLabel(coverage: string): string {
  switch (coverage) {
    case 'strong': return tt('skill.coverage_strong')
    case 'moderate': return tt('skill.coverage_moderate')
    case 'weak': return tt('skill.coverage_weak')
    default: return tt('skill.coverage_missing')
  }
}

export function SkillTreeView() {
  const t = useT()
  const skills = useStore((s) => s.skills)
  const duns = useStore((s) => s.duns)
  const openClawSkills = useStore((s) => s.openClawSkills)
  const skillEnvValues = useStore((s) => s.skillEnvValues)
  const setSkillEnvValue = useStore((s) => s.setSkillEnvValue)

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlePosRef = useRef<ParticleScreenPos[]>([])
  const hoveredRef = useRef<string | null>(null)
  const pausedRef = useRef(false)
  const selectedIdRef = useRef<string | null>(null)

  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 })
  const [tooltip, setTooltip] = useState<{ name: string; desc?: string; x: number; y: number } | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<ParticleScreenPos | null>(null)
  const [showSummaryPopup, setShowSummaryPopup] = useState(false)
  const [showScoreTooltip, setShowScoreTooltip] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  // ── LLM 摘要（从 store 读取持久化数据） ──
  const skillAnalysis = useStore((s) => s.skillAnalysis)
  const shouldRefresh = useStore((s) => s.shouldRefreshSkillAnalysis)
  const generateAnalysis = useStore((s) => s.generateSkillAnalysis)

  // 自动触发分析（仅在需要刷新时）
  useEffect(() => {
    if (skills.length > 0 && shouldRefresh()) {
      generateAnalysis()
    }
  }, [skills.length, shouldRefresh, generateAnalysis])

  const summaryLoading = skillAnalysis.loading
  const structuredAnalysis: StructuredSkillAnalysis | null = skillAnalysis.structured
  const displaySummary = structuredAnalysis?.oneLiner
    || skillAnalysis.summary
    || fallbackSummary(skills)

  // ── 容器尺寸监听 ──
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // ── 聚合评分 ──
  const avgScore = useMemo(() => {
    const arr: DunEntity[] = Array.from(duns.values())
    if (arr.length === 0) return 0
    const total = arr.reduce((s, n) => s + (n.scoring?.score ?? 0), 0)
    return Math.round(total / arr.length)
  }, [duns])

  const activeCount = useMemo(() => skills.filter(s => s.unlocked || s.status === 'active').length, [skills])

  // ── 选中时冻结粒子 ──
  useEffect(() => {
    selectedIdRef.current = selectedSkill?.id ?? null
    if (selectedSkill) {
      pausedRef.current = true
    }
  }, [selectedSkill])

  // ── 命中检测 ──
  const findNearest = useCallback((clientX: number, clientY: number): ParticleScreenPos | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    let nearest: ParticleScreenPos | null = null
    let minDist = 25
    for (const p of particlePosRef.current) {
      const dx = p.sx - mx
      const dy = p.sy - my
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist) {
        minDist = dist
        nearest = p
      }
    }
    return nearest
  }, [])

  // 节流：mousemove 碰撞检测间隔（避免每像素都遍历 161 个粒子）
  const lastMoveRef = useRef(0)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const now = performance.now()
    if (now - lastMoveRef.current < 32) return  // ~30fps 检测即可
    lastMoveRef.current = now

    const hit = findNearest(e.clientX, e.clientY)
    const canvas = canvasRef.current
    if (canvas) canvas.style.cursor = hit ? 'pointer' : 'default'
    pausedRef.current = !!hit || selectedIdRef.current !== null
    const hitId = hit?.id ?? null
    if (hitId !== hoveredRef.current) {
      hoveredRef.current = hitId
      if (hit) {
        const rect = canvas!.getBoundingClientRect()
        setTooltip({ name: hit.name, desc: hit.description, x: hit.sx + rect.left, y: hit.sy + rect.top })
      } else {
        setTooltip(null)
      }
    }
  }, [findNearest])

  const handleMouseLeave = useCallback(() => {
    hoveredRef.current = null
    pausedRef.current = selectedIdRef.current !== null
    setTooltip(null)
    if (canvasRef.current) canvasRef.current.style.cursor = 'default'
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const hit = findNearest(e.clientX, e.clientY)
    if (hit) {
      setSelectedSkill(hit)
      selectedIdRef.current = hit.id
      pausedRef.current = true
    } else {
      setSelectedSkill(null)
      selectedIdRef.current = null
    }
  }, [findNearest])

  // ── Canvas 粒子动画 ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf: number
    let time = 0

    const src = skills.length > 0
      ? skills
      : Array.from({ length: 24 }, (_, i) => ({
          id: `ph-${i}`, name: `Skill ${i}`, unlocked: Math.random() > 0.5,
          status: 'inactive' as const, description: 'Placeholder skill',
          category: 'general', x: 0, y: 0, level: 0, dependencies: [],
        }))

    const particles: Particle[] = src.map((skill, i) => {
      const isActive = skill.unlocked || skill.status === 'active'
      const h = skillHue(skill.name || `s${i}`)
      const spd = (isActive ? 0.005 : 0.002) * (Math.random() * 0.4 + 0.8)
      return {
        id: skill.id || `p-${i}`,
        name: skill.name || `Skill ${i}`,
        description: skill.description,
        category: skill.category,
        status: skill.status,
        angle: (Math.PI * 2 * i) / src.length,
        speed: spd,
        baseSpeed: spd,
        radiusX: 100,
        radiusY: 100,
        // 小幅倾斜 ±30°，避免轨道旋转导致溢出
        tilt: (Math.random() - 0.5) * Math.PI / 3,
        color: isActive
          ? `hsla(${h}, 80%, 60%, 1)`
          : `hsla(${h}, 30%, 55%, 0.4)`,
        size: isActive ? Math.random() * 2.5 + 2.5 : Math.random() * 1.5 + 1,
        alpha: isActive ? 0.95 : 0.4,
        active: isActive,
      }
    })

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // 用 X/Y 各自半轴独立计算轨道，粒子充分展开
      const halfW = rect.width / 2
      const halfH = rect.height / 2
      const coreRadius = 120  // 核心视觉半径
      const minOrbitX = coreRadius + 30
      const minOrbitY = coreRadius + 30
      const maxOrbitX = halfW - 15
      const maxOrbitY = halfH - 15

      particles.forEach(p => {
        const t = p.active ? (Math.random() * 0.5 + 0.2) : (Math.random() * 0.35 + 0.55)
        p.radiusX = minOrbitX + (maxOrbitX - minOrbitX) * t
        p.radiusY = minOrbitY + (maxOrbitY - minOrbitY) * t * (Math.random() * 0.3 + 0.6)
      })
    }
    resize()
    window.addEventListener('resize', resize)

    const render = () => {
      time += 0.006
      const w = canvas.width / (window.devicePixelRatio || 1)
      const h = canvas.height / (window.devicePixelRatio || 1)
      const cx = w / 2
      const cy = h / 2

      ctx.clearRect(0, 0, w, h)

      // 极光光晕
      const breath = Math.sin(time * 0.8) * 0.08 + 1
      const coreR = Math.min(w, h) * 0.12

      const g1 = ctx.createRadialGradient(cx - 10, cy - 10, coreR * 0.5, cx - 10, cy - 10, coreR * 4 * breath)
      g1.addColorStop(0, 'rgba(217,70,239,0.12)')
      g1.addColorStop(0.4, 'rgba(129,140,248,0.08)')
      g1.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g1
      ctx.fillRect(0, 0, w, h)

      const g2 = ctx.createRadialGradient(cx + 15, cy + 10, coreR * 0.3, cx + 15, cy + 10, coreR * 3.5 * breath)
      g2.addColorStop(0, 'rgba(34,211,238,0.1)')
      g2.addColorStop(0.5, 'rgba(99,102,241,0.05)')
      g2.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g2
      ctx.fillRect(0, 0, w, h)

      // 粒子
      const positions: ParticleScreenPos[] = []
      const isPaused = pausedRef.current || selectedIdRef.current !== null

      particles.forEach(p => {
        if (isPaused) {
          p.speed = Math.max(0, p.speed - 0.0005)
        } else {
          p.speed = Math.min(p.baseSpeed, p.speed + 0.0002)
        }

        p.angle += p.speed
        const ux = Math.cos(p.angle) * p.radiusX
        const uy = Math.sin(p.angle) * p.radiusY
        const cosT = Math.cos(p.tilt)
        const sinT = Math.sin(p.tilt)
        const x = ux * cosT - uy * sinT
        const y = ux * sinT + uy * cosT
        const z = Math.sin(p.angle)

        const pScale = 1 + z * 0.35
        const alpha = p.alpha * (0.5 + z * 0.5)

        const sx = cx + x
        const sy = cy + y
        positions.push({ id: p.id, name: p.name, description: p.description, category: p.category, status: p.status, sx, sy })

        const isHovered = hoveredRef.current === p.id
        const finalSize = p.size * pScale * (isHovered ? 3 : 1)

        // 活跃星点外发光 — 用简单透明圆替代 RadialGradient
        if (p.active) {
          ctx.beginPath()
          ctx.arc(sx, sy, finalSize * 3, 0, Math.PI * 2)
          ctx.fillStyle = p.color.replace(/[\d.]+\)$/, '0.12)')
          ctx.globalAlpha = 0.7
          ctx.fill()
        }

        // hovered 光环
        if (isHovered) {
          ctx.beginPath()
          ctx.arc(sx, sy, finalSize + 6, 0, Math.PI * 2)
          ctx.strokeStyle = 'rgba(255,255,255,0.4)'
          ctx.lineWidth = 1.5
          ctx.globalAlpha = 0.8
          ctx.stroke()
        }

        // 星点本体
        ctx.beginPath()
        ctx.arc(sx, sy, Math.max(0.8, finalSize), 0, Math.PI * 2)
        ctx.fillStyle = isHovered ? '#e879f9' : p.color
        ctx.globalAlpha = isHovered ? 1 : Math.max(0.1, alpha)
        ctx.fill()

        // 随机能量连线 (降低频率)
        if (p.active && Math.random() > 0.997) {
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(cx, cy)
          ctx.strokeStyle = 'rgba(192,132,252,0.2)'
          ctx.lineWidth = 0.5
          ctx.globalAlpha = 0.3
          ctx.stroke()
        }
      })

      particlePosRef.current = positions
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(render)
    }
    render()

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(raf)
    }
  }, [skills])

  const cx = containerSize.w / 2
  const cy = containerSize.h / 2

  // 查找完整 OpenClawSkill（含 requires/inputs 等）
  const selectedOpenClaw = useMemo(() => {
    if (!selectedSkill) return null
    return openClawSkills.find(s =>
      s.name === selectedSkill.id
      || s.name?.toLowerCase() === selectedSkill.name?.toLowerCase()
      || s.toolName === selectedSkill.id
    ) || null
  }, [selectedSkill, openClawSkills])

  // 稳定化 envValues 引用（避免每帧创建新 {} 触发子组件重渲染）
  const emptyEnv = useMemo<Record<string, string>>(() => ({}), [])
  const currentEnvValues = selectedOpenClaw
    ? skillEnvValues[selectedOpenClaw.name] || emptyEnv
    : emptyEnv

  // 转换为 UISkillModel 供 SkillDetailCard 使用
  const selectedUIModel = useMemo(() =>
    selectedOpenClaw ? mapSkillToUIModel(selectedOpenClaw, currentEnvValues) : null,
    [selectedOpenClaw, currentEnvValues]
  )

  const handleEnvChange = useCallback((key: string, val: string) => {
    if (selectedOpenClaw) setSkillEnvValue(selectedOpenClaw.name, key, val)
  }, [selectedOpenClaw, setSkillEnvValue])

  const handleOpenDrawer = useCallback(() => setDrawerOpen(true), [])
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), [])
  const handleCloseCard = useCallback(() => {
    setSelectedSkill(null)
    selectedIdRef.current = null
  }, [])

  return (
    <div className="h-full relative overflow-hidden">
      {/* ── 全幅动画容器 ── */}
      <div
        ref={wrapRef}
        className="absolute inset-0 rounded-3xl"
        style={{
          backgroundColor: '#fefaf6',
          backgroundImage: 'radial-gradient(circle at center, rgba(224,231,255,0.3) 0%, transparent 70%)',
        }}
      >
        {/* 点阵纹理 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden pointer-events-none">
          <div
            className="absolute inset-0 opacity-[0.3]"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(203,213,225,0.6) 1px, transparent 1px)',
              backgroundSize: '40px 40px',
            }}
          />
        </div>

        {/* Canvas 粒子层 — will-change 提示 GPU 保留合成层 */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full z-[5]"
          style={{ willChange: 'transform' }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        />

        {/* ── 极光光晕 + 暗物质核心 ── */}
        <div
          className="absolute z-20 flex flex-col items-center pointer-events-none"
          style={{ left: cx, top: cy, transform: 'translate(-50%, -50%)' }}
        >
          {/* 极光光晕 — 用预扩散渐变替代 filter:blur(60px)，避免 GPU 每帧重算高斯模糊 */}
          <div className="absolute w-[520px] h-[520px] rounded-full pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse at center, rgba(217,70,239,0.08) 0%, rgba(99,102,241,0.06) 25%, rgba(34,211,238,0.04) 45%, transparent 70%)',
              transform: 'translate(-50%, -50%)',
              left: '50%',
              top: '50%',
            }}
          />

          {/* 暗物质核心球体 — 点击展开完整摘要 */}
          <div
            className="relative w-64 h-64 rounded-full flex flex-col items-center justify-center overflow-hidden cursor-pointer pointer-events-auto"
            onClick={() => setShowSummaryPopup(prev => !prev)}
            style={{
              background: 'radial-gradient(ellipse at 30% 25%, rgba(51,65,85,0.95) 0%, rgba(15,23,42,0.98) 100%)',
              boxShadow: [
                'inset -8px -8px 30px rgba(139,92,246,0.15)',
                'inset 4px 4px 20px rgba(255,255,255,0.03)',
                '0 0 60px rgba(139,92,246,0.15)',
                '0 0 120px rgba(34,211,238,0.08)',
                '0 25px 60px rgba(0,0,0,0.25)',
              ].join(', '),
            }}
          >
            <div className="absolute inset-0 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(ellipse at 30% 20%, rgba(255,255,255,0.08) 0%, transparent 50%)' }}
            />
            <div className="absolute inset-0 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(ellipse at 70% 80%, rgba(139,92,246,0.1) 0%, transparent 60%)' }}
            />

            <div className="relative z-10 flex flex-col items-center justify-center text-center px-6 py-3">
              {summaryLoading ? (
                <Loader2 className="w-5 h-5 text-cyan-400 mb-2 animate-spin" />
              ) : (
                <Network className="w-5 h-5 text-cyan-400 mb-2" />
              )}
              <span className="text-[10px] font-black text-slate-200 tracking-wider mb-2">DunCrew CORE</span>
              <p className="text-[11px] text-stone-400 leading-[1.7] line-clamp-4 max-w-[180px]">
                {summaryLoading ? t('skill.analyzing') : displaySummary}
              </p>
            </div>

            {/* 脉冲环 — animate-pulse 替代 animate-ping（ping 在大元素上每帧触发 layout） */}
            <div className="absolute rounded-full opacity-10 animate-pulse"
              style={{ inset: -16, border: '2px solid rgba(139,92,246,0.3)' }}
            />
          </div>

          {/* 评分胶囊 — 点击弹出说明气泡 */}
          <div className="mt-4 relative">
            <button
              onClick={(e) => { e.stopPropagation(); setShowScoreTooltip(prev => !prev) }}
              className="px-5 py-1.5 bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-full shadow-lg hover:border-cyan-500/50 transition-colors pointer-events-auto"
            >
              <span className="text-[10px] font-black text-cyan-400 uppercase tracking-widest">
                SCORE {avgScore}
              </span>
            </button>

            {/* SCORE 说明气泡 */}
            {showScoreTooltip && (
              <div
                className="absolute top-full mt-2 left-1/2 -translate-x-1/2 w-72 bg-white/95 backdrop-blur-xl border border-stone-200 rounded-xl shadow-lg z-[120] p-4 pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-cyan-500" />
                    <span className="text-xs font-black text-stone-700">{t('skill.score_title')}</span>
                  </div>
                  <button onClick={() => setShowScoreTooltip(false)} className="w-5 h-5 rounded-md bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors">
                    <X className="w-3 h-3 text-stone-400" />
                  </button>
                </div>
                <div className="space-y-2 text-[11px] text-stone-500 leading-relaxed">
                  <p><strong className="text-stone-700">SCORE</strong> {t('skill.score_desc')}</p>
                  <div className="space-y-1">
                    <p>• <strong className="text-emerald-600">{t('skill.score_success')}</strong></p>
                    <p>• <strong className="text-red-500">{t('skill.score_fail')}</strong></p>
                    <p>• {t('skill.score_initial')}</p>
                  </div>
                  <div className="pt-1.5 border-t border-stone-100 text-[10px] text-stone-400">
                    <p>{t('skill.score_meaning')}</p>
                    {(() => {
                      const dunArr: DunEntity[] = Array.from(duns.values())
                      const totalRuns = dunArr.reduce((s, n) => s + (n.scoring?.totalRuns ?? 0), 0)
                      const totalSuccess = dunArr.reduce((s, n) => s + (n.scoring?.successCount ?? 0), 0)
                      return totalRuns > 0 ? (
                        <p className="mt-1">{t('skill.total_runs').replace('{0}', String(totalRuns)).replace('{1}', String(totalSuccess)).replace('{2}', String(Math.round(totalSuccess / totalRuns * 100)))}</p>
                      ) : (
                        <p className="mt-1">{t('skill.no_runs')}</p>
                      )
                    })()}
                  </div>
                </div>
                <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 bg-white border-l border-t border-stone-200 rotate-45" />
              </div>
            )}
          </div>
        </div>

        {/* ── hover Tooltip ── */}
        {tooltip && !selectedSkill && (
          <div
            className="fixed px-3 py-1.5 bg-white border border-stone-200 rounded-lg shadow-lg z-50 pointer-events-none"
            style={{ left: tooltip.x, top: tooltip.y - 48, transform: 'translateX(-50%)' }}
          >
            <p className="text-xs font-bold text-stone-800 whitespace-nowrap">{tooltip.name}</p>
            {tooltip.desc && (
              <p className="text-[10px] text-stone-400 font-normal mt-0.5 max-w-[200px] truncate">{tooltip.desc}</p>
            )}
          </div>
        )}

        {/* ── 点击详情卡片 ── */}
        <AnimatePresence>
          {selectedSkill && selectedUIModel && (
            <SkillDetailCard
              skill={selectedUIModel}
              x={selectedSkill.sx}
              y={selectedSkill.sy}
              envValues={currentEnvValues}
              onEnvChange={handleEnvChange}
              onOpenDrawer={handleOpenDrawer}
              onClose={handleCloseCard}
            />
          )}
        </AnimatePresence>

        {/* ── 配置抽屉 ── */}
        <SkillDetailsDrawer
          skill={selectedOpenClaw || null}
          isOpen={drawerOpen}
          envValues={currentEnvValues}
          onEnvChange={handleEnvChange}
          onClose={handleCloseDrawer}
        />

        {/* 空状态 */}
        {skills.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
            <div className="text-center">
              <Sparkles className="w-8 h-8 text-stone-400 mx-auto mb-2" />
              <p className="text-sm text-stone-400">{t('skill.loading')}</p>
            </div>
          </div>
        )}

        {/* ── 结构化分析弹窗（居中大气泡，点击核心球体展开） ── */}
        <AnimatePresence>
          {showSummaryPopup && (
            <div className="absolute inset-0 z-[100] flex items-center justify-center pointer-events-auto">
              {/* 遮罩 */}
              <div
                className="absolute inset-0 bg-black/10 backdrop-blur-[2px]"
                onClick={() => setShowSummaryPopup(false)}
              />
              {/* 弹窗主体 */}
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 10 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="relative w-[420px] max-h-[70vh] bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_25px_60px_rgba(0,0,0,0.15)] overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                {/* 标题栏 */}
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-stone-100 bg-gradient-to-r from-cyan-50/50 to-purple-50/50">
                  <div className="flex items-center gap-2">
                    <Network className="w-4 h-4 text-cyan-500" />
                    <span className="text-sm font-black text-stone-700">{t('skill.profile_title')}</span>
                    <span className="text-[10px] text-stone-400 bg-stone-100 px-2 py-0.5 rounded-full">
                      {skills.length} {t('skill.skills_unit')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => generateAnalysis('full')}
                      disabled={summaryLoading}
                      className="w-7 h-7 rounded-lg bg-stone-100 hover:bg-cyan-50 flex items-center justify-center transition-colors disabled:opacity-50"
                      title={t('skill.refresh')}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 text-stone-500 ${summaryLoading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={() => setShowSummaryPopup(false)}
                      className="w-7 h-7 rounded-lg bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors"
                    >
                      <X className="w-3.5 h-3.5 text-stone-500" />
                    </button>
                  </div>
                </div>

                {/* 内容区 */}
                <div className="px-5 py-4 overflow-y-auto max-h-[calc(70vh-120px)]">
                  {summaryLoading ? (
                    <div className="flex flex-col items-center justify-center py-10 gap-3">
                      <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                      <p className="text-xs text-stone-400">{t('skill.analyzing')}</p>
                    </div>
                  ) : structuredAnalysis ? (
                    <div className="space-y-4">
                      {/* 核心优势 */}
                      {structuredAnalysis.coreStrengths && (
                        <div>
                          <h4 className="text-[10px] font-black text-emerald-500 uppercase tracking-widest mb-1.5">{t('skill.core_strengths')}</h4>
                          <p className="text-xs text-stone-600 leading-relaxed">{structuredAnalysis.coreStrengths}</p>
                        </div>
                      )}

                      {/* 能力域覆盖 */}
                      <div>
                        <h4 className="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-2">{t('skill.domain_coverage')}</h4>
                        <div className="grid grid-cols-2 gap-2">
                          {structuredAnalysis.domains.map(domain => (
                            <div key={domain.name} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stone-50 border border-stone-100">
                              <div className={`w-2 h-2 rounded-full flex-shrink-0 ${coverageColor(domain.coverage)}`} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center justify-between">
                                  <p className="text-xs font-bold text-stone-700 truncate">{domain.name}</p>
                                  <span className="text-[10px] text-stone-400 ml-1 flex-shrink-0">{t('skill.domain_count').replace('{0}', String(domain.skillCount))}</span>
                                </div>
                                <p className="text-[10px] text-stone-400">
                                  {coverageLabel(domain.coverage)}
                                  {domain.highlights.length > 0 && ` · ${domain.highlights.slice(0, 2).join(', ')}`}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* 薄弱领域 */}
                      {structuredAnalysis.weaknesses && (
                        <div>
                          <h4 className="text-[10px] font-black text-amber-500 uppercase tracking-widest mb-1.5">{t('skill.weaknesses')}</h4>
                          <p className="text-xs text-stone-600 leading-relaxed">{structuredAnalysis.weaknesses}</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-8">
                      <p className="text-xs text-stone-400">{displaySummary}</p>
                      <button
                        onClick={() => generateAnalysis('full')}
                        className="mt-3 px-4 py-1.5 text-xs text-cyan-500 bg-cyan-50 rounded-lg hover:bg-cyan-100 transition-colors"
                      >
                        {t('skill.generate_analysis')}
                      </button>
                    </div>
                  )}
                </div>

                {/* 底栏 */}
                <div className="px-5 py-3 border-t border-stone-100 bg-stone-50/50 flex items-center justify-between">
                  <span className="text-[10px] text-stone-400">
                    {t('skill.skills_active').replace('{0}', String(skills.length)).replace('{1}', String(activeCount))}
                  </span>
                  <div className="flex items-center gap-3">
                    {avgScore > 0 && (
                      <span className="text-[10px] text-cyan-500 font-bold">SCORE {avgScore}</span>
                    )}
                    {skillAnalysis.timestamp > 0 && (
                      <span className="text-[10px] text-stone-300">
                        {new Date(skillAnalysis.timestamp).toLocaleDateString('zh-CN')}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
