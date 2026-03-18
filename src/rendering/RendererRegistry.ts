// ============================================
// DunCrew 渲染器注册表
// ============================================

import type {
  WorldTheme,
  RendererSet,
} from './types'

/**
 * 渲染器注册表
 * 管理不同世界主题对应的渲染器集合
 */
export class RendererRegistry {
  private themes: Map<WorldTheme, RendererSet> = new Map()
  private currentTheme: WorldTheme = 'minimalist'

  /**
   * 注册主题渲染器集合
   */
  register(theme: WorldTheme, renderers: RendererSet): void {
    this.themes.set(theme, renderers)
    console.log(`[RendererRegistry] Registered theme: ${theme}`)
  }

  /**
   * 获取指定主题的渲染器集合
   */
  get(theme: WorldTheme): RendererSet | undefined {
    return this.themes.get(theme)
  }

  /**
   * 获取当前主题的渲染器集合
   */
  getCurrent(): RendererSet | undefined {
    return this.themes.get(this.currentTheme)
  }

  /**
   * 切换当前主题
   */
  setTheme(theme: WorldTheme): void {
    if (!this.themes.has(theme)) {
      console.warn(`[RendererRegistry] Theme not found: ${theme}`)
      return
    }
    
    const oldRenderers = this.themes.get(this.currentTheme)
    const newRenderers = this.themes.get(theme)
    
    // 清理旧渲染器资源
    if (oldRenderers && oldRenderers !== newRenderers) {
      this.disposeRendererSet(oldRenderers)
    }
    
    this.currentTheme = theme
    console.log(`[RendererRegistry] Switched to theme: ${theme}`)
  }

  /**
   * 获取当前主题名称
   */
  getCurrentTheme(): WorldTheme {
    return this.currentTheme
  }

  /**
   * 获取所有已注册的主题
   */
  getRegisteredThemes(): WorldTheme[] {
    return Array.from(this.themes.keys())
  }

  /**
   * 检查主题是否已注册
   */
  hasTheme(theme: WorldTheme): boolean {
    return this.themes.has(theme)
  }

  /**
   * 清理指定渲染器集合的资源
   */
  private disposeRendererSet(renderers: RendererSet): void {
    renderers.background.dispose?.()
    renderers.grid.dispose?.()
    renderers.decorations?.dispose?.()
    renderers.core?.dispose?.()
    renderers.ripple.dispose?.()
    
    for (const entity of renderers.entities) {
      entity.dispose?.()
    }
    
    for (const particle of renderers.particles) {
      particle.dispose?.()
    }
  }

  /**
   * 销毁所有渲染器
   */
  destroy(): void {
    for (const renderers of this.themes.values()) {
      this.disposeRendererSet(renderers)
    }
    this.themes.clear()
    console.log('[RendererRegistry] Destroyed')
  }
}

// ============================================
// 辅助工厂函数
// ============================================

/**
 * 创建空的渲染器集合 (用于测试或占位)
 */
export function createEmptyRendererSet(): RendererSet {
  const noop = () => {}
  
  return {
    background: { id: 'empty-bg', render: noop },
    grid: { id: 'empty-grid', render: noop },
    entities: [],
    particles: [],
    // core 已移除
    ripple: { id: 'empty-ripple', trigger: noop, update: noop, render: noop },
  }
}

/**
 * 合并渲染器集合
 * 用于扩展或覆盖部分渲染器
 */
export function mergeRendererSets(
  base: RendererSet,
  override: Partial<RendererSet>,
): RendererSet {
  return {
    background: override.background ?? base.background,
    grid: override.grid ?? base.grid,
    decorations: override.decorations ?? base.decorations,
    entities: override.entities ?? base.entities,
    particles: override.particles ?? base.particles,
    core: override.core ?? base.core,
    ripple: override.ripple ?? base.ripple,
  }
}
