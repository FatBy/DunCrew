/**
 * SkillTreeView - 暗物质引擎 + 极光光晕 + Canvas 彩色星尘
 *
 * 核心: 深色毛玻璃暗物质球体，承载 LLM 生成的能力总结
 * 光晕: 紫青色弥散极光 (fuchsia → indigo → cyan)
 * 星尘: Canvas 粒子系统，彩色星点宽幅椭圆轨道环绕
 * 交互: hover 停止旋转 + 点击弹出详情气泡
 */

import { useEffect, useMemo, useRef, useState, useLayoutEffect, useCallback } from 'react'
import { Network, Sparkles, X, Loader2 } from 'lucide-react'
import { useStore } from '@/store'
import { chat } from '@/services/llmService'
import { skillStatsService } from '@/services/skillStatsService'
import type { SkillNode } from '@/types'

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
  if (skills.length === 0) return '核心引擎待命中，等待技能模块挂载...'
  const active = skills.filter(s => s.unlocked || s.status === 'active')
  if (active.length === 0) return `已加载 ${skills.length} 项技能但均未激活。`
  return `已挂载 ${active.length}/${skills.length} 项活跃技能，能力就绪。`
}

// 构建 LLM prompt
function buildSkillPrompt(skills: SkillNode[], scoringInfo: string, statsInfo: string): string {
  const list = skills.map(s => {
    const st = s.unlocked || s.status === 'active' ? '活跃' : '未激活'
    return `- ${s.name} [${s.category || '通用'}] (${st})${s.description ? ': ' + s.description.slice(0, 60) : ''}`
  }).join('\n')

  return [
    '以下是 Agent 当前挂载的技能列表：',
    list,
    '',
    scoringInfo ? `执行数据：${scoringInfo}` : '',
    statsInfo ? `使用统计：${statsInfo}` : '',
    '',
    '请用一句简洁中文（30-60字）总结这个 Agent 能做什么和不能做什么。',
    '直接输出总结，不要加任何前缀、标点符号列表或解释。',
  ].filter(Boolean).join('\n')
}

export function SkillTreeView() {
  const skills = useStore((s) => s.skills)
  const nexuses = useStore((s) => s.nexuses)

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

  // ── LLM 摘要 ──
  const [llmSummary, setLlmSummary] = useState<string | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)

  // 稳定的 skill 指纹（仅 id+status 变化时重新请求）
  const skillKey = useMemo(() => {
    if (skills.length === 0) return ''
    return skills.map(s => `${s.id}:${s.status || ''}:${s.unlocked ? 1 : 0}`).sort().join(',')
  }, [skills])

  // 调用 LLM 生成摘要
  useEffect(() => {
    if (!skillKey || skills.length === 0) {
      setLlmSummary(null)
      return
    }

    // sessionStorage 缓存
    const cacheKey = `ddos-skill-llm-summary-${skillKey.length}-${skillKey.slice(0, 80)}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      setLlmSummary(cached)
      return
    }

    let cancelled = false
    setSummaryLoading(true)

    // 收集执行数据
    const nexusArr = Array.from(nexuses.values())
    const totalRuns = nexusArr.reduce((s, n) => s + (n.scoring?.totalRuns ?? 0), 0)
    const totalSuccess = nexusArr.reduce((s, n) => s + (n.scoring?.successCount ?? 0), 0)
    const totalFail = nexusArr.reduce((s, n) => s + (n.scoring?.failureCount ?? 0), 0)
    const scoringInfo = totalRuns > 0
      ? `共执行 ${totalRuns} 次，成功 ${totalSuccess} 次，失败 ${totalFail} 次`
      : ''

    // 收集使用统计
    const allStats = skillStatsService.getAllStats()
    const topUsed = allStats
      .filter(s => s.callCount > 0)
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 5)
    const statsInfo = topUsed.length > 0
      ? topUsed.map(s => `${s.skillId}(调用${s.callCount}次,成功${s.successCount},失败${s.failureCount})`).join('; ')
      : ''

    const prompt = buildSkillPrompt(skills, scoringInfo, statsInfo)

    chat([
      {
        role: 'system',
        content: '你是 DD-OS 的技能分析引擎。用自然语言简洁总结 Agent 的能力和限制。只输出一句话总结。',
      },
      { role: 'user', content: prompt },
    ]).then(result => {
      if (!cancelled && result) {
        const cleaned = result.trim().replace(/^["「]|["」]$/g, '')
        setLlmSummary(cleaned)
        setSummaryLoading(false)
        sessionStorage.setItem(cacheKey, cleaned)
      }
    }).catch(() => {
      if (!cancelled) setSummaryLoading(false)
    })

    return () => { cancelled = true }
  }, [skillKey, skills, nexuses])

  // 最终显示的摘要
  const displaySummary = llmSummary || fallbackSummary(skills)

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
    const arr = Array.from(nexuses.values())
    if (arr.length === 0) return 0
    const total = arr.reduce((s, n) => s + (n.scoring?.score ?? 0), 0)
    return Math.round(total / arr.length)
  }, [nexuses])

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

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
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

        // 活跃星点外发光
        if (p.active) {
          const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, finalSize * 4)
          sg.addColorStop(0, p.color.replace(/[\d.]+\)$/, '0.3)'))
          sg.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.beginPath()
          ctx.arc(sx, sy, finalSize * 4, 0, Math.PI * 2)
          ctx.fillStyle = sg
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

        // 随机能量连线
        if (p.active && Math.random() > 0.992) {
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

  const selectedFull = useMemo(() => {
    if (!selectedSkill) return null
    return skills.find(s => s.id === selectedSkill.id) || null
  }, [selectedSkill, skills])

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

        {/* Canvas 粒子层 */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full z-[5]"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onClick={handleClick}
        />

        {/* ── 极光光晕 + 暗物质核心 ── */}
        <div
          className="absolute z-20 flex flex-col items-center pointer-events-none"
          style={{ left: cx, top: cy, transform: 'translate(-50%, -50%)' }}
        >
          {/* 极光光晕 */}
          <div className="absolute w-[520px] h-[520px] rounded-full animate-pulse pointer-events-none"
            style={{
              background: 'radial-gradient(ellipse at center, rgba(217,70,239,0.2) 0%, rgba(99,102,241,0.15) 35%, rgba(34,211,238,0.1) 60%, transparent 80%)',
              filter: 'blur(60px)',
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
              <span className="text-[10px] font-black text-slate-200 tracking-wider mb-2">DD-OS CORE</span>
              <p className="text-[11px] text-stone-400 leading-[1.7] line-clamp-4 max-w-[180px]">
                {summaryLoading ? '正在分析技能矩阵...' : displaySummary}
              </p>
            </div>

            <div className="absolute rounded-full animate-ping opacity-10"
              style={{ inset: -16, border: '2px solid rgba(139,92,246,0.3)' }}
            />
          </div>

          {/* 评分胶囊 */}
          <div className="mt-4 px-5 py-1.5 bg-slate-900/80 backdrop-blur-sm border border-slate-700/50 rounded-full shadow-lg">
            <span className="text-[10px] font-black text-cyan-400 uppercase tracking-widest">
              SCORE {avgScore}
            </span>
          </div>
        </div>

        {/* ── hover Tooltip ── */}
        {tooltip && !selectedSkill && (
          <div
            className="fixed px-3 py-1.5 bg-white/95 backdrop-blur-xl border border-stone-200 rounded-lg shadow-lg z-50 pointer-events-none"
            style={{ left: tooltip.x, top: tooltip.y - 48, transform: 'translateX(-50%)' }}
          >
            <p className="text-xs font-bold text-stone-800 whitespace-nowrap">{tooltip.name}</p>
            {tooltip.desc && (
              <p className="text-[10px] text-stone-400 font-normal mt-0.5 max-w-[200px] truncate">{tooltip.desc}</p>
            )}
          </div>
        )}

        {/* ── 点击详情气泡 ── */}
        {selectedSkill && (() => {
          const bubbleW = 288
          const bubbleH = 220
          const pad = 12
          let bx = selectedSkill.sx + 16
          let by = selectedSkill.sy - bubbleH / 2
          // 右溢出 → 翻到左边
          if (bx + bubbleW + pad > containerSize.w) bx = selectedSkill.sx - bubbleW - 16
          // 左溢出兜底
          if (bx < pad) bx = pad
          if (by < pad) by = pad
          if (by + bubbleH + pad > containerSize.h) by = containerSize.h - bubbleH - pad
          return (
            <div
              className="absolute z-[100] w-72 bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.12)] overflow-hidden"
              style={{ left: bx, top: by }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50/50">
                <h3 className="text-sm font-black text-stone-800 truncate">{selectedSkill.name}</h3>
                <button
                  onClick={() => { setSelectedSkill(null); selectedIdRef.current = null }}
                  className="w-6 h-6 rounded-lg bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors pointer-events-auto"
                >
                  <X className="w-3 h-3 text-stone-500" />
                </button>
              </div>
              <div className="px-4 py-3 space-y-2">
                {selectedSkill.category && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Category</span>
                    <span className="px-1.5 py-0.5 bg-indigo-50 border border-indigo-200 rounded text-[10px] font-bold text-indigo-600">
                      {selectedSkill.category}
                    </span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Status</span>
                  <span className={`px-1.5 py-0.5 border rounded text-[10px] font-bold ${
                    selectedSkill.status === 'active'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                      : selectedSkill.status === 'error'
                      ? 'bg-red-50 border-red-200 text-red-500'
                      : 'bg-stone-50 border-stone-200 text-stone-500'
                  }`}>
                    {selectedSkill.status === 'active' ? '活跃' : selectedSkill.status === 'error' ? '异常' : '未激活'}
                  </span>
                </div>
                {selectedFull?.description ? (
                  <div>
                    <span className="text-[10px] font-black text-stone-400 uppercase tracking-widest block mb-1">Description</span>
                    <p className="text-xs text-stone-600 leading-relaxed">{selectedFull.description}</p>
                  </div>
                ) : (
                  <p className="text-xs text-stone-400 italic">暂无详细描述</p>
                )}
                {selectedFull?.version && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Version</span>
                    <span className="text-[10px] font-mono text-stone-500">{selectedFull.version}</span>
                  </div>
                )}
              </div>
            </div>
          )
        })()}

        {/* 空状态 */}
        {skills.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-30 pointer-events-none">
            <div className="text-center">
              <Sparkles className="w-8 h-8 text-stone-400 mx-auto mb-2" />
              <p className="text-sm text-stone-400">等待技能加载...</p>
            </div>
          </div>
        )}

        {/* ── 核心摘要完整弹窗（点击核心球体展开） ── */}
        {showSummaryPopup && displaySummary && (
          <div
            className="absolute z-[110] w-80 bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_20px_50px_rgba(0,0,0,0.15)] overflow-hidden"
            style={{ left: Math.max(12, cx - 160), top: cy + 150 }}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100 bg-stone-50/50">
              <div className="flex items-center gap-2">
                <Network className="w-4 h-4 text-cyan-500" />
                <span className="text-xs font-black text-stone-700">Agent 能力总结</span>
              </div>
              <button
                onClick={() => setShowSummaryPopup(false)}
                className="w-6 h-6 rounded-lg bg-stone-100 hover:bg-rose-50 flex items-center justify-center transition-colors"
              >
                <X className="w-3 h-3 text-stone-500" />
              </button>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs text-stone-600 leading-relaxed">{displaySummary}</p>
              <div className="flex items-center gap-3 mt-3 pt-2 border-t border-stone-100">
                <span className="text-[10px] text-stone-400">
                  {skills.length} 项技能 / {activeCount} 项活跃
                </span>
                {avgScore > 0 && (
                  <span className="text-[10px] text-cyan-500 font-bold">SCORE {avgScore}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
