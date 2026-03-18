// ============================================
// DunCrew 坐标转换工具
// ============================================

import type { CameraState } from '@/types'
import type { Point, GridPosition } from '../types'

// 等轴投影常量
export const TILE_WIDTH = 128
export const TILE_HEIGHT = 64

/**
 * 世界坐标 → 屏幕坐标
 * 等轴投影变换
 */
export function worldToScreen(
  gridX: number,
  gridY: number,
  camera: CameraState,
  canvasWidth: number,
  canvasHeight: number,
): Point {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  const x = (gridX - gridY) * (TILE_WIDTH / 2) * camera.zoom + cx + camera.x * camera.zoom
  const y = (gridX + gridY) * (TILE_HEIGHT / 2) * camera.zoom + cy + camera.y * camera.zoom
  return { x, y }
}

/**
 * 屏幕坐标 → 世界坐标
 * 等轴投影逆变换
 */
export function screenToWorld(
  screenX: number,
  screenY: number,
  camera: CameraState,
  canvasWidth: number,
  canvasHeight: number,
): GridPosition {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  const sx = (screenX - cx - camera.x * camera.zoom) / camera.zoom
  const sy = (screenY - cy - camera.y * camera.zoom) / camera.zoom
  const gridX = (sx / (TILE_WIDTH / 2) + sy / (TILE_HEIGHT / 2)) / 2
  const gridY = (sy / (TILE_HEIGHT / 2) - sx / (TILE_WIDTH / 2)) / 2
  return { gridX, gridY }
}

/**
 * 判断屏幕坐标是否在视锥内
 */
export function isInViewport(
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  margin: number = 120,
): boolean {
  return (
    screenX >= -margin &&
    screenX <= canvasWidth + margin &&
    screenY >= -margin &&
    screenY <= canvasHeight + margin
  )
}

/**
 * 计算两点间距离
 */
export function distance(p1: Point, p2: Point): number {
  return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2)
}

/**
 * 计算点到中心的距离比例
 * 用于网格渐隐效果
 */
export function distanceRatioToCenter(
  point: Point,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const cx = canvasWidth / 2
  const cy = canvasHeight / 2
  const maxDim = Math.max(canvasWidth, canvasHeight) * 0.5
  const dist = Math.sqrt((point.x - cx) ** 2 + (point.y - cy) ** 2)
  return dist / maxDim
}
