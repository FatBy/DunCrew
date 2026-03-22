/**
 * Signal Matcher -- Ported from DunCrew frontend src/utils/signalMatcher.ts
 * V2: 同步 classifyErrorType + extractErrorFingerprint + 指纹兜底
 *
 * Pure string matching, no ML deps. Supports:
 * - Regex patterns: /pattern/flags
 * - Substring matching: case-insensitive
 */

// ============================================
// Types (mirrored from frontend src/types.ts)
// ============================================

export interface Gene {
  id: string;
  category: "repair" | "optimize" | "pattern" | "capability" | "artifact" | "activity";
  signals_match: string[];
  strategy: string[];
  preconditions?: string[];
  antiPatterns?: string[];
  source: {
    traceId?: string;
    nexusId?: string;
    createdAt: number;
    isSeed?: boolean;
  };
  metadata: {
    confidence: number;
    useCount: number;
    successCount: number;
    lastUsedAt?: number;
  };
}

export interface GeneMatch {
  gene: Gene;
  score: number;
  matchedSignals: string[];
}

// ============================================
// Constants
// ============================================

const ERROR_KEYWORDS = [
  "error", "timeout", "permission", "denied", "not found", "no such file",
  "enoent", "eperm", "eacces", "econnrefused", "etimedout",
  "syntax error", "unexpected token", "cannot find", "is not defined",
  "failed", "rejected", "aborted", "invalid", "missing", "overflow",
  "null", "undefined", "nan", "exception", "crash", "fatal",
];

const ERROR_CODE_REGEX = /\b(E[A-Z]{2,}|HTTP_\d{3}|ERR_[A-Z_]+|[A-Z_]{4,}_ERROR)\b/g;

// ============================================
// V2: Error classification
// ============================================

export function classifyErrorType(errorMessage: string): string {
  const lower = errorMessage.toLowerCase();
  if (/timeout|etimedout|econnreset|econnrefused|fetch failed|aborted|network/i.test(lower)) {
    return "transient";
  }
  if (/enoent|not found|not exist|no such file|does not exist/i.test(lower)) {
    return "missing_resource";
  }
  if (/permission|eacces|access denied|forbidden/i.test(lower)) {
    return "permission";
  }
  if (/invalid.*param|bad.*argument|type.*error|invalid.*type/i.test(lower)) {
    return "bad_input";
  }
  if (/syntax|unexpected token|json.*parse|unterminated/i.test(lower)) {
    return "parse_error";
  }
  if (/empty|cannot be empty|required/i.test(lower)) {
    return "missing_input";
  }
  if (/codec|encode|decode|utf-8|gbk/i.test(lower)) {
    return "encoding_error";
  }
  return "unknown";
}

// ============================================
// V2: Error fingerprint extraction
// ============================================

function extractErrorFingerprint(lowerError: string): string | null {
  // Extract file path fragment
  const pathMatch = lowerError.match(/(?:path|file|dir(?:ectory)?)[:\s]+["']?([^\s"']+)/i);
  if (pathMatch) {
    const pathParts = pathMatch[1].replace(/\\/g, "/").split("/");
    const lastParts = pathParts.slice(-2).join("/");
    if (lastParts.length > 3 && lastParts.length < 60) {
      return `path:${lastParts.toLowerCase()}`;
    }
  }

  // Extract HTTP status code
  const httpMatch = lowerError.match(/\b(4\d{2}|5\d{2})\b/);
  if (httpMatch) {
    return `http:${httpMatch[1]}`;
  }

  // Extract command name
  const cmdMatch = lowerError.match(/(?:command|cmd)[:\s]+["']?(\S+)/i);
  if (cmdMatch && cmdMatch[1].length < 30) {
    return `cmd:${cmdMatch[1].toLowerCase()}`;
  }

  // Extract key error phrase
  const cleanError = lowerError.replace(/[^a-z0-9\s]/g, " ").trim();
  const words = cleanError.split(/\s+/).filter((w) => w.length > 2).slice(0, 5);
  if (words.length >= 2) {
    return `err:${words.join("_")}`;
  }

  return null;
}

// ============================================
// Signal extraction (V2: with errorType + fingerprint)
// ============================================

export function extractSignals(toolName: string, errorMessage: string): string[] {
  const signals: string[] = [];
  const lowerError = errorMessage.toLowerCase();

  // 1. Tool name
  signals.push(toolName);

  // 2. Error codes
  const codes = errorMessage.match(ERROR_CODE_REGEX);
  if (codes) {
    for (const code of codes) {
      if (!signals.includes(code.toLowerCase())) {
        signals.push(code.toLowerCase());
      }
    }
  }

  // 3. Predefined keywords
  for (const kw of ERROR_KEYWORDS) {
    if (lowerError.includes(kw) && !signals.includes(kw)) {
      signals.push(kw);
    }
  }

  // 4. Structured error signature (toolName:errorType)
  const errorType = classifyErrorType(errorMessage);
  const structuredSig = `${toolName}:${errorType}`;
  if (!signals.includes(structuredSig)) {
    signals.push(structuredSig);
  }

  // 5. Error fingerprint with fallback
  const errorFingerprint = extractErrorFingerprint(lowerError);
  if (errorFingerprint && !signals.includes(errorFingerprint)) {
    signals.push(errorFingerprint);
  } else if (!errorFingerprint) {
    const fallbackFingerprint = `fp:${errorType}`;
    if (!signals.includes(fallbackFingerprint)) {
      signals.push(fallbackFingerprint);
    }
  }

  return signals;
}

// ============================================
// Gene scoring & ranking
// ============================================

function matchPattern(pattern: string, signals: string[]): boolean {
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2]);
      return signals.some((s) => re.test(s));
    } catch {
      // Invalid regex falls through to substring matching
    }
  }

  const lowerPattern = pattern.toLowerCase();
  return signals.some(
    (s) => s.includes(lowerPattern) || lowerPattern.includes(s)
  );
}

export function scoreGene(
  gene: Gene,
  signals: string[]
): { score: number; matchedSignals: string[] } {
  const matchedSignals: string[] = [];
  for (const pattern of gene.signals_match) {
    if (matchPattern(pattern, signals)) {
      matchedSignals.push(pattern);
    }
  }
  return { score: matchedSignals.length, matchedSignals };
}

export function rankGenes(signals: string[], genes: Gene[]): GeneMatch[] {
  const matches: GeneMatch[] = [];

  for (const gene of genes) {
    if (gene.metadata.confidence < 0.1 && gene.metadata.useCount > 5) {
      continue;
    }
    const { score, matchedSignals } = scoreGene(gene, signals);
    if (score > 0) {
      matches.push({ gene, score, matchedSignals });
    }
  }

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.gene.metadata.confidence - a.gene.metadata.confidence;
  });

  return matches;
}

// ============================================
// Signal overlap (for duplicate detection)
// ============================================

export function signalOverlap(signalsA: string[], signalsB: string[]): number {
  if (signalsA.length === 0 || signalsB.length === 0) return 0;

  const setB = new Set(signalsB.map((s) => s.toLowerCase()));
  const overlap = signalsA.filter((s) => setB.has(s.toLowerCase())).length;
  const maxLen = Math.max(signalsA.length, signalsB.length);

  return overlap / maxLen;
}
