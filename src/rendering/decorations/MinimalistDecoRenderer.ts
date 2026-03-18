// ============================================
// DunCrew 极简主题环境装饰渲染器
// 在 Nexus 周围渲染小树/路灯/长椅/灌木
// ============================================

import type { DecoLayerRenderer, RenderContext, GridPosition } from '../types'
import { worldToScreen } from '../utils/coordinateTransforms'

type PropType = 'tree' | 'lamp' | 'bench' | 'bush'

interface Prop {
  type: PropType
  offsetGX: number   // 相对 Nexus 的格子偏移
  offsetGY: number
  size: number        // 0.6-1.0
  variant: number     // 子变体 0-2
}

// 树冠颜色变体
const TREE_COLORS = ['#7CB37C', '#5E9E5E', '#90C090']
const BUSH_COLORS = ['#8BBF8B', '#6DA86D', '#A3CCA3']

function hashNum(a: number, b: number, seed: number): number {
  let h = seed
  h = Math.imul(h ^ (a * 374761393), 1103515245)
  h = Math.imul(h ^ (b * 668265263), 1103515245)
  return Math.abs(h)
}

/**
 * 极简主题环境装饰渲染器
 * 在每个 Nexus 周围确定性生成 4-6 个装饰物
 */
export class MinimalistDecoRenderer implements DecoLayerRenderer {
  readonly id = 'minimalist-deco-renderer'

  private propsMap: Map<string, { gx: number; gy: number; props: Prop[] }> = new Map()

  updateNexusPositions(positions: GridPosition[]): void {
    const newKeys = new Set<string>()

    for (const pos of positions) {
      const key = `${pos.gridX},${pos.gridY}`
      newKeys.add(key)
      if (this.propsMap.has(key)) continue

      // 确定性生成装饰
      const props = this.generateProps(pos.gridX, pos.gridY)
      this.propsMap.set(key, { gx: pos.gridX, gy: pos.gridY, props })
    }

    // 移除已删除的 Nexus 的装饰
    for (const key of this.propsMap.keys()) {
      if (!newKeys.has(key)) this.propsMap.delete(key)
    }
  }

  private generateProps(gridX: number, gridY: number): Prop[] {
    const props: Prop[] = []
    const seed = hashNum(gridX, gridY, 42)
    const count = 4 + (seed % 3)  // 4-6 个装饰

    for (let i = 0; i < count; i++) {
      const h = hashNum(gridX * 100 + i, gridY * 100 + i, seed)

      // 随机偏移 (0.8 ~ 2.0 格, 避开中心 0.5)
      const angle = ((h % 360) / 360) * Math.PI * 2
      const dist = 0.8 + (h % 120) / 100  // 0.8 - 2.0
      const offsetGX = Math.cos(angle) * dist
      const offsetGY = Math.sin(angle) * dist

      // 类型分配
      const typeRoll = h % 10
      let type: PropType
      if (typeRoll <= 3) type = 'tree'
      else if (typeRoll <= 5) type = 'lamp'
      else if (typeRoll <= 7) type = 'bench'
      else type = 'bush'

      props.push({
        type,
        offsetGX,
        offsetGY,
        size: 0.6 + (h % 40) / 100,  // 0.6-1.0
        variant: h % 3,
      })
    }

    return props
  }

  render(ctx: RenderContext): void {
    const { ctx: c, camera, width, height } = ctx

    for (const { gx, gy, props } of this.propsMap.values()) {
      for (const prop of props) {
        const worldGX = gx + prop.offsetGX
        const worldGY = gy + prop.offsetGY
        const screen = worldToScreen(worldGX, worldGY, camera, width, height)

        // 视锥剔除
        if (screen.x < -80 || screen.x > width + 80 ||
            screen.y < -80 || screen.y > height + 80) {
          continue
        }

        const scale = camera.zoom * prop.size

        switch (prop.type) {
          case 'tree':
            this.drawTree(c, screen.x, screen.y, scale, prop.variant)
            break
          case 'lamp':
            this.drawLamp(c, screen.x, screen.y, scale)
            break
          case 'bench':
            this.drawBench(c, screen.x, screen.y, scale)
            break
          case 'bush':
            this.drawBush(c, screen.x, screen.y, scale, prop.variant)
            break
        }
      }
    }
  }

  /**
   * 绘制小树: 棕色树干 + 绿色三角冠
   */
  private drawTree(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    scale: number, variant: number,
  ): void {
    const trunkW = 2 * scale
    const trunkH = 6 * scale
    const crownW = 10 * scale
    const crownH = 12 * scale

    // 树干
    ctx.fillStyle = '#A0856C'
    ctx.fillRect(x - trunkW / 2, y - trunkH, trunkW, trunkH)

    // 树冠 (等腰三角形)
    ctx.fillStyle = TREE_COLORS[variant % TREE_COLORS.length]
    ctx.beginPath()
    ctx.moveTo(x, y - trunkH - crownH)
    ctx.lineTo(x + crownW / 2, y - trunkH + 1)
    ctx.lineTo(x - crownW / 2, y - trunkH + 1)
    ctx.closePath()
    ctx.fill()
  }

  /**
   * 绘制路灯: 灰色灯柱 + 黄色灯头 + 微弱光晕
   */
  private drawLamp(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    scale: number,
  ): void {
    const poleH = 12 * scale
    const bulbR = 2.5 * scale
    const glowR = 14 * scale

    // 灯柱
    ctx.strokeStyle = '#999'
    ctx.lineWidth = 1.5 * scale
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x, y - poleH)
    ctx.stroke()

    // 光晕
    const glow = ctx.createRadialGradient(x, y - poleH, 0, x, y - poleH, glowR)
    glow.addColorStop(0, 'rgba(255, 240, 180, 0.1)')
    glow.addColorStop(1, 'rgba(255, 240, 180, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, y - poleH, glowR, 0, Math.PI * 2)
    ctx.fill()

    // 灯头
    ctx.fillStyle = '#FFD966'
    ctx.beginPath()
    ctx.arc(x, y - poleH, bulbR, 0, Math.PI * 2)
    ctx.fill()
  }

  /**
   * 绘制长椅: 棕色座面 + 两条短腿
   */
  private drawBench(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    scale: number,
  ): void {
    const seatW = 9 * scale
    const seatH = 2.5 * scale
    const legH = 3 * scale
    const legW = 1 * scale

    // 座面
    ctx.fillStyle = '#B08968'
    ctx.fillRect(x - seatW / 2, y - seatH - legH, seatW, seatH)

    // 两条腿
    ctx.fillRect(x - seatW / 2 + 1 * scale, y - legH, legW, legH)
    ctx.fillRect(x + seatW / 2 - 2 * scale, y - legH, legW, legH)
  }

  /**
   * 绘制灌木: 2-3 个重叠绿色圆
   */
  private drawBush(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    scale: number, variant: number,
  ): void {
    const baseColor = BUSH_COLORS[variant % BUSH_COLORS.length]
    const r1 = 4 * scale
    const r2 = 3.5 * scale
    const r3 = 3 * scale

    ctx.fillStyle = baseColor
    ctx.globalAlpha = 0.8

    // 主球
    ctx.beginPath()
    ctx.arc(x, y - r1, r1, 0, Math.PI * 2)
    ctx.fill()

    // 侧球
    ctx.globalAlpha = 0.7
    ctx.beginPath()
    ctx.arc(x - r1 * 0.6, y - r2 * 0.5, r2, 0, Math.PI * 2)
    ctx.fill()

    ctx.beginPath()
    ctx.arc(x + r1 * 0.5, y - r3 * 0.4, r3, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalAlpha = 1
  }

  dispose(): void {
    this.propsMap.clear()
  }
}
