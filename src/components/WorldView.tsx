import { useEffect, useRef, useCallback, useMemo } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '@/store'
import { GameCanvas } from '@/rendering/GameCanvas'
import { DashboardView } from '@/components/dashboard/DashboardView'

export function WorldView() {
  const worldTheme = useStore((s) => s.worldTheme)

  // Dashboard 模式: 使用 React/SVG 力导向图
  if (worldTheme === 'dashboard') {
    return <DashboardView />
  }

  // Minimalist 模式: 使用 GameCanvas 渲染引擎
  return <CanvasWorldView />
}

function CanvasWorldView() {
  const currentView = useStore((s) => s.currentView)
  const nexuses = useStore((s) => s.nexuses)
  const camera = useStore((s) => s.camera)
  const selectedNexusId = useStore((s) => s.selectedNexusId)
  const renderSettings = useStore((s) => s.renderSettings)
  const panCamera = useStore((s) => s.panCamera)
  const setZoom = useStore((s) => s.setZoom)
  const selectNexus = useStore((s) => s.selectNexus)
  const openNexusPanel = useStore((s) => s.openNexusPanel)
  const tickConstructionAnimations = useStore((s) => s.tickConstructionAnimations)

  // 执行状态追踪
  const executingNexusId = useStore((s) => s.executingNexusId)
  const executionStartTime = useStore((s) => s.executionStartTime)

  // 主题调色板
  const canvasPalette = useStore((s) => s.canvasPalette)

  // Soul 数据：通过 ref 传递避免频繁重渲染
  // 这些数据仅用于计算 energyCoreState，变化不需要触发组件重渲染
  const soulIdentityRef = useRef(useStore.getState().soulIdentity)
  const soulCoreTruthsRef = useRef(useStore.getState().soulCoreTruths)
  const soulDimensionsRef = useRef(useStore.getState().soulDimensions)
  const skillsRef = useRef(useStore.getState().skills)

  // 通过 subscribe 同步 ref，不触发重渲染
  useEffect(() => {
    const unsub = useStore.subscribe((state) => {
      soulIdentityRef.current = state.soulIdentity
      soulCoreTruthsRef.current = state.soulCoreTruths
      soulDimensionsRef.current = state.soulDimensions
      skillsRef.current = state.skills
    })
    return unsub
  }, [])

  // 保留变量名兼容下方 useMemo
  const soulIdentity = soulIdentityRef.current
  const soulCoreTruths = soulCoreTruthsRef.current
  const soulDimensions = soulDimensionsRef.current
  const skills = skillsRef.current

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<GameCanvas | null>(null)
  const isDragging = useRef(false)
  const dragMoved = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const canvasPaletteRef = useRef(canvasPalette)

  // 保持 ref 同步
  canvasPaletteRef.current = canvasPalette

  const isHouseOpen = currentView !== 'world'

  // 计算能量核心参数 (memoized)
  const energyCoreState = useMemo(() => {
    const name = soulIdentity?.name || 'GENESIS'
    const activeSkills = skills.filter(s => s.unlocked || s.status === 'active')
    return {
      name,
      skills: skills.length > 0
        ? skills.map(s => ({ id: s.id, active: s.unlocked || s.status === 'active' }))
        : [],
      complexity: Math.min(100, soulCoreTruths.length * 8 + soulDimensions.length * 4 + 20),
      activity: skills.length > 0
        ? Math.max(0.1, Math.min(1, activeSkills.length / (skills.length || 10)))
        : 0.3,
      turbulence: soulDimensions.length > 0
        ? soulDimensions.reduce((sum, d) => sum + d.value, 0) / (soulDimensions.length * 100)
        : 0.3,
    }
  }, [soulIdentity, soulCoreTruths, soulDimensions, skills])

  // 初始化/销毁渲染引擎
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    try {
      const engine = new GameCanvas(canvas)
      engineRef.current = engine
      
      // 立即设置当前主题的调色板
      engine.setPalette(canvasPaletteRef.current)

      const handleResize = () => engine.resize()
      window.addEventListener('resize', handleResize)

      return () => {
        engine.destroy()
        engineRef.current = null
        window.removeEventListener('resize', handleResize)
      }
    } catch (err) {
      console.error('[WorldView] GameCanvas init failed:', err)
    }
  }, [])

  // 同步 store 状态到渲染引擎
  useEffect(() => {
    engineRef.current?.updateState({
      nexuses, camera, selectedNexusId, renderSettings,
      energyCore: energyCoreState,
      executingNexusId,
      executionStartTime,
    })
  }, [nexuses, camera, selectedNexusId, renderSettings, energyCoreState, executingNexusId, executionStartTime])

  // 同步主题调色板到渲染引擎
  useEffect(() => {
    engineRef.current?.setPalette(canvasPalette)
  }, [canvasPalette])

  // House 打开时暂停/恢复 GameCanvas 渲染引擎
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    if (isHouseOpen) {
      engine.pause()
    } else {
      engine.resume()
    }
  }, [isHouseOpen])

  // 建造动画 tick (V2: 始终运行，不受 House 打开状态影响)
  // tick 现在只负责标记完成 + 触发重渲染，不做高频递增
  useEffect(() => {
    let animId: number
    
    const tick = () => {
      tickConstructionAnimations(0)
      animId = requestAnimationFrame(tick)
    }
    
    animId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animId)
  }, [tickConstructionAnimations])

  // ---- 鼠标交互 ----

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1
    setZoom(camera.zoom * factor)
  }, [camera.zoom, setZoom])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 0) {
      isDragging.current = true
      dragMoved.current = false
      lastMouse.current = { x: e.clientX, y: e.clientY }
    }
  }, [])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return
    const dx = (e.clientX - lastMouse.current.x) / camera.zoom
    const dy = (e.clientY - lastMouse.current.y) / camera.zoom
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      dragMoved.current = true
    }
    panCamera(dx, dy)
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }, [camera.zoom, panCamera])

  const handleMouseUp = useCallback(() => {
    isDragging.current = false
  }, [])

  const handleClick = useCallback((e: React.MouseEvent) => {
    // 如果刚拖拽过，不触发点击
    if (dragMoved.current) return
    
    const engine = engineRef.current
    if (!engine) return

    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return

    const screenX = e.clientX - rect.left
    const screenY = e.clientY - rect.top
    const world = engine.screenToWorld(screenX, screenY, camera)

    // 找距离最近的 nexus
    let nearest: string | null = null
    let minDist = 1.5 // grid 距离阈值

    for (const [id, nexus] of nexuses) {
      const dx = nexus.position.gridX - world.gridX
      const dy = nexus.position.gridY - world.gridY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist) {
        minDist = dist
        nearest = id
      }
    }

    selectNexus(nearest)
    
    if (nearest) {
      openNexusPanel(nearest)
    } else {
      // 没有点中，触发能量波纹
      engineRef.current?.triggerRipple(screenX, screenY)
    }
  }, [camera, nexuses, selectNexus, openNexusPanel])

  return (
    <div className="absolute inset-0 overflow-hidden bg-skin-bg-primary">
      {/* Layer 0: 装饰性网格 (minimalist 风格) */}
      <div 
        className="absolute inset-0 z-0 pointer-events-none opacity-[0.06]"
        style={{
          backgroundImage: `linear-gradient(rgba(0,0,0,0.03) 1px, transparent 1px),
               linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px)`,
          backgroundSize: '80px 80px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
          WebkitMaskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
        }}
      />

      {/* Layer 1: 游戏引擎 (GameCanvas) */}
      <motion.div
        className="absolute inset-0 z-10"
        animate={{
          scale: isHouseOpen ? 1.08 : 1,
          filter: isHouseOpen ? 'blur(6px) brightness(0.88)' : 'blur(0px) brightness(1)',
          opacity: 1,
        }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
        />
      </motion.div>

      {/* Layer 2: 边缘渐变 (minimalist 暖色风格) */}
      <div 
        className="absolute inset-0 z-20 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 50%, rgba(230,228,225,0.4) 85%, rgba(220,218,215,0.7) 100%)'
        }}
      />

      {/* Layer 3: 加载占位 */}
      {nexuses.size === 0 && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
          <div className="relative w-8 h-8 mb-3">
            <div className="absolute inset-0 rounded-full border-2 border-stone-300/20 animate-ping" />
            <div className="absolute inset-0 rounded-full border-2 border-t-gray-400/40 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
          </div>
          <p className="font-mono text-xs tracking-widest uppercase text-stone-500/50">
            正在构建世界...
          </p>
        </div>
      )}
    </div>
  )
}
