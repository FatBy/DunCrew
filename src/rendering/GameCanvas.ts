// ============================================
// GameCanvas 渲染引擎 (协调器版本)
// ============================================

import type { CameraState } from '@/types'
import type { CanvasPalette } from '@/types/theme'
import type { 
  WorldTheme, 
  RenderState, 
  RenderContext,
  Point,
} from './types'
import { RendererRegistry } from './RendererRegistry'
import { createMinimalistRenderers } from './index'
import { worldToScreen as wts, screenToWorld as stw } from './utils/coordinateTransforms'
import { BlockRenderer } from './entities/BlockRenderer'
import { CosmosRippleRenderer } from './backgrounds/CosmosRipple'

// 默认调色板 (warm 主题)
const DEFAULT_PALETTE: CanvasPalette = {
  spaceGradient: ['#fdfbf5', '#f7f3e9', '#faf6ee'],
  gridColor: '180, 165, 140',
  gridOpacity: 0.06,
  starColor: '#c8b898',
  labelSelected: 'rgba(60,50,40,0.9)',
  labelDefault: 'rgba(120,105,85,0.6)',
  glowHue: 35,
  coreHue: 30,
}

/**
 * GameCanvas 渲染引擎
 * 协调各渲染器完成画面绘制
 */
export class GameCanvas {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private dpr: number = 1
  private animFrameId = 0
  private _time = 0
  private palette: CanvasPalette = DEFAULT_PALETTE
  private registry: RendererRegistry

  private state: RenderState = {
    nexuses: new Map(),
    camera: { x: 0, y: 0, zoom: 1 },
    selectedNexusId: null,
    renderSettings: { showGrid: true, showParticles: true, showLabels: true, enableGlow: true },
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to get 2d context')
    this.ctx = ctx

    // 初始化渲染器注册表 (仅 minimalist 主题)
    this.registry = new RendererRegistry()
    this.registry.register('minimalist', createMinimalistRenderers())
    this.registry.setTheme('minimalist')

    this.resize()
    this.render = this.render.bind(this)
    this.animFrameId = requestAnimationFrame(this.render)
    console.log('[GameCanvas] Created (Plugin Architecture)')
  }

  // ---- Lifecycle ----

  resize(): void {
    this.dpr = window.devicePixelRatio || 1
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return
    this.canvas.width = w * this.dpr
    this.canvas.height = h * this.dpr
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    // 通知渲染器
    const renderers = this.registry.getCurrent()
    if (renderers) {
      renderers.background.resize?.(w, h)
      for (const particle of renderers.particles) {
        particle.resize?.(w, h)
      }
      for (const entity of renderers.entities) {
        entity.clearCache?.()
      }
    }
    
    // 更新 BlockRenderer 的 DPR
    this.updateRenderersDpr()
  }

  destroy(): void {
    cancelAnimationFrame(this.animFrameId)
    this.registry.destroy()
    console.log('[GameCanvas] Destroyed')
  }

  updateState(state: RenderState): void {
    // 更新核心粒子 (如果存在核心渲染器)
    const prevSkillCount = this.state.energyCore?.skills.length ?? -1
    const newSkillCount = state.energyCore?.skills.length ?? -1
    if (state.energyCore && prevSkillCount !== newSkillCount) {
      const renderers = this.registry.getCurrent()
      renderers?.core?.initParticles?.(state.energyCore)
    }
    
    // 更新执行状态到 BlockRenderer
    const blockRenderer = this.getBlockRenderer()
    if (blockRenderer) {
      blockRenderer.setExecutionState(
        state.executingNexusId ?? null,
        state.executionStartTime ?? null,
      )
    }
    
    // 更新涟漪渲染器的核心状态
    const rippleRenderer = this.getRippleRenderer()
    if (rippleRenderer && state.energyCore) {
      rippleRenderer.setCoreState(state.energyCore)
    }
    
    // 更新网格渲染器的建筑位置（用于道路网络生成）
    const renderers = this.registry.getCurrent()
    if (renderers?.grid?.updateNexusPositions && state.nexuses) {
      const positions = [...state.nexuses.values()].map(n => n.position)
      renderers.grid.updateNexusPositions(positions)
    }
    
    // 更新装饰层的建筑位置（用于避开建筑区域）
    if (renderers?.decorations?.updateNexusPositions && state.nexuses) {
      const positions = [...state.nexuses.values()].map(n => n.position)
      renderers.decorations.updateNexusPositions(positions)
    }
    
    this.state = state
  }

  triggerRipple(x: number, y: number): void {
    const renderers = this.registry.getCurrent()
    renderers?.ripple.trigger(x, y)
  }

  setPalette(palette: CanvasPalette): void {
    this.palette = palette
  }

  // ---- Theme Management ----

  setWorldTheme(theme: WorldTheme): void {
    this.registry.setTheme(theme)
    this.updateRenderersDpr()
  }

  getWorldTheme(): WorldTheme {
    return this.registry.getCurrentTheme()
  }

  // ---- Coordinate Transforms ----

  worldToScreen(gridX: number, gridY: number, camera: CameraState): Point {
    return wts(gridX, gridY, camera, this.canvas.clientWidth, this.canvas.clientHeight)
  }

  screenToWorld(screenX: number, screenY: number, camera: CameraState): { gridX: number; gridY: number } {
    return stw(screenX, screenY, camera, this.canvas.clientWidth, this.canvas.clientHeight)
  }

  // ---- Cache Management ----

  invalidateCache(nexusId: string): void {
    const renderers = this.registry.getCurrent()
    if (renderers) {
      for (const entity of renderers.entities) {
        entity.invalidateCache?.(nexusId)
      }
    }
  }

  clearCache(): void {
    const renderers = this.registry.getCurrent()
    if (renderers) {
      for (const entity of renderers.entities) {
        entity.clearCache?.()
      }
    }
  }

  // ---- Private Methods ----

  private getBlockRenderer(): BlockRenderer | null {
    const renderers = this.registry.getCurrent()
    if (!renderers) return null
    const block = renderers.entities.find(e => e.id === 'block-renderer')
    return block as BlockRenderer | null
  }

  private getRippleRenderer(): CosmosRippleRenderer | null {
    const renderers = this.registry.getCurrent()
    if (!renderers) return null
    if (renderers.ripple.id === 'cosmos-ripple') {
      return renderers.ripple as CosmosRippleRenderer
    }
    return null
  }

  private updateRenderersDpr(): void {
    const blockRenderer = this.getBlockRenderer()
    if (blockRenderer) {
      blockRenderer.setDpr(this.dpr)
    }
  }

  // ---- Main Render Loop ----

  // ---- Pause / Resume ----

  private _paused = false

  /** 暂停渲染循环（House 打开时调用，零 GPU 开销） */
  pause(): void {
    if (this._paused) return
    this._paused = true
    cancelAnimationFrame(this.animFrameId)
  }

  /** 恢复渲染循环（回到世界视图时调用） */
  resume(): void {
    if (!this._paused) return
    this._paused = false
    this.animFrameId = requestAnimationFrame(this.render)
  }

  get paused(): boolean {
    return this._paused
  }

  // ---- Main Render Loop ----

  private _lastLogTime = 0

  private render(timestamp: number): void {
    if (this._paused) return
    this.animFrameId = requestAnimationFrame(this.render)
    
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) {
      if (timestamp - this._lastLogTime > 3000) {
        console.warn('[GameCanvas] Canvas size is 0')
        this._lastLogTime = timestamp
      }
      return
    }

    const ctx = this.ctx
    ctx.clearRect(0, 0, w, h)

    const renderers = this.registry.getCurrent()
    if (!renderers) return

    this._time += 0.002

    const { camera, nexuses, selectedNexusId, renderSettings } = this.state

    // 构建渲染上下文
    const renderCtx: RenderContext = {
      ctx,
      canvas: this.canvas,
      camera,
      palette: this.palette,
      time: this._time,
      dpr: this.dpr,
      width: w,
      height: h,
    }

    // Layer 0: Background
    if (renderSettings.showParticles) {
      renderers.background.render(renderCtx)
    }

    // Layer 1: Grid
    if (renderSettings.showGrid) {
      renderers.grid.render(renderCtx)
    }

    // Layer 1.5: Decorations (树木/灌木，在建筑之前渲染)
    if (renderers.decorations) {
      renderers.decorations.render(renderCtx)
    }

    // Layer 2: Entities (几何积木)
    try {
      if (nexuses && nexuses.size > 0) {
        const sorted = [...nexuses.values()].sort(
          (a, b) => (a.position.gridX + a.position.gridY) - (b.position.gridX + b.position.gridY)
        )
        for (const nexus of sorted) {
          const screen = this.worldToScreen(nexus.position.gridX, nexus.position.gridY, camera)
          // 视锥剔除
          if (screen.x < -120 || screen.x > w + 120 || screen.y < -120 || screen.y > h + 120) continue
          
          const isSelected = nexus.id === selectedNexusId
          
          for (const entityRenderer of renderers.entities) {
            if (entityRenderer.canRender(nexus)) {
              entityRenderer.render(renderCtx, nexus, screen, isSelected, timestamp)
              break
            }
          }
        }
      }
    } catch (e) {
      console.error('[GameCanvas] Entity render error:', e)
    }

    // Layer 3: Particles
    for (const particleRenderer of renderers.particles) {
      particleRenderer.update(timestamp)
      particleRenderer.render(renderCtx)
    }

    // Layer 4: Ripples (交互波纹)
    renderers.ripple.update()
    renderers.ripple.render(renderCtx)
  }
}
