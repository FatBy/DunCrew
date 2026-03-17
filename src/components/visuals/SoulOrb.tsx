import { useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import type { SoulIdentity, SkillNode } from '@/types'

interface SoulOrbProps {
  identity?: SoulIdentity
  skills?: SkillNode[]
  complexity?: number       // 0-100
  activity?: number         // 0-1
  // 交互 props
  interactive?: boolean
  onParticleClick?: (skillId: string, pos: { x: number; y: number }) => void
  onParticleHover?: (skillId: string | null, x: number, y: number) => void
  pulsingSkillIds?: string[]
  centerContent?: React.ReactNode
}

interface Particle {
  id: string
  x: number; y: number; z: number
  angle: number
  speed: number
  radiusX: number; radiusY: number
  tilt: number
  color: string
  size: number
  alpha: number
  active: boolean
}

// 屏幕坐标缓存 (每帧更新)
interface ParticleScreenPos {
  id: string
  sx: number
  sy: number
}

export function SoulOrb({
  identity, skills = [], complexity = 50, activity = 0.5,
  interactive = false, onParticleClick, onParticleHover,
  pulsingSkillIds, centerContent,
}: SoulOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlePosRef = useRef<ParticleScreenPos[]>([])
  const hoveredRef = useRef<string | null>(null)
  const pulseStartRef = useRef<Map<string, number>>(new Map())

  // 基于名字生成配色
  const getColors = (name: string) => {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
    const h = Math.abs(hash % 360)
    return {
      core: `hsla(${h}, 85%, 60%, 1)`,
      glow: `hsla(${h}, 90%, 70%, 0.5)`,
      skillActive: `hsla(${h}, 95%, 85%, 1)`,
      skillInactive: `hsla(${(h + 180) % 360}, 10%, 40%, 0.2)`,
      pulseColor: `hsla(${h}, 100%, 90%, 1)`,
    }
  }

  // 命中检测
  const findNearestParticle = useCallback((clientX: number, clientY: number): ParticleScreenPos | null => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    let nearest: ParticleScreenPos | null = null
    let minDist = 20 // 命中阈值
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
    if (!interactive) return
    const hit = findNearestParticle(e.clientX, e.clientY)
    const canvas = canvasRef.current
    if (canvas) canvas.style.cursor = hit ? 'pointer' : 'default'
    const hitId = hit?.id ?? null
    if (hitId !== hoveredRef.current) {
      hoveredRef.current = hitId
      onParticleHover?.(hitId, hit?.sx ?? 0, hit?.sy ?? 0)
    }
  }, [interactive, findNearestParticle, onParticleHover])

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!interactive) return
    const hit = findNearestParticle(e.clientX, e.clientY)
    if (hit) {
      onParticleClick?.(hit.id, { x: hit.sx, y: hit.sy })
    }
  }, [interactive, findNearestParticle, onParticleClick])

  // 脉冲 ID 变化时记录开始时间
  useEffect(() => {
    if (!pulsingSkillIds) return
    const now = performance.now()
    for (const id of pulsingSkillIds) {
      if (!pulseStartRef.current.has(id)) {
        pulseStartRef.current.set(id, now)
      }
    }
    // 清除不在列表中的
    for (const id of pulseStartRef.current.keys()) {
      if (!pulsingSkillIds.includes(id)) {
        pulseStartRef.current.delete(id)
      }
    }
  }, [pulsingSkillIds])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number
    let time = 0
    const colors = getColors(identity?.name || 'Unknown')

    const sourceData = skills.length > 0 ? skills : Array.from({ length: 20 }).map((_, i) => ({ 
      id: `dummy-${i}`, unlocked: Math.random() > 0.7, status: 'inactive' 
    })) as any[]

    const particles: Particle[] = sourceData.map((skill, i) => {
      const isActive = skill.unlocked || skill.status === 'active'
      const baseR = 100
      return {
        id: skill.id || skill.name || `p-${i}`,
        x: 0, y: 0, z: 0,
        angle: (Math.PI * 2 * i) / (sourceData.length || 1), 
        speed: (isActive ? 0.008 : 0.003) * (Math.random() * 0.5 + 0.8), 
        radiusX: baseR,
        radiusY: baseR,
        tilt: Math.random() * Math.PI * 2, 
        color: isActive ? colors.skillActive : colors.skillInactive,
        size: isActive ? Math.random() * 2 + 1.5 : Math.random() + 0.5,
        alpha: isActive ? 0.9 : 0.3,
        active: isActive,
      }
    })

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
      const minDim = Math.min(rect.width, rect.height)
      particles.forEach(p => {
        const range = p.active ? 0.28 : 0.45
        const r = minDim * (range + Math.random() * 0.1)
        p.radiusX = r
        p.radiusY = r * (Math.random() * 0.3 + 0.6) 
      })
    }
    
    resize()
    window.addEventListener('resize', resize)

    const render = () => {
      const speedMult = 1 + activity * 2
      time += 0.01 * speedMult
      const now = performance.now()
      
      const w = canvas.width / (window.devicePixelRatio || 1)
      const h = canvas.height / (window.devicePixelRatio || 1)
      const cx = w / 2
      const cy = h / 2
      const coreR = Math.min(w, h) * 0.16

      ctx.clearRect(0, 0, w, h)

      // Layer 1: 核心光晕
      const breath = Math.sin(time * 1.5) * 0.05 + 1
      const grad = ctx.createRadialGradient(cx, cy, coreR * 0.5, cx, cy, coreR * 3 * breath)
      grad.addColorStop(0, colors.glow)
      grad.addColorStop(0.5, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, h)

      // Layer 2: 核心实体
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2)
      ctx.clip()
      
      const coreBg = ctx.createRadialGradient(cx - coreR*0.3, cy - coreR*0.3, 0, cx, cy, coreR)
      coreBg.addColorStop(0, `hsla(0, 0%, 15%, 1)`) 
      coreBg.addColorStop(1, `hsla(0, 0%, 5%, 1)`)
      ctx.fillStyle = coreBg
      ctx.fill()
      
      ctx.restore()

      // Layer 3: 技能粒子
      const screenPositions: ParticleScreenPos[] = []

      particles.forEach(p => {
        p.angle += p.speed * speedMult
        
        const ux = Math.cos(p.angle) * p.radiusX
        const uy = Math.sin(p.angle) * p.radiusY
        const cosT = Math.cos(p.tilt)
        const sinT = Math.sin(p.tilt)
        const x = ux * cosT - uy * sinT
        const y = ux * sinT + uy * cosT
        const z = Math.sin(p.angle) 
        
        const pScale = 1 + z * 0.25
        const alpha = p.alpha * (0.6 + z * 0.4)
        
        const sx = cx + x
        const sy = cy + y
        screenPositions.push({ id: p.id, sx, sy })

        // 脉冲效果
        const pulseStart = pulseStartRef.current.get(p.id)
        let extraScale = 0
        let isPulsing = false
        if (pulseStart) {
          const elapsed = (now - pulseStart) / 1000
          if (elapsed < 2) {
            isPulsing = true
            const decay = 1 - elapsed / 2
            extraScale = Math.sin(elapsed * 8 * Math.PI) * 1.5 * decay
          }
        }

        // hover 高亮
        const isHovered = interactive && hoveredRef.current === p.id
        const finalSize = p.size * pScale * (1 + extraScale) * (isHovered ? 2 : 1)

        if (isPulsing) {
          // 脉冲光晕
          const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, finalSize * 3)
          glowGrad.addColorStop(0, colors.pulseColor)
          glowGrad.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.beginPath()
          ctx.arc(sx, sy, finalSize * 3, 0, Math.PI * 2)
          ctx.fillStyle = glowGrad
          ctx.globalAlpha = 0.4 * (1 - (now - (pulseStart || 0)) / 2000)
          ctx.fill()
        }

        // 粒子本体
        ctx.beginPath()
        ctx.arc(sx, sy, Math.max(0.5, finalSize), 0, Math.PI * 2)
        ctx.fillStyle = isPulsing ? colors.pulseColor : (isHovered ? colors.skillActive : p.color)
        ctx.globalAlpha = Math.max(0.05, isHovered ? 1 : alpha)
        ctx.fill()
        
        // 能量连接线
        if (p.active && Math.random() > 0.99) {
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.lineTo(cx, cy)
          ctx.strokeStyle = colors.skillActive
          ctx.lineWidth = 0.5
          ctx.globalAlpha = 0.3
          ctx.stroke()
        }
      })

      particlePosRef.current = screenPositions
      ctx.globalAlpha = 1

      animationFrameId = requestAnimationFrame(render)
    }
    render()

    return () => {
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animationFrameId)
    }
  }, [identity, skills, complexity, activity])

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full block"
        onMouseMove={interactive ? handleMouseMove : undefined}
        onClick={interactive ? handleClick : undefined}
        onMouseLeave={interactive ? () => {
          hoveredRef.current = null
          onParticleHover?.(null, 0, 0)
          if (canvasRef.current) canvasRef.current.style.cursor = 'default'
        } : undefined}
      />
      
      {/* 球心内容 */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
        {centerContent ? (
          <div className="pointer-events-auto z-10">{centerContent}</div>
        ) : (
          <div className="text-center pt-48 z-10 mix-blend-screen opacity-90">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1.5 }}
            >
              <h2 className="text-4xl font-black text-stone-800 tracking-[0.2em] uppercase blur-[0.5px] drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">
                {identity?.name || 'GENESIS'}
              </h2>
              <div className="flex items-center justify-center gap-3 mt-2 opacity-70">
                <span className="h-[1px] w-8 bg-cyan-400"></span>
                <p className="text-[13px] font-mono text-cyan-200 uppercase tracking-widest">
                  Soul Core Active
                </p>
                <span className="h-[1px] w-8 bg-cyan-400"></span>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </div>
  )
}
