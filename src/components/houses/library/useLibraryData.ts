/**
 * useLibraryData - Library House 数据 hook
 * 三层视图: 首页 → 列表 → 详情
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { WikiEntitySummary, WikiEntityDetail, LibraryExport } from '@/components/shared/wiki-ui/types'
import { getServerUrl } from '@/utils/env'

/** 三层视图状态 */
export type LibraryView =
  | { type: 'home' }                                      // 智能首页
  | { type: 'list'; category?: string }                   // 分类列表
  | { type: 'detail'; entityId: string }                  // 实体详情

export interface WikiStats {
  totalEntities: number
  totalClaims: number
  totalRelations: number
  types: { name: string; count: number }[]
  categories: { name: string; count: number }[]
  recentEntities: { id: string; title: string; type: string; category: string | null; updatedAt: number }[]
  recentIngests: { id: string; createdAt: number; entitiesAffected: string[] }[]
  healthIssues: { conflicts: number; emptyEntities: number }
}

export interface SearchResult {
  entityId: string
  title: string
  type: string
  tldr: string | null
  score: number
  claims: { content: string; type: string | null; confidence: number }[]
}

export interface LibrarianContext {
  entityOverview: string
  prompt: string
  entityCount: number
}

export type BatchAction = {
  op: 'archive' | 'unarchive' | 'tag' | 'untag' | 'set_category' | 'delete'
  ids: string[]
  value?: string
}

export function useLibraryData() {
  const [view, setView] = useState<LibraryView>({ type: 'home' })
  const [entities, setEntities] = useState<WikiEntitySummary[]>([])
  const [entityDetail, setEntityDetail] = useState<WikiEntityDetail | null>(null)
  const [stats, setStats] = useState<WikiStats | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // P3: 批量选择状态
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // P4: Librarian 状态
  const [librarianContext, setLibrarianContext] = useState<LibrarianContext | null>(null)
  const [librarianLoading, setLibrarianLoading] = useState(false)

  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const baseUrl = getServerUrl()

  // ── Stats 加载 ──
  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/stats`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      setStats(await resp.json())
    } catch {
      // stats 加载失败不阻塞
    } finally {
      setStatsLoading(false)
    }
  }, [baseUrl])

  // ── 实体列表加载（支持 category 过滤）──
  const loadEntities = useCallback(async (category?: string) => {
    setLoading(true)
    setError(null)
    try {
      const url = category
        ? `${baseUrl}/api/wiki/entities?category=${encodeURIComponent(category)}`
        : `${baseUrl}/api/wiki/entities`
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setEntities(Array.isArray(data) ? data : [])
    } catch (e) {
      setError('加载实体列表失败: ' + (e as Error).message)
      setEntities([])
    } finally {
      setLoading(false)
    }
  }, [baseUrl])

  // ── 实体详情加载 ──
  const loadEntityDetail = useCallback(async (entityId: string) => {
    setDetailLoading(true)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/entity/${entityId}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      setEntityDetail(await resp.json())
    } catch (e) {
      setError('加载实体详情失败: ' + (e as Error).message)
    } finally {
      setDetailLoading(false)
    }
  }, [baseUrl])

  // ── 语义搜索 ──
  const doSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null)
      return
    }
    setSearchLoading(true)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/search?q=${encodeURIComponent(query)}&limit=10`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setSearchResults(Array.isArray(data) ? data : [])
    } catch {
      setSearchResults(null)
    } finally {
      setSearchLoading(false)
    }
  }, [baseUrl])

  // ── 视图切换响应 ──
  useEffect(() => {
    if (view.type === 'home') {
      loadStats()
    } else if (view.type === 'list') {
      loadEntities(view.category)
    } else if (view.type === 'detail') {
      loadEntityDetail(view.entityId)
    }
  }, [view, loadStats, loadEntities, loadEntityDetail])

  // 初始加载首页 stats
  useEffect(() => { loadStats() }, [loadStats])

  // ── 搜索防抖 ──
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    searchTimerRef.current = setTimeout(() => doSearch(searchQuery), 300)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [searchQuery, doSearch])

  // ── 导航动作 ──
  const goHome = useCallback(() => {
    setView({ type: 'home' })
    setSearchQuery('')
    setSearchResults(null)
    setEntityDetail(null)
  }, [])

  const goCategory = useCallback((category?: string) => {
    setView({ type: 'list', category })
    setSearchResults(null)
    setEntityDetail(null)
  }, [])

  const goEntity = useCallback((entityId: string) => {
    setView({ type: 'detail', entityId })
    setSearchResults(null)
  }, [])

  // ── 导入 ──
  const handleImport = useCallback(async (exportData: LibraryExport) => {
    if (!exportData.entities?.length) {
      setError('导入数据中没有实体')
      return
    }

    setImporting(true)
    setImportProgress({ current: 0, total: exportData.entities.length })
    setError(null)

    let created = 0
    let updated = 0
    let errors = 0

    for (let i = 0; i < exportData.entities.length; i++) {
      const entity = exportData.entities[i]
      setImportProgress({ current: i + 1, total: exportData.entities.length })

      try {
        const resp = await fetch(`${baseUrl}/api/wiki/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            op: 'create',
            dun_id: null,
            entity: {
              title: entity.title,
              type: entity.type,
              tldr: entity.tldr,
              tags: entity.tags,
              slug: entity.slug,
            },
            claims: entity.claims.map(c => ({
              content: c.content,
              type: c.type,
              value: c.value,
              trend: c.trend,
              confidence: c.confidence,
              evidence: c.evidence,
            })),
            relations: entity.relations.map(r => ({
              target_title: r.target_title,
              type: r.type,
              strength: r.strength,
              description: r.description,
            })),
          }),
        })

        if (!resp.ok) {
          errors++
          continue
        }

        const result = await resp.json()
        if (result.op === 'create') created++
        else if (result.op === 'update') updated++
      } catch {
        errors++
      }
    }

    setImporting(false)
    setImportProgress(null)
    // 刷新 stats 和当前视图
    loadStats()
    if (view.type === 'list') loadEntities(view.category)

    if (errors > 0) {
      setError(`导入完成: ${created} 新建, ${updated} 更新, ${errors} 失败`)
    }

    return { created, updated, errors }
  }, [baseUrl, loadStats, loadEntities, view])

  // ── P3: 批量操作 ──
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(entities.map(e => e.id)))
  }, [entities])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const batchAction = useCallback(async (action: BatchAction) => {
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const result = await resp.json()
      setSelectedIds(new Set())
      // 刷新
      loadStats()
      if (view.type === 'list') loadEntities(view.category)
      return result as { affected: number }
    } catch (e) {
      setError('批量操作失败: ' + (e as Error).message)
    }
  }, [baseUrl, loadStats, loadEntities, view])

  // ── P4: Librarian ──
  const startLibrarian = useCallback(async (scope?: string, category?: string) => {
    setLibrarianLoading(true)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/librarian`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: scope || 'full', category }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      setLibrarianContext(await resp.json())
    } catch (e) {
      setError('Librarian 启动失败: ' + (e as Error).message)
    } finally {
      setLibrarianLoading(false)
    }
  }, [baseUrl])

  const executeLibrarianActions = useCallback(async (actions: Record<string, unknown>[]) => {
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/librarian/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const result = await resp.json()
      setLibrarianContext(null)
      // 刷新
      loadStats()
      if (view.type === 'list') loadEntities(view.category)
      return result as { executed: number; errors: string[] }
    } catch (e) {
      setError('Librarian 执行失败: ' + (e as Error).message)
    }
  }, [baseUrl, loadStats, loadEntities, view])

  // ── 列表文本过滤（列表视图本地辅助） ──
  const filteredEntities = searchQuery && view.type === 'list' && !searchResults
    ? entities.filter(e =>
        e.title.toLowerCase().includes(searchQuery.toLowerCase())
        || (e.tldr && e.tldr.toLowerCase().includes(searchQuery.toLowerCase()))
        || e.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : entities

  return {
    // 视图状态
    view,
    goHome,
    goCategory,
    goEntity,
    // 数据
    entities: filteredEntities,
    totalCount: entities.length,
    entityDetail,
    stats,
    searchResults,
    // 加载状态
    loading,
    detailLoading,
    statsLoading,
    searchLoading,
    // 搜索
    searchQuery,
    setSearchQuery,
    // 导入
    importing,
    importProgress,
    handleImport,
    // P3: 批量操作
    selectedIds,
    toggleSelect,
    selectAll,
    clearSelection,
    batchAction,
    // P4: Librarian
    librarianContext,
    librarianLoading,
    startLibrarian,
    executeLibrarianActions,
    // 其他
    error,
    setError,
    refresh: () => {
      loadStats()
      if (view.type === 'list') loadEntities(view.category)
    },
  }
}
