/**
 * DunCrew Dun Manager — Node.js file-based Dun management for OpenClaw extension.
 *
 * Handles: DUN.md parsing, experience read/write, SOP tracking, Dun state persistence.
 * Data stored in: {dunDataDir}/duns/{dunId}/
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

import type { SessionToolTrace } from "./gene-pool.js";

// ============================================
// Types
// ============================================

export interface SOPStep {
  text: string;
  index: number;
  keywords: string[];
}

export interface SOPPhase {
  name: string;
  index: number;
  steps: SOPStep[];
}

export interface SOPTracker {
  phases: SOPPhase[];
  currentPhaseIndex: number; // -1 = not started
  dunId: string;
  dunLabel: string;
}

/** SOP 执行模式 */
export type SOPMode = 'strict' | 'optional' | 'skip';

export interface SOPEvaluation {
  mode: SOPMode;
  reason: string;
}

/** 简化版规则 (从 DUN.md ## Rules 段落解析) */
export interface DunRule {
  id: string;
  condition: string;
  action: string;
  priority: number;
}

export interface DunMeta {
  id: string;
  name: string;
  version?: string;
  objective?: string;
  metrics?: string[];
  strategy?: string;
  triggers?: string[];
  boundSkillIds?: string[];
  tags?: string[];
  sopContent?: string;
}

// ============================================
// SOP Fitness types
// ============================================

export interface TraceSummary {
  timestamp: number;
  success: boolean;
  fitness: number;
  toolCount: number;
  errorCount: number;
  durationMs: number;
  phaseReached: number;
  toolChain: string[];
  errorTools: string[];
}

export interface PhaseStatEntry {
  successes: number;
  failures: number;
  commonTools: string[];
  commonErrors: string[];
}

export interface ExtensionSOPFitness {
  ema: number;
  totalExecutions: number;
  executionsSinceRewrite: number;
  baselineEma: number;
  recentTraces: TraceSummary[];
  phaseStats: Record<string, PhaseStatEntry>;
  lastUpdatedAt: number;
}

// ============================================
// Golden Path types
// ============================================

export interface GoldenPath {
  /** Most common core tools across successful executions */
  recommendedToolChain: string[];
  /** Confidence (0-1): average presence rate of core tools across successes */
  confidence: number;
  /** Average execution duration (ms) for matching traces */
  averageDurationMs: number;
  /** Known failure patterns extracted from failures */
  knownPitfalls: string[];
  /** Number of successful executions this path is based on */
  basedOnSuccesses: number;
  /** Timestamp of last distillation */
  lastDistilledAt: number;
}

export interface RecentEntities {
  files: string[];
  commands: string[];
  queries: string[];
  lastToolName: string | null;
  timestamp: number;
}

// ============================================
// DunManager
// ============================================

export class DunManager {
  private dataDir: string;
  private sopTrackers = new Map<string, SOPTracker>();
  private recentEntities: RecentEntities = {
    files: [],
    commands: [],
    queries: [],
    lastToolName: null,
    timestamp: Date.now(),
  };

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.ensureDir(dataDir);
  }

  // ============================================
  // Directory management
  // ============================================

  private ensureDir(dir: string) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private dunDir(dunId: string): string {
    return join(this.dataDir, "duns", dunId);
  }

  private dunMdPath(dunId: string): string {
    return join(this.dunDir(dunId), "DUN.md");
  }

  private experienceDir(dunId: string): string {
    return join(this.dunDir(dunId), "experience");
  }

  // ============================================
  // Dun CRUD
  // ============================================

  listDuns(): string[] {
    const dunsDir = join(this.dataDir, "duns");
    if (!existsSync(dunsDir)) return [];
    return readdirSync(dunsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  loadDunMeta(dunId: string): DunMeta | null {
    const mdPath = this.dunMdPath(dunId);
    if (!existsSync(mdPath)) return null;

    const content = readFileSync(mdPath, "utf-8");
    return this.parseDunMd(dunId, content);
  }

  saveDunMd(dunId: string, content: string): void {
    this.ensureDir(this.dunDir(dunId));
    writeFileSync(this.dunMdPath(dunId), content, "utf-8");
  }

  // ============================================
  // DUN.md parsing
  // ============================================

  private parseDunMd(dunId: string, content: string): DunMeta {
    const meta: DunMeta = { id: dunId, name: dunId, sopContent: content };

    // Parse YAML frontmatter
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const yaml = fmMatch[1];
      const getString = (key: string) => {
        const m = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
        return m ? m[1].trim() : undefined;
      };
      const getArray = (key: string) => {
        const lines: string[] = [];
        const re = new RegExp(`^${key}:\\s*$`, "m");
        const idx = yaml.search(re);
        if (idx < 0) return undefined;
        const after = yaml.slice(idx).split("\n").slice(1);
        for (const line of after) {
          const itemMatch = line.match(/^\s+-\s+(.+)/);
          if (itemMatch) lines.push(itemMatch[1].trim());
          else break;
        }
        return lines.length > 0 ? lines : undefined;
      };

      meta.name = getString("name") || dunId;
      meta.version = getString("version");
      meta.objective = getString("objective");
      meta.strategy = getString("strategy");
      meta.metrics = getArray("metrics");
      meta.triggers = getArray("triggers");
      meta.boundSkillIds = getArray("skill_dependencies");
      meta.tags = getArray("tags");
    }

    return meta;
  }

  // ============================================
  // SOP Parsing & Tracking
  // ============================================

  parseSOP(dunId: string, content: string): SOPPhase[] {
    const phases: SOPPhase[] = [];
    const lines = content.split("\n");
    let currentPhase: SOPPhase | null = null;
    let inSOP = false;

    for (const line of lines) {
      // Detect SOP section start
      if (/^##\s+SOP/i.test(line)) {
        inSOP = true;
        continue;
      }
      // Detect next ## section (exit SOP)
      if (inSOP && /^##\s+[^#]/.test(line) && !/^###/.test(line)) {
        inSOP = false;
        continue;
      }
      if (!inSOP) continue;

      // Phase header: ### Phase N: Name / ### N. Name / ### Name
      const phaseMatch = line.match(
        /^###\s+(?:Phase\s+\d+[:.：]\s*|(\d+)\.\s+)?(.+)/i
      );
      if (phaseMatch) {
        const phaseName = phaseMatch[2].trim();
        // Skip non-phase sections
        if (/^(?:Mission|Constraints|Notes|技能应用)/i.test(phaseName)) continue;
        currentPhase = {
          name: phaseName,
          index: phases.length + 1,
          steps: [],
        };
        phases.push(currentPhase);
        continue;
      }

      // Step: 1. text / - text
      if (currentPhase) {
        const stepMatch = line.match(/^\s*(?:\d+\.\s+|-\s+)(.+)/);
        if (stepMatch) {
          const text = stepMatch[1].trim();
          const keywords = this.extractKeywords(text);
          currentPhase.steps.push({
            text,
            index: currentPhase.steps.length + 1,
            keywords,
          });
        }
      }
    }

    return phases;
  }

  private extractKeywords(text: string): string[] {
    // Extract meaningful keywords (Chinese + English, filter short/common words)
    const words = text
      .replace(/[^\w\u4e00-\u9fff]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2);
    return [...new Set(words)].slice(0, 8);
  }

  createSOPTracker(dunId: string, dunLabel: string, content: string): SOPTracker {
    const phases = this.parseSOP(dunId, content);
    const tracker: SOPTracker = {
      phases,
      currentPhaseIndex: phases.length > 0 ? 0 : -1,
      dunId,
      dunLabel
    };
    this.sopTrackers.set(dunId, tracker);
    return tracker;
  }

  getSOPTracker(dunId: string): SOPTracker | undefined {
    return this.sopTrackers.get(dunId);
  }

  inferSOPProgress(
    dunId: string,
    toolName: string,
    toolResult: string
  ): void {
    const tracker = this.sopTrackers.get(dunId);
    if (!tracker || tracker.phases.length === 0) return;

    const combined = `${toolName} ${toolResult}`.toLowerCase();

    // Scan forward from current phase
    for (let i = tracker.currentPhaseIndex; i < tracker.phases.length; i++) {
      const phase = tracker.phases[i];
      for (const step of phase.steps) {
        const matched = step.keywords.some(
          (kw) => combined.includes(kw.toLowerCase())
        );
        if (matched && i > tracker.currentPhaseIndex) {
          tracker.currentPhaseIndex = i;
          return;
        }
      }
    }
  }

  // ============================================
  // Context Building
  // ============================================

  buildSOPContext(dunId: string, maxLength: number): string {
    const meta = this.loadDunMeta(dunId);
    if (!meta) return "";

    const parts: string[] = [];

    // Dun identity
    if (meta.objective) {
      parts.push(`[Dun: ${meta.name}] Objective: ${meta.objective}`);
    }
    if (meta.metrics && meta.metrics.length > 0) {
      parts.push(`Metrics: ${meta.metrics.join("; ")}`);
    }
    if (meta.strategy) {
      parts.push(`Strategy: ${meta.strategy}`);
    }

    // SOP roadmap (structured, concise)
    const tracker = this.sopTrackers.get(dunId);
    if (tracker && tracker.phases.length > 0) {
      parts.push("\n--- SOP Roadmap ---");
      for (const phase of tracker.phases) {
        const isCurrent = phase.index - 1 === tracker.currentPhaseIndex;
        const marker = isCurrent ? "→" : " ";
        parts.push(`${marker} Phase ${phase.index}: ${phase.name}`);
        for (const step of phase.steps) {
          parts.push(`    ${step.index}. ${step.text}`);
        }
      }
      if (tracker.currentPhaseIndex >= 0) {
        parts.push(
          `\n当前进度: Phase ${tracker.currentPhaseIndex + 1}/${tracker.phases.length}`
        );
      }
    }

    // Full SOP content (reference, truncated)
    if (meta.sopContent) {
      const truncated =
        meta.sopContent.length > maxLength
          ? meta.sopContent.slice(0, maxLength) + "\n...(truncated)"
          : meta.sopContent;
      parts.push("\n--- Full SOP Reference ---\n" + truncated);
    }

    return parts.join("\n");
  }

  // ============================================
  // Anaphora Resolution
  // ============================================

  updateRecentEntities(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolResult: string
  ): void {
    const now = Date.now();
    this.recentEntities.lastToolName = toolName;
    this.recentEntities.timestamp = now;

    // Extract file paths
    const filePath =
      (toolArgs.path as string) || (toolArgs.filePath as string) || (toolArgs.file as string);
    if (filePath && typeof filePath === "string") {
      this.recentEntities.files = [
        filePath,
        ...this.recentEntities.files.filter((f) => f !== filePath),
      ].slice(0, 5);
    }

    // Extract commands
    if (
      (toolName === "runCmd" || toolName === "run_command") &&
      toolArgs.command
    ) {
      const cmd = String(toolArgs.command);
      this.recentEntities.commands = [
        cmd,
        ...this.recentEntities.commands.filter((c) => c !== cmd),
      ].slice(0, 5);
    }

    // Extract queries
    if (
      (toolName === "webSearch" || toolName === "web_search") &&
      toolArgs.query
    ) {
      const query = String(toolArgs.query);
      this.recentEntities.queries = [
        query,
        ...this.recentEntities.queries.filter((q) => q !== query),
      ].slice(0, 5);
    }
  }

  buildAnaphoraHint(expireMs: number): string {
    const elapsed = Date.now() - this.recentEntities.timestamp;
    if (elapsed > expireMs) return "";

    const { files, commands, queries, lastToolName } = this.recentEntities;
    if (!files.length && !commands.length && !queries.length) return "";

    const parts = [
      "[Anaphora Resolution] Recent context for pronoun resolution:",
    ];
    if (files.length > 0) parts.push(`  Files: ${files.join(", ")}`);
    if (commands.length > 0) parts.push(`  Commands: ${commands.join(", ")}`);
    if (queries.length > 0) parts.push(`  Queries: ${queries.join(", ")}`);
    if (lastToolName) parts.push(`  Last tool: ${lastToolName}`);
    return parts.join("\n");
  }

  // ============================================
  // Experience Recording
  // ============================================

  recordExperience(
    dunId: string,
    type: "success" | "failure",
    entry: { task: string; toolsUsed: string[]; duration?: number; output?: string; error?: string }
  ): void {
    const expDir = this.experienceDir(dunId);
    this.ensureDir(expDir);

    const fileName = type === "success" ? "successes.md" : "failures.md";
    const filePath = join(expDir, fileName);

    const timestamp = new Date().toISOString();
    const toolsList = entry.toolsUsed.length > 0 ? entry.toolsUsed.join(", ") : "none";
    const durationStr = entry.duration ? `${Math.round(entry.duration / 1000)}s` : "N/A";

    let record = `\n### ${timestamp}\n`;
    record += `- **Task**: ${entry.task.slice(0, 200)}\n`;
    record += `- **Tools**: ${toolsList}\n`;
    record += `- **Duration**: ${durationStr}\n`;
    if (entry.output) {
      record += `- **Result**: ${entry.output.slice(0, 500)}\n`;
    }
    if (entry.error) {
      record += `- **Error**: ${entry.error.slice(0, 300)}\n`;
    }

    // Append to experience file
    let existing = "";
    if (existsSync(filePath)) {
      existing = readFileSync(filePath, "utf-8");
    } else {
      existing = `# ${type === "success" ? "Successes" : "Failures"}\n`;
    }
    writeFileSync(filePath, existing + record, "utf-8");
  }

  searchExperiences(dunId: string, query: string, topK = 3): string[] {
    const results: string[] = [];

    for (const type of ["successes", "failures"] as const) {
      const filePath = join(this.experienceDir(dunId), `${type}.md`);
      if (!existsSync(filePath)) continue;

      const content = readFileSync(filePath, "utf-8");
      const entries = content.split(/\n###\s+/).filter((e) => e.trim());
      const queryLower = query.toLowerCase();

      // Simple keyword scoring
      const scored = entries.map((entry) => {
        const lower = entry.toLowerCase();
        let score = 0;
        for (const word of queryLower.split(/\s+/)) {
          if (word.length >= 2 && lower.includes(word)) score++;
        }
        return { entry: `[${type}] ### ${entry.trim()}`, score };
      });

      scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .forEach((s) => results.push(s.entry));
    }

    return results.slice(0, topK);
  }

  // ============================================
  // SOP Mode Evaluation (Phase 4)
  // ============================================

  /**
   * 评估用户任务是否需要 SOP 执行
   * strict: 关键字强匹配或包含多步骤明确任务
   * optional: 有 SOP 但任务可能不需要
   * skip: 没有 SOP 或简单查询
   */
  evaluateSOPApplicability(
    userQuery: string,
    dunId: string
  ): SOPEvaluation {
    const tracker = this.sopTrackers.get(dunId);
    if (!tracker || tracker.phases.length === 0) {
      return { mode: "skip", reason: "No SOP phases available" };
    }

    const queryLower = userQuery.toLowerCase();

    // 简单查询模式检测: 短查询或纯问答
    const simplePatterns = [
      /^(什么|为什么|怎么|如何|where|what|why|how|is|are|can)\b/i,
      /[?？]$/,
    ];
    const isSimpleQuery =
      queryLower.length < 20 ||
      simplePatterns.some((p) => p.test(queryLower.trim()));
    if (isSimpleQuery) {
      return { mode: "skip", reason: "Simple query detected" };
    }

    // 检查用户查询是否匹配 SOP Phase 关键字
    let matchCount = 0;
    for (const phase of tracker.phases) {
      for (const step of phase.steps) {
        if (
          step.keywords.some((kw) => queryLower.includes(kw.toLowerCase()))
        ) {
          matchCount++;
          break;
        }
      }
    }

    // 如果匹配了 >50% 的 Phase，strict
    if (matchCount >= Math.ceil(tracker.phases.length * 0.5)) {
      return {
        mode: "strict",
        reason: `Matched ${matchCount}/${tracker.phases.length} phases`,
      };
    }

    // 有 SOP 且非简单查询: optional
    return {
      mode: "optional",
      reason: "SOP available, task may benefit from structured execution",
    };
  }

  /**
   * 检测模型首轮回复是否采纳了 SOP
   * 查找 [SOP:FOLLOW] 或 [SOP:FREE] 标记
   */
  detectSOPAdoption(responseText: string): boolean {
    if (responseText.includes("[SOP:FOLLOW]")) return true;
    if (responseText.includes("[SOP:FREE]")) return false;
    // 默认: 如果回复中提到了 Phase 或阶段，视为采纳
    return /phase\s*\d|阶段\s*\d/i.test(responseText);
  }

  /**
   * 构建 SOP 中途提醒 (注入到后续 prompt 中)
   */
  buildSOPReminder(
    dunId: string,
    toolsUsed: string[],
    lastToolResult?: string
  ): string {
    const tracker = this.sopTrackers.get(dunId);
    if (!tracker || tracker.phases.length === 0) return "";

    const currentPhase = tracker.phases[tracker.currentPhaseIndex];
    if (!currentPhase) return "";

    const nextPhase =
      tracker.currentPhaseIndex + 1 < tracker.phases.length
        ? tracker.phases[tracker.currentPhaseIndex + 1]
        : null;

    const parts: string[] = [];
    parts.push(
      `[SOP 进度提醒 - ${tracker.dunLabel}]`
    );
    parts.push(
      `当前: Phase ${tracker.currentPhaseIndex + 1}/${tracker.phases.length} — ${currentPhase.name}`
    );

    // 展示当前 Phase 的步骤
    for (const step of currentPhase.steps) {
      parts.push(`  ${step.index}. ${step.text}`);
    }

    if (nextPhase) {
      parts.push(`下一阶段: Phase ${nextPhase.index} — ${nextPhase.name}`);
    }

    parts.push(
      `已使用工具: ${toolsUsed.length > 0 ? toolsUsed.join(", ") : "无"}`
    );

    if (lastToolResult) {
      parts.push(
        `上一工具结果摘要: ${lastToolResult.slice(0, 200)}`
      );
    }

    parts.push(
      "请继续按 SOP 执行，完成当前阶段后自动进入下一阶段。"
    );

    return parts.join("\n");
  }

  /**
   * 构建首轮 SOP 指引 (根据 sopMode 生成 strict/optional 指令)
   */
  buildSOPDirective(
    dunId: string,
    mode: SOPMode
  ): string {
    const tracker = this.sopTrackers.get(dunId);
    if (!tracker || tracker.phases.length === 0 || mode === "skip") return "";

    if (mode === "strict") {
      let directive = `[SOP 执行指令 - ${tracker.dunLabel}]\n`;
      directive += `你已激活 Dun "${tracker.dunLabel}"，必须严格按照 SOP 流程执行。\n`;
      directive += `注意：根据任务实际需求灵活调整执行深度。对于简单任务，可以快速通过或跳过分析/验证类阶段；对于复杂任务，每个阶段都应充分执行。\n`;
      const firstPhase = tracker.phases[0];
      if (firstPhase) {
        directive += `从 Phase 1 "${firstPhase.name}" 开始:\n`;
        for (const step of firstPhase.steps) {
          directive += `  ${step.index}. ${step.text}\n`;
        }
      }
      directive += `完成一个阶段后立即进入下一个阶段，不要停下来询问用户。`;
      return directive;
    }

    // optional mode
    let choice = `[SOP 适用性评估 - ${tracker.dunLabel}]\n`;
    choice += `当前 Dun "${tracker.dunLabel}" 有预定义的 SOP 流程（共 ${tracker.phases.length} 个阶段）。\n`;
    choice += `请先判断用户的任务是否适合按此 SOP 流程执行：\n\n`;
    choice += `SOP 概要:\n`;
    for (const phase of tracker.phases) {
      choice += `  Phase ${phase.index}: ${phase.name}\n`;
    }
    choice += `\n如果此任务适合按 SOP 执行，请在回复开头包含 [SOP:FOLLOW]，然后从 Phase 1 开始。\n`;
    choice += `如果此任务不需要 SOP（如简单查询、单步操作等），请在回复开头包含 [SOP:FREE]，然后自由选择最佳方案。\n`;
    choice += `提示：即使选择 [SOP:FOLLOW]，也可以根据任务复杂度跳过不相关的阶段（如任务简单时跳过深度分析或验证阶段）。\n`;
    choice += `注意：[SOP:FOLLOW] 和 [SOP:FREE] 标记仅供系统识别，不会展示给用户。`;
    return choice;
  }

  // ============================================
  // Rule Parsing (Phase 4: simplified rule engine)
  // ============================================

  /**
   * 从 DUN.md 的 ## Rules 段落解析规则
   */
  parseRules(dunId: string): DunRule[] {
    const meta = this.loadDunMeta(dunId);
    if (!meta?.sopContent) return [];

    const rules: DunRule[] = [];
    const content = meta.sopContent;
    const lines = content.split("\n");
    let inRules = false;

    for (const line of lines) {
      if (/^##\s+Rules/i.test(line)) {
        inRules = true;
        continue;
      }
      if (inRules && /^##\s+[^#]/.test(line) && !/^###/.test(line)) {
        inRules = false;
        continue;
      }
      if (!inRules) continue;

      // 规则格式: - IF <condition> THEN <action>  或  - <condition> → <action>
      const ruleMatch = line.match(
        /^\s*(?:-\s+)?(?:IF\s+)?(.+?)(?:\s+THEN\s+|\s*[→⇒]\s*)(.+)/i
      );
      if (ruleMatch) {
        rules.push({
          id: `rule-${rules.length + 1}`,
          condition: ruleMatch[1].trim(),
          action: ruleMatch[2].trim(),
          priority: rules.length + 1,
        });
      }
    }

    return rules;
  }

  /**
   * 构建规则上下文 (注入到 agent prompt)
   */
  buildRulesContext(dunId: string): string {
    const rules = this.parseRules(dunId);
    if (rules.length === 0) return "";

    const parts = [`[Dun Rules - Active]`];
    for (const rule of rules) {
      parts.push(`  R${rule.priority}: IF ${rule.condition} THEN ${rule.action}`);
    }
    return parts.join("\n");
  }

  // ============================================
  // XP Management
  // ============================================

  private xpFilePath(dunId: string): string {
    return join(this.dunDir(dunId), "xp.json");
  }

  static xpToLevel(xp: number): number {
    if (xp >= 500) return 4;
    if (xp >= 100) return 3;
    if (xp >= 20) return 2;
    return 1;
  }

  loadDunXP(dunId: string): { xp: number; level: number } {
    const filePath = this.xpFilePath(dunId);
    if (!existsSync(filePath)) return { xp: 0, level: 1 };
    try {
      const raw = readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      const xp = typeof data.xp === "number" ? data.xp : 0;
      return { xp, level: DunManager.xpToLevel(xp) };
    } catch {
      return { xp: 0, level: 1 };
    }
  }

  saveDunXP(dunId: string, xp: number): void {
    this.ensureDir(this.dunDir(dunId));
    const level = DunManager.xpToLevel(xp);
    const data = { xp, level, updatedAt: Date.now() };
    writeFileSync(this.xpFilePath(dunId), JSON.stringify(data, null, 2), "utf-8");
  }

  // ============================================
  // Dun Profile (complete context for agent)
  // ============================================

  buildDunProfile(dunId: string): string {
    const meta = this.loadDunMeta(dunId);
    if (!meta) return "";

    const parts: string[] = [];
    parts.push(`[Active Dun: ${meta.name}]`);

    if (meta.objective) parts.push(`Objective: ${meta.objective}`);
    if (meta.metrics && meta.metrics.length > 0) {
      parts.push(`Metrics: ${meta.metrics.join("; ")}`);
    }
    if (meta.strategy) parts.push(`Strategy: ${meta.strategy}`);

    if (meta.boundSkillIds && meta.boundSkillIds.length > 0) {
      parts.push(`Bound Skills (prefer these tools): ${meta.boundSkillIds.join(", ")}`);
    }

    const { xp, level } = this.loadDunXP(dunId);
    parts.push(`Experience: Lv${level} (XP: ${xp})`);

    const experiences = this.searchExperiences(dunId, "", 3);
    if (experiences.length > 0) {
      parts.push("\n--- Recent Experience ---");
      for (const exp of experiences) {
        const trimmed = exp.length > 300 ? exp.slice(0, 300) + "..." : exp;
        parts.push(trimmed);
      }
    }

    return parts.join("\n");
  }

  // ============================================
  // SOP Fitness — Data structures & persistence
  // ============================================

  private fitnessFilePath(dunId: string): string {
    return join(this.dunDir(dunId), "sop-fitness.json");
  }

  loadSOPFitness(dunId: string): ExtensionSOPFitness {
    const fp = this.fitnessFilePath(dunId);
    if (!existsSync(fp)) {
      return {
        ema: 0.5,
        totalExecutions: 0,
        executionsSinceRewrite: 0,
        baselineEma: 0.5,
        recentTraces: [],
        phaseStats: {},
        lastUpdatedAt: 0,
      };
    }
    try {
      return JSON.parse(readFileSync(fp, "utf-8")) as ExtensionSOPFitness;
    } catch {
      return {
        ema: 0.5,
        totalExecutions: 0,
        executionsSinceRewrite: 0,
        baselineEma: 0.5,
        recentTraces: [],
        phaseStats: {},
        lastUpdatedAt: 0,
      };
    }
  }

  saveSOPFitness(dunId: string, data: ExtensionSOPFitness): void {
    this.ensureDir(this.dunDir(dunId));
    data.lastUpdatedAt = Date.now();
    writeFileSync(this.fitnessFilePath(dunId), JSON.stringify(data, null, 2), "utf-8");
  }

  // ============================================
  // SOP Fitness — Computation
  // ============================================

  computeSessionFitness(
    sessionTrace: SessionToolTrace[],
    sopTracker: SOPTracker | null,
    isSuccess: boolean
  ): { fitness: number; traceSummary: TraceSummary } {
    const toolCount = sessionTrace.length;
    const errorCount = sessionTrace.filter((t) => t.status === "error").length;
    const totalDurationMs = sessionTrace.reduce((s, t) => s + t.durationMs, 0);

    const successScore = isSuccess ? 1 : 0;
    const efficiency = Math.max(0, 1 - toolCount / 25);
    const errorRate = toolCount > 0 ? errorCount / toolCount : 0;
    const fitness = 0.5 * successScore + 0.3 * efficiency + 0.2 * (1 - errorRate);

    const toolChain = sessionTrace
      .filter((t) => t.status === "success")
      .map((t) => t.name);
    const errorTools = sessionTrace
      .filter((t) => t.status === "error")
      .map((t) => t.name);

    const phaseReached = sopTracker ? sopTracker.currentPhaseIndex + 1 : 0;

    const traceSummary: TraceSummary = {
      timestamp: Date.now(),
      success: isSuccess,
      fitness: Math.round(fitness * 1000) / 1000,
      toolCount,
      errorCount,
      durationMs: totalDurationMs,
      phaseReached,
      toolChain: toolChain.slice(0, 20),
      errorTools: [...new Set(errorTools)],
    };

    return { fitness, traceSummary };
  }

  updateSOPFitness(dunId: string, traceSummary: TraceSummary): ExtensionSOPFitness {
    const data = this.loadSOPFitness(dunId);
    const EMA_ALPHA = 0.3;

    // Update EMA
    data.ema = EMA_ALPHA * traceSummary.fitness + (1 - EMA_ALPHA) * data.ema;
    data.ema = Math.round(data.ema * 1000) / 1000;
    data.totalExecutions++;
    data.executionsSinceRewrite++;

    // Ring buffer: keep last 10 traces
    data.recentTraces.push(traceSummary);
    if (data.recentTraces.length > 10) {
      data.recentTraces = data.recentTraces.slice(-10);
    }

    // Update phase stats
    if (traceSummary.phaseReached > 0) {
      const key = String(traceSummary.phaseReached);
      if (!data.phaseStats[key]) {
        data.phaseStats[key] = { successes: 0, failures: 0, commonTools: [], commonErrors: [] };
      }
      const ps = data.phaseStats[key];
      if (traceSummary.success) {
        ps.successes++;
        // Track common tools for successful runs
        for (const tool of traceSummary.toolChain) {
          if (!ps.commonTools.includes(tool)) {
            ps.commonTools.push(tool);
          }
        }
        ps.commonTools = ps.commonTools.slice(0, 5);
      } else {
        ps.failures++;
        for (const tool of traceSummary.errorTools) {
          if (!ps.commonErrors.includes(tool)) {
            ps.commonErrors.push(tool);
          }
        }
        ps.commonErrors = ps.commonErrors.slice(0, 5);
      }
    }

    this.saveSOPFitness(dunId, data);
    return data;
  }

  // ============================================
  // SOP Fitness — Improvement hints
  // ============================================

  buildSOPImprovementHints(dunId: string): string | null {
    const data = this.loadSOPFitness(dunId);
    if (data.totalExecutions < 3) return null;

    const meta = this.loadDunMeta(dunId);
    const dunName = meta?.name || dunId;
    const parts: string[] = [];
    let shouldInject = false;

    // Trigger: overall fitness low
    if (data.ema < 0.6) {
      shouldInject = true;
    }

    // Trigger: consecutive failures
    const recent3 = data.recentTraces.slice(-3);
    if (recent3.length >= 3 && recent3.every((t) => !t.success)) {
      shouldInject = true;
    }

    // Trigger: any phase with high failure rate
    const phaseHints: string[] = [];
    const tracker = this.getSOPTracker(dunId);
    for (const [key, ps] of Object.entries(data.phaseStats)) {
      const total = ps.successes + ps.failures;
      if (total < 3) continue;
      const failRate = Math.round((ps.failures / total) * 100);
      if (failRate > 50) {
        shouldInject = true;
        const phaseIndex = parseInt(key) - 1;
        const phaseName = tracker?.phases[phaseIndex]?.name || `Phase ${key}`;
        let hint = `  ${phaseName}: ${failRate}% failure rate`;
        if (ps.commonErrors.length > 0) {
          hint += `\n    Common errors: ${ps.commonErrors.join(", ")}`;
        }
        if (ps.commonTools.length > 0) {
          hint += `\n    Proven tools: ${ps.commonTools.join(" -> ")}`;
        }
        phaseHints.push(hint);
      }
    }

    if (!shouldInject) return null;

    parts.push(`[SOP Execution Intelligence — ${dunName}]`);
    parts.push(`Based on ${data.totalExecutions} executions (avg fitness: ${Math.round(data.ema * 100)}%):`);

    if (data.ema < 0.6) {
      parts.push("Overall success rate is low. Consider more careful planning.");
    }

    if (recent3.length >= 3 && recent3.every((t) => !t.success)) {
      parts.push(`Last ${recent3.length} executions all failed. Try a different approach.`);
    }

    if (phaseHints.length > 0) {
      parts.push("Phase analysis:");
      parts.push(...phaseHints.slice(0, 4));
    }

    const result = parts.join("\n");
    return result.length > 800 ? result.slice(0, 797) + "..." : result;
  }

  // ============================================
  // SOP Rewrite — Request + write-back
  // ============================================

  /**
   * Build an SOP rewrite request using three-tier trigger mechanism.
   * Returns null if rewrite should not be triggered.
   *
   * Tiers:
   *   EMERGENCY: last 3 executions all failed
   *   STANDARD:  5+ executions && EMA < 0.5
   *   GRADUAL:   10+ executions && EMA < 0.7 && recent performance declining
   */
  buildSOPRewriteRequest(dunId: string): string | null {
    const data = this.loadSOPFitness(dunId);

    // ── Three-tier trigger mechanism ──
    let triggerLevel: "emergency" | "standard" | "gradual" | null = null;
    let triggerReason = "";

    // EMERGENCY: last 3 executions all failed
    const last3 = data.recentTraces.slice(-3);
    if (last3.length >= 3 && last3.every(t => !t.success)) {
      triggerLevel = "emergency";
      triggerReason = `Last ${last3.length} executions all failed`;
    }

    // STANDARD: 5+ executions && EMA < 0.5
    if (!triggerLevel && data.totalExecutions >= 5 && data.ema < 0.5) {
      triggerLevel = "standard";
      triggerReason = `Low fitness (${Math.round(data.ema * 100)}%) over ${data.totalExecutions} executions`;
    }

    // GRADUAL: 10+ executions && EMA < 0.7 && recent performance declining
    if (!triggerLevel && data.totalExecutions >= 10 && data.ema < 0.7) {
      const recentSlice = data.recentTraces.slice(-5);
      if (recentSlice.length > 0) {
        const recentAvg = recentSlice.reduce((s, t) => s + t.fitness, 0) / recentSlice.length;
        if (recentAvg < data.ema) {
          triggerLevel = "gradual";
          triggerReason = `Performance declining (recent: ${Math.round(recentAvg * 100)}%, overall: ${Math.round(data.ema * 100)}%)`;
        }
      }
    }

    if (!triggerLevel) return null;

    const meta = this.loadDunMeta(dunId);
    const dunName = meta?.name || dunId;

    const parts: string[] = [];
    parts.push(`[SOP Rewrite Request — ${triggerLevel.toUpperCase()}]`);
    parts.push(
      `The current SOP for Dun "${dunName}" needs improvement.`
    );
    parts.push(`Trigger: ${triggerReason}`);
    parts.push(`Overall fitness: ${Math.round(data.ema * 100)}% over ${data.totalExecutions} executions.`);

    // Phase performance data
    const tracker = this.getSOPTracker(dunId);
    const significantPhases = Object.entries(data.phaseStats)
      .filter(([, ps]) => ps.successes + ps.failures >= 2);

    if (significantPhases.length > 0) {
      parts.push("");
      parts.push("Phase performance data:");
      for (const [key, ps] of significantPhases) {
        const total = ps.successes + ps.failures;
        const phaseIndex = parseInt(key) - 1;
        const phaseName = tracker?.phases[phaseIndex]?.name || `Phase ${key}`;
        let line = `  ${phaseName}: ${ps.successes}/${total} success`;
        if (ps.commonErrors.length > 0) {
          line += `, errors: ${ps.commonErrors.join(", ")}`;
        }
        parts.push(line);
      }
    }

    parts.push("");
    parts.push("Please output an improved SOP wrapped in:");
    parts.push("<SOP_REWRITE>");
    parts.push("...improved SOP content...");
    parts.push("</SOP_REWRITE>");
    parts.push("");
    parts.push("Rules: Keep frontmatter (YAML) unchanged. Keep mission/objective. Improve phases based on data above.");
    parts.push("If you believe the current SOP is fine, skip the rewrite block.");

    return parts.join("\n");
  }

  /**
   * Write new SOP content back to DUN.md, preserving frontmatter.
   */
  writeSOPContent(dunId: string, newSOPContent: string): boolean {
    const mdPath = this.dunMdPath(dunId);
    if (!existsSync(mdPath)) return false;

    try {
      const raw = readFileSync(mdPath, "utf-8");

      // Preserve frontmatter (---...---) if present
      const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/);
      const frontmatter = fmMatch ? fmMatch[0] : "";

      // Build new content: frontmatter + new SOP
      const newContent = frontmatter + newSOPContent.trim() + "\n";
      writeFileSync(mdPath, newContent, "utf-8");

      // Reload the meta to update cached sopContent
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reset fitness data after SOP rewrite, preserving EMA as baseline.
   */
  resetSOPFitnessAfterRewrite(dunId: string): void {
    const data = this.loadSOPFitness(dunId);
    data.baselineEma = data.ema;
    data.executionsSinceRewrite = 0;
    // Keep phaseStats and recentTraces for history — they'll naturally age out
    this.saveSOPFitness(dunId, data);
  }

  // ============================================
  // Golden Path — Distillation & Injection
  // ============================================

  private goldenPathFilePath(dunId: string): string {
    return join(this.dunDir(dunId), "golden-path.json");
  }

  loadGoldenPath(dunId: string): GoldenPath | null {
    const filePath = this.goldenPathFilePath(dunId);
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as GoldenPath;
    } catch {
      return null;
    }
  }

  /**
   * Distill a golden path from historical traces + experience files.
   * Uses tool frequency vectors instead of exact sequence matching.
   * Requires at least 5 successful executions.
   */
  distillGoldenPath(dunId: string): GoldenPath | null {
    const fitness = this.loadSOPFitness(dunId);
    const successTraces = fitness.recentTraces.filter(t => t.success);

    // Supplement with experience file data
    const expDir = this.experienceDir(dunId);
    const successFilePath = join(expDir, "successes.md");
    const additionalToolChains: string[][] = [];

    if (existsSync(successFilePath)) {
      const content = readFileSync(successFilePath, "utf-8");
      const entries = content.split(/\n###\s+/).filter(e => e.trim());
      for (const entry of entries) {
        const toolsMatch = entry.match(/\*\*Tools\*\*:\s*(.+)/);
        if (toolsMatch && toolsMatch[1] !== "none") {
          const tools = toolsMatch[1].split(",").map(t => t.trim()).filter(Boolean);
          if (tools.length > 0) additionalToolChains.push(tools);
        }
      }
    }

    const allSuccessChains = [
      ...successTraces.map(t => t.toolChain),
      ...additionalToolChains,
    ];

    if (allSuccessChains.length < 5) return null;

    // --- Tool frequency vector approach ---
    // Build a frequency vector: for each tool, count how many success chains include it
    const toolPresence = new Map<string, number>();
    for (const chain of allSuccessChains) {
      const uniqueTools = new Set(chain);
      for (const tool of uniqueTools) {
        toolPresence.set(tool, (toolPresence.get(tool) || 0) + 1);
      }
    }

    // Core tools: present in >= 60% of successful chains
    const coreThreshold = Math.ceil(allSuccessChains.length * 0.6);
    const coreTools: Array<{ tool: string; count: number }> = [];
    for (const [tool, count] of toolPresence) {
      if (count >= coreThreshold) {
        coreTools.push({ tool, count });
      }
    }

    if (coreTools.length === 0) return null;

    // Sort core tools by prevalence (most common first)
    coreTools.sort((a, b) => b.count - a.count);

    // Determine typical order from successful chains
    const orderedCoreTools = this.inferToolOrder(
      coreTools.map(ct => ct.tool),
      allSuccessChains
    );

    // Confidence = average presence rate of core tools
    const confidence = Math.round(
      (coreTools.reduce((sum, ct) => sum + ct.count / allSuccessChains.length, 0) / coreTools.length) * 100
    ) / 100;

    // Average duration from traces that contain all core tools
    const coreToolSet = new Set(orderedCoreTools);
    const matchingTraces = successTraces.filter(t => {
      const traceTools = new Set(t.toolChain);
      for (const ct of coreToolSet) {
        if (!traceTools.has(ct)) return false;
      }
      return true;
    });
    const averageDurationMs = matchingTraces.length > 0
      ? Math.round(matchingTraces.reduce((sum, t) => sum + t.durationMs, 0) / matchingTraces.length)
      : 0;

    // Known pitfalls from failure traces
    const failureTraces = fitness.recentTraces.filter(t => !t.success);
    const errorToolFrequency = new Map<string, number>();
    for (const trace of failureTraces) {
      for (const tool of trace.errorTools) {
        errorToolFrequency.set(tool, (errorToolFrequency.get(tool) || 0) + 1);
      }
    }
    const knownPitfalls: string[] = [];
    for (const [tool, count] of errorToolFrequency) {
      if (count >= 2) {
        knownPitfalls.push(`${tool} frequently fails (${count} times)`);
      }
    }

    // Extract additional pitfalls from failures.md
    const failureFilePath = join(expDir, "failures.md");
    if (existsSync(failureFilePath)) {
      const content = readFileSync(failureFilePath, "utf-8");
      const entries = content.split(/\n###\s+/).filter(e => e.trim());
      for (const entry of entries.slice(-5)) {
        const errorMatch = entry.match(/\*\*Error\*\*:\s*(.+)/);
        if (errorMatch) {
          const errorText = errorMatch[1].trim().slice(0, 80);
          if (!knownPitfalls.some(p => p.includes(errorText.slice(0, 20)))) {
            knownPitfalls.push(errorText);
          }
        }
      }
    }

    const goldenPath: GoldenPath = {
      recommendedToolChain: orderedCoreTools,
      confidence,
      averageDurationMs,
      knownPitfalls: knownPitfalls.slice(0, 5),
      basedOnSuccesses: allSuccessChains.length,
      lastDistilledAt: Date.now(),
    };

    // Persist
    this.ensureDir(this.dunDir(dunId));
    writeFileSync(
      this.goldenPathFilePath(dunId),
      JSON.stringify(goldenPath, null, 2),
      "utf-8"
    );

    return goldenPath;
  }

  /**
   * Infer typical tool ordering from successful chains.
   * For each pair of core tools, vote on which tends to come first.
   */
  private inferToolOrder(coreTools: string[], chains: string[][]): string[] {
    if (coreTools.length <= 1) return coreTools;

    // Build pairwise ordering votes
    const before = new Map<string, Map<string, number>>();
    for (const tool of coreTools) {
      before.set(tool, new Map());
    }

    for (const chain of chains) {
      const positions = new Map<string, number>();
      for (let i = 0; i < chain.length; i++) {
        if (!positions.has(chain[i])) {
          positions.set(chain[i], i);
        }
      }

      for (let i = 0; i < coreTools.length; i++) {
        for (let j = i + 1; j < coreTools.length; j++) {
          const posA = positions.get(coreTools[i]);
          const posB = positions.get(coreTools[j]);
          if (posA === undefined || posB === undefined) continue;
          if (posA < posB) {
            before.get(coreTools[i])!.set(
              coreTools[j],
              (before.get(coreTools[i])!.get(coreTools[j]) || 0) + 1
            );
          } else {
            before.get(coreTools[j])!.set(
              coreTools[i],
              (before.get(coreTools[j])!.get(coreTools[i]) || 0) + 1
            );
          }
        }
      }
    }

    // Sort by: for each tool, count how many other tools it tends to precede
    return [...coreTools].sort((a, b) => {
      const aBeforeB = before.get(a)?.get(b) || 0;
      const bBeforeA = before.get(b)?.get(a) || 0;
      return bBeforeA - aBeforeB; // a comes first if more chains have a before b
    });
  }

  /**
   * Build golden path hint for injection into agent context.
   * Only injects if confidence >= 0.5.
   */
  buildGoldenPathHint(dunId: string): string | null {
    const goldenPath = this.loadGoldenPath(dunId);
    if (!goldenPath || goldenPath.confidence < 0.5) return null;

    const parts: string[] = [];
    parts.push(`[Golden Path — Proven Execution Pattern]`);
    parts.push(`Based on ${goldenPath.basedOnSuccesses} successful executions (confidence: ${Math.round(goldenPath.confidence * 100)}%):`);
    parts.push(`  Recommended core tools: ${goldenPath.recommendedToolChain.join(" -> ")}`);

    if (goldenPath.averageDurationMs > 0) {
      parts.push(`  Expected duration: ~${Math.round(goldenPath.averageDurationMs / 1000)}s`);
    }

    if (goldenPath.knownPitfalls.length > 0) {
      parts.push(`  Known pitfalls:`);
      for (const pitfall of goldenPath.knownPitfalls) {
        parts.push(`    - ${pitfall}`);
      }
    }

    parts.push(`Prefer this pattern unless the task clearly requires a different approach.`);
    return parts.join("\n");
  }

  // ============================================
  // Dun Catalog (for Agent-driven matching)
  // ============================================

  /**
   * Build a compact catalog of all available Duns for injection
   * when no Dun is currently active.
   */
  buildDunCatalog(): string | null {
    const dunIds = this.listDuns();
    if (dunIds.length === 0) return null;

    const entries: string[] = [];
    for (const nid of dunIds) {
      if (entries.length >= 15) break;
      const meta = this.loadDunMeta(nid);
      if (!meta) continue;
      const { level } = this.loadDunXP(nid);

      const objective = meta.objective
        ? meta.objective.slice(0, 50) + (meta.objective.length > 50 ? "..." : "")
        : "(no objective)";
      const triggers = meta.triggers?.slice(0, 5).join(",") || "";
      const skills =
        meta.boundSkillIds && meta.boundSkillIds.length > 0
          ? ` | skills: ${meta.boundSkillIds.slice(0, 3).join(",")}`
          : "";

      entries.push(
        `- ${nid}: "${objective}"${triggers ? ` | triggers: ${triggers}` : ""}${skills} | Lv${level}`
      );
    }

    if (entries.length === 0) return null;

    const header = [
      "[Available Dun Workstations]",
      "No Dun is active. Review the list below. If a Dun matches this task,",
      "output <ACTIVATE_DUN>dunId</ACTIVATE_DUN> to activate it.",
      "If none fits, proceed without a Dun.",
      "",
    ];

    const result = [...header, ...entries].join("\n");
    return result.length > 2000 ? result.slice(0, 1997) + "..." : result;
  }
}
