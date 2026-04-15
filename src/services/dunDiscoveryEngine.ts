/**
 * Nexus 发现引擎 — 从 ExecTrace.task/tags 中发现用户反复追求的"目的"
 *
 * 纯函数设计 [Q9]：不做任何 I/O，接收 traces 作为参数。
 * 数据源：ExecTrace.tags（主信号）、ExecTrace.task（补充信号）、turnCount（complexity 增强信号）
 *
 * 算法路径：轻量关键词聚类，零 LLM 消耗。
 */

import type { ExecTrace, TriggerPattern, IntentCluster } from '@/types'

// ============================================
// 配置常量
// ============================================

export const NEXUS_DISCOVERY_CONFIG = {
  MIN_CLUSTER_SIZE: 3,              // 意图簇最少 3 条 trace
  MIN_TRACES: 5,                    // 最少 5 条 trace 才分析
  KEYWORD_MIN_LENGTH: 2,            // 关键词最小长度
  KEYWORD_CO_OCCURRENCE_THRESHOLD: 3, // 关键词至少在 3 条 trace 中共现
  CONFIDENCE_THRESHOLD: 0.5,        // 置信度阈值
  ANALYSIS_DAYS: 14,                // 统计窗口 14 天
  COMPLEXITY_TURNS_THRESHOLD: 10,   // complexity 增强信号阈值 [Q2]
} as const

// ============================================
// 停用词表（中英文混合）
// ============================================

const STOP_WORDS = new Set([
  // 中文停用词
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '怎么', '如何', '可以',
  '能', '把', '被', '从', '用', '对', '让', '给', '但', '而', '或', '如果', '因为',
  '所以', '这个', '那个', '这些', '那些', '帮我', '请', '吗', '呢', '吧', '啊',
  '一下', '一些', '关于', '进行', '使用', '通过', '需要', '应该', '已经',
  // 英文停用词
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'not', 'no', 'nor', 'so', 'if', 'then', 'than', 'too', 'very',
  'just', 'about', 'also', 'this', 'that', 'these', 'those', 'it',
  'its', 'my', 'your', 'his', 'her', 'our', 'their', 'me', 'him',
  'us', 'them', 'i', 'you', 'he', 'she', 'we', 'they', 'what', 'how',
  'please', 'help',
])

// ============================================
// 关键词提取 [Q5]
// ============================================

/**
 * tags 噪音过滤：过滤非功能性描述、特殊字符、文件路径等
 */
const TAG_NOISE_PATTERNS = [
  /^\[.*\]$/,             // [上下文参考] 等方括号包裹的标记
  /^\*+$/,                // ** 等纯星号
  /^[·\-—…~]+$/,          // 纯标点符号
  /^继续执行/,             // "继续执行" 前缀（非功能性描述）
  /^[a-zA-Z]:[\\\/]/,     // Windows 文件路径（C:\...）
  /^\/\w/,                // Unix 文件路径（/usr/...）
  /^\d+\s*(条|个|次|项)/,  // "73条" 等数量描述
  /^https?:\/\//,          // URL
]

/**
 * 从单条 trace 提取关键词，tags 优先 [Q5]
 *
 * 优先级：
 * 1. ExecTrace.tags — 主信号（已由执行引擎提取的高质量关键词）
 * 2. ExecTrace.task 分词 — 补充信号（仅当 tags 为空时使用）
 */
function extractTraceKeywords(trace: ExecTrace): string[] {
  // 1. 优先使用 tags（已由执行引擎提取的高质量关键词）
  if (trace.tags && trace.tags.length > 0) {
    const filtered = trace.tags.filter(tag =>
      tag.length >= NEXUS_DISCOVERY_CONFIG.KEYWORD_MIN_LENGTH
      && !TAG_NOISE_PATTERNS.some(pattern => pattern.test(tag))
      && !STOP_WORDS.has(tag.toLowerCase())
    )
    // 过滤后仍有有效关键词才使用，否则 fallback 到 task 分词
    if (filtered.length > 0) return filtered
  }

  // 2. Fallback: 从 task 文本提取（仅当 tags 为空或全被过滤时）
  return extractFromText(trace.task || '')
}

/**
 * 从自然语言文本提取关键词（兜底方案）
 * 不做 bigram（避免噪音 [Q5]），只取完整 token
 *
 * 中文使用 Intl.Segmenter 分词，英文使用空格分词
 */
function extractFromText(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》\-—…·~`!@#$%^&*()+=\[\]{};:'",.<>?\/\\|]/g, ' ')

  // 检测是否含中文字符
  if (/[\u4e00-\u9fff]/.test(cleaned)) {
    // 使用 Intl.Segmenter 进行中文分词（Electron/现代浏览器均支持）
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
    return [...segmenter.segment(cleaned)]
      .filter(s => s.isWordLike)
      .map(s => s.segment)
      .filter(token =>
        token.length >= 2  // 中文词语通常 2-4 字，使用更宽松的最小长度
        && !STOP_WORDS.has(token)
        && !/^\d+$/.test(token)
      )
  }

  // 英文/其他语言走原有空格分词逻辑
  return cleaned
    .split(/\s+/)
    .filter(token =>
      token.length >= NEXUS_DISCOVERY_CONFIG.KEYWORD_MIN_LENGTH
      && !STOP_WORDS.has(token)
      && !/^\d+$/.test(token)
    )
}

// ============================================
// 意图聚类算法
// ============================================

interface TraceKeywordEntry {
  traceId: string
  traceIndex: number
  keywords: Set<string>
}

/**
 * 纯函数 [Q9]：从 traces 中聚类出意图簇
 */
function clusterByIntent(traces: ExecTrace[]): IntentCluster[] {
  // Step 1: 为每条 trace 提取关键词集合
  const entries: TraceKeywordEntry[] = traces.map((trace, index) => ({
    traceId: trace.id,
    traceIndex: index,
    keywords: new Set(extractTraceKeywords(trace)),
  }))

  // Step 2: 构建倒排索引 keyword → Set<traceIndex>
  const invertedIndex = new Map<string, Set<number>>()
  for (const entry of entries) {
    for (const keyword of entry.keywords) {
      if (!invertedIndex.has(keyword)) {
        invertedIndex.set(keyword, new Set())
      }
      invertedIndex.get(keyword)!.add(entry.traceIndex)
    }
  }

  // Step 3: 找高频关键词（出现在 ≥ threshold 条 trace 中）
  const highFreqKeywords: Array<{ keyword: string; traceIndices: Set<number> }> = []
  for (const [keyword, traceIndices] of invertedIndex) {
    if (traceIndices.size >= NEXUS_DISCOVERY_CONFIG.KEYWORD_CO_OCCURRENCE_THRESHOLD) {
      highFreqKeywords.push({ keyword, traceIndices })
    }
  }

  if (highFreqKeywords.length === 0) return []

  // Step 4: 以高频关键词为种子，聚合共享关键词的 traces 为一个簇
  const usedTraces = new Set<number>()
  const clusters: IntentCluster[] = []

  // 按覆盖 trace 数量降序排列
  highFreqKeywords.sort((a, b) => b.traceIndices.size - a.traceIndices.size)

  for (const seed of highFreqKeywords) {
    // 跳过已被其他簇覆盖的种子
    const uncoveredTraces = new Set(
      [...seed.traceIndices].filter(idx => !usedTraces.has(idx))
    )
    if (uncoveredTraces.size < NEXUS_DISCOVERY_CONFIG.MIN_CLUSTER_SIZE) continue

    // Step 5: 找与种子关键词共现的其他高频关键词，形成关键词组（最多 5 个）
    const coreKeywords = [seed.keyword]
    for (const other of highFreqKeywords) {
      if (other.keyword === seed.keyword) continue
      if (coreKeywords.length >= 5) break

      // 计算与当前簇 traces 的重叠度
      const overlap = [...other.traceIndices].filter(idx => uncoveredTraces.has(idx)).length
      if (overlap >= NEXUS_DISCOVERY_CONFIG.MIN_CLUSTER_SIZE) {
        coreKeywords.push(other.keyword)
      }
    }

    // 收集簇内的 traces
    const clusterTraceIndices = [...uncoveredTraces]
    const clusterTraces = clusterTraceIndices.map(idx => traces[idx])

    // 标记已使用
    for (const idx of clusterTraceIndices) {
      usedTraces.add(idx)
    }

    // 计算簇的统计信息
    const turnCounts = clusterTraces.map(t => t.turnCount || 0)
    const avgTurnCount = turnCounts.reduce((sum, tc) => sum + tc, 0) / clusterTraces.length
    const successCount = clusterTraces.filter(t => t.success).length
    const successRate = successCount / clusterTraces.length

    // 计算时间跨度
    const timestamps = clusterTraces.map(t => t.timestamp)
    const timeSpanMs = Math.max(...timestamps) - Math.min(...timestamps)
    const timeSpanDays = Math.max(1, Math.round(timeSpanMs / (24 * 60 * 60 * 1000)))

    // 收集工具链
    const toolChains = clusterTraces.map(t => t.tools.map(tool => tool.name))

    // 聚合 tags
    const allTags = new Set<string>()
    for (const trace of clusterTraces) {
      if (trace.tags) {
        for (const tag of trace.tags) allTags.add(tag)
      }
    }

    clusters.push({
      coreKeywords,
      traceIds: clusterTraces.map(t => t.id),
      taskDescriptions: clusterTraces.map(t => t.task),
      toolChains,
      aggregatedTags: [...allTags],
      size: clusterTraces.length,
      timeSpanDays,
      avgTurnCount,
      successRate,
    })
  }

  return clusters
}

// ============================================
// 从意图簇生成 TriggerPattern [Q1]
// ============================================

/**
 * 纯函数 [Q9]：将意图簇转换为 TriggerPattern
 * 直接输出 TriggerPattern（type = 'intent-cluster'），不经过中间类型 [Q1]
 */
function clusterToTriggerPattern(cluster: IntentCluster): TriggerPattern | null {
  // 计算置信度 [Q4]
  const confidence = calculateConfidence(cluster)

  if (confidence < NEXUS_DISCOVERY_CONFIG.CONFIDENCE_THRESHOLD) {
    return null
  }

  // 从簇内所有 traces 的工具链中统计频率 Top 5
  const toolFrequency: Record<string, number> = {}
  for (const chain of cluster.toolChains) {
    for (const tool of chain) {
      toolFrequency[tool] = (toolFrequency[tool] || 0) + 1
    }
  }
  const suggestedSkills = Object.entries(toolFrequency)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([name]) => name)

  // 从最常见的工具链生成 SOP
  const chainSignatures: Record<string, number> = {}
  for (const chain of cluster.toolChains) {
    const signature = chain.join('→')
    chainSignatures[signature] = (chainSignatures[signature] || 0) + 1
  }
  const mostCommonChain = Object.entries(chainSignatures)
    .sort(([, a], [, b]) => b - a)[0]
  const suggestedSOP = mostCommonChain
    ? `你的标准作业流程是执行以下工具链：${mostCommonChain[0]}。请按顺序规划并调用这些工具完成任务。在每一步完成后验证结果，确保下一步有正确的输入。`
    : `使用 ${suggestedSkills.join('、')} 工具完成用户的需求。`

  // 取簇内最短的 task 描述作为代表
  const sortedTasks = [...cluster.taskDescriptions].sort((a, b) => a.length - b.length)
  const representativeTask = sortedTasks[0] || ''
  const discoveredObjective = `${representativeTask}（基于 ${cluster.size} 次相似执行）`

  // 建议的 Nexus 名称：核心关键词前 3 个用 · 连接
  const suggestedName = cluster.coreKeywords.slice(0, 3).join('·')

  // 建议的 triggers：核心关键词前 5 个
  const suggestedTriggers = cluster.coreKeywords.slice(0, 5)

  // 建议的 metrics：基于成功率和工具使用推断
  const suggestedMetrics: string[] = []
  if (cluster.successRate >= 0.7) {
    suggestedMetrics.push(`保持 ${Math.round(cluster.successRate * 100)}%+ 的成功率`)
  }
  if (suggestedSkills.length > 0) {
    suggestedMetrics.push(`正确使用 ${suggestedSkills[0]} 等核心工具`)
  }
  if (cluster.avgTurnCount > 0) {
    suggestedMetrics.push(`平均 ${Math.round(cluster.avgTurnCount)} 轮内完成任务`)
  }

  return {
    type: 'intent-cluster',
    confidence,
    evidence: [
      `发现意图簇: "${suggestedName}" (${cluster.size} 条 trace, 跨 ${cluster.timeSpanDays} 天)`,
      `核心关键词: ${cluster.coreKeywords.join(', ')}`,
      `成功率: ${Math.round(cluster.successRate * 100)}%, 平均轮次: ${Math.round(cluster.avgTurnCount)}`,
    ],
    detectedAt: Date.now(),
    suggestedSkills,
    suggestedSOP,
    discoveredObjective,
    suggestedName,
    suggestedTriggers,
    suggestedMetrics,
    intentCluster: cluster,
  }
}

// ============================================
// 置信度计算 [Q4]
// ============================================

/**
 * 修正后的置信度公式 [Q4]
 *
 * 边界验证：
 * - 最差情况（3 条, 2 关键词, 工具不一致, 低成功率, 低轮次）: 0.45 → 不通过
 * - 良好情况（6 条, 3 关键词, 工具一致, 高成功率, 高轮次）: 1.0 → 通过
 * - 中等情况（5 条, 3 关键词, 工具一致, 中等成功率）: 0.75 → 通过
 */
function calculateConfidence(cluster: IntentCluster): number {
  // 基数
  let confidence = 0.2

  // 簇大小分量
  confidence += Math.min(cluster.size / 20, 0.3)

  // 关键词多样性（要求提高到 3）
  confidence += cluster.coreKeywords.length >= 3 ? 0.15 : 0.05

  // 工具一致性（用比例而非阈值）
  const toolConsistencyRatio = calculateToolConsistencyRatio(cluster)
  confidence += toolConsistencyRatio >= 0.5 ? 0.15 : 0.05

  // 成功率信号
  confidence += cluster.successRate >= 0.7 ? 0.1 : 0

  // complexity 增强信号 [Q2]
  confidence += cluster.avgTurnCount >= NEXUS_DISCOVERY_CONFIG.COMPLEXITY_TURNS_THRESHOLD ? 0.1 : 0

  return confidence
}

/**
 * 计算工具一致性比例
 * 簇内所有 traces 中，最常见工具出现的比例
 */
function calculateToolConsistencyRatio(cluster: IntentCluster): number {
  if (cluster.toolChains.length === 0) return 0

  const toolFrequency: Record<string, number> = {}
  for (const chain of cluster.toolChains) {
    for (const tool of chain) {
      toolFrequency[tool] = (toolFrequency[tool] || 0) + 1
    }
  }

  const maxFrequency = Math.max(...Object.values(toolFrequency), 0)
  return maxFrequency / cluster.toolChains.length
}

// ============================================
// 公开 API — 纯函数 [Q9]
// ============================================

/**
 * 分析意图模式，返回 TriggerPattern（如果检测到意图簇）
 *
 * 纯函数：不做任何 I/O，接收 traces 作为参数。
 * 直接返回 TriggerPattern（type = 'intent-cluster'）[Q1]
 */
export function analyzeIntentPatterns(
  traces: ExecTrace[],
): TriggerPattern | null {
  if (traces.length < NEXUS_DISCOVERY_CONFIG.MIN_TRACES) {
    return null
  }

  // Step 1: 意图聚类
  const clusters = clusterByIntent(traces)
  if (clusters.length === 0) return null

  // Step 2: 取最大的簇（最有代表性）
  const bestCluster = clusters.sort((a, b) => b.size - a.size)[0]

  // Step 3: 转换为 TriggerPattern
  return clusterToTriggerPattern(bestCluster)
}
