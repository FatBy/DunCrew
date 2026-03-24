/**
 * useMemoryData - 记忆宫殿数据层 Hook
 *
 * 聚合 L0 核心记忆、L1 底层推演、执行轨迹、概念图谱所需的全部数据。
 * 将 memoryStore / confidenceTracker / fileRegistry / Zustand store 的分散数据
 * 统一为 UI 可直接消费的结构化视图模型。
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useStore } from '@/store'
import { memoryStore } from '@/services/memoryStore'
import { confidenceTracker } from '@/services/confidenceTracker'
import { fileRegistry } from '@/services/fileRegistry'
import type { MemorySearchResult, NexusEntity, L1MemoryEntry } from '@/types'

// ============================================
// 视图模型类型
// ============================================

/** L0 核心记忆卡片 */
export interface L0MemoryCard {
  id: string
  content: string
  snippet: string
  nexusId: string | undefined
  nexusLabel: string | undefined
  tags: string[]
  createdAt: number
  confidence: number
  /** 关联的 L1 条目数量 */
  l1Count: number
  /** 关联的执行轨迹数量 */
  traceCount: number
  /** 原始搜索结果 */
  raw: MemorySearchResult
}

/** 执行轨迹条目 */
export interface TraceEntry {
  id: string
  timestamp: number
  nexusId: string | undefined
  nexusLabel: string | undefined
  /** 操作类型 */
  operationType: 'read' | 'write' | 'edit' | 'command' | 'unknown'
  /** 操作摘要 */
  summary: string
  /** 操作目标文件路径 */
  filePath: string | undefined
  /** 代码片段预览 */
  codePreview: string | undefined
  /** 原始数据 */
  raw: MemorySearchResult
}

/** 概念图谱节点 */
export interface GraphNode {
  id: string
  label: string
  type: 'core' | 'tag' | 'file'
  /** 关联的记忆/轨迹数量（决定节点大小） */
  weight: number
}

/** 概念图谱边 */
export interface GraphEdge {
  source: string
  target: string
}

/** 透视镜面板数据（点击 L0 卡片后展开） */
export interface LensData {
  /** 选中的 L0 记忆 */
  memory: L0MemoryCard
  /** 关联的执行轨迹 */
  relatedTraces: TraceEntry[]
  /** 底层 L1 推演条目 */
  l1Entries: L1MemoryEntry[]
  /** 加载状态 */
  loading: boolean
}

/** 活跃神经元统计 */
export interface NeuronStats {
  /** L1 总条目数 */
  totalL1: number
  /** 已晋升到 L0 的数量 */
  promotedCount: number
  /** 平均置信度 */
  averageConfidence: number
  /** 固化进度百分比 (promoted / total) */
  solidificationPercent: number
}

/** Hook 返回值 */
export interface MemoryDataState {
  /** L0 核心记忆列表 */
  l0Memories: L0MemoryCard[]
  /** 全局执行轨迹列表 */
  traces: TraceEntry[]
  /** 概念图谱节点 */
  graphNodes: GraphNode[]
  /** 概念图谱边 */
  graphEdges: GraphEdge[]
  /** 活跃神经元统计 */
  neuronStats: NeuronStats
  /** 当前选中的 L0 记忆 ID */
  selectedMemoryId: string | null
  /** 透视镜面板数据 */
  lensData: LensData | null
  /** 加载状态 */
  loading: boolean
  /** L0 记忆总数 */
  l0Count: number
  /** 执行轨迹总数 */
  traceCount: number
  /** 选中一条 L0 记忆（展开透视镜） */
  selectMemory: (memoryId: string | null) => void
  /** 搜索记忆 */
  searchMemories: (query: string) => Promise<void>
  /** 刷新全部数据 */
  refresh: () => Promise<void>
}

// ============================================
// 工具函数
// ============================================

/** 从工具名推断操作类型 */
function inferOperationType(actionOrSource: string): TraceEntry['operationType'] {
  const lower = actionOrSource.toLowerCase()
  if (lower.includes('read') || lower.includes('search') || lower.includes('list')) return 'read'
  if (lower.includes('write') || lower.includes('create') || lower.includes('append')) return 'write'
  if (lower.includes('edit') || lower.includes('update') || lower.includes('modify')) return 'edit'
  if (lower.includes('cmd') || lower.includes('run') || lower.includes('exec') || lower.includes('command')) return 'command'
  return 'unknown'
}

/** 从 MemorySearchResult 的 metadata 中提取文件路径 */
function extractFilePath(result: MemorySearchResult): string | undefined {
  const meta = result.metadata
  if (!meta) return undefined
  if (typeof meta.file === 'string') return meta.file
  if (typeof meta.path === 'string') return meta.path
  if (typeof meta.target === 'string' && (meta.target as string).includes('.')) return meta.target as string
  return undefined
}

/** 清理 trace summary，提取核心信息 */
function cleanTraceSummary(raw: string): string {
  let cleaned = raw.replace(/^Task:\s*/i, '')
  const toolsIdx = cleaned.indexOf('\nTools:')
  if (toolsIdx > 0) cleaned = cleaned.slice(0, toolsIdx)
  const durIdx = cleaned.indexOf('\nDuration:')
  if (durIdx > 0) cleaned = cleaned.slice(0, durIdx)
  if (cleaned.length > 120) cleaned = cleaned.slice(0, 117) + '...'
  return cleaned.trim()
}

/** 从 MemorySearchResult 的 metadata 中提取代码预览 */
function extractCodePreview(result: MemorySearchResult): string | undefined {
  const meta = result.metadata
  if (!meta) return undefined
  if (typeof meta.resultPreview === 'string') return meta.resultPreview
  if (typeof meta.codeSnippet === 'string') return meta.codeSnippet
  return result.snippet?.slice(0, 300) || undefined
}

/** 构建 nexusId → label 的查找表 */
function buildNexusLabelMap(nexuses: Map<string, NexusEntity>): Map<string, string> {
  const labelMap = new Map<string, string>()
  for (const [id, nexus] of nexuses) {
    labelMap.set(id, nexus.label || id)
  }
  return labelMap
}

// ============================================
// 主 Hook
// ============================================

export function useMemoryData(): MemoryDataState {
  const nexuses = useStore(s => s.nexuses)
  const connectionStatus = useStore(s => s.connectionStatus)
  const isConnected = connectionStatus === 'connected'

  // 从 store 读取缓存的记忆数据
  const memoryCacheRaw = useStore(s => s.memoryCacheRaw)
  const memoryCacheVersion = useStore(s => s.memoryCacheVersion)
  const memoryCacheLoaded = useStore(s => s.memoryCacheLoaded)
  const setMemoryCacheRaw = useStore(s => s.setMemoryCacheRaw)

  // 搜索模式的本地 state（临时，不缓存到 store）
  const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null)
  const [lensData, setLensData] = useState<LensData | null>(null)

  // 防止并发刷新
  const refreshLock = useRef(false)

  // nexus label 查找表
  const nexusLabelMap = useMemo(() => buildNexusLabelMap(nexuses), [nexuses])

  // ── 初次加载（仅在 store 未加载时 fetch） ──

  const loadMemoryCache = useCallback(async () => {
    if (!isConnected || refreshLock.current) return
    refreshLock.current = true
    setLoading(true)

    try {
      const allResults = await memoryStore.search({
        query: '*',
        maxResults: 500,
        minScore: 0,
        useMmr: false,
      })
      // 写入 store，固化
      setMemoryCacheRaw(allResults)
    } catch (error) {
      console.warn('[useMemoryData] Failed to load memory cache:', error)
    } finally {
      setLoading(false)
      refreshLock.current = false
    }
  }, [isConnected, setMemoryCacheRaw])

  // 仅在 store 未加载时触发 fetch
  useEffect(() => {
    if (isConnected && !memoryCacheLoaded) {
      loadMemoryCache()
    }
  }, [isConnected, memoryCacheLoaded, loadMemoryCache])

  // ── 按 source 分类（从 store 缓存或搜索结果） ──

  const activeData = searchResults ?? memoryCacheRaw

  const rawL0 = useMemo(
    () => activeData.filter(r => r.source === 'memory'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, memoryCacheVersion],
  )
  const rawTraces = useMemo(
    () => activeData.filter(r => r.source === 'exec_trace'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, memoryCacheVersion],
  )
  const rawL1 = useMemo(
    () => activeData.filter(r => r.source === 'l1_memory'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeData, memoryCacheVersion],
  )

  // ── L0 核心记忆视图模型 ──

  const l0Memories = useMemo<L0MemoryCard[]>(() => {
    return rawL0
      .map(result => {
        const nexusId = result.nexusId
        const trackedEntry = result.id ? confidenceTracker.getEntry(result.id) : undefined
        const confidence = trackedEntry?.confidence
          ?? (result.metadata?.confidence as number | undefined)
          ?? result.confidence
          ?? result.score
          ?? 0.5

        // 按 nexusId 聚合 L1 和 Trace 计数
        const l1Count = nexusId
          ? rawL1.filter(l1 => l1.nexusId === nexusId).length
          : 0
        const relatedTraceCount = nexusId
          ? rawTraces.filter(tr => tr.nexusId === nexusId).length
          : 0

        return {
          id: result.id,
          content: result.content || result.snippet || '',
          snippet: result.snippet || '',
          nexusId,
          nexusLabel: nexusId ? nexusLabelMap.get(nexusId) : undefined,
          tags: Array.isArray(result.tags) ? result.tags : [],
          createdAt: result.createdAt || 0,
          confidence,
          l1Count,
          traceCount: relatedTraceCount,
          raw: result,
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [rawL0, rawL1, rawTraces, nexusLabelMap])

  // ── 执行轨迹视图模型 ──

  const traces = useMemo<TraceEntry[]>(() => {
    return rawTraces
      .map(result => {
        const actionName = (result.metadata?.action as string)
          || (result.metadata?.toolName as string)
          || ''
        return {
          id: result.id,
          timestamp: result.createdAt || 0,
          nexusId: result.nexusId,
          nexusLabel: result.nexusId ? nexusLabelMap.get(result.nexusId) : undefined,
          operationType: inferOperationType(actionName || result.snippet || ''),
          summary: cleanTraceSummary(result.snippet || result.content || ''),
          filePath: extractFilePath(result),
          codePreview: extractCodePreview(result),
          raw: result,
        }
      })
      .sort((a, b) => b.timestamp - a.timestamp)
  }, [rawTraces, nexusLabelMap])

  // ── 概念图谱 ──

  const { graphNodes, graphEdges } = useMemo(() => {
    const nodes: GraphNode[] = []
    const edges: GraphEdge[] = []
    const nodeIdSet = new Set<string>()

    // 1. Core 节点：从有记忆关联的 nexus 中提取
    const nexusMemoryCount = new Map<string, number>()
    for (const mem of rawL0) {
      if (mem.nexusId) {
        nexusMemoryCount.set(mem.nexusId, (nexusMemoryCount.get(mem.nexusId) || 0) + 1)
      }
    }
    for (const tr of rawTraces) {
      if (tr.nexusId) {
        nexusMemoryCount.set(tr.nexusId, (nexusMemoryCount.get(tr.nexusId) || 0) + 1)
      }
    }

    for (const [nexusId, count] of nexusMemoryCount) {
      const coreId = `core:${nexusId}`
      nodes.push({
        id: coreId,
        label: nexusLabelMap.get(nexusId) || nexusId,
        type: 'core',
        weight: count,
      })
      nodeIdSet.add(coreId)
    }

    // 2. Tag 节点：从 L0 记忆的 tags 去重提取
    const tagNexusLinks = new Map<string, Set<string>>()
    for (const mem of rawL0) {
      if (!Array.isArray(mem.tags) || !mem.nexusId) continue
      for (const tag of mem.tags) {
        if (!tagNexusLinks.has(tag)) {
          tagNexusLinks.set(tag, new Set())
        }
        tagNexusLinks.get(tag)!.add(mem.nexusId)
      }
    }

    for (const [tag, linkedNexuses] of tagNexusLinks) {
      const tagId = `tag:${tag}`
      nodes.push({
        id: tagId,
        label: `#${tag}`,
        type: 'tag',
        weight: linkedNexuses.size,
      })
      nodeIdSet.add(tagId)

      for (const nexusId of linkedNexuses) {
        const coreId = `core:${nexusId}`
        if (nodeIdSet.has(coreId)) {
          edges.push({ source: tagId, target: coreId })
        }
      }
    }

    // 3. File 节点：从 exec_trace 和 fileRegistry 提取
    const fileNexusLinks = new Map<string, Set<string>>()

    for (const tr of rawTraces) {
      const filePath = extractFilePath(tr)
      if (!filePath || !tr.nexusId) continue
      const fileName = filePath.split('/').pop() || filePath
      if (!fileNexusLinks.has(fileName)) {
        fileNexusLinks.set(fileName, new Set())
      }
      fileNexusLinks.get(fileName)!.add(tr.nexusId)
    }

    const knownFiles = fileRegistry.getKnownFiles()
    for (const entry of knownFiles) {
      if (!entry.nexusId) continue
      const fileName = entry.path.split('/').pop() || entry.path
      if (!fileNexusLinks.has(fileName)) {
        fileNexusLinks.set(fileName, new Set())
      }
      fileNexusLinks.get(fileName)!.add(entry.nexusId)
    }

    for (const [fileName, linkedNexuses] of fileNexusLinks) {
      const fileId = `file:${fileName}`
      nodes.push({
        id: fileId,
        label: fileName,
        type: 'file',
        weight: linkedNexuses.size,
      })
      nodeIdSet.add(fileId)

      for (const nexusId of linkedNexuses) {
        const coreId = `core:${nexusId}`
        if (nodeIdSet.has(coreId)) {
          edges.push({ source: fileId, target: coreId })
        }
      }
    }

    // 4. Tag 之间的横向连接：共享同一个 nexus 的 tag 互相连接
    const tagIds = nodes.filter(n => n.type === 'tag').map(n => n.id)
    for (let i = 0; i < tagIds.length; i++) {
      for (let j = i + 1; j < tagIds.length; j++) {
        const tagA = tagIds[i].replace('tag:', '')
        const tagB = tagIds[j].replace('tag:', '')
        const nexusesA = tagNexusLinks.get(tagA)
        const nexusesB = tagNexusLinks.get(tagB)
        if (nexusesA && nexusesB) {
          const hasOverlap = [...nexusesA].some(n => nexusesB.has(n))
          if (hasOverlap) {
            edges.push({ source: tagIds[i], target: tagIds[j] })
          }
        }
      }
    }

    return { graphNodes: nodes, graphEdges: edges }
  }, [rawL0, rawTraces, nexusLabelMap])

  // ── 活跃神经元统计 ──

  const neuronStats = useMemo<NeuronStats>(() => {
    const trackerStats = confidenceTracker.getStats()
    const totalL1 = Math.max(trackerStats.total, rawL1.length)
    const promotedCount = trackerStats.promoted
    const solidificationPercent = totalL1 > 0
      ? Math.round((promotedCount / totalL1) * 100)
      : 0

    return {
      totalL1,
      promotedCount,
      averageConfidence: trackerStats.avgConfidence,
      solidificationPercent,
    }
  }, [rawL1.length])

  // ── 透视镜：选中 L0 记忆后加载关联数据 ──

  const selectMemory = useCallback(async (memoryId: string | null) => {
    setSelectedMemoryId(memoryId)

    if (!memoryId) {
      setLensData(null)
      return
    }

    const selectedCard = l0Memories.find(m => m.id === memoryId)
    if (!selectedCard) {
      setLensData(null)
      return
    }

    setLensData({
      memory: selectedCard,
      relatedTraces: [],
      l1Entries: [],
      loading: true,
    })

    const targetNexusId = selectedCard.nexusId

    // 按 nexusId 过滤关联轨迹
    const relatedTraces = targetNexusId
      ? traces.filter(t => t.nexusId === targetNexusId)
      : []

    // 从 confidenceTracker 获取 L1 条目
    let l1Entries = targetNexusId
      ? confidenceTracker.getEntriesByNexus(targetNexusId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : []

    // fallback: 从 memoryStore 搜索
    if (l1Entries.length === 0 && targetNexusId) {
      try {
        const l1SearchResults = await memoryStore.search({
          query: '*',
          sources: ['l1_memory'],
          nexusId: targetNexusId,
          maxResults: 20,
          minScore: 0,
          useMmr: false,
        })
        l1Entries = l1SearchResults.map(r => ({
          id: r.id,
          nexusId: targetNexusId,
          content: r.snippet || r.content || '',
          confidence: (r.metadata?.confidence as number) ?? r.score ?? 0.3,
          signals: [],
          promotedToL0: r.tags?.includes('l0_promoted') ?? false,
          createdAt: r.createdAt || 0,
          updatedAt: r.createdAt || 0,
        }))
      } catch {
        // 静默失败
      }
    }

    setLensData({
      memory: selectedCard,
      relatedTraces,
      l1Entries,
      loading: false,
    })
  }, [l0Memories, traces])

  // ── 搜索 ──

  const searchMemories = useCallback(async (query: string) => {
    if (!query.trim()) {
      // 清空搜索结果，回退到 store 缓存数据
      setSearchResults(null)
      return
    }

    setLoading(true)
    try {
      const results = await memoryStore.search({
        query,
        sources: ['memory', 'exec_trace', 'l1_memory'],
        maxResults: 50,
        minScore: 0.1,
        useMmr: true,
      })

      // 搜索结果写入本地 state，不污染 store 缓存
      setSearchResults(results)
    } catch (error) {
      console.warn('[useMemoryData] Search failed:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  return {
    l0Memories,
    traces,
    graphNodes,
    graphEdges,
    neuronStats,
    selectedMemoryId,
    lensData,
    loading,
    l0Count: l0Memories.length,
    traceCount: traces.length,
    selectMemory,
    searchMemories,
    refresh: loadMemoryCache,
  }
}
