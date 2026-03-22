/**
 * MemoryStore - 统一记忆存储服务
 *
 * 前端 API 客户端，对接后端 SQLite + FTS5 存储。
 * 提供：
 * - 混合搜索（FTS5 全文 + 向量语义 + 时间衰减 + MMR 去冗余）
 * - 记忆写入（exec_trace, gene, nexus_xp, session, memory）
 * - 批量导入/导出
 *
 * 后端实现在 duncrew-server.py，前端仅做 API 调用和结果处理。
 */

import type { MemorySearchResult } from '@/types'
import { SEARCH_CONFIG } from '@/types'
import { localEmbed, cosineSimilarity } from './llmService'
import { getServerUrl } from '@/utils/env'

// ============================================
// 类型定义
// ============================================

export type MemorySource = 'memory' | 'exec_trace' | 'gene' | 'nexus_xp' | 'session' | 'l1_memory'

export interface MemoryWriteParams {
  source: MemorySource
  content: string
  nexusId?: string
  tags?: string[]
  metadata?: Record<string, unknown>
}

export interface MemorySearchParams {
  query: string
  sources?: MemorySource[]
  nexusId?: string
  maxResults?: number
  minScore?: number
  /** 是否启用 MMR 去冗余 */
  useMmr?: boolean
  /** 时间范围（仅返回该时间戳之后的结果） */
  since?: number
}

export interface MemoryStats {
  totalEntries: number
  bySource: Record<MemorySource, number>
  oldestEntry?: number
  newestEntry?: number
}

// ============================================
// 时间衰减计算
// ============================================

/** 计算时间衰减因子 (半衰期指数衰减) */
function temporalDecay(entryTimestamp: number, halfLifeDays: number = SEARCH_CONFIG.TEMPORAL_DECAY_HALF_LIFE_DAYS): number {
  const ageMs = Date.now() - entryTimestamp
  const ageDays = ageMs / (24 * 60 * 60 * 1000)
  return Math.pow(0.5, ageDays / halfLifeDays)
}

// ============================================
// MMR (Maximal Marginal Relevance) 去冗余
// ============================================

/**
 * MMR 重排序：在相关性和多样性之间取得平衡
 *
 * score_mmr = lambda * relevance - (1 - lambda) * max_similarity_to_selected
 */
function mmrRerank(
  results: MemorySearchResult[],
  embeddings: Map<string, number[]>,
  lambda: number = SEARCH_CONFIG.MMR_LAMBDA,
  maxResults: number = SEARCH_CONFIG.DEFAULT_MAX_RESULTS,
): MemorySearchResult[] {
  if (results.length <= 1) return results

  const selected: MemorySearchResult[] = []
  const remaining = [...results]

  // 贪心选择
  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const relevance = candidate.score

      // 计算与已选集合的最大相似度
      let maxSim = 0
      if (selected.length > 0) {
        const candEmb = embeddings.get(candidate.id)
        if (candEmb) {
          for (const sel of selected) {
            const selEmb = embeddings.get(sel.id)
            if (selEmb) {
              const sim = cosineSimilarity(candEmb, selEmb)
              maxSim = Math.max(maxSim, sim)
            }
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim
      if (mmrScore > bestScore) {
        bestScore = mmrScore
        bestIdx = i
      }
    }

    selected.push(remaining[bestIdx])
    remaining.splice(bestIdx, 1)
  }

  return selected
}

// ============================================
// MemoryStore 服务
// ============================================

class MemoryStoreService {
  private serverUrl: string = getServerUrl()

  /** 更新后端地址 */
  setServerUrl(url: string): void {
    this.serverUrl = url
  }

  // ═══ 搜索 ═══

  /**
   * 混合搜索：FTS5 + 向量语义 + 时间衰减 + MMR
   *
   * 流程：
   * 1. 向后端发送 FTS5 全文搜索请求
   * 2. 本地计算查询向量与结果的语义相似度
   * 3. 融合分数 = FTS_WEIGHT * fts_score + VECTOR_WEIGHT * vector_sim
   * 4. 应用时间衰减
   * 5. 可选 MMR 去冗余
   */
  async search(params: MemorySearchParams): Promise<MemorySearchResult[]> {
    const {
      query,
      sources,
      nexusId,
      maxResults = SEARCH_CONFIG.DEFAULT_MAX_RESULTS,
      minScore = SEARCH_CONFIG.DEFAULT_MIN_SCORE,
      useMmr = true,
      since,
    } = params

    try {
      // 1. 向后端发送 FTS 搜索
      const searchParams = new URLSearchParams({
        q: query,
        limit: String(maxResults * 3), // 多取一些用于后续过滤和 MMR
      })
      if (sources?.length) searchParams.set('source', sources[0])
      if (nexusId) searchParams.set('nexusId', nexusId)
      if (since) searchParams.set('since', String(since))

      const res = await fetch(`${this.serverUrl}/api/memory/search?${searchParams}`)
      if (!res.ok) {
        console.warn(`[MemoryStore] Search failed: ${res.status}`)
        return []
      }

      let results: MemorySearchResult[] = await res.json()

      // 2. 本地向量语义增强（如果结果数 > 0）
      if (results.length > 0) {
        const queryEmbed = localEmbed(query)
        const embeddings = new Map<string, number[]>()

        for (const r of results) {
          const snippetEmbed = localEmbed(r.snippet.slice(0, 300))
          embeddings.set(r.id, snippetEmbed)

          const vectorSim = cosineSimilarity(queryEmbed, snippetEmbed)
          // 融合分数
          r.score = SEARCH_CONFIG.FTS_WEIGHT * r.score + SEARCH_CONFIG.VECTOR_WEIGHT * vectorSim
        }

        // 3. 时间衰减（基于 id 中的时间戳或 score 保持）
        // results 的 score 已经包含 FTS+向量融合，再乘以时间衰减
        for (const r of results) {
          // 尝试从 id 提取时间戳
          const tsMatch = r.id.match(/(\d{13})/)
          if (tsMatch) {
            const ts = parseInt(tsMatch[1])
            r.score *= temporalDecay(ts)
          }
        }

        // 4. 排序
        results.sort((a, b) => b.score - a.score)

        // 5. MMR 去冗余
        if (useMmr && results.length > 1) {
          results = mmrRerank(results, embeddings, SEARCH_CONFIG.MMR_LAMBDA, maxResults)
        }
      }

      // 过滤低分结果
      results = results.filter(r => r.score >= minScore)

      // 限制返回数量
      return results.slice(0, maxResults)
    } catch (error: any) {
      console.warn('[MemoryStore] Search error:', error.message)
      return []
    }
  }

  // ═══ 写入 ═══

  /** 写入一条记忆 */
  async write(params: MemoryWriteParams): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: params.source,
          content: params.content,
          nexusId: params.nexusId,
          tags: params.tags,
          metadata: params.metadata,
          timestamp: Date.now(),
        }),
      })
      return res.ok
    } catch (error: any) {
      console.warn('[MemoryStore] Write error:', error.message)
      return false
    }
  }

  /** 批量写入记忆 */
  async writeBatch(entries: MemoryWriteParams[]): Promise<number> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/write-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries: entries.map(e => ({
            ...e,
            timestamp: Date.now(),
          })),
        }),
      })
      if (res.ok) {
        const data = await res.json()
        return data.written || 0
      }
      return 0
    } catch (error: any) {
      console.warn('[MemoryStore] WriteBatch error:', error.message)
      return 0
    }
  }

  // ═══ 管理 ═══

  /** 获取记忆统计 */
  async getStats(): Promise<MemoryStats | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/stats`)
      if (res.ok) {
        return await res.json()
      }
      return null
    } catch {
      return null
    }
  }

  /** 清理过期记忆 */
  async prune(olderThanDays: number = 90): Promise<number> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/prune`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ olderThanDays }),
      })
      if (res.ok) {
        const data = await res.json()
        return data.pruned || 0
      }
      return 0
    } catch {
      return 0
    }
  }

  /** 按 Nexus ID 获取记忆 */
  async getByNexus(nexusId: string, limit: number = 20): Promise<MemorySearchResult[]> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/nexus/${encodeURIComponent(nexusId)}?limit=${limit}`)
      if (res.ok) {
        return await res.json()
      }
      return []
    } catch {
      return []
    }
  }
}

// 导出单例
export const memoryStore = new MemoryStoreService()
