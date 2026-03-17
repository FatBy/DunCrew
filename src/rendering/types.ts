// ============================================
// DD-OS 渲染器架构 - 核心类型定义
// ============================================

import type { NexusEntity, CameraState, RenderSettings } from '@/types'
import type { CanvasPalette } from '@/types/theme'

// ============================================
// 世界主题
// ============================================

export type WorldTheme = 'minimalist' | 'dashboard'

// ============================================
// 坐标与几何
// ============================================

export interface Point {
  x: number
  y: number
}

export interface GridPosition {
  gridX: number
  gridY: number
}

// ============================================
// 渲染上下文 (传递给所有渲染器)
// ============================================

export interface RenderContext {
  ctx: CanvasRenderingContext2D
  canvas: HTMLCanvasElement
  camera: CameraState
  palette: CanvasPalette
  time: number           // 全局时间 (驱动动画)
  dpr: number            // 设备像素比
  width: number          // 画布逻辑宽度
  height: number         // 画布逻辑高度
}

// ============================================
// 能量核心状态 (由 WorldView 计算后传入)
// ============================================

export interface EnergyCoreState {
  name: string            // identity.name → 颜色哈希种子
  skills: Array<{ id: string; active: boolean }>
  complexity: number      // 0-100
  activity: number        // 0-1
  turbulence: number      // 0-1
}

// ============================================
// 渲染状态 (GameCanvas 维护)
// ============================================

export interface RenderState {
  nexuses: Map<string, NexusEntity>
  camera: CameraState
  selectedNexusId: string | null
  renderSettings: RenderSettings
  energyCore?: EnergyCoreState
  executingNexusId?: string | null
  executionStartTime?: number | null
}

// ============================================
// 渲染器接口定义
// ============================================

/**
 * 背景渲染器
 * 负责渲染深空/城市/自然背景
 */
export interface BackgroundRenderer {
  readonly id: string
  
  /** 渲染背景层 */
  render(ctx: RenderContext): void
  
  /** 窗口大小变化时调用 (可选) */
  resize?(width: number, height: number): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

/**
 * 实体渲染器
 * 负责渲染 Nexus 节点 (积木块)
 */
export interface EntityRenderer {
  readonly id: string
  
  /** 判断是否能渲染此 Nexus */
  canRender(nexus: NexusEntity): boolean
  
  /** 渲染单个 Nexus 节点 */
  render(
    ctx: RenderContext,
    nexus: NexusEntity,
    screenPos: Point,
    isSelected: boolean,
    timestamp: number,
  ): void
  
  /** 获取缓存的渲染结果 (可选) */
  getCache?(nexus: NexusEntity): OffscreenCanvas | HTMLCanvasElement | null
  
  /** 使缓存失效 (可选) */
  invalidateCache?(nexusId: string): void
  
  /** 清理所有缓存 (可选) */
  clearCache?(): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

/**
 * 粒子渲染器
 * 负责渲染背景粒子效果
 */
export interface ParticleRenderer {
  readonly id: string
  
  /** 更新粒子状态 */
  update(deltaTime: number): void
  
  /** 渲染粒子 */
  render(ctx: RenderContext): void
  
  /** 窗口大小变化时调用 (可选) */
  resize?(width: number, height: number): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

/**
 * 能量核心渲染器
 * 负责渲染中心能量核心
 */
export interface EnergyCoreRenderer {
  readonly id: string
  
  /** 渲染能量核心 */
  render(
    ctx: RenderContext,
    coreState: EnergyCoreState,
    mousePos: Point,
  ): void
  
  /** 初始化核心粒子 (技能数量变化时调用) */
  initParticles?(coreState: EnergyCoreState): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

/**
 * 涟漪渲染器
 * 负责渲染交互波纹效果
 */
export interface RippleRenderer {
  readonly id: string
  
  /** 触发新涟漪 */
  trigger(x: number, y: number): void
  
  /** 更新涟漪状态 */
  update(): void
  
  /** 渲染涟漪 */
  render(ctx: RenderContext): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

/**
 * 网格渲染器
 * 负责渲染等轴网格
 */
export interface GridRenderer {
  readonly id: string
  
  /** 渲染网格 */
  render(ctx: RenderContext): void
  
  /** 更新建筑位置（用于生成道路网络等） */
  updateNexusPositions?(positions: GridPosition[]): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

// ============================================
// 渲染器集合 (完整主题包)
// ============================================

/**
 * 装饰层渲染器
 * 负责渲染空地上的树木/灌木等装饰
 */
export interface DecoLayerRenderer {
  readonly id: string
  
  /** 更新建筑位置（用于避开建筑区域） */
  updateNexusPositions?(positions: GridPosition[]): void
  
  /** 渲染装饰层 */
  render(ctx: RenderContext): void
  
  /** 清理资源 (可选) */
  dispose?(): void
}

export interface RendererSet {
  background: BackgroundRenderer
  grid: GridRenderer
  decorations?: DecoLayerRenderer    // 装饰层（树木/灌木，在建筑之前渲染）
  entities: EntityRenderer[]
  particles: ParticleRenderer[]
  core?: EnergyCoreRenderer          // 可选，不再强制渲染中心核心
  ripple: RippleRenderer
}

// ============================================
// 辅助类型
// ============================================

// 兼容类型定义
export type BufferCanvas = HTMLCanvasElement | OffscreenCanvas
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// 涟漪
export interface Ripple {
  x: number
  y: number
  radius: number
  alpha: number
}
