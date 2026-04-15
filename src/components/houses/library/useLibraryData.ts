/**
 * useLibraryData - Library House 数据 hook
 * 简化版: 只管理实体列表、详情查看、JSON 导入
 */

import { useState, useEffect, useCallback } from 'react'
import type { WikiEntitySummary, WikiEntityDetail, LibraryExport } from '@/components/shared/wiki-ui/types'
import { getServerUrl } from '@/utils/env'

export function useLibraryData() {
  const [entities, setEntities] = useState<WikiEntitySummary[]>([])
  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)
  const [entityDetail, setEntityDetail] = useState<WikiEntityDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const baseUrl = getServerUrl()

  const loadEntities = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/entities`)
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

  const loadEntityDetail = useCallback(async (entityId: string) => {
    setDetailLoading(true)
    try {
      const resp = await fetch(`${baseUrl}/api/wiki/entity/${entityId}`)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const data = await resp.json()
      setEntityDetail(data)
    } catch (e) {
      setError('加载实体详情失败: ' + (e as Error).message)
    } finally {
      setDetailLoading(false)
    }
  }, [baseUrl])

  // 选中实体时加载详情
  useEffect(() => {
    if (selectedEntityId) {
      loadEntityDetail(selectedEntityId)
    } else {
      setEntityDetail(null)
    }
  }, [selectedEntityId, loadEntityDetail])

  // 初始加载
  useEffect(() => { loadEntities() }, [loadEntities])

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
    await loadEntities()

    if (errors > 0) {
      setError(`导入完成: ${created} 新建, ${updated} 更新, ${errors} 失败`)
    }

    return { created, updated, errors }
  }, [baseUrl, loadEntities])

  // 搜索过滤
  const filteredEntities = searchQuery
    ? entities.filter(e =>
        e.title.toLowerCase().includes(searchQuery.toLowerCase())
        || (e.tldr && e.tldr.toLowerCase().includes(searchQuery.toLowerCase()))
        || e.tags.some(t => t.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    : entities

  return {
    entities: filteredEntities,
    totalCount: entities.length,
    selectedEntityId,
    setSelectedEntityId,
    entityDetail,
    loading,
    detailLoading,
    importing,
    importProgress,
    error,
    setError,
    searchQuery,
    setSearchQuery,
    refresh: loadEntities,
    handleImport,
  }
}
