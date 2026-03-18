/**
 * Signal Matcher -- Ported from DunCrew frontend src/utils/signalMatcher.ts
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
  source: {
    traceId?: string;
    nexusId?: string;
    createdAt: number;
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
// Signal extraction
// ============================================

export function extractSignals(toolName: string, errorMessage: string): string[] {
  const signals: string[] = [];
  const lowerError = errorMessage.toLowerCase();

  // 1. Tool name itself is an important signal
  signals.push(toolName);

  // 2. Extract error codes (ENOENT, EPERM, etc.)
  const codes = errorMessage.match(ERROR_CODE_REGEX);
  if (codes) {
    for (const code of codes) {
      if (!signals.includes(code.toLowerCase())) {
        signals.push(code.toLowerCase());
      }
    }
  }

  // 3. Match predefined keywords
  for (const kw of ERROR_KEYWORDS) {
    if (lowerError.includes(kw) && !signals.includes(kw)) {
      signals.push(kw);
    }
  }

  // 4. Error message snippet (first 100 chars, for exact matching)
  const snippet = errorMessage.slice(0, 100).trim();
  if (snippet && !signals.includes(snippet.toLowerCase())) {
    signals.push(snippet.toLowerCase());
  }

  return signals;
}

// ============================================
// Gene scoring & ranking
// ============================================

function matchPattern(pattern: string, signals: string[]): boolean {
  // Regex pattern: /pattern/flags
  const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const re = new RegExp(regexMatch[1], regexMatch[2]);
      return signals.some((s) => re.test(s));
    } catch {
      // Invalid regex falls through to substring matching
    }
  }

  // Substring matching (case-insensitive)
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
    // Skip low-confidence retired genes
    if (gene.metadata.confidence < 0.1 && gene.metadata.useCount > 5) {
      continue;
    }
    const { score, matchedSignals } = scoreGene(gene, signals);
    if (score > 0) {
      matches.push({ gene, score, matchedSignals });
    }
  }

  // Sort by score desc, then confidence desc
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
