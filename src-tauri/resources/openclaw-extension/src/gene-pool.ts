/**
 * Extension Gene Pool -- Lightweight file-based Gene Pool for OpenClaw extension.
 * V2: Thompson Sampling + 策略抽象化 + 注入精简 + 崩溃过滤
 *
 * Handles:
 * - Gene loading/saving from stateDir/genes/
 * - Error signal matching and hint generation (T3)
 * - Session trace collection and gene harvesting (T4)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import {
  type Gene,
  type GeneMatch,
  extractSignals,
  rankGenes,
  signalOverlap,
  classifyErrorType,
} from "./signal-matcher.js";

// ============================================
// Constants
// ============================================

const MAX_GENE_HINTS = 3;
const MAX_HINT_LENGTH = 2000;
const DUPLICATE_OVERLAP_THRESHOLD = 0.85;
const HARVEST_MIN_CONFIDENCE = 0.3;
const CONFIDENCE_CAP = 1.0;

// ============================================
// Session trace types
// ============================================

export interface SessionToolTrace {
  name: string;
  params: Record<string, unknown>;
  status: "success" | "error";
  result: string;
  durationMs: number;
  order: number;
  /** V2: 碱基类型 */
  baseType?: "E" | "P" | "V" | "X";
  /** V2: P 碱基推理摘要 */
  reasoningSummary?: string;
}

// ============================================
// V2: Thompson Sampling
// ============================================

function betaSample(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  const std = Math.sqrt(variance);
  const u1 = Math.random();
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, Math.min(1, mean + std * normal));
}

function thompsonSelect(matches: GeneMatch[], count: number): GeneMatch[] {
  if (matches.length <= count) return matches;
  const scored = matches.map((m) => ({
    match: m,
    sample: betaSample(
      m.gene.metadata.successCount + 1,
      (m.gene.metadata.useCount - m.gene.metadata.successCount) + 1
    ) * m.score,
  }));
  scored.sort((a, b) => b.sample - a.sample);
  return scored.slice(0, count).map((s) => s.match);
}

// ============================================
// V2: Base Type Classifier (E/P/V/X)
// SYNC: 此分类器逻辑必须与 src/utils/baseClassifier.ts 保持同步
// ============================================

const READ_TOOLS = new Set(["readFile", "listDir", "searchText", "searchFiles", "readMultipleFiles", "search_files"]);
const EXPLORE_TOOLS = new Set(["webSearch", "webFetch"]);
const WRITE_TOOLS = new Set(["writeFile", "appendFile", "deleteFile", "renameFile"]);
const VERIFY_CMD_PATTERNS = [
  /tsc\b.*--noEmit/i, /npm\s+(test|run\s+test|run\s+lint|run\s+build)/i,
  /pytest|jest|vitest|mocha/i, /eslint|prettier.*--check/i,
  /cargo\s+(check|test|clippy)/i,
  /go\s+(test|vet)/i,
  /python\s+-m\s+(unittest|pytest)/i,
];
const EXPLORE_CMD_PATTERNS = [
  /^(ls|dir|tree|find)\b/i,
  /^(cat|head|tail|less|more)\b/i,
  /^(grep|rg|ag|ack)\b/i,
  /^git\s+(log|status|diff|show|branch)/i,
  /^(which|where|type|command\s+-v)\b/i,
  /^(echo\s+\$|env|printenv|set)\b/i,
];
const EXPLORE_NAME_PATTERNS = [
  /search/i, /fetch/i, /get/i, /list/i, /read/i,
  /find/i, /query/i, /browse/i, /scan/i, /lookup/i,
  /navigate/i, /screenshot/i, /inspect/i,
];

interface BaseCtx {
  successfulResources: Set<string>;
  recentWrites: Array<{ resource: string; order: number }>;
  lastEntry: SessionToolTrace | null;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function extractResource(toolName: string, params: Record<string, unknown>): string | null {
  const p = params.path || params.filePath || params.file || params.directory;
  if (typeof p === "string") return normalizePath(p);
  const url = params.url || params.href;
  if (typeof url === "string") return url;
  const query = params.query || params.q || params.search_query;
  if (typeof query === "string") return `query:${query}`;
  if (toolName === "runCmd") {
    const cmd = String(params.command || params.cmd || "");
    const m = cmd.match(/(?:^|\s)((?:\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+)/);
    return m ? normalizePath(m[1]) : `cmd:${cmd.slice(0, 50)}`;
  }
  return null;
}

function inferIntentFromArgs(args: Record<string, unknown>): "read" | "write" | "unknown" {
  const hasContent = !!(args.content || args.body || args.data || args.text || args.payload);
  const hasReadTarget = !!(args.url || args.href || args.query || args.q || args.search_query ||
    args.path || args.filePath || args.file || args.directory);
  if (hasContent) return "write";
  if (hasReadTarget && !hasContent) return "read";
  return "unknown";
}

function classifyBaseType(
  toolName: string, params: Record<string, unknown>,
  _status: "success" | "error", ctx: BaseCtx
): "E" | "V" | "X" {
  const resource = extractResource(toolName, params);
  const isKnownTool = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName) ||
    EXPLORE_TOOLS.has(toolName) || toolName === "runCmd";

  // V: write-then-read same resource (path normalized)
  if (READ_TOOLS.has(toolName) && resource && ctx.recentWrites.some(w => w.resource === resource)) return "V";
  // V: retry after failure
  if (ctx.lastEntry && ctx.lastEntry.name === toolName && ctx.lastEntry.status === "error") return "V";
  // V: compile/test after write
  if (toolName === "runCmd" && VERIFY_CMD_PATTERNS.some(p => p.test(String(params.command || params.cmd || ""))) && ctx.recentWrites.length > 0) return "V";

  // X: read operation on never-successfully-accessed resource
  if (READ_TOOLS.has(toolName) && resource && !ctx.successfulResources.has(resource)) return "X";
  // X: web search/fetch
  if (EXPLORE_TOOLS.has(toolName)) return "X";
  // X: listDir on never-accessed directory
  if (toolName === "listDir" && resource && !ctx.successfulResources.has(resource)) return "X";
  // X: listDir early in session (fallback for no-path listDir)
  if (toolName === "listDir" && !resource && (ctx.lastEntry === null || (ctx.lastEntry.order <= 3))) return "X";
  // X: exploratory shell commands
  if (toolName === "runCmd") {
    const cmd = String(params.command || params.cmd || "").trim();
    if (EXPLORE_CMD_PATTERNS.some(p => p.test(cmd))) return "X";
  }

  // Unknown tool fallback: param shape → name pattern
  if (!isKnownTool) {
    const argIntent = inferIntentFromArgs(params);
    if (argIntent === "read") return "X";
    if (argIntent === "unknown" && EXPLORE_NAME_PATTERNS.some(p => p.test(toolName))) return "X";
  }

  return "E";
}

function createBaseCtx(): BaseCtx {
  return { successfulResources: new Set(), recentWrites: [], lastEntry: null };
}

function updateBaseCtx(ctx: BaseCtx, entry: SessionToolTrace): void {
  const resource = extractResource(entry.name, entry.params);
  if (entry.status === "success" && resource) ctx.successfulResources.add(resource);
  if (WRITE_TOOLS.has(entry.name) && entry.status === "success" && resource) {
    ctx.recentWrites.push({ resource: normalizePath(resource), order: entry.order });
    if (ctx.recentWrites.length > 10) ctx.recentWrites.shift();
  }
  ctx.lastEntry = entry;
}

// ============================================
// ExtensionGenePool
// ============================================

export class ExtensionGenePool {
  private genes: Gene[] = [];
  private genesDir: string;
  private pendingHints: string[] = [];
  private sessionTrace: SessionToolTrace[] = [];
  private baseCtx: BaseCtx = createBaseCtx();

  constructor(dataDir: string) {
    this.genesDir = join(dataDir, "genes");
    this.ensureDir(this.genesDir);
    this.loadGenes();
  }

  private ensureDir(dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // ============================================
  // Gene persistence
  // ============================================

  loadGenes(): void {
    this.genes = [];
    if (!existsSync(this.genesDir)) return;

    const files = readdirSync(this.genesDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.genesDir, file), "utf-8");
        const gene: Gene = JSON.parse(raw);
        if (gene.id && gene.signals_match && gene.strategy) {
          this.genes.push(gene);
        }
      } catch {
        // Skip malformed gene files
      }
    }
  }

  private saveGene(gene: Gene): void {
    this.ensureDir(this.genesDir);
    const filePath = join(this.genesDir, `${gene.id}.json`);
    writeFileSync(filePath, JSON.stringify(gene, null, 2), "utf-8");
  }

  getGeneCount(): number {
    return this.genes.length;
  }

  // ============================================
  // T3: Gene matching and hint injection
  // ============================================

  findMatchingGenes(toolName: string, errorMsg: string): GeneMatch[] {
    if (this.genes.length === 0) return [];
    const signals = extractSignals(toolName, errorMsg);
    const matches = rankGenes(signals, this.genes);
    // V2: Thompson Sampling
    return thompsonSelect(matches, MAX_GENE_HINTS);
  }

  buildGeneHint(matches: GeneMatch[]): string {
    if (matches.length === 0) return "";

    const hints = matches.map((m, i) => {
      const confidence = Math.round(m.gene.metadata.confidence * 100);
      // V2: Only output strategy core, skip raw error data
      const strategyText = m.gene.strategy
        .filter((s) => !s.startsWith("Error encountered:") && !s.startsWith("Recovery result:"))
        .join("; ");

      let hint = `${i + 1}. [${confidence}%] ${strategyText}`;

      // V2: Anti-pattern warning
      if (m.gene.antiPatterns && m.gene.antiPatterns.length > 0) {
        hint += `\n   ⚠ Not applicable when: ${m.gene.antiPatterns[0]}`;
      }

      return hint;
    });

    let text = `\n[Gene Pool] Historical repair experience:\n${hints.join("\n")}\nApply if the error matches; use your judgment if context differs.`;

    if (text.length > MAX_HINT_LENGTH) {
      text = text.slice(0, MAX_HINT_LENGTH) + "\n...(truncated)";
    }
    return text;
  }

  /**
   * Match error against gene pool and queue hint for next prompt injection.
   */
  matchAndQueue(toolName: string, errorMsg: string): void {
    const matches = this.findMatchingGenes(toolName, errorMsg);
    if (matches.length > 0) {
      const hint = this.buildGeneHint(matches);
      if (hint) {
        this.pendingHints.push(hint);
      }
      // Update use counts
      for (const m of matches) {
        m.gene.metadata.useCount++;
        m.gene.metadata.lastUsedAt = Date.now();
        this.saveGene(m.gene);
      }
    }
  }

  /**
   * Consume and clear pending hints (called from before_prompt_build).
   */
  consumePendingHints(): string | null {
    if (this.pendingHints.length === 0) return null;
    const combined = this.pendingHints.join("\n");
    this.pendingHints = [];
    return combined;
  }

  // ============================================
  // T4: Session trace collection
  // ============================================

  /**
   * Record a tool call from after_tool_call event.
   */
  recordToolCall(event: {
    toolName?: string;
    name?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs?: number;
  }): void {
    const name = event.toolName || event.name || "unknown";
    const hasError = !!event.error;
    const resultStr =
      typeof event.result === "string"
        ? event.result
        : JSON.stringify(event.result || "").slice(0, 1000);

    const status: "success" | "error" = hasError ? "error" : "success";
    const params = event.params || {};

    // V2: Base type classification
    const baseType = classifyBaseType(name, params, status, this.baseCtx);

    const entry: SessionToolTrace = {
      name,
      params,
      status,
      result: hasError ? (event.error || "") : resultStr,
      durationMs: event.durationMs || 0,
      order: this.sessionTrace.length,
      baseType,
    };

    this.sessionTrace.push(entry);

    // V2: Update base classifier context
    updateBaseCtx(this.baseCtx, entry);
  }

  /**
   * Reset session trace (called from session_start).
   */
  resetSession(): void {
    this.sessionTrace = [];
    this.pendingHints = [];
    this.baseCtx = createBaseCtx();
  }

  /**
   * Get a copy of the current session trace (for SOP fitness computation).
   */
  getSessionTrace(): SessionToolTrace[] {
    return [...this.sessionTrace];
  }

  /**
   * V2: Get base sequence string for analysis.
   */
  getBaseSequence(): string {
    return this.sessionTrace
      .filter(t => t.baseType)
      .map(t => t.baseType)
      .join("-");
  }

  // ============================================
  // T4: Gene harvesting
  // ============================================

  /**
   * Analyze session trace for error->success patterns and extract new genes.
   */
  harvestGenes(nexusId?: string): Gene[] {
    if (this.sessionTrace.length < 2) return [];

    const sorted = [...this.sessionTrace].sort((a, b) => a.order - b.order);
    const harvested: Gene[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const failedTool = sorted[i];
      if (failedTool.status !== "error") continue;

      // V2: Skip plugin crash errors — not useful as repair genes
      const errorMsg = failedTool.result || "";
      if (/plugin exited|exit code|3221225794|segfault|stack overflow/i.test(errorMsg)) {
        continue;
      }

      // Find same-name success call after this failure
      for (let j = i + 1; j < sorted.length; j++) {
        const recoveryTool = sorted[j];
        if (recoveryTool.name !== failedTool.name) continue;
        if (recoveryTool.status !== "success") continue;

        // Found error->success pair
        const signals = extractSignals(failedTool.name, errorMsg);

        // Check for duplicate genes
        const isDuplicate = this.genes.some((existing) => {
          const overlap = signalOverlap(signals, existing.signals_match);
          if (overlap >= DUPLICATE_OVERLAP_THRESHOLD) {
            // Boost existing gene's confidence
            existing.metadata.confidence = Math.min(
              CONFIDENCE_CAP,
              existing.metadata.confidence + 0.05
            );
            this.saveGene(existing);
            return true;
          }
          return false;
        });

        if (isDuplicate) break;

        // Build repair strategy from the diff
        const strategy = this.buildStrategy(failedTool, recoveryTool, sorted.slice(i + 1, j));
        if (strategy.length === 0) break;

        // V2: Auto-generate preconditions
        const errorType = classifyErrorType(errorMsg);
        const preconditions = [`${failedTool.name} returned a ${errorType} type error`];

        const gene: Gene = {
          id: `gene-${Date.now()}-${harvested.length}`,
          category: "repair",
          signals_match: signals,
          strategy,
          preconditions,
          source: {
            traceId: `trace-${sorted[0].order}`,
            nexusId,
            createdAt: Date.now(),
          },
          metadata: {
            confidence: HARVEST_MIN_CONFIDENCE,
            useCount: 0,
            successCount: 0,
          },
        };

        harvested.push(gene);
        break; // Only pair with first success
      }
    }

    // Persist new genes
    for (const gene of harvested) {
      this.genes.push(gene);
      this.saveGene(gene);
    }

    return harvested;
  }

  /**
   * V2: Build abstract repair strategy (no concrete param values).
   */
  private buildStrategy(
    failed: SessionToolTrace,
    success: SessionToolTrace,
    intermediate: SessionToolTrace[]
  ): string[] {
    const strategy: string[] = [];
    const failedArgs = failed.params || {};
    const successArgs = success.params || {};

    // 1. Analyze parameter change patterns (abstract, no concrete values)
    const paramPatterns: string[] = [];
    for (const key of Object.keys(successArgs)) {
      const failedVal = failedArgs[key];
      const successVal = successArgs[key];
      const failedStr = JSON.stringify(failedVal ?? "");
      const successStr = JSON.stringify(successVal);

      if (failedStr === successStr) continue;

      if (!failedVal || failedStr === '""' || failedStr === "null") {
        paramPatterns.push(`parameter "${key}" was empty — need to obtain correct ${key} first`);
      } else if (typeof failedVal === "string" && typeof successVal === "string") {
        if (failedVal.includes("/") || failedVal.includes("\\") || successVal.includes("/") || successVal.includes("\\")) {
          paramPatterns.push(`parameter "${key}" path was corrected — verify correct path before retry`);
        } else {
          paramPatterns.push(`parameter "${key}" value was corrected — check format and content`);
        }
      } else {
        paramPatterns.push(`parameter "${key}" was modified — check type and format`);
      }
    }

    // 2. Generate repair strategy
    const errorType = classifyErrorType(failed.result || "");
    const toolName = failed.name;

    if (paramPatterns.length > 0) {
      strategy.push(`${toolName} failed (${errorType}): ${paramPatterns.join("; ")}`);
    }

    // 3. Record repair path
    if (intermediate.length > 0) {
      const successfulIntermediates = intermediate.filter((t) => t.status === "success" && t.name !== failed.name);
      const uniqueTools = [...new Set(successfulIntermediates.map((t) => t.name))];
      if (uniqueTools.length > 0) {
        strategy.push(`Repair path: use ${uniqueTools.join(" → ")} to gather info, then retry ${toolName} with correct params`);
      }
    }

    // 4. Fallback strategy based on error type
    if (strategy.length === 0) {
      const fallbackStrategies: Record<string, string> = {
        missing_resource: `${toolName} target not found — use listDir to verify path exists`,
        missing_input: `${toolName} missing required parameter — ensure all required params are non-empty`,
        permission: `${toolName} access denied — check path is within allowed working directory`,
        bad_input: `${toolName} bad parameter format — check parameter types and format`,
        parse_error: `${toolName} parse error — check input data format`,
        encoding_error: `${toolName} encoding error — try specifying a different encoding`,
        transient: `${toolName} transient error — retry directly, likely to succeed`,
        unknown: `${toolName} failed then succeeded on retry — possibly transient`,
      };
      strategy.push(fallbackStrategies[errorType] || fallbackStrategies.unknown);
    }

    return strategy;
  }

  // ============================================
  // Pre-check hints from Gene Pool
  // ============================================

  /**
   * Build pre-check hints from historical failure genes.
   * Extracts concrete, actionable checks based on known failure patterns
   * relevant to the given nexusId (or global genes if no nexusId).
   * Only includes high-confidence genes (>= 0.5).
   */
  buildPreCheckHints(nexusId?: string): string | null {
    // Filter genes relevant to this nexus (or all repair genes if no nexusId)
    const relevantGenes = this.genes.filter(g => {
      if (g.category !== "repair") return false;
      if (g.metadata.confidence < 0.5) return false;
      if (nexusId && g.source.nexusId && g.source.nexusId !== nexusId) return false;
      return true;
    });

    if (relevantGenes.length === 0) return null;

    // Sort by confidence desc, then by useCount desc
    relevantGenes.sort((a, b) => {
      if (b.metadata.confidence !== a.metadata.confidence) {
        return b.metadata.confidence - a.metadata.confidence;
      }
      return b.metadata.useCount - a.metadata.useCount;
    });

    // Extract unique error patterns and their repair actions
    const checks: string[] = [];
    const seenTools = new Set<string>();

    for (const gene of relevantGenes.slice(0, 5)) {
      // Extract the failing tool from signals
      const toolSignals = gene.signals_match.filter(s => !s.startsWith("/") && !s.includes(" "));
      const failingTool = toolSignals[0] || "unknown";

      if (seenTools.has(failingTool)) continue;
      seenTools.add(failingTool);

      // V2: Use strategy directly (already abstracted)
      const strategyText = gene.strategy
        .filter(s => !s.startsWith("Error encountered:") && !s.startsWith("Recovery result:"))
        .join("; ");

      checks.push(
        `- ${failingTool}: ${strategyText} (confidence: ${Math.round(gene.metadata.confidence * 100)}%)`
      );
    }

    if (checks.length === 0) return null;

    const parts: string[] = [];
    parts.push("[Pre-Check — Known Failure Patterns]");
    parts.push("Based on Gene Pool data, these tools have known failure patterns:");
    parts.push(...checks);
    parts.push("Take preventive action for these before proceeding.");

    return parts.join("\n");
  }
}
