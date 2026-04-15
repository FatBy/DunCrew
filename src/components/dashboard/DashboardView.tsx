// ============================================
// DashboardView - 暖色孵化室 Dun Dashboard
// 数据转换层 + 双圆轨道布局 + 拖拽 + 萌宠圆环渲染
// ============================================

import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '@/store'
import { useT } from '@/i18n'
import { calculateClusteredOrbits } from './clusteredOrbits'
import { IncubatorPod, type AgentData } from './IncubatorPod'
import { inferRole, mapToPrototypeStage, stageToLevel } from './roleInference'
import { getGrowthStage, getDefaultSpecies, getDunEmoji, type AnimalSpecies } from './dunGrowth'

export function DashboardView() {
  const t = useT()
  const duns = useStore((s) => s.duns)
  const selectedDunId = useStore((s) => s.selectedDunId)
  const executingDunId = useStore((s) => s.executingDunId)
  const selectDun = useStore((s) => s.selectDun)
  const openDunPanel = useStore((s) => s.openDunPanel)
  const currentView = useStore((s) => s.currentView)

  const containerRef = useRef<HTMLDivElement>(null)
  const isHouseOpen = currentView !== 'world'

  // ==========================================
  // 数据转换: DunEntity → AgentData
  // ==========================================
  const dunArray = useMemo(() => Array.from(duns.values()), [duns])

  const agents: AgentData[] = useMemo(() => {
    return dunArray.map(dun => {
      const role = inferRole(dun)
      const scoring = dun.scoring
      const growthStage = scoring ? getGrowthStage(scoring.score, scoring.totalRuns) : 'egg'
      const species = dun.species as AnimalSpecies || getDefaultSpecies(dun.id)
      const animalEmoji = getDunEmoji(species, scoring ?? undefined)
      return {
        id: dun.id,
        name: dun.label || dun.id,
        role,
        animalEmoji,
        level: stageToLevel(growthStage),
        xp: scoring?.score ?? 0,
        maxXp: 100,
        status: executingDunId === dun.id ? 'working' as const : 'idle' as const,
        stage: mapToPrototypeStage(growthStage),
        offsetX: 0,
        offsetY: 0,
      }
    })
  }, [dunArray, executingDunId])

  // ==========================================
  // 轨道布局
  // ==========================================
  const orbitMap = useMemo(
    () => calculateClusteredOrbits(agents),
    [agents],
  )

  // ==========================================
  // 拖拽系统
  // ==========================================
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverrides, setDragOverrides] = useState<Map<string, { offsetX: number; offsetY: number }>>(new Map())
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; startOffsetX: number; startOffsetY: number } | null>(null)
  const [liveDragPos, setLiveDragPos] = useState<{ id: string; offsetX: number; offsetY: number } | null>(null)

  // Pan and zoom
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const isPanning = useRef(false)
  const panStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 })
  const panMoved = useRef(false)

  const getOffset = useCallback((agentId: string) => {
    if (liveDragPos && liveDragPos.id === agentId) {
      return { offsetX: liveDragPos.offsetX, offsetY: liveDragPos.offsetY }
    }
    const override = dragOverrides.get(agentId)
    if (override) return override
    return orbitMap.get(agentId) ?? { offsetX: 0, offsetY: 0 }
  }, [orbitMap, dragOverrides, liveDragPos])

  const handleNodeMouseDown = useCallback((e: React.MouseEvent, agentId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const offset = dragOverrides.get(agentId) ?? orbitMap.get(agentId) ?? { offsetX: 0, offsetY: 0 }
    setDraggingId(agentId)
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startOffsetX: offset.offsetX,
      startOffsetY: offset.offsetY,
    }
  }, [orbitMap, dragOverrides])

  useEffect(() => {
    if (!draggingId) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragStartRef.current) return
      const dx = e.clientX - dragStartRef.current.mouseX
      const dy = e.clientY - dragStartRef.current.mouseY
      setLiveDragPos({
        id: draggingId,
        offsetX: dragStartRef.current.startOffsetX + dx,
        offsetY: dragStartRef.current.startOffsetY + dy,
      })
    }

    const handleMouseUp = () => {
      if (liveDragPos && draggingId) {
        setDragOverrides(prev => {
          const next = new Map(prev)
          next.set(draggingId, { offsetX: liveDragPos.offsetX, offsetY: liveDragPos.offsetY })
          return next
        })
      }
      setDraggingId(null)
      setLiveDragPos(null)
      dragStartRef.current = null
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [draggingId, liveDragPos])

  // ==========================================
  // 交互
  // ==========================================
  // Canvas pan
  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    isPanning.current = true
    panMoved.current = false
    panStart.current = { x: e.clientX, y: e.clientY, panX: panOffset.x, panY: panOffset.y }
  }, [panOffset])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isPanning.current || draggingId) return
      const dx = e.clientX - panStart.current.x
      const dy = e.clientY - panStart.current.y
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved.current = true
      setPanOffset({ x: panStart.current.panX + dx, y: panStart.current.panY + dy })
    }
    const onUp = () => { isPanning.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingId])

  // Wheel zoom - 必须用 non-passive listener 才能 preventDefault
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setZoom(z => Math.min(2, Math.max(0.3, z * (e.deltaY > 0 ? 1 / 1.08 : 1.08))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const handleNodeClick = useCallback((agentId: string) => {
    selectDun(agentId)
    openDunPanel(agentId)
  }, [selectDun, openDunPanel])

  const handleBgClick = useCallback(() => {
    if (panMoved.current) return
    selectDun(null)
  }, [selectDun])

  // ==========================================
  // 渲染
  // ==========================================

  // 当 House 打开时，跳过完整渲染，只显示静态模糊背景
  // 避免大量 IncubatorPod 节点 + 动画 + 定时器在后台持续消耗性能
  if (isHouseOpen) {
    return (
      <div
        className="absolute inset-0 overflow-hidden select-none"
        style={{
          backgroundColor: '#fefaf6',
          backgroundImage: 'radial-gradient(#e5dbce 2px, transparent 2px)',
          backgroundSize: '32px 32px',
          filter: 'blur(6px) brightness(0.88)',
        }}
      />
    )
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 overflow-hidden select-none font-sans"
      style={{
        backgroundColor: '#fefaf6',
        backgroundImage: 'radial-gradient(#e5dbce 2px, transparent 2px)',
        backgroundSize: '32px 32px',
      }}
      onClick={handleBgClick}
      onMouseDown={handlePanStart}
    >
      {/* 主内容层 */}
      <motion.div
        className="absolute inset-0 z-10"
        animate={{
          scale: zoom,
          x: panOffset.x,
          y: panOffset.y,
        }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ cursor: draggingId ? 'grabbing' : isPanning.current ? 'grabbing' : 'grab',
          transformOrigin: 'center center',
        }}
      >
        {agents.map((agent) => {
          const offset = getOffset(agent.id)
          const isDragging = draggingId === agent.id

          return (
            <div
              key={agent.id}
              style={{
                zIndex: isDragging ? 100 : 10,
                cursor: isDragging ? 'grabbing' : 'grab',
              }}
              onMouseDown={(e) => handleNodeMouseDown(e, agent.id)}
            >
              <IncubatorPod
                data={{ ...agent, offsetX: offset.offsetX, offsetY: offset.offsetY }}
                isSelected={selectedDunId === agent.id}
                onClick={handleNodeClick}
              />
            </div>
          )
        })}
      </motion.div>

      {/* 边缘柔和渐变遮罩 */}
      <div
        className="absolute inset-0 z-20 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 55%, rgba(254,250,246,0.6) 100%)',
        }}
      />

      {/* 空状态 */}
      {duns.size === 0 && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-5xl mb-4">{'\uD83E\uDD5A'}</div>
          <p className="text-sm font-mono tracking-wider" style={{ color: '#b0a898' }}>
            {t('dashboard.incubating')}
          </p>
        </div>
      )}
    </div>
  )
}
