// ============================================
// DunCrew 积木块渲染器 (极简主题)
// 纯代码生成的 3D 彩色积木块
// Level 差异 + 窗户纹理 + 屋顶装饰
// ============================================

import type { DunEntity } from '@/types'
import { scoringToVisualLevel } from '@/types'
import { getConstructionProgress } from '@/store/slices/worldSlice'
import type { EntityRenderer, RenderContext, Point, BufferCanvas } from '../types'
import { TILE_WIDTH, TILE_HEIGHT } from '../utils/coordinateTransforms'

// ---- 治愈系高级色盘 ----
const COLOR_PALETTE = [
  { top: '#F4A261', left: '#E76F51', right: '#E98A6C', zone: 'rgba(244, 162, 97, 0.15)' }, // 暖橘
  { top: '#2A9D8F', left: '#21867A', right: '#3DB8A9', zone: 'rgba(42, 157, 143, 0.15)' },  // 森绿
  { top: '#E9C46A', left: '#D4A348', right: '#F0D080', zone: 'rgba(233, 196, 106, 0.15)' }, // 明黄
  { top: '#8AB17D', left: '#6E9063', right: '#9EC28F', zone: 'rgba(138, 177, 125, 0.15)' }, // 草绿
  { top: '#A2D2FF', left: '#7BB8F0', right: '#B8E0FF', zone: 'rgba(162, 210, 255, 0.15)' }, // 天蓝
  { top: '#DDA0DD', left: '#BA7EBA', right: '#E8B8E8', zone: 'rgba(221, 160, 221, 0.15)' }, // 淡紫
  { top: '#FFB4A2', left: '#E69585', right: '#FFC8BA', zone: 'rgba(255, 180, 162, 0.15)' }, // 珊瑚
]

// ---- Level 配置: 高度/宽度随等级递增 ----
const LEVEL_CONFIG: Record<number, { baseH: number; hRange: number; scale: number }> = {
  1: { baseH: 25, hRange: 10, scale: 0.45 },  // 小平房
  2: { baseH: 40, hRange: 15, scale: 0.55 },  // 普通建筑
  3: { baseH: 60, hRange: 15, scale: 0.65 },  // 中型大楼
  4: { baseH: 80, hRange: 15, scale: 0.75 },  // 高级塔楼
  5: { baseH: 100, hRange: 0, scale: 0.85 },  // 地标
}

/**
 * 简易哈希，用于确定性随机
 */
function getHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0
  }
  return Math.abs(hash)
}

/**
 * 从 visualDNA 的 primaryHue 生成发光颜色
 */
function getGlowColor(nexus: DunEntity): string {
  const hue = nexus.visualDNA?.primaryHue ?? 180
  return `hsl(${hue}, 80%, 60%)`
}

/**
 * 积木块渲染器 - 极简主题
 * - 纯代码绘制 3D 彩色积木块
 * - Level 差异化 (高度/宽度/细节)
 * - 窗户纹理 + 屋顶装饰
 * - 执行时悬浮动画
 */
export class BlockRenderer implements EntityRenderer {
  readonly id = 'block-renderer'
  
  private cache: Map<string, BufferCanvas> = new Map()
  private dpr = 1
  private executingDunId: string | null = null
  private executionStartTime: number | null = null

  canRender(_nexus: DunEntity): boolean {
    return true
  }

  setDpr(dpr: number): void {
    if (this.dpr !== dpr) {
      this.dpr = dpr
      this.clearCache()
    }
  }

  setExecutionState(dunId: string | null, startTime: number | null): void {
    this.executingDunId = dunId
    this.executionStartTime = startTime
  }

  render(
    ctx: RenderContext,
    nexus: DunEntity,
    screenPos: Point,
    isSelected: boolean,
    timestamp: number,
  ): void {
    const { ctx: c, camera } = ctx
    const isExecuting = nexus.id === this.executingDunId

    // 基于 ID 计算独特的建筑特征
    const hash = getHash(nexus.id)
    const colors = COLOR_PALETTE[hash % COLOR_PALETTE.length]
    const level = Math.min(Math.max(scoringToVisualLevel(nexus.scoring), 1), 5)
    
    // Level 差异化高度和宽度
    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG[1]
    const heightZ = (cfg.baseH + hash % Math.max(cfg.hRange, 1)) * camera.zoom
    const blockScale = cfg.scale + ((hash % 10) / 100)
    const w = TILE_WIDTH * blockScale * camera.zoom
    const h = TILE_HEIGHT * blockScale * camera.zoom
    
    const cx = screenPos.x
    const cy = screenPos.y

    // 构造进度 (V2: 基于时间戳实时计算)
    const buildProgress = getConstructionProgress(nexus)
    
    c.save()
    c.globalAlpha = 0.3 + 0.7 * buildProgress

    // ==========================================
    // 第一层：绘制底部的"专属色块/地毯" (Zone)
    // ==========================================
    const zoneW = TILE_WIDTH * 0.9 * camera.zoom
    const zoneH = TILE_HEIGHT * 0.9 * camera.zoom
    
    c.beginPath()
    c.moveTo(cx, cy - zoneH / 2)
    c.lineTo(cx + zoneW / 2, cy)
    c.lineTo(cx, cy + zoneH / 2)
    c.lineTo(cx - zoneW / 2, cy)
    c.closePath()
    c.fillStyle = colors.zone
    c.fill()
    
    c.lineWidth = 1.5
    c.strokeStyle = colors.top
    c.globalAlpha = (0.3 + 0.7 * buildProgress) * 0.5
    c.stroke()
    c.globalAlpha = 0.3 + 0.7 * buildProgress

    // ==========================================
    // 第二层：绘制 3D 积木模型
    // ==========================================
    
    // 执行时悬浮效果
    let floatY = 0
    if (isExecuting) {
      floatY = -12 + Math.sin(timestamp / 150) * 4
      c.fillStyle = 'rgba(0, 0, 0, 0.15)'
      c.beginPath()
      c.ellipse(cx, cy + 2, w / 2.5, h / 3, 0, 0, Math.PI * 2)
      c.fill()
    }

    const baseY = cy + floatY

    // 选中/执行时的发光效果
    if (isSelected || isExecuting) {
      const glowColor = getGlowColor(nexus)
      const pulse = isExecuting
        ? 0.6 + 0.4 * Math.sin(timestamp / 200)
        : 0.8
      c.shadowColor = glowColor
      c.shadowBlur = 25 * pulse
    }

    // --- 绘制左侧面 (深色背光面) ---
    c.beginPath()
    c.moveTo(cx - w / 2, baseY)
    c.lineTo(cx, baseY + h / 2)
    c.lineTo(cx, baseY + h / 2 - heightZ)
    c.lineTo(cx - w / 2, baseY - heightZ)
    c.closePath()
    c.fillStyle = colors.left
    c.fill()
    c.strokeStyle = 'rgba(0, 0, 0, 0.1)'
    c.lineWidth = 1
    c.stroke()

    // --- 绘制右侧面 (浅色向光面) ---
    c.beginPath()
    c.moveTo(cx, baseY + h / 2)
    c.lineTo(cx + w / 2, baseY)
    c.lineTo(cx + w / 2, baseY - heightZ)
    c.lineTo(cx, baseY + h / 2 - heightZ)
    c.closePath()
    c.fillStyle = colors.right
    c.fill()
    c.stroke()

    // --- 绘制窗户 (侧面之后、顶面之前) ---
    this.drawWindows(c, cx, baseY, w, h, heightZ, level, hash)

    // --- 绘制顶面 ---
    c.beginPath()
    c.moveTo(cx, baseY - h / 2 - heightZ)
    c.lineTo(cx + w / 2, baseY - heightZ)
    c.lineTo(cx, baseY + h / 2 - heightZ)
    c.lineTo(cx - w / 2, baseY - heightZ)
    c.closePath()
    c.fillStyle = colors.top
    c.fill()
    
    if (isSelected) {
      c.fillStyle = 'rgba(255, 255, 255, 0.35)'
      c.fill()
    }
    c.strokeStyle = 'rgba(0, 0, 0, 0.1)'
    c.lineWidth = 1
    c.stroke()

    // --- 屋顶装饰 ---
    this.drawRoofDecoration(c, cx, baseY, w, h, heightZ, level, timestamp, colors, nexus)

    // 重置阴影
    c.shadowColor = 'transparent'
    c.shadowBlur = 0
    c.globalAlpha = 1
    c.restore()

    // 标签
    if (nexus.label) {
      this.drawLabel(c, nexus, screenPos, isSelected, floatY, heightZ)
    }

    // 执行指示器
    if (isExecuting && this.executionStartTime) {
      this.drawExecutionIndicator(c, screenPos, timestamp, nexus, floatY, heightZ)
    }
  }

  /**
   * 绘制窗户纹理
   * 在左侧面和右侧面上绘制等距分布的窗户
   */
  private drawWindows(
    ctx: CanvasRenderingContext2D,
    cx: number, baseY: number,
    w: number, h: number,
    heightZ: number, level: number,
    hash: number,
  ): void {
    if (level < 2 || heightZ < 20) return

    // 窗户配置: cols × rows
    const windowConfig: Record<number, { cols: number; rows: number }> = {
      2: { cols: 1, rows: 2 },
      3: { cols: 1, rows: 3 },
      4: { cols: 2, rows: 3 },
      5: { cols: 2, rows: 3 },
    }
    const wCfg = windowConfig[level] || windowConfig[2]

    const winW = w * 0.08
    const winH = heightZ * 0.08
    const verticalPadding = heightZ * 0.15
    const usableHeight = heightZ - verticalPadding * 2

    ctx.save()

    // --- 左面窗户 ---
    // 左面从 (cx - w/2, baseY) 到 (cx, baseY + h/2), 高度方向向上 heightZ
    for (let col = 0; col < wCfg.cols; col++) {
      for (let row = 0; row < wCfg.rows; row++) {
        // 沿左面水平方向的参数 t (0=左边, 1=右边)
        const tH = (col + 1) / (wCfg.cols + 1)
        // 沿高度方向的参数 (0=底部, 1=顶部)
        const tV = (row + 1) / (wCfg.rows + 1)
        const yOff = verticalPadding + usableHeight * (1 - tV)

        // 左面上的点: 从底边线性插值
        const faceMidX = cx - w / 2 + (w / 2) * tH
        const faceMidY = baseY + (h / 2) * tH

        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)'
        ctx.fillRect(faceMidX - winW / 2, faceMidY - yOff - winH / 2, winW, winH)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(faceMidX - winW / 2, faceMidY - yOff - winH / 2, winW, winH)
      }
    }

    // --- 右面窗户 ---
    for (let col = 0; col < wCfg.cols; col++) {
      for (let row = 0; row < wCfg.rows; row++) {
        const tH = (col + 1) / (wCfg.cols + 1)
        const tV = (row + 1) / (wCfg.rows + 1)
        const yOff = verticalPadding + usableHeight * (1 - tV)

        // 右面上的点: 从底边线性插值
        const faceMidX = cx + (w / 2) * tH
        const faceMidY = baseY + h / 2 - (h / 2) * tH

        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)'
        ctx.fillRect(faceMidX - winW / 2, faceMidY - yOff - winH / 2, winW, winH)
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)'
        ctx.lineWidth = 0.5
        ctx.strokeRect(faceMidX - winW / 2, faceMidY - yOff - winH / 2, winW, winH)
      }
    }

    // Level 5: 窗户发光
    if (level >= 5) {
      const glowAlpha = 0.05 + 0.03 * Math.sin((hash % 100) * 0.1)
      ctx.shadowColor = `rgba(255, 240, 180, ${glowAlpha})`
      ctx.shadowBlur = 4
    }

    ctx.restore()
  }

  /**
   * 绘制屋顶装饰
   */
  private drawRoofDecoration(
    ctx: CanvasRenderingContext2D,
    cx: number, baseY: number,
    w: number, h: number,
    heightZ: number, level: number,
    timestamp: number,
    colors: typeof COLOR_PALETTE[0],
    nexus: DunEntity,
  ): void {
    if (level < 3) return

    const topCenterY = baseY - heightZ

    if (level === 3) {
      // 栏杆: 顶面四边的细线边缘
      ctx.save()
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)'
      ctx.lineWidth = 1

      // 顶面四个顶点
      const topUp = { x: cx, y: topCenterY - h / 2 }
      const topRight = { x: cx + w / 2, y: topCenterY }
      const topDown = { x: cx, y: topCenterY + h / 2 }
      const topLeft = { x: cx - w / 2, y: topCenterY }

      // 内缩 2px 的栏杆线
      const inset = 3
      ctx.beginPath()
      ctx.moveTo(topUp.x, topUp.y + inset)
      ctx.lineTo(topRight.x - inset, topRight.y)
      ctx.lineTo(topDown.x, topDown.y - inset)
      ctx.lineTo(topLeft.x + inset, topLeft.y)
      ctx.closePath()
      ctx.stroke()
      ctx.restore()
    }

    if (level === 4) {
      // 天线: 顶面中心垂直线 + 小球
      ctx.save()
      const antennaHeight = 12
      const antennaX = cx
      const antennaBaseY = topCenterY

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(antennaX, antennaBaseY)
      ctx.lineTo(antennaX, antennaBaseY - antennaHeight)
      ctx.stroke()

      // 天线顶部小球
      ctx.beginPath()
      ctx.arc(antennaX, antennaBaseY - antennaHeight, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = colors.top
      ctx.fill()
      ctx.restore()
    }

    if (level >= 5) {
      // 悬浮光环: 顶部旋转弧线
      ctx.save()
      const haloY = topCenterY - 18
      const haloRadius = 10
      const rotation = timestamp / 500
      const pulse = 0.5 + 0.5 * Math.sin(timestamp / 300)

      ctx.translate(cx, haloY)
      ctx.rotate(rotation)
      ctx.strokeStyle = getGlowColor(nexus)
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.4 + 0.3 * pulse
      ctx.lineCap = 'round'

      ctx.beginPath()
      ctx.arc(0, 0, haloRadius, 0, Math.PI * 1.3)
      ctx.stroke()

      // 第二段弧线 (对侧)
      ctx.beginPath()
      ctx.arc(0, 0, haloRadius, Math.PI, Math.PI * 2.3)
      ctx.stroke()

      ctx.restore()
    }
  }

  private drawLabel(
    ctx: CanvasRenderingContext2D,
    nexus: DunEntity,
    pos: Point,
    isSelected: boolean,
    _floatY: number,
    _heightZ: number,
  ): void {
    const label = nexus.label || nexus.id.slice(0, 8)
    
    ctx.font = `600 ${isSelected ? 13 : 11}px "SF Mono", "Fira Code", monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    
    const metrics = ctx.measureText(label)
    const padding = 6
    const bgWidth = metrics.width + padding * 2
    const bgHeight = 18
    const bgX = pos.x - bgWidth / 2
    const bgY = pos.y + 20
    
    ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.75)'
    ctx.beginPath()
    ctx.roundRect(bgX, bgY, bgWidth, bgHeight, 4)
    ctx.fill()
    
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)'
    ctx.lineWidth = 1
    ctx.stroke()
    
    ctx.fillStyle = isSelected ? '#1a1a2e' : '#333'
    ctx.fillText(label, pos.x, bgY + 3)
  }

  private drawExecutionIndicator(
    ctx: CanvasRenderingContext2D,
    pos: Point,
    timestamp: number,
    nexus: DunEntity,
    floatY: number,
    heightZ: number,
  ): void {
    const glowColor = getGlowColor(nexus)
    const elapsed = timestamp - (this.executionStartTime || timestamp)
    const pulse = 0.5 + 0.5 * Math.sin(elapsed / 150)
    
    ctx.save()
    ctx.translate(pos.x, pos.y + floatY - heightZ - 25)
    ctx.rotate(elapsed / 500)
    
    ctx.strokeStyle = glowColor
    ctx.lineWidth = 3
    ctx.lineCap = 'round'
    ctx.globalAlpha = pulse
    
    ctx.beginPath()
    ctx.arc(0, 0, 14, 0, Math.PI * 1.5)
    ctx.stroke()
    
    ctx.restore()
  }

  invalidateCache(dunId: string): void {
    this.cache.delete(dunId)
  }

  clearCache(): void {
    this.cache.clear()
  }

  dispose(): void {
    this.cache.clear()
  }
}
