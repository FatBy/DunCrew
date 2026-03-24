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
import { PROMOTION_PROMPT, parsePromotionResult } from '@/utils/memoryPromotion'
import { chat, isLLMConfigured } from './llmService'

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

  // ═══ 分组搜索 (Phase 1.1) ═══

  /** 按 source 分别限制数量的分组搜索 */
  async searchGrouped(params: {
    query: string
    sourceLimits: Record<string, number>
    nexusId?: string
    minScore?: number
    useMmr?: boolean
  }): Promise<MemorySearchResult[]> {
    const {
      query,
      sourceLimits,
      nexusId,
      minScore = SEARCH_CONFIG.DEFAULT_MIN_SCORE,
      useMmr = true,
    } = params

    try {
      const res = await fetch(`${this.serverUrl}/api/memory/search-grouped`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: query,
          sourceLimits,
          nexusId,
          minScore,
          useMmr,
        }),
      })

      if (!res.ok) {
        console.warn(`[MemoryStore] searchGrouped failed: ${res.status}`)
        return []
      }

      const results: MemorySearchResult[] = await res.json()

      // 应用时间衰减
      for (const result of results) {
        const timestampMatch = result.id.match(/(\d{13})/)
        if (timestampMatch) {
          const entryTimestamp = parseInt(timestampMatch[1])
          result.score *= temporalDecay(entryTimestamp)
        }
      }

      // MMR 去冗余
      if (useMmr && results.length > 1) {
        const totalLimit = Object.values(sourceLimits).reduce((sum, limit) => sum + limit, 0)
        return mmrRerank(results, SEARCH_CONFIG.MMR_LAMBDA, totalLimit)
      }

      return results.filter(result => result.score >= minScore)
    } catch (error: any) {
      console.warn('[MemoryStore] searchGrouped error:', error.message)
      // 降级：用原有 search 方法
      return this.search({
        query,
        maxResults: Object.values(sourceLimits).reduce((sum, limit) => sum + limit, 0),
        minScore,
        useMmr,
        nexusId,
      })
    }
  }

  // ═══ 去重写入 (Phase 2.0) ═══

  /** 最近写入缓存（5 分钟过期） */
  private recentWrites: Array<{ content: string; timestamp: number }> = []
  private readonly DEDUP_CACHE_TTL = 5 * 60 * 1000

  /**
   * 带去重的记忆写入
   * 仅对 source='memory' 生效，其他 source 直接写入
   */
  async writeWithDedup(params: MemoryWriteParams): Promise<boolean> {
    if (params.source !== 'memory') {
      return this.write(params)
    }

    // 1. 先检查本地缓存（零网络开销）
    const now = Date.now()
    this.recentWrites = this.recentWrites.filter(write => now - write.timestamp < this.DEDUP_CACHE_TTL)

    for (const recent of this.recentWrites) {
      if (this.bigramJaccardSimilarity(params.content, recent.content) > 0.7) {
        console.log(`[MemoryStore] Dedup (cache hit): skipped "${params.content.slice(0, 50)}..."`)
        return true
      }
    }

    // 2. 缓存未命中，走后端语义搜索
    try {
      const similar = await this.search({
        query: params.content,
        sources: ['memory'],
        maxResults: 3,
        minScore: SEARCH_CONFIG.DEDUP_SIMILARITY_THRESHOLD,
        useMmr: false,
      })
      if (similar.length > 0) {
        console.log(`[MemoryStore] Dedup (backend hit): skipped "${params.content.slice(0, 50)}..."`)
        this.recentWrites.push({ content: params.content, timestamp: now })
        return true
      }
    } catch {
      // 去重查询失败不阻塞写入
    }

    // 3. 写入并加入缓存
    const writeSuccess = await this.write(params)
    if (writeSuccess) {
      this.recentWrites.push({ content: params.content, timestamp: now })
    }
    return writeSuccess
  }

  /** 基于字符 bigram 的 Jaccard 文本相似度 */
  private bigramJaccardSimilarity(textA: string, textB: string): number {
    const bigramsA = new Set<string>()
    const bigramsB = new Set<string>()
    for (let i = 0; i < textA.length - 1; i++) bigramsA.add(textA.slice(i, i + 2))
    for (let i = 0; i < textB.length - 1; i++) bigramsB.add(textB.slice(i, i + 2))
    let intersection = 0
    for (const bigram of bigramsA) if (bigramsB.has(bigram)) intersection++
    const union = bigramsA.size + bigramsB.size - intersection
    return union === 0 ? 0 : intersection / union
  }

  // ═══ 软删除 (Phase 3.2) ═══

  /** 软删除一条记忆（设置 deleted_at） */
  async delete(memoryId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/memory/${encodeURIComponent(memoryId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      })
      if (res.ok) {
        console.log(`[MemoryStore] Soft-deleted memory: ${memoryId}`)
        return true
      }
      console.warn(`[MemoryStore] Delete failed: ${res.status}`)
      return false
    } catch (error: any) {
      console.warn('[MemoryStore] Delete error:', error.message)
      return false
    }
  }

  // ═══ 旧数据清理 (F2) ═══

  /**
   * 一次性清理旧低质量 L0 记忆
   * 正则快速过滤工具日志 + LLM 兜底判断
   * 由设置页"整理记忆"按钮触发
   */
  async cleanupLowQualityMemories(): Promise<number> {
    const allL0 = await this.search({
      query: '*',
      sources: ['memory'],
      maxResults: 200,
      minScore: 0,
      useMmr: false,
    })

    let cleaned = 0
    for (const mem of allL0) {
      const content = mem.content || mem.snippet || ''

      // 快速过滤：纯工具日志特征（不需要 LLM）
      const isToolLog = /^(readFile|writeFile|runCmd|listDir|searchFiles)\s*[:：]/.test(content)
        || /返回\s*\d+\s*字节/.test(content)
        || /操作了\s*.+\.(json|ts|py|md)/.test(content)

      if (isToolLog) {
        await this.delete(mem.id)
        cleaned++
        continue
      }

      // 对不确定的短内容，用 LLM 判断（复用 PROMOTION_PROMPT）
      if (content.length < 100 && isLLMConfigured()) {
        try {
          const result = await chat([
            { role: 'system', content: PROMOTION_PROMPT },
            { role: 'user', content },
          ])
          const parsed = parsePromotionResult(result?.trim() || '')
          if (!parsed) {
            await this.delete(mem.id)
            cleaned++
          }
        } catch {
          // LLM 调用失败，保守保留
        }
      }
    }

    console.log(`[MemoryStore] Cleanup completed: ${cleaned} low-quality memories removed`)
    return cleaned
  }
}

// 导出单例
export const memoryStore = new MemoryStoreService()
