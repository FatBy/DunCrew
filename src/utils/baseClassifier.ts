/**
 * Base Type Classifier (E/P/V/X) for ExecTraceToolCall
 *
 * Classifies each tool call into one of four "base" types:
 *   E (Execute) - Agent knows what to do and has the info needed
 *   P (Plan)    - Agent knows context but needs to figure out how (LLM-assigned only)
 *   V (Verify)  - Agent is checking the result of a previous action
 *   X (Explore) - Agent is exploring unknown territory
 *
 * Note: P is fundamentally a reasoning-level classification that cannot be
 * reliably inferred from tool calls alone. It must be assigned by the LLM
 * itself (via reasoning or function-call metadata). This classifier handles
 * E/V/X and defaults to E when no V/X signal is detected.
 *
 * SYNC: 此分类器逻辑必须与 openclaw-extension/src/gene-pool.ts 保持同步
 */

// ============================================
// Tool categories (白名单 — 精确分类)
// ============================================

const READ_TOOLS = new Set([
  'readFile', 'listDir', 'searchText', 'searchFiles',
  'readMultipleFiles', 'search_files',
])

const EXPLORE_TOOLS = new Set([
  'webSearch', 'webFetch',
])

const WRITE_TOOLS = new Set([
  'writeFile', 'appendFile', 'deleteFile', 'renameFile',
])

const VERIFY_CMD_PATTERNS = [
  /tsc\b.*--noEmit/i,
  /npm\s+(test|run\s+test|run\s+lint|run\s+build)/i,
  /pytest|jest|vitest|mocha/i,
  /eslint|prettier.*--check/i,
  /cargo\s+(check|test|clippy)/i,
  /go\s+(test|vet)/i,
  /python\s+-m\s+(unittest|pytest)/i,
]

// 探索性 shell 命令 (runCmd 专用)
const EXPLORE_CMD_PATTERNS = [
  /^(ls|dir|tree|find)\b/i,
  /^(cat|head|tail|less|more)\b/i,
  /^(grep|rg|ag|ack)\b/i,
  /^git\s+(log|status|diff|show|branch)/i,
  /^(which|where|type|command\s+-v)\b/i,
  /^(echo\s+\$|env|printenv|set)\b/i,
]

// 未知工具的名称模式兜底 (优先级低于白名单和参数推断)
const EXPLORE_NAME_PATTERNS = [
  /search/i, /fetch/i, /get/i, /list/i, /read/i,
  /find/i, /query/i, /browse/i, /scan/i, /lookup/i,
  /navigate/i, /screenshot/i, /inspect/i,
]

// ============================================
// Context for stateful classification
// ============================================

export interface BaseClassifierCtx {
  /** Resources successfully accessed in this session */
  successfulResources: Set<string>
  /** Recent write operations (sliding window of 10) */
  recentWrites: Array<{ resource: string; order: number }>
  /** Previous tool call entry */
  lastEntry: { name: string; status: 'success' | 'error'; order: number } | null
}

export function createBaseClassifierCtx(): BaseClassifierCtx {
  return {
    successfulResources: new Set(),
    recentWrites: [],
    lastEntry: null,
  }
}

// ============================================
// Path normalization
// ============================================

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
}

// ============================================
// Resource extraction
// ============================================

function extractResource(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  // 文件系统路径
  const p = args.path || args.filePath || args.file || args.directory
  if (typeof p === 'string') return normalizePath(p)

  // 网络资源: URL 或搜索查询
  const url = args.url || args.href
  if (typeof url === 'string') return url
  const query = args.query || args.q || args.search_query
  if (typeof query === 'string') return `query:${query}`

  if (toolName === 'runCmd') {
    const cmd = String(args.command || args.cmd || '')
    const m = cmd.match(/(?:^|\s)((?:\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+)/)
    return m ? normalizePath(m[1]) : `cmd:${cmd.slice(0, 50)}`
  }

  return null
}

// ============================================
// Parameter shape inference (未知工具专用)
// ============================================

function inferIntentFromArgs(args: Record<string, unknown>): 'read' | 'write' | 'unknown' {
  const hasContent = !!(args.content || args.body || args.data || args.text || args.payload)
  const hasReadTarget = !!(args.url || args.href || args.query || args.q || args.search_query ||
    args.path || args.filePath || args.file || args.directory)

  if (hasContent) return 'write'
  if (hasReadTarget && !hasContent) return 'read'
  return 'unknown'
}

// ============================================
// Classification
// ============================================

/**
 * Classify a tool call into E/V/X based on context.
 * P must be assigned externally (by LLM metadata).
 *
 * Priority chain:
 *   1. V checks (highest priority — verification patterns)
 *   2. X checks (known read tools + explore tools + shell explore commands)
 *   3. Unknown tool fallback (param shape → name pattern)
 *   4. E (default)
 */
export function classifyBaseType(
  toolName: string,
  args: Record<string, unknown>,
  _status: 'success' | 'error',
  ctx: BaseClassifierCtx,
): 'E' | 'V' | 'X' {
  const resource = extractResource(toolName, args)
  const isKnownTool = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) ||
    EXPLORE_TOOLS.has(toolName) || toolName === 'runCmd'

  // --- V (Verify) ---
  // Write-then-read same resource (path normalized)
  if (READ_TOOLS.has(toolName) && resource &&
    ctx.recentWrites.some(w => w.resource === resource)) {
    return 'V'
  }
  // Retry after failure (same tool called again immediately after error)
  if (ctx.lastEntry && ctx.lastEntry.name === toolName && ctx.lastEntry.status === 'error') {
    return 'V'
  }
  // Compile/test/lint after write
  if (toolName === 'runCmd') {
    const cmd = String(args.command || args.cmd || '')
    if (VERIFY_CMD_PATTERNS.some(p => p.test(cmd)) && ctx.recentWrites.length > 0) {
      return 'V'
    }
  }

  // --- X (Explore) ---
  // Read operation on a resource never successfully accessed
  if (READ_TOOLS.has(toolName) && resource && !ctx.successfulResources.has(resource)) {
    return 'X'
  }
  // Web search/fetch — always exploring new information
  if (EXPLORE_TOOLS.has(toolName)) {
    return 'X'
  }
  // listDir on never-accessed directory
  if (toolName === 'listDir' && resource && !ctx.successfulResources.has(resource)) {
    return 'X'
  }
  // listDir early in session (fallback for no-path listDir)
  if (toolName === 'listDir' && !resource && (ctx.lastEntry === null || ctx.lastEntry.order <= 3)) {
    return 'X'
  }
  // Exploratory shell commands (ls, grep, git status, etc.)
  if (toolName === 'runCmd') {
    const cmd = String(args.command || args.cmd || '').trim()
    if (EXPLORE_CMD_PATTERNS.some(p => p.test(cmd))) {
      return 'X'
    }
  }

  // --- Unknown tool fallback (方向 1+2) ---
  if (!isKnownTool) {
    // 优先看参数形态
    const argIntent = inferIntentFromArgs(args)
    if (argIntent === 'read') return 'X'
    // 再看工具名模式
    if (argIntent === 'unknown' && EXPLORE_NAME_PATTERNS.some(p => p.test(toolName))) {
      return 'X'
    }
  }

  // --- E (Execute) ---
  return 'E'
}

/**
 * Update classifier context after a tool call completes.
 * Must be called AFTER classifyBaseType for the same entry.
 */
export function updateBaseClassifierCtx(
  ctx: BaseClassifierCtx,
  toolName: string,
  args: Record<string, unknown>,
  status: 'success' | 'error',
  order: number,
): void {
  const resource = extractResource(toolName, args)

  if (status === 'success' && resource) {
    ctx.successfulResources.add(resource)
  }
  if (WRITE_TOOLS.has(toolName) && status === 'success' && resource) {
    ctx.recentWrites.push({ resource, order })
    if (ctx.recentWrites.length > 10) ctx.recentWrites.shift()
  }

  ctx.lastEntry = { name: toolName, status, order }
}

// ============================================
// Phase 3: P 碱基自动检测
// ============================================

/**
 * 推理链中的计划关键词模式（中英文混合）
 *
 * 检测 LLM 输出的 reasoning_content 中是否包含结构化计划信号。
 * 设计为保守匹配（精确率优先于召回率），避免将普通推理误标为 P。
 *
 * 匹配逻辑：需要关键词 + 结构化标记（如编号列表）同时出现。
 */
const PLAN_KEYWORD_PATTERNS = [
  // 中文计划关键词 + 步骤编号
  /(?:计划|方案|策略|思路|步骤)[：:]\s*\n\s*[1１一①]/,
  /(?:分步|分阶段|按顺序)[执进]行/,
  /第[一二三四1-4]步[，,：:]/,
  // 英文计划关键词 + 编号
  /(?:plan|strategy|approach)[：:]\s*\n\s*(?:1[\.\):]|step\s*1)/i,
  /(?:step-by-step|multi-step)\s+(?:plan|approach|strategy)/i,
  // 明确的目标分解
  /(?:子目标|子任务|sub[- ]?(?:objective|task|goal)s?)[：:]/i,
  /(?:拆分|拆解|分解)为?\s*(?:以下|如下|多个)/,
]

/**
 * 检测 LLM Function Calling 返回中的 _meta.planStep 标记。
 *
 * 部分 LLM 可在 Function Calling 中附带元数据，
 * 格式: { _meta: { planStep: true } } 或在 tool_call.function.arguments 中。
 *
 * @param toolCallArgs 工具调用参数（parsed JSON）
 * @returns 'llm_meta' 如果检测到标记，否则 null
 */
export function detectPlanFromMeta(
  toolCallArgs: Record<string, unknown> | undefined,
): 'llm_meta' | null {
  if (!toolCallArgs) return null

  // 直接检查 _meta.planStep
  const meta = toolCallArgs._meta
  if (meta && typeof meta === 'object' && (meta as Record<string, unknown>).planStep) {
    return 'llm_meta'
  }

  return null
}

/**
 * 检测 LLM 推理内容 (reasoning_content) 中是否包含结构化计划。
 *
 * 适用于 DeepSeek 等提供 reasoning_content 字段的模型。
 * 使用保守匹配策略：需要关键词 + 结构化格式同时出现。
 *
 * @param reasoningContent LLM 输出的 reasoning_content 字符串
 * @returns 'reasoning_content' 如果检测到计划模式，否则 null
 */
export function detectPlanFromReasoning(
  reasoningContent: string | undefined | null,
): 'reasoning_content' | null {
  if (!reasoningContent || reasoningContent.length < 30) return null

  for (const pattern of PLAN_KEYWORD_PATTERNS) {
    if (pattern.test(reasoningContent)) {
      return 'reasoning_content'
    }
  }

  return null
}

/**
 * 综合 P 碱基检测：合并 _meta 和推理链两个来源。
 *
 * 在 ReAct 循环每轮工具调用后调用。如果返回非 null，
 * 则应在该工具碱基之前插入一个 P 碱基。
 *
 * 优先级: llm_meta > reasoning_content
 */
export function detectPBase(
  toolCallArgs?: Record<string, unknown>,
  reasoningContent?: string | null,
): 'llm_meta' | 'reasoning_content' | null {
  const fromMeta = detectPlanFromMeta(toolCallArgs)
  if (fromMeta) return fromMeta

  return detectPlanFromReasoning(reasoningContent)
}

// ============================================
// Aggregation helpers
// ============================================

export type BaseType = 'E' | 'P' | 'V' | 'X'

/**
 * Build a base sequence string like "X-E-V-E-E" from an array of tool calls.
 */
export function buildBaseSequence(
  tools: Array<{ baseType?: BaseType }>,
): string {
  return tools
    .filter(t => t.baseType)
    .map(t => t.baseType)
    .join('-')
}

/**
 * Compute base distribution from an array of tool calls.
 */
export function buildBaseDistribution(
  tools: Array<{ baseType?: BaseType }>,
): { E: number; P: number; V: number; X: number } {
  const dist = { E: 0, P: 0, V: 0, X: 0 }
  for (const t of tools) {
    if (t.baseType && t.baseType in dist) {
      dist[t.baseType]++
    }
  }
  return dist
}

/**
 * Build a base sequence string from BaseSequenceEntry array.
 * Includes P bases from the independent entries array.
 */
export function buildBaseSequenceFromEntries(
  entries: Array<{ base: BaseType }>,
): string {
  return entries.map(e => e.base).join('-')
}

/**
 * Compute base distribution from BaseSequenceEntry array.
 * Includes P bases from the independent entries array.
 */
export function buildBaseDistributionFromEntries(
  entries: Array<{ base: BaseType }>,
): { E: number; P: number; V: number; X: number } {
  const dist = { E: 0, P: 0, V: 0, X: 0 }
  for (const entry of entries) {
    if (entry.base in dist) {
      dist[entry.base]++
    }
  }
  return dist
}
