/**
 * Signal Matcher — 信号提取与匹配引擎
 * 
 * 纯字符串匹配，无 ML 依赖。支持:
 * - 正则模式: /pattern/flags
 * - 子串匹配: case-insensitive
 */

import type { Gene, GeneMatch } from '@/types'

// 常见错误关键词 (用于信号提取)
const ERROR_KEYWORDS = [
  'error', 'timeout', 'permission', 'denied', 'not found', 'no such file',
  'enoent', 'eperm', 'eacces', 'econnrefused', 'etimedout',
  'syntax error', 'unexpected token', 'cannot find', 'is not defined',
  'failed', 'rejected', 'aborted', 'invalid', 'missing', 'overflow',
  'null', 'undefined', 'nan', 'exception', 'crash', 'fatal',
]

// 错误码正则: ENOENT, EPERM, HTTP_404, ERR_xxx 等
const ERROR_CODE_REGEX = /\b(E[A-Z]{2,}|HTTP_\d{3}|ERR_[A-Z_]+|[A-Z_]{4,}_ERROR)\b/g

/**
 * 对错误消息进行分类，返回结构化的错误类型标签
 * 用于生成泛化的错误签名，替代过于具体的原始错误消息
 */
export function classifyErrorType(errorMessage: string): string {
  const lower = errorMessage.toLowerCase()
  if (/timeout|etimedout|econnreset|econnrefused|fetch failed|aborted|network/i.test(lower)) {
    return 'transient'
  }
  if (/enoent|not found|not exist|no such file|does not exist|找不到|不存在/i.test(lower)) {
    return 'missing_resource'
  }
  if (/permission|eacces|access denied|forbidden|权限/i.test(lower)) {
    return 'permission'
  }
  if (/invalid.*param|bad.*argument|type.*error|invalid.*type|参数错误|格式错误/i.test(lower)) {
    return 'bad_input'
  }
  if (/syntax|unexpected token|json.*parse|unterminated/i.test(lower)) {
    return 'parse_error'
  }
  if (/empty|cannot be empty|required|缺少/i.test(lower)) {
    return 'missing_input'
  }
  if (/codec|encode|decode|utf-8|gbk/i.test(lower)) {
    return 'encoding_error'
  }
  return 'unknown'
}

/**
 * 从工具名和错误消息中提取信号列表
 */
export function extractSignals(toolName: string, errorMessage: string): string[] {
  const signals: string[] = []
  const lowerError = errorMessage.toLowerCase()

  // 1. 工具名本身就是重要信号
  signals.push(toolName)

  // 2. 提取错误码 (ENOENT, EPERM, etc.)
  const codes = errorMessage.match(ERROR_CODE_REGEX)
  if (codes) {
    for (const code of codes) {
      if (!signals.includes(code.toLowerCase())) {
        signals.push(code.toLowerCase())
      }
    }
  }

  // 3. 匹配预定义关键词
  for (const kw of ERROR_KEYWORDS) {
    if (lowerError.includes(kw) && !signals.includes(kw)) {
      signals.push(kw)
    }
  }

  // 4. 结构化错误签名 (toolName:errorType)
  //    替代旧的原始消息子串，使同工具同类错误天然匹配
  const errorType = classifyErrorType(errorMessage)
  const structuredSig = `${toolName}:${errorType}`
  if (!signals.includes(structuredSig)) {
    signals.push(structuredSig)
  }

  // 5. 提取错误消息中的特征指纹 (提高基因区分度)
  //    让同一工具的不同错误场景产生不同信号，避免所有同类错误都被视为重复基因
  const errorFingerprint = extractErrorFingerprint(lowerError)
  if (errorFingerprint && !signals.includes(errorFingerprint)) {
    signals.push(errorFingerprint)
  } else if (!errorFingerprint) {
    // V2 兜底: 当所有正则都 miss 时，用 errorType 作为指纹
    // 确保每个错误至少有一个区分信号
    const fallbackFingerprint = `fp:${errorType}`
    if (!signals.includes(fallbackFingerprint)) {
      signals.push(fallbackFingerprint)
    }
  }

  return signals
}

/**
 * 从错误消息中提取特征指纹
 * 让同一工具的不同错误场景产生不同的信号，避免所有 readFile 错误都被视为重复基因
 */
function extractErrorFingerprint(lowerError: string): string | null {
  // 提取文件路径片段 (最后一级目录+文件名)
  const pathMatch = lowerError.match(/(?:path|file|dir(?:ectory)?)[:\s]+["']?([^\s"']+)/i)
  if (pathMatch) {
    const pathParts = pathMatch[1].replace(/\\/g, '/').split('/')
    const lastParts = pathParts.slice(-2).join('/')
    if (lastParts.length > 3 && lastParts.length < 60) {
      return `path:${lastParts.toLowerCase()}`
    }
  }

  // 提取 HTTP 状态码
  const httpMatch = lowerError.match(/\b(4\d{2}|5\d{2})\b/)
  if (httpMatch) {
    return `http:${httpMatch[1]}`
  }

  // 提取命令名 (runCmd 场景)
  const cmdMatch = lowerError.match(/(?:command|cmd)[:\s]+["']?(\S+)/i)
  if (cmdMatch && cmdMatch[1].length < 30) {
    return `cmd:${cmdMatch[1].toLowerCase()}`
  }

  // 提取关键错误短语 (取前几个有意义的词作为摘要)
  const cleanError = lowerError.replace(/[^a-z0-9\s]/g, ' ').trim()
  const words = cleanError.split(/\s+/).filter(w => w.length > 2).slice(0, 5)
  if (words.length >= 2) {
    return `err:${words.join('_')}`
  }

  return null
}

/**
 * 测试单个模式是否匹配任一信号
 * 支持 /regex/flags 和普通子串匹配
 */
function matchPattern(pattern: string, signals: string[]): boolean {
  // 正则模式: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/)
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2])
      return signals.some(s => re.test(s))
    } catch {
      // 无效正则降级为子串匹配
    }
  }

  // 子串匹配 (case-insensitive)
  const lowerPattern = pattern.toLowerCase()
  return signals.some(s => s.includes(lowerPattern) || lowerPattern.includes(s))
}

/**
 * 计算单个基因与信号集的匹配分数
 * 返回匹配的信号数量和命中列表
 */
export function scoreGene(gene: Gene, signals: string[]): { score: number; matchedSignals: string[] } {
  const matchedSignals: string[] = []

  for (const pattern of gene.signals_match) {
    if (matchPattern(pattern, signals)) {
      matchedSignals.push(pattern)
    }
  }

  return { score: matchedSignals.length, matchedSignals }
}

/**
 * 在基因库中查找与当前信号匹配的基因，按分数降序排列
 */
export function rankGenes(signals: string[], genes: Gene[]): GeneMatch[] {
  const matches: GeneMatch[] = []

  for (const gene of genes) {
    // 跳过置信度过低的废弃基因
    if (gene.metadata.confidence < 0.1 && gene.metadata.useCount > 5) {
      continue
    }

    const { score, matchedSignals } = scoreGene(gene, signals)
    if (score > 0) {
      matches.push({ gene, score, matchedSignals })
    }
  }

  // 按分数降序，相同分数按置信度降序
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.gene.metadata.confidence - a.gene.metadata.confidence
  })

  return matches
}

/**
 * 计算两组信号的重叠度 (0-1)
 * 用于防重复基因检测
 */
export function signalOverlap(signalsA: string[], signalsB: string[]): number {
  if (signalsA.length === 0 || signalsB.length === 0) return 0

  const setB = new Set(signalsB.map(s => s.toLowerCase()))
  const overlap = signalsA.filter(s => setB.has(s.toLowerCase())).length
  const maxLen = Math.max(signalsA.length, signalsB.length)

  return overlap / maxLen
}
