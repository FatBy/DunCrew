/**
 * MemoryStore - 统一记忆存储服务
 *
 * 前端 API 客户端，对接后端 SQLite + FTS5 + BGE 向量存储。
 * 提供：
 * - 搜索（信任后端混合排序 + 时间衰减 + MMR 去冗余）
 * - 记忆写入（exec_trace, gene, nexus_xp, session, memory）
 * - 批量导入/导出
 *
 * 后端实现在 duncrew-server.py，前端仅做 API 调用和结果后处理。
 */

import type { MemorySearchResult } from '@/types'
import { SEARCH_CONFIG } from '@/types'
import { getServerUrl } from '@/utils/env'

// ============================================
// 类型定义
// ============================================

export type MemorySource = 'memory' | 'exec_trace' | 'gene' | 'nexus_xp' | 'session' | 'l1_memory' | 'diary'

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
 * MMR 重排序：基于 Jaccard 文本相似度的去冗余
 *
 * 后端不返回 embedding 向量，使用 snippet 文本重叠度作为多样性指标。
 * score_mmr = lambda * relevance - (1 - lambda) * max_text_similarity_to_selected
 */
function mmrRerank(
  results: MemorySearchResult[],
  lambda: number = SEARCH_CONFIG.MMR_LAMBDA,
  maxResults: number = SEARCH_CONFIG.DEFAULT_MAX_RESULTS,
): MemorySearchResult[] {
  if (results.length <= 1) return results

  const selected: MemorySearchResult[] = []
  const remaining = [...results]

  const tokenize = (text: string): Set<string> =>
    new Set(text.toLowerCase().split(/\s+/).filter(w => w.length > 1))

  const jaccardSim = (a: Set<string>, b: Set<string>): number => {
    let intersection = 0
    for (const w of a) { if (b.has(w)) intersection++ }
    const union = a.size + b.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  const snippetTokens = new Map<string, Set<string>>()
  for (const r of results) {
    snippetTokens.set(r.id, tokenize(r.snippet.slice(0, 300)))
  }

  while (selected.length < maxResults && remaining.length > 0) {
    let bestIdx = 0
    let bestScore = -Infinity

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      const relevance = candidate.score

      let maxSim = 0
      if (selected.length > 0) {
        const candTokens = snippetTokens.get(candidate.id)
        if (candTokens) {
          for (const sel of selected) {
            const selTokens = snippetTokens.get(sel.id)
            if (selTokens) {
              maxSim = Math.max(maxSim, jaccardSim(candTokens, selTokens))
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
  private writeCallbacks: Array<(entries: MemorySearchResult[]) => void> = []

  /** 更新后端地址 */
  setServerUrl(url: string): void {
    this.serverUrl = url
  }

  /** 注册写入回调（用于通知 store 更新缓存） */
  onWrite(callback: (entries: MemorySearchResult[]) => void): void {
    this.writeCallbacks.push(callback)
  }

  /** 从 MemoryWriteParams 构造合成的 MemorySearchResult */
  private synthesizeResult(params: MemoryWriteParams): MemorySearchResult {
    const now = Date.now()
    return {
      id: `mem-${now}-${Math.random().toString(36).slice(2, 8)}`,
      source: params.source,
      content: params.content,
      snippet: params.content.slice(0, 200),
      nexusId: params.nexusId || '',
      tags: params.tags || [],
      score: 1.0,
      createdAt: now,
      confidence: 0.5,
      metadata: params.metadata || {},
    }
  }

  /** 通知所有注册的回调 */
  private notifyWrite(entries: MemorySearchResult[]): void {
    for (const cb of this.writeCallbacks) {
      try { cb(entries) } catch { /* 回调失败不影响主流程 */ }
    }
  }

  // ═══ 搜索 ═══

  /**
   * 搜索：信任后端混合分数 + 时间衰减 + MMR 去冗余
   *
   * 流程：
   * 1. 向后端发送搜索请求（后端已做 FTS5 + BGE 向量混合排序）
   * 2. 信任后端返回的 score，不再前端重新计算
   * 3. 应用时间衰减
   * 4. 可选 MMR 去冗余（基于文本去重）
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
      // 通配符 '*' 不是语义搜索，跳过混合引擎，走 SQL 直查
      const effectiveQuery = query === '*' ? '' : query
      const limit = Math.min(maxResults * 3, 500)

      // 1. 向后端发送搜索请求
      const searchParams = new URLSearchParams({
        q: effectiveQuery,
        limit: String(limit),
      })
      if (effectiveQuery === '') searchParams.set('hybrid', '0')
      if (sources?.length) searchParams.set('source', sources[0])
      if (nexusId) searchParams.set('nexusId', nexusId)
      if (since) searchParams.set('since', String(since))

      const res = await fetch(`${this.serverUrl}/api/memory/search?${searchParams}`)
      if (!res.ok) {
        console.warn(`[MemoryStore] Search failed: ${res.status}`)
        return []
      }

      let results: MemorySearchResult[] = await res.json()

      // 2. 信任后端 score，仅应用时间衰减
      if (results.length > 0) {
        for (const r of results) {
          const tsMatch = r.id.match(/(\d{13})/)
          if (tsMatch) {
            const ts = parseInt(tsMatch[1])
            r.score *= temporalDecay(ts)
          }
        }

        // 3. 排序
        results.sort((a, b) => b.score - a.score)

        // 4. MMR 去冗余（基于文本相似度）
        if (useMmr && results.length > 1) {
          results = mmrRerank(results, SEARCH_CONFIG.MMR_LAMBDA, maxResults)
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
      if (res.ok) {
        this.notifyWrite([this.synthesizeResult(params)])
        return true
      }
      return false
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
        const written = data.written || 0
        if (written > 0) {
          this.notifyWrite(entries.map(e => this.synthesizeResult(e)))
        }
        return written
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
