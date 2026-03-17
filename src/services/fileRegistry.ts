/**
 * FileRegistry - 文件路径注册表服务
 *
 * 维护 Agent 访问过的文件路径 → 元数据的 O(1) 查找表。
 * 作为 Agent 的"文件认知地图"，减少重复探索和上下文污染。
 *
 * 功能：
 * - 自动注册：executeTool() 中文件操作成功后自动注册
 * - 被动清理：ENOENT 错误时自动移除条目
 * - 上下文注入：buildDynamicContext() 中注入已知文件列表
 * - LRU 淘汰：超过 MAX_ENTRIES 时按 lastAccessed 淘汰
 * - localStorage 持久化（debounced）
 */

import type { FileRegistryEntry } from '@/types'
import { FILE_REGISTRY_CONFIG } from '@/types'

// ============================================
// 路径归一化工具
// ============================================

/** 归一化路径：统一使用 / 分隔，去掉末尾 / */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** ENOENT 错误匹配模式 */
const ENOENT_PATTERNS = [
  'enoent',
  'file not found',
  'no such file',
  '文件不存在',
  '找不到文件',
  'not found:',
] as const

function isFileNotFoundError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return ENOENT_PATTERNS.some(p => lower.includes(p))
}

// ============================================
// FileRegistryService
// ============================================

class FileRegistryService {
  private registry = new Map<string, FileRegistryEntry>()
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.load()
  }

  // ═══ 核心操作 ═══

  /**
   * 注册/更新文件条目
   * - writeFile/appendFile: 更新 mtime (文件被修改)
   * - readFile: 不更新 mtime (只是读取)
   * - listDir: 不注册 (目录本身不需要跟踪)
   */
  register(path: string, toolName: string, nexusId: string | null): void {
    if (!path || toolName === 'listDir') return

    const key = normalizePath(path)
    const now = Date.now()
    const existing = this.registry.get(key)

    if (existing) {
      existing.lastAccessed = now
      existing.accessCount++
      // 写操作更新 mtime
      if (toolName === 'writeFile' || toolName === 'appendFile') {
        existing.mtime = now
      }
      // 如果之前没有关联 Nexus，补上
      if (!existing.nexusId && nexusId) {
        existing.nexusId = nexusId
      }
    } else {
      const entry: FileRegistryEntry = {
        path: key,
        mtime: (toolName === 'writeFile' || toolName === 'appendFile') ? now : now,
        lastAccessed: now,
        accessCount: 1,
        nexusId: nexusId,
        registeredAt: now,
      }
      this.registry.set(key, entry)
    }

    this.prune()
    this.schedulePersist()
  }

  /** O(1) 路径查找 */
  lookup(path: string): FileRegistryEntry | undefined {
    return this.registry.get(normalizePath(path))
  }

  /**
   * 获取已知文件列表
   * @param nexusId 可选过滤，只返回该 Nexus 关联的文件
   */
  getKnownFiles(nexusId?: string): FileRegistryEntry[] {
    const entries = Array.from(this.registry.values())
    const filtered = nexusId
      ? entries.filter(e => e.nexusId === nexusId)
      : entries
    return filtered.sort((a, b) => b.lastAccessed - a.lastAccessed)
  }

  /** 注册表大小 */
  get size(): number {
    return this.registry.size
  }

  // ═══ 上下文构建 ═══

  /**
   * 构建上下文注入段落
   * 格式化为 Markdown，供 buildDynamicContext() 注入系统提示词
   */
  buildContextSection(nexusId?: string, maxEntries = 15): string {
    const files = this.getKnownFiles(nexusId).slice(0, maxEntries)
    if (files.length === 0) return ''

    const now = Date.now()
    const lines = files.map(f => {
      const name = f.path.split('/').pop() || f.path
      const dir = f.path.split('/').slice(0, -1).join('/')
      const recency = this.formatRecency(now - f.lastAccessed)
      const countStr = f.accessCount > 1 ? `${f.accessCount}次访问` : '1次访问'
      return `- ${dir ? dir + '/' : ''}**${name}** (${countStr}, ${recency})`
    })

    return `## 已知文件路径\n以下文件已被访问过，无需重复探索：\n${lines.join('\n')}`
  }

  // ═══ 错误处理 ═══

  /**
   * 处理工具执行错误
   * 如果错误匹配 ENOENT，自动从 registry 移除
   */
  handleToolError(path: string, errorMsg: string): void {
    if (!path) return
    if (isFileNotFoundError(errorMsg)) {
      const key = normalizePath(path)
      if (this.registry.delete(key)) {
        console.log(`[FileRegistry] Auto-removed missing file: ${key}`)
        this.schedulePersist()
      }
    }
  }

  // ═══ 持久化 ═══

  /** 从 localStorage 恢复 */
  private load(): void {
    try {
      const raw = localStorage.getItem(FILE_REGISTRY_CONFIG.LOCALSTORAGE_KEY)
      if (!raw) return

      const entries: FileRegistryEntry[] = JSON.parse(raw)
      const now = Date.now()

      for (const entry of entries) {
        // 过滤过期条目
        if (now - entry.lastAccessed > FILE_REGISTRY_CONFIG.STALE_THRESHOLD_MS) {
          continue
        }
        this.registry.set(entry.path, entry)
      }

      console.log(`[FileRegistry] Loaded ${this.registry.size} entries from localStorage`)
    } catch (err) {
      console.warn('[FileRegistry] Failed to load from localStorage:', err)
    }
  }

  /** Debounced 持久化到 localStorage */
  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
    }
    this.persistTimer = setTimeout(() => {
      this.persist()
      this.persistTimer = null
    }, FILE_REGISTRY_CONFIG.PERSIST_DEBOUNCE_MS)
  }

  private persist(): void {
    try {
      const entries = Array.from(this.registry.values())
      localStorage.setItem(
        FILE_REGISTRY_CONFIG.LOCALSTORAGE_KEY,
        JSON.stringify(entries),
      )
    } catch (err) {
      console.warn('[FileRegistry] Failed to persist:', err)
    }
  }

  // ═══ 维护 ═══

  /** LRU 淘汰：超过 MAX_ENTRIES 时移除最久未访问的条目 */
  private prune(): void {
    if (this.registry.size <= FILE_REGISTRY_CONFIG.MAX_ENTRIES) return

    const entries = Array.from(this.registry.entries())
      .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)

    const toRemove = entries.length - FILE_REGISTRY_CONFIG.MAX_ENTRIES
    for (let i = 0; i < toRemove; i++) {
      this.registry.delete(entries[i][0])
    }
  }

  /** 格式化相对时间 */
  private formatRecency(ms: number): string {
    const minutes = Math.floor(ms / 60000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes}分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}小时前`
    const days = Math.floor(hours / 24)
    return `${days}天前`
  }

  /** 清空注册表 (测试用) */
  clear(): void {
    this.registry.clear()
    localStorage.removeItem(FILE_REGISTRY_CONFIG.LOCALSTORAGE_KEY)
  }
}

// 导出单例
export const fileRegistry = new FileRegistryService()
