// ============================================
// 分布算法：双同心圆轨道排列 (固定像素半径，防挤压)
// 内环 180px / 外环 360px — 使用正圆而非椭圆
// ============================================

import type { NexusRole } from './roleInference'

export interface OrbitPosition {
  offsetX: number
  offsetY: number
}

/**
 * 双同心圆布局
 * - CORE 节点在中心 (0,0)
 * - 前 6 个卫星节点在内环 (半径 180px)
 * - 后续节点在外环 (半径 360px)
 * - 所有坐标为相对容器中心的偏移量 (配合 CSS calc(50% + Xpx))
 */
export function calculateClusteredOrbits(
  nodes: Array<{ id: string; role: NexusRole }>,
): Map<string, OrbitPosition> {
  const result = new Map<string, OrbitPosition>()
  if (!nodes || nodes.length === 0) return result

  // CORE 节点放中心
  const coreNode = nodes.find(n => n.role === 'CORE')
  if (coreNode) result.set(coreNode.id, { offsetX: 0, offsetY: 0 })

  // 卫星节点按 role 排序
  const satellites = nodes.filter(n => n.role !== 'CORE')
  satellites.sort((a, b) => a.role.localeCompare(b.role))

  const orbit1Count = Math.min(6, satellites.length)
  const orbit2Count = satellites.length - orbit1Count

  // 内环 (固定像素半径 180)
  const orbit1Radius = 180
  for (let i = 0; i < orbit1Count; i++) {
    const angle = (i / orbit1Count) * 2 * Math.PI - Math.PI / 2
    result.set(satellites[i].id, {
      offsetX: orbit1Radius * Math.cos(angle),
      offsetY: orbit1Radius * Math.sin(angle),
    })
  }

  // 外环 (固定像素半径 360)
  const orbit2Radius = 360
  for (let i = 0; i < orbit2Count; i++) {
    const angle = (i / orbit2Count) * 2 * Math.PI - Math.PI / 2 + (Math.PI / orbit2Count)
    result.set(satellites[orbit1Count + i].id, {
      offsetX: orbit2Radius * Math.cos(angle),
      offsetY: orbit2Radius * Math.sin(angle),
    })
  }

  return result
}
