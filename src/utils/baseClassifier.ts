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
 */

// ============================================
// Tool categories
// ============================================

const READ_TOOLS = new Set([
  'readFile', 'listDir', 'searchText', 'searchFiles',
  'readMultipleFiles', 'search_files',
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
// Resource extraction
// ============================================

function extractResource(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  const p = args.path || args.filePath || args.file || args.directory
  if (typeof p === 'string') return p

  if (toolName === 'runCmd') {
    const cmd = String(args.command || args.cmd || '')
    const m = cmd.match(/(?:^|\s)((?:\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+)/)
    return m ? m[1] : `cmd:${cmd.slice(0, 50)}`
  }

  return null
}

// ============================================
// Classification
// ============================================

/**
 * Classify a tool call into E/V/X based on context.
 * P must be assigned externally (by LLM metadata).
 */
export function classifyBaseType(
  toolName: string,
  args: Record<string, unknown>,
  _status: 'success' | 'error',
  ctx: BaseClassifierCtx,
): 'E' | 'V' | 'X' {
  const resource = extractResource(toolName, args)

  // --- V (Verify) ---
  // Write-then-read same resource
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
  // listDir early in session (no previous entry or very early order)
  if (toolName === 'listDir' && (ctx.lastEntry === null || ctx.lastEntry.order <= 3)) {
    return 'X'
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
