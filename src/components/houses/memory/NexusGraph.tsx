import { useMemo } from 'react'
import { Share2 } from 'lucide-react'
import type { GraphNode, GraphEdge } from './useMemoryData'

/**
 * NexusGraph - 同心圆布局的概念神经网络
 *
 * 三层环：core(内环) → tag(中环) → file(外环)
 * 纯 SVG + CSS，不使用 Framer Motion 动画组件以保证大节点数下的性能。
 * hover 效果通过 CSS :hover 实现，不触发 React 重渲染。
 */

const nodeColor: Record<GraphNode['type'], {
  fill: string; stroke: string; text: string
}> = {
  core: { fill: '#d1fae5', stroke: '#10b981', text: '#065f46' },
  tag:  { fill: '#fef3c7', stroke: '#f59e0b', text: '#92400e' },
  file: { fill: '#e0e7ff', stroke: '#6366f1', text: '#3730a3' },
}

interface NexusGraphProps {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

interface LayoutNode extends GraphNode {
  x: number
  y: number
  r: number
}

/** 在圆弧上均匀分布节点 */
function distributeOnCircle(
  items: GraphNode[],
  cx: number, cy: number,
  radius: number,
  sizeCalc: (weight: number) => number,
): LayoutNode[] {
  if (items.length === 0) return []
  const angleStep = (2 * Math.PI) / items.length
  const offsetAngle = -Math.PI / 2

  return items.map((node, i) => ({
    ...node,
    x: cx + radius * Math.cos(offsetAngle + i * angleStep),
    y: cy + radius * Math.sin(offsetAngle + i * angleStep),
    r: sizeCalc(node.weight),
  }))
}

/** 内联 CSS 样式 —— 注入一次到 SVG 内部，用 CSS :hover 实现交互 */
const svgStyles = `
  .nexus-node { cursor: pointer; }
  .nexus-node circle { transition: r 0.15s, stroke-width 0.15s; }
  .nexus-node:hover circle { stroke-width: 2.5; }
  .nexus-node:hover { transform-origin: center; }
  .nexus-node .node-weight { display: none; font-size: 10px; font-weight: 700; }
  .nexus-node:hover .node-weight { display: block; }
  .nexus-edge { stroke: #d6d3d1; stroke-width: 0.8; opacity: 0.35; }
`

export function NexusGraph({ nodes, edges }: NexusGraphProps) {
  // 分层节点
  const coreNodes = useMemo(() => nodes.filter(n => n.type === 'core'), [nodes])
  const tagNodes  = useMemo(() => nodes.filter(n => n.type === 'tag'), [nodes])
  const fileNodes = useMemo(() => nodes.filter(n => n.type === 'file'), [nodes])

  // 画布参数
  const viewW = 800
  const viewH = 600
  const cx = viewW / 2
  const cy = viewH / 2

  const r1 = Math.min(viewW, viewH) * 0.15
  const r2 = Math.min(viewW, viewH) * 0.32
  const r3 = Math.min(viewW, viewH) * 0.46

  // 布局
  const layoutNodes = useMemo(() => {
    const coreLayout = distributeOnCircle(coreNodes, cx, cy, coreNodes.length <= 1 ? 0 : r1, w => 12 + w * 2)
    const tagLayout  = distributeOnCircle(tagNodes, cx, cy, r2, w => 8 + w * 1.5)
    const fileLayout = distributeOnCircle(fileNodes, cx, cy, r3, w => 7 + w * 1)

    const map = new Map<string, LayoutNode>()
    for (const n of [...coreLayout, ...tagLayout, ...fileLayout]) {
      map.set(n.id, n)
    }
    return map
  }, [coreNodes, tagNodes, fileNodes, cx, cy, r1, r2, r3])

  // 预计算边的坐标（避免渲染时查表）
  const resolvedEdges = useMemo(() => {
    return edges
      .map(e => {
        const from = layoutNodes.get(e.source)
        const to = layoutNodes.get(e.target)
        if (!from || !to) return null
        return { x1: from.x, y1: from.y, x2: to.x, y2: to.y }
      })
      .filter(Boolean) as { x1: number; y1: number; x2: number; y2: number }[]
  }, [edges, layoutNodes])

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center">
          <Share2 className="w-14 h-14 text-stone-200" />
          <p className="text-sm text-stone-500">暂无概念图谱</p>
          <p className="text-xs text-stone-400">积累足够的记忆和轨迹后，概念关系将自动浮现</p>
        </div>
      </div>
    )
  }

  const allNodes = Array.from(layoutNodes.values())

  return (
    <div className="w-full h-full relative overflow-hidden">
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        className="w-full h-full"
        style={{ minHeight: '100%' }}
      >
        <defs>
          <style>{svgStyles}</style>
        </defs>

        {/* 同心环辅助线 */}
        {[r1, r2, r3].map((r, i) => (
          <circle
            key={i}
            cx={cx} cy={cy} r={r}
            fill="none" stroke="#e7e5e4" strokeWidth="0.5"
            strokeDasharray="4 4" opacity={0.5}
          />
        ))}

        {/* 边 —— 纯静态 SVG，无 React 状态依赖 */}
        {resolvedEdges.map((e, i) => (
          <line
            key={i}
            x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            className="nexus-edge"
          />
        ))}

        {/* 节点 —— 用 CSS :hover，不触发 React 重渲染 */}
        {allNodes.map(node => {
          const colors = nodeColor[node.type]
          const maxLen = node.type === 'file' ? 12 : 16
          const label = node.label.length > maxLen
            ? node.label.slice(0, maxLen - 1) + '…'
            : node.label

          return (
            <g key={node.id} className="nexus-node">
              <circle
                cx={node.x} cy={node.y} r={node.r}
                fill={colors.fill}
                stroke={colors.stroke}
                strokeWidth={1.2}
              />
              <text
                x={node.x} y={node.y + node.r + 12}
                textAnchor="middle"
                fill={colors.text}
                fontSize={node.type === 'core' ? 11 : 9}
                fontWeight={node.type === 'core' ? 600 : 400}
                fontFamily="system-ui, sans-serif"
              >
                {label}
              </text>
              {/* hover 时显示 weight */}
              <text
                className="node-weight"
                x={node.x} y={node.y + 4}
                textAnchor="middle"
                fill={colors.text}
              >
                {node.weight}
              </text>
            </g>
          )
        })}
      </svg>

      {/* 图例 */}
      <div className="absolute bottom-4 right-4 flex items-center gap-4 text-[10px] text-stone-500">
        {([
          ['core', '核心概念', '#10b981'],
          ['tag', '标签', '#f59e0b'],
          ['file', '文件', '#6366f1'],
        ] as const).map(([, label, color]) => (
          <div key={label} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}
