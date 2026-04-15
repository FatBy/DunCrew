// ============================================
// DunCrew 极简网格渲染器
// Notion/Figma 风格的微弱圆点阵列
// ============================================

import type { GridRenderer, RenderContext, GridPosition } from '../types'
import { TILE_WIDTH, TILE_HEIGHT } from '../utils/coordinateTransforms'

/**
 * 极简网格渲染器
 * 微弱圆点标示空间
 */
export class MinimalistGrid implements GridRenderer {
  readonly id = 'minimalist-grid'

  // Nexus 位置缓存
  private nexusSet = new Set<string>()

  updateDunPositions(positions: GridPosition[]): void {
    this.nexusSet.clear()
    for (const p of positions) {
      this.nexusSet.add(`${p.gridX},${p.gridY}`)
    }
  }

  render(ctx: RenderContext): void {
    const { ctx: c, width, height, camera } = ctx

    const GRID_SIZE = 25 // 渲染范围

    c.save()

    // 极简设计：微弱的灰色圆点
    // 浅色背景用半透明黑点
    c.fillStyle = 'rgba(0, 0, 0, 0.06)'

    const halfW = width / 2
    const halfH = height / 2
    const scale = camera.zoom * 0.8
    const tileW = TILE_WIDTH * scale
    const tileH = TILE_HEIGHT * scale

    for (let gx = -GRID_SIZE; gx <= GRID_SIZE; gx++) {
      for (let gy = -GRID_SIZE; gy <= GRID_SIZE; gy++) {
        // 等距坐标 → 屏幕坐标
        const screenX = halfW + (gx - gy) * (tileW / 2) + camera.x * camera.zoom
        const screenY = halfH + (gx + gy) * (tileH / 2) + camera.y * camera.zoom

        // 视锥裁剪
        if (screenX < -50 || screenX > width + 50 ||
            screenY < -50 || screenY > height + 50) {
          continue
        }

        // 根据缩放动态调整圆点大小
        const dotRadius = Math.max(1.2, 2 * camera.zoom)
        
        c.beginPath()
        c.arc(screenX, screenY, dotRadius, 0, Math.PI * 2)
        c.fill()
      }
    }

    c.restore()
  }

  dispose(): void {
    this.nexusSet.clear()
  }
}
