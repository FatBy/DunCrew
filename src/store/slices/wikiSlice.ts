/**
 * wikiSlice — Wiki 知识图谱实体状态管理
 *
 * 解决核心问题：知识写入 SQLite 后前端无感知。
 * 通过 Zustand Store 实现写入→UI刷新的响应式链路。
 *
 * 写入侧（knowledgeIngestService）调用 notifyWikiIngest(dunId)
 * → 自动 refetch → 订阅方（DunKnowledgeTab）响应式更新
 */

import type { StateCreator } from 'zustand'
import { getServerUrl } from '@/utils/env'

// ============================================
// Types
// ============================================

export interface WikiEntitySummary {
  id: string
  dunId: string | null
  slug: string
  title: string
  type: string
  tldr: string | null
  tags: string[]
  status: string
  claimCount: number
  createdAt: number
  updatedAt: number
}

// ============================================
// Slice 接口
// ============================================

export interface WikiSlice {
  // State
  wikiEntitiesByDun: Record<string, WikiEntitySummary[]>
  wikiLoadingByDun: Record<string, boolean>

  // Actions
  fetchWikiEntities: (dunId: string) => Promise<WikiEntitySummary[]>
  notifyWikiIngest: (dunId: string) => void
  clearWikiEntities: (dunId: string) => void
}

// ============================================
// 创建 Slice
// ============================================

export const createWikiSlice: StateCreator<WikiSlice> = (set, get) => ({
  wikiEntitiesByDun: {},
  wikiLoadingByDun: {},

  fetchWikiEntities: async (dunId: string) => {
    // 防止并发重复请求
    if (get().wikiLoadingByDun[dunId]) {
      return get().wikiEntitiesByDun[dunId] || []
    }

    set(state => ({
      wikiLoadingByDun: { ...state.wikiLoadingByDun, [dunId]: true },
    }))

    const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()

    try {
      const resp = await fetch(
        `${serverUrl}/api/wiki/entities?dun_id=${encodeURIComponent(dunId)}`
      )
      if (!resp.ok) {
        set(state => ({
          wikiLoadingByDun: { ...state.wikiLoadingByDun, [dunId]: false },
        }))
        return get().wikiEntitiesByDun[dunId] || []
      }

      const entities: WikiEntitySummary[] = await resp.json()

      set(state => ({
        wikiEntitiesByDun: { ...state.wikiEntitiesByDun, [dunId]: entities },
        wikiLoadingByDun: { ...state.wikiLoadingByDun, [dunId]: false },
      }))

      return entities
    } catch {
      set(state => ({
        wikiLoadingByDun: { ...state.wikiLoadingByDun, [dunId]: false },
      }))
      return get().wikiEntitiesByDun[dunId] || []
    }
  },

  notifyWikiIngest: (dunId: string) => {
    // 延迟 500ms refetch，给后端 SQLite commit 留出时间
    setTimeout(() => {
      get().fetchWikiEntities(dunId)
    }, 500)
  },

  clearWikiEntities: (dunId: string) => {
    set(state => {
      const next = { ...state.wikiEntitiesByDun }
      delete next[dunId]
      return { wikiEntitiesByDun: next }
    })
  },
})
