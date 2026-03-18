// ============================================
// DunCrew 渲染缓存管理器
// ============================================

import type { BufferCanvas, Ctx2D } from '../types'

/**
 * 创建离屏画布
 * 优先使用 OffscreenCanvas，fallback 到 HTMLCanvasElement
 */
export function createBufferCanvas(w: number, h: number): BufferCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h)
      const testCtx = oc.getContext('2d')
      if (testCtx) return oc
    } catch (_e) {
      console.warn('[CacheManager] OffscreenCanvas fallback')
    }
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  return canvas
}

/**
 * 获取画布 2D 上下文
 */
export function getBufferContext(canvas: BufferCanvas): Ctx2D | null {
  return canvas.getContext('2d') as Ctx2D | null
}

/**
 * LRU 缓存管理器
 * 用于管理渲染缓存，自动淘汰最近最少使用的条目
 */
export class LRUCache<K, V> {
  private cache: Map<K, V> = new Map()
  private readonly maxSize: number

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key)
    if (value !== undefined) {
      // 移到末尾 (最近使用)
      this.cache.delete(key)
      this.cache.set(key, value)
    }
    return value
  }

  set(key: K, value: V): void {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }
    // 检查容量
    while (this.cache.size >= this.maxSize) {
      // 删除最旧的 (第一个)
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  has(key: K): boolean {
    return this.cache.has(key)
  }

  delete(key: K): boolean {
    return this.cache.delete(key)
  }

  /**
   * 删除所有以指定前缀开头的键
   */
  deleteByPrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        this.cache.delete(key)
      }
    }
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  keys(): IterableIterator<K> {
    return this.cache.keys()
  }
}

/**
 * 渲染缓存管理器
 * 专门用于管理 OffscreenCanvas 缓存
 */
export class RenderCacheManager {
  private cache: LRUCache<string, BufferCanvas>
  private dpr: number = 1

  constructor(maxSize: number = 100) {
    this.cache = new LRUCache(maxSize)
  }

  setDpr(dpr: number): void {
    if (this.dpr !== dpr) {
      this.dpr = dpr
      this.clear() // DPR 变化时清空缓存
    }
  }

  getDpr(): number {
    return this.dpr
  }

  /**
   * 获取或创建缓存
   */
  getOrCreate(
    key: string,
    width: number,
    height: number,
    renderFn: (ctx: Ctx2D, w: number, h: number, dpr: number) => void,
  ): BufferCanvas | null {
    let cached = this.cache.get(key)
    if (cached) return cached

    const buffer = createBufferCanvas(width * this.dpr, height * this.dpr)
    const ctx = getBufferContext(buffer)
    if (!ctx) return null

    ctx.scale(this.dpr, this.dpr)
    renderFn(ctx, width, height, this.dpr)
    
    this.cache.set(key, buffer)
    return buffer
  }

  get(key: string): BufferCanvas | undefined {
    return this.cache.get(key)
  }

  set(key: string, buffer: BufferCanvas): void {
    this.cache.set(key, buffer)
  }

  invalidate(nexusId: string): void {
    this.cache.deleteByPrefix(`planet_${nexusId}`)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }
}
