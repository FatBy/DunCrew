// ============================================
// DashboardView - 暖色孵化室 Nexus Dashboard
// 数据转换层 + 双圆轨道布局 + 拖拽 + 萌宠圆环渲染
// ============================================

import { useEffect, useRef, useCallback, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { useStore } from '@/store'
import { calculateClusteredOrbits } from './clusteredOrbits'
import { IncubatorPod, type AgentData } from './IncubatorPod'
import { inferRole, mapToPrototypeStage, stageToLevel } from './roleInference'
import { getGrowthStage, getDefaultSpecies, getNexusEmoji } from './nexusGrowth'

export function DashboardView() {
  const nexuses = useStore((s) => s.nexuses)
  const selectedNexusId = useStore((s) => s.selectedNexusId)
  const executingNexusId = useStore((s) => s.executingNexusId)
  const selectNexus = useStore((s) => s.selectNexus)
  const openNexusPanel = useStore((s) => s.openNexusPanel)
  const currentView = useStore((s) => s.currentView)

  const containerRef = useRef<HTMLDivElement>(null)
  const isHouseOpen = currentView !== 'world'

  // ==========================================
  // 数据转换: NexusEntity → AgentData
  // ==========================================
  const nexusArray = useMemo(() => Array.from(nexuses.values()), [nexuses])

  const agents: AgentData[] = useMemo(() => {
    return nexusArray.map(nexus => {
      const role = inferRole(nexus)
      const scoring = nexus.scoring
      const growthStage = scoring ? getGrowthStage(scoring.score, scoring.totalRuns) : 'egg'
      const species = (nexus as any).species || getDefaultSpecies(nexus.id)
      const animalEmoji = getNexusEmoji(species, scoring ?? undefined)
      return {
        id: nexus.id,
        name: nexus.label || nexus.id,
        role,
        animalEmoji,
        level: stageToLevel(growthStage),
        xp: scoring?.score ?? 0,
        maxXp: 100,
        status: executingNexusId === nexus.id ? 'working' as const : 'idle' as const,
        stage: mapToPrototypeStage(growthStage),
        offsetX: 0,
        offsetY: 0,
      }
    })
  }, [nexusArray, executingNexusId])

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
  const handleNodeClick = useCallback((agentId: string) => {
    selectNexus(agentId)
    openNexusPanel(agentId)
  }, [selectNexus, openNexusPanel])

  const handleBgClick = useCallback(() => {
    selectNexus(null)
  }, [selectNexus])

  // ==========================================
  // 渲染
  // ==========================================
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
    >
      {/* 主内容层 */}
      <motion.div
        className="absolute inset-0 z-10"
        animate={{
          scale: isHouseOpen ? 1.03 : 1,
          filter: isHouseOpen ? 'blur(6px) brightness(0.88)' : 'blur(0px) brightness(1)',
        }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        style={{ cursor: draggingId ? 'grabbing' : 'default' }}
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
                isSelected={selectedNexusId === agent.id}
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
      {nexuses.size === 0 && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-5xl mb-4">{'\uD83E\uDD5A'}</div>
          <p className="text-sm font-mono tracking-wider" style={{ color: '#b0a898' }}>
            等待 Nexus 孵化中...
          </p>
        </div>
      )}
    </div>
  )
}
