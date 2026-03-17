// ============================================
// DD-OS 渲染器集合工厂
// ============================================

import type { RendererSet } from './types'

// 极简主题
import { MinimalistBackground } from './backgrounds/MinimalistBackground'
import { MinimalistGrid } from './backgrounds/MinimalistGrid'
import { BlockRenderer } from './entities/BlockRenderer'
import { MinimalistDecoRenderer } from './decorations/MinimalistDecoRenderer'

// 共享涟漪渲染器
import { CosmosRippleRenderer } from './backgrounds/CosmosRipple'

/**
 * 创建 Minimalist 主题渲染器集合
 * 治愈系几何积木 - Stripe/Monument Valley 风格
 */
export function createMinimalistRenderers(): RendererSet {
  return {
    background: new MinimalistBackground(),
    grid: new MinimalistGrid(),
    decorations: new MinimalistDecoRenderer(),
    entities: [new BlockRenderer()],
    particles: [],
    ripple: new CosmosRippleRenderer(),
  }
}

// 导出所有类型
export * from './types'

// 导出注册表
export { RendererRegistry, createEmptyRendererSet, mergeRendererSets } from './RendererRegistry'

// 导出工具函数
export { worldToScreen, screenToWorld, isInViewport, TILE_WIDTH, TILE_HEIGHT } from './utils/coordinateTransforms'
export { createBufferCanvas, getBufferContext, LRUCache, RenderCacheManager } from './utils/cacheManager'

// 导出渲染器类 (供扩展使用)
export { CosmosRippleRenderer } from './backgrounds/CosmosRipple'
export { MinimalistBackground } from './backgrounds/MinimalistBackground'
export { MinimalistGrid } from './backgrounds/MinimalistGrid'
export { BlockRenderer } from './entities/BlockRenderer'
export { MinimalistDecoRenderer } from './decorations/MinimalistDecoRenderer'
