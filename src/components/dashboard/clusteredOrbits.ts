// ============================================
// 分布算法：自适应多环轨道排列
// 根据节点数量自动扩展环数（2~N 环），每环容量合理，间距均匀
// ============================================

import type { NexusRole } from './roleInference'

export interface OrbitPosition {
  offsetX: number
  offsetY: number
}

/** 每环最少间距（节点间弧线距离），用于计算每环最大容量 */
const MIN_ARC_GAP = 160

/** 第一环起始半径 */
const FIRST_ORBIT_RADIUS = 200

/** 环与环之间的间距 */
const ORBIT_RING_GAP = 200

/**
 * 计算单环在给定半径下最多能放多少节点（保证弧间距 ≥ MIN_ARC_GAP）
 */
function maxNodesForRadius(radius: number): number {
  if (radius <= 0) return 0
  const circumference = 2 * Math.PI * radius
  return Math.max(1, Math.floor(circumference / MIN_ARC_GAP))
}

/**
 * 将卫星节点分配到多个环上
 * 返回每环的节点数组
 */
function distributeToRings(
  satellites: Array<{ id: string; role: NexusRole }>,
): Array<{ radius: number; nodes: Array<{ id: string; role: NexusRole }> }> {
  const rings: Array<{ radius: number; nodes: Array<{ id: string; role: NexusRole }> }> = []
  let remaining = [...satellites]
  let ringIndex = 0

  while (remaining.length > 0) {
    const radius = FIRST_ORBIT_RADIUS + ringIndex * ORBIT_RING_GAP
    const capacity = maxNodesForRadius(radius)

    // 如果是最后一批，全部放进当前环（即使略超容量也比再开一环好）
    const takeCount = remaining.length <= capacity + 2
      ? remaining.length
      : Math.min(capacity, remaining.length)

    rings.push({
      radius,
      nodes: remaining.slice(0, takeCount),
    })

    remaining = remaining.slice(takeCount)
    ringIndex++
  }

  return rings
}

/**
 * 自适应多环同心圆布局
 * - CORE 节点在中心 (0,0)
 * - 卫星节点根据数量自动分配到多个环上
 * - 每环节点均匀分布，相邻环之间有角度偏移避免径向对齐
 * - 所有坐标为相对容器中心的偏移量
 */
export function calculateClusteredOrbits(
  nodes: Array<{ id: string; role: NexusRole }>,
): Map<string, OrbitPosition> {
  const result = new Map<string, OrbitPosition>()
  if (!nodes || nodes.length === 0) return result

  // CORE 节点放中心
  const coreNode = nodes.find(n => n.role === 'CORE')
  if (coreNode) result.set(coreNode.id, { offsetX: 0, offsetY: 0 })

  // 卫星节点按 role 排序，保证布局稳定
  const satellites = nodes.filter(n => n.role !== 'CORE')
  satellites.sort((a, b) => a.role.localeCompare(b.role))

  if (satellites.length === 0) return result

  // 分配到多环
  const rings = distributeToRings(satellites)

  // 为每环计算坐标
  rings.forEach((ring, ringIndex) => {
    const { radius, nodes: ringNodes } = ring
    // 相邻环错开半个间距，避免节点径向重叠
    const angleOffset = ringIndex % 2 === 0
      ? -Math.PI / 2
      : -Math.PI / 2 + Math.PI / ringNodes.length

    for (let i = 0; i < ringNodes.length; i++) {
      const angle = (i / ringNodes.length) * 2 * Math.PI + angleOffset
      result.set(ringNodes[i].id, {
        offsetX: radius * Math.cos(angle),
        offsetY: radius * Math.sin(angle),
      })
    }
  })

  return result
}
