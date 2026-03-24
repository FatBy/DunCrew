/**
 * SOP Evolution Service — SOP 自进化机制本地实现
 *
 * 从 openclaw-extension/src/nexus-manager.ts 移植完整的 SOP 自进化闭环：
 * - SOPTracker: Phase 级别实时追踪
 * - Fitness 计算 + EMA 持久化
 * - Improvement Hints 注入
 * - Rewrite 三级触发 + <SOP_REWRITE> 检测写回
 * - Golden Path 提炼 + 注入
 * - SOP Reminder 中途提醒
 *
 * IO 适配：所有文件操作通过后端 HTTP API (duncrew-server.py) 完成。
 */

import { getServerUrl } from '@/utils/env'
import { simpleChat } from '@/services/llmService'
import type { SimpleChatMessage } from '@/services/llmService'

// ============================================
// Types
// ============================================

export interface SOPEvStep {
  text: string
  index: number
  keywords: string[]
}

export interface SOPEvPhase {
  name: string
  index: number
  steps: SOPEvStep[]
}

export interface SOPTracker {
  phases: SOPEvPhase[]
  currentPhaseIndex: number // -1 = not started
  nexusId: string
  nexusLabel: string
}

export interface TraceSummary {
  timestamp: number
  success: boolean
  fitness: number
  toolCount: number
  errorCount: number
  durationMs: number
  phaseReached: number
  toolChain: string[]
  errorTools: string[]
  taskSummary?: string  // 用户 prompt 前 200 字符，用于 LLM 任务分类
}

interface PhaseStatEntry {
  successes: number
  failures: number
  commonTools: string[]
  commonErrors: string[]
}

export interface SOPFitness {
  ema: number
  totalExecutions: number
  executionsSinceRewrite: number
  baselineEma: number
  recentTraces: TraceSummary[]
  phaseStats: Record<string, PhaseStatEntry>
  lastUpdatedAt: number
}

/** 旧版 GoldenPath（统计式，保留兼容） */
export interface GoldenPath {
  recommendedToolChain: string[]
  confidence: number
  averageDurationMs: number
  knownPitfalls: string[]
  basedOnSuccesses: number
  lastDistilledAt: number
}

/** 新版 GoldenPathSummary — LLM 语义分析结果 */
export interface GoldenPathSummary {
  taskCategories: Array<{
    name: string
    typicalToolChain: string[]
    estimatedDurationMs: number
    tips: string
  }>
  phaseInsights: Array<{
    phaseName: string
    status: 'golden' | 'stable' | 'bottleneck'
    insight: string
  }>
  commonPitfalls: string[]
  confidence: number           // 0-1 整体置信度
  lastSummarizedAt: number
  basedOnExecutions: number
}

/** 工具执行记录（兼容 LocalClawService 的 traceTools） */
export interface ToolTrace {
  name: string
  status: 'success' | 'error'
  result?: string
  duration?: number
}

// ============================================
// Constants
// ============================================

const EVO = {
  EMA_ALPHA: 0.3,
  MIN_EXECUTIONS_FOR_HINTS: 3,
  MIN_SUCCESSES_FOR_GOLDEN_PATH: 5,
  GOLDEN_PATH_COOLDOWN_MS: 600_000,
  MAX_RECENT_TRACES: 10,
  REMINDER_INTERVAL_TURNS: 5,
  FITNESS_FILE: 'sop-fitness.json',
  GOLDEN_PATH_FILE: 'golden-path.json',
  GOLDEN_SUMMARY_FILE: 'golden-path-summary.json',
  GOLDEN_EMA_THRESHOLD: 0.7,
  GOLDEN_CONFIDENCE_THRESHOLD: 0.6,
}

function createDefaultFitness(): SOPFitness {
  return {
    ema: 0.5,
    totalExecutions: 0,
    executionsSinceRewrite: 0,
    baselineEma: 0.5,
    recentTraces: [],
    phaseStats: {},
    lastUpdatedAt: 0,
  }
}

// ============================================
// SOPEvolutionService
// ============================================

class SOPEvolutionService {
  private serverUrl: string = getServerUrl()
  private sopTrackers = new Map<string, SOPTracker>()
  private fitnessCache = new Map<string, { data: SOPFitness; ts: number }>()
  private readonly CACHE_TTL = 60_000

  setServerUrl(url: string): void {
    this.serverUrl = url
  }

  // ═══ IO 层 ═══

  private async readFile(path: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'readFile', args: { path } }),
      })
      if (!res.ok) return null
      const data = await res.json()
      return data.status === 'error' ? null : (data.result ?? null)
    } catch {
      return null
    }
  }

  private async writeFile(path: string, content: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'writeFile', args: { path, content } }),
      })
      if (!res.ok) return false
      const data = await res.json()
      return data.status !== 'error'
    } catch {
      return false
    }
  }

  private nexusFilePath(nexusId: string, filename: string): string {
    return `nexuses/${nexusId}/${filename}`
  }

  // ═══ SOPTracker 管理 ═══

  createSOPTracker(nexusId: string, nexusLabel: string, sopContent: string): SOPTracker {
    const phases = this.parseSOP(sopContent)
    const tracker: SOPTracker = {
      phases,
      currentPhaseIndex: phases.length > 0 ? 0 : -1,
      nexusId,
      nexusLabel,
    }
    this.sopTrackers.set(nexusId, tracker)
    return tracker
  }

  getSOPTracker(nexusId: string): SOPTracker | undefined {
    return this.sopTrackers.get(nexusId)
  }

  /** 推断 SOP 进度 — 工具执行后调用，关键词匹配前进 Phase */
  inferSOPProgress(nexusId: string, toolName: string, toolResult: string): void {
    const tracker = this.sopTrackers.get(nexusId)
    if (!tracker || tracker.phases.length === 0) return

    const combined = `${toolName} ${toolResult}`.toLowerCase()

    for (let i = tracker.currentPhaseIndex; i < tracker.phases.length; i++) {
      const phase = tracker.phases[i]
      for (const step of phase.steps) {
        const matched = step.keywords.some(kw => combined.includes(kw.toLowerCase()))
        if (matched && i > tracker.currentPhaseIndex) {
          tracker.currentPhaseIndex = i
          return
        }
      }
    }
  }

  // ═══ SOP 解析 ═══

  parseSOP(content: string): SOPEvPhase[] {
    const phases: SOPEvPhase[] = []
    const lines = content.split('\n')
    let currentPhase: SOPEvPhase | null = null
    let inSOP = false

    for (const line of lines) {
      if (/^##\s+SOP/i.test(line)) { inSOP = true; continue }
      if (inSOP && /^##\s+[^#]/.test(line) && !/^###/.test(line)) { inSOP = false; continue }
      if (!inSOP) continue

      const phaseMatch = line.match(/^###\s+(?:Phase\s+\d+[:.：]\s*|(\d+)\.\s+)?(.+)/i)
      if (phaseMatch) {
        const phaseName = phaseMatch[2].trim()
        if (/^(?:Mission|Constraints|Notes|技能应用)/i.test(phaseName)) continue
        currentPhase = { name: phaseName, index: phases.length + 1, steps: [] }
        phases.push(currentPhase)
        continue
      }

      if (currentPhase) {
        const stepMatch = line.match(/^\s*(?:\d+\.\s+|-\s+)(.+)/)
        if (stepMatch) {
          const text = stepMatch[1].trim()
          currentPhase.steps.push({
            text,
            index: currentPhase.steps.length + 1,
            keywords: this.extractKeywords(text),
          })
        }
      }
    }
    return phases
  }

  private extractKeywords(text: string): string[] {
    const words = text.replace(/[^\w\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(w => w.length >= 2)
    return [...new Set(words)].slice(0, 8)
  }

  // ═══ Fitness 数据读写 ═══

  async loadSOPFitness(nexusId: string): Promise<SOPFitness> {
    const cached = this.fitnessCache.get(nexusId)
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.data

    const content = await this.readFile(this.nexusFilePath(nexusId, EVO.FITNESS_FILE))
    if (!content) return createDefaultFitness()
    try {
      const data = JSON.parse(content) as SOPFitness
      this.fitnessCache.set(nexusId, { data, ts: Date.now() })
      return data
    } catch {
      return createDefaultFitness()
    }
  }

  private async saveSOPFitness(nexusId: string, data: SOPFitness): Promise<void> {
    data.lastUpdatedAt = Date.now()
    await this.writeFile(this.nexusFilePath(nexusId, EVO.FITNESS_FILE), JSON.stringify(data, null, 2))
    this.fitnessCache.set(nexusId, { data, ts: Date.now() })
  }

  // ═══ Fitness 计算 ═══

  computeSessionFitness(
    nexusId: string,
    traceTools: ToolTrace[],
    isSuccess: boolean,
    userPrompt?: string,
  ): { fitness: number; traceSummary: TraceSummary } {
    const toolCount = traceTools.length
    const errorCount = traceTools.filter(t => t.status === 'error').length
    const totalDurationMs = traceTools.reduce((s, t) => s + (t.duration || 0), 0)

    const successScore = isSuccess ? 1 : 0
    const efficiency = Math.max(0, 1 - toolCount / 25)
    const errorRate = toolCount > 0 ? errorCount / toolCount : 0
    const fitness = 0.5 * successScore + 0.3 * efficiency + 0.2 * (1 - errorRate)

    const toolChain = traceTools.filter(t => t.status === 'success').map(t => t.name)
    const errorTools = traceTools.filter(t => t.status === 'error').map(t => t.name)

    const tracker = this.sopTrackers.get(nexusId)
    const phaseReached = tracker ? tracker.currentPhaseIndex + 1 : 0

    return {
      fitness,
      traceSummary: {
        timestamp: Date.now(),
        success: isSuccess,
        fitness: Math.round(fitness * 1000) / 1000,
        toolCount,
        errorCount,
        durationMs: totalDurationMs,
        phaseReached,
        toolChain: toolChain.slice(0, 20),
        errorTools: [...new Set(errorTools)],
        taskSummary: userPrompt ? userPrompt.slice(0, 200) : undefined,
      },
    }
  }

  /** 更新 EMA + Phase 统计 + Ring Buffer，持久化 */
  private async updateAndPersistFitness(nexusId: string, traceSummary: TraceSummary): Promise<SOPFitness> {
    const data = await this.loadSOPFitness(nexusId)

    data.ema = EVO.EMA_ALPHA * traceSummary.fitness + (1 - EVO.EMA_ALPHA) * data.ema
    data.ema = Math.round(data.ema * 1000) / 1000
    data.totalExecutions++
    data.executionsSinceRewrite++

    data.recentTraces.push(traceSummary)
    if (data.recentTraces.length > EVO.MAX_RECENT_TRACES) {
      data.recentTraces = data.recentTraces.slice(-EVO.MAX_RECENT_TRACES)
    }

    if (traceSummary.phaseReached > 0) {
      const key = String(traceSummary.phaseReached)
      if (!data.phaseStats[key]) {
        data.phaseStats[key] = { successes: 0, failures: 0, commonTools: [], commonErrors: [] }
      }
      const ps = data.phaseStats[key]
      if (traceSummary.success) {
        ps.successes++
        for (const tool of traceSummary.toolChain) {
          if (!ps.commonTools.includes(tool)) ps.commonTools.push(tool)
        }
        ps.commonTools = ps.commonTools.slice(0, 5)
      } else {
        ps.failures++
        for (const tool of traceSummary.errorTools) {
          if (!ps.commonErrors.includes(tool)) ps.commonErrors.push(tool)
        }
        ps.commonErrors = ps.commonErrors.slice(0, 5)
      }
    }

    await this.saveSOPFitness(nexusId, data)
    return data
  }

  // ═══ 上下文 Hints 注入 ═══

  /** 供 buildDynamicContext() 调用 — 返回所有 SOP 进化 hints */
  async getContextHints(nexusId: string): Promise<string | null> {
    const parts: string[] = []

    const hints = await this.buildSOPImprovementHints(nexusId)
    if (hints) parts.push(hints)

    const rewriteReq = await this.buildSOPRewriteRequest(nexusId)
    if (rewriteReq) parts.push(rewriteReq)

    const gp = await this.buildGoldenPathHint(nexusId)
    if (gp) parts.push(gp)

    return parts.length > 0 ? parts.join('\n\n') : null
  }

  private async buildSOPImprovementHints(nexusId: string): Promise<string | null> {
    const data = await this.loadSOPFitness(nexusId)
    if (data.totalExecutions < EVO.MIN_EXECUTIONS_FOR_HINTS) return null

    let shouldInject = false
    if (data.ema < 0.6) shouldInject = true

    const recent3 = data.recentTraces.slice(-3)
    if (recent3.length >= 3 && recent3.every(t => !t.success)) shouldInject = true

    const phaseHints: string[] = []
    const tracker = this.sopTrackers.get(nexusId)
    for (const [key, ps] of Object.entries(data.phaseStats)) {
      const total = ps.successes + ps.failures
      if (total < 3) continue
      const failRate = Math.round((ps.failures / total) * 100)
      if (failRate > 50) {
        shouldInject = true
        const phaseIndex = parseInt(key) - 1
        const phaseName = tracker?.phases[phaseIndex]?.name || `Phase ${key}`
        let hint = `  ${phaseName}: ${failRate}% failure rate`
        if (ps.commonErrors.length > 0) hint += `\n    Common errors: ${ps.commonErrors.join(', ')}`
        if (ps.commonTools.length > 0) hint += `\n    Proven tools: ${ps.commonTools.join(' -> ')}`
        phaseHints.push(hint)
      }
    }

    if (!shouldInject) return null

    const label = tracker?.nexusLabel || nexusId
    const parts: string[] = []
    parts.push(`[SOP Execution Intelligence — ${label}]`)
    parts.push(`Based on ${data.totalExecutions} executions (avg fitness: ${Math.round(data.ema * 100)}%):`)
    if (data.ema < 0.6) parts.push('Overall success rate is low. Consider more careful planning.')
    if (recent3.length >= 3 && recent3.every(t => !t.success)) {
      parts.push(`Last ${recent3.length} executions all failed. Try a different approach.`)
    }
    if (phaseHints.length > 0) {
      parts.push('Phase analysis:')
      parts.push(...phaseHints.slice(0, 4))
    }
    const result = parts.join('\n')
    return result.length > 800 ? result.slice(0, 797) + '...' : result
  }

  /** Rewrite Request — 三级触发 (EMERGENCY / STANDARD / GRADUAL)
   *  Golden 状态下只保留 EMERGENCY 级，暂停 STANDARD 和 GRADUAL */
  private async buildSOPRewriteRequest(nexusId: string): Promise<string | null> {
    const data = await this.loadSOPFitness(nexusId)
    const isGolden = await this.isGoldenNexus(nexusId)

    let triggerLevel: 'emergency' | 'standard' | 'gradual' | null = null
    let triggerReason = ''

    // EMERGENCY: 连续 3 次失败（始终生效，包括 Golden 状态）
    const last3 = data.recentTraces.slice(-3)
    if (last3.length >= 3 && last3.every(t => !t.success)) {
      triggerLevel = 'emergency'
      triggerReason = `Last ${last3.length} executions all failed`
    }

    // Golden 状态下跳过 STANDARD 和 GRADUAL
    if (isGolden && !triggerLevel) return null

    if (!triggerLevel && data.totalExecutions >= 5 && data.ema < 0.5) {
      triggerLevel = 'standard'
      triggerReason = `Low fitness (${Math.round(data.ema * 100)}%) over ${data.totalExecutions} executions`
    }

    if (!triggerLevel && data.totalExecutions >= 10 && data.ema < 0.7) {
      const recentSlice = data.recentTraces.slice(-5)
      if (recentSlice.length > 0) {
        const recentAvg = recentSlice.reduce((s, t) => s + t.fitness, 0) / recentSlice.length
        if (recentAvg < data.ema) {
          triggerLevel = 'gradual'
          triggerReason = `Performance declining (recent: ${Math.round(recentAvg * 100)}%, overall: ${Math.round(data.ema * 100)}%)`
        }
      }
    }

    if (!triggerLevel) return null

    const label = this.sopTrackers.get(nexusId)?.nexusLabel || nexusId
    const tracker = this.sopTrackers.get(nexusId)

    const parts: string[] = []
    parts.push(`[SOP Rewrite Request — ${triggerLevel.toUpperCase()}]`)
    parts.push(`The current SOP for Nexus "${label}" needs improvement.`)
    parts.push(`Trigger: ${triggerReason}`)
    parts.push(`Overall fitness: ${Math.round(data.ema * 100)}% over ${data.totalExecutions} executions.`)

    const significantPhases = Object.entries(data.phaseStats).filter(([, ps]) => ps.successes + ps.failures >= 2)
    if (significantPhases.length > 0) {
      parts.push('', 'Phase performance data:')
      for (const [key, ps] of significantPhases) {
        const total = ps.successes + ps.failures
        const phaseIndex = parseInt(key) - 1
        const phaseName = tracker?.phases[phaseIndex]?.name || `Phase ${key}`
        let line = `  ${phaseName}: ${ps.successes}/${total} success`
        if (ps.commonErrors.length > 0) line += `, errors: ${ps.commonErrors.join(', ')}`
        parts.push(line)
      }
    }

    parts.push('', 'Please output an improved SOP wrapped in:')
    parts.push('<SOP_REWRITE>', '...improved SOP content...', '</SOP_REWRITE>')
    parts.push('', 'Rules: Keep frontmatter (YAML) unchanged. Keep mission/objective. Improve phases based on data above.')
    parts.push('If you believe the current SOP is fine, skip the rewrite block.')
    return parts.join('\n')
  }

  private async buildGoldenPathHint(nexusId: string): Promise<string | null> {
    // 优先使用新版 GoldenPathSummary
    const summary = await this.loadGoldenPathSummary(nexusId)
    if (summary && summary.confidence >= EVO.GOLDEN_CONFIDENCE_THRESHOLD) {
      const parts: string[] = []
      parts.push('[Golden Path — LLM Semantic Analysis]')
      parts.push(`Based on ${summary.basedOnExecutions} executions (confidence: ${Math.round(summary.confidence * 100)}%):`)

      if (summary.taskCategories.length > 0) {
        parts.push('', 'Task categories:')
        for (const cat of summary.taskCategories.slice(0, 4)) {
          parts.push(`  [${cat.name}]: ${cat.typicalToolChain.join(' -> ')}`)
          if (cat.tips) parts.push(`    Tip: ${cat.tips}`)
        }
      }

      if (summary.phaseInsights.length > 0) {
        parts.push('', 'Phase insights:')
        for (const pi of summary.phaseInsights) {
          const statusIcon = pi.status === 'golden' ? '🏆' : pi.status === 'bottleneck' ? '⚠️' : '✅'
          parts.push(`  ${statusIcon} ${pi.phaseName} [${pi.status}]: ${pi.insight}`)
        }
      }

      if (summary.commonPitfalls.length > 0) {
        parts.push('', 'Common pitfalls:')
        for (const p of summary.commonPitfalls.slice(0, 5)) parts.push(`  - ${p}`)
      }

      parts.push('', 'Prefer proven patterns unless the task clearly requires a different approach.')
      const result = parts.join('\n')
      return result.length > 1200 ? result.slice(0, 1197) + '...' : result
    }

    // 降级：使用旧版统计式 GoldenPath
    const gp = await this.loadGoldenPath(nexusId)
    if (!gp || gp.confidence < 0.5) return null

    const parts: string[] = []
    parts.push('[Golden Path — Proven Execution Pattern]')
    parts.push(`Based on ${gp.basedOnSuccesses} successful executions (confidence: ${Math.round(gp.confidence * 100)}%):`)
    parts.push(`  Recommended core tools: ${gp.recommendedToolChain.join(' -> ')}`)
    if (gp.averageDurationMs > 0) parts.push(`  Expected duration: ~${Math.round(gp.averageDurationMs / 1000)}s`)
    if (gp.knownPitfalls.length > 0) {
      parts.push('  Known pitfalls:')
      for (const p of gp.knownPitfalls) parts.push(`    - ${p}`)
    }
    parts.push('Prefer this pattern unless the task clearly requires a different approach.')
    return parts.join('\n')
  }

  // ═══ SOP Rewrite 检测 + 写回 ═══

  /** 检测 LLM 输出中的 <SOP_REWRITE> 标签并写回 NEXUS.md */
  async detectAndApplyRewrite(llmOutput: string, nexusId: string): Promise<boolean> {
    const m = llmOutput.match(/<SOP_REWRITE>([\s\S]*?)<\/SOP_REWRITE>/)
    if (!m) return false

    const newSOP = m[1].trim()
    if (newSOP.length < 50) return false

    const mdPath = this.nexusFilePath(nexusId, 'NEXUS.md')
    const raw = await this.readFile(mdPath)
    if (!raw) return false

    // 保留 frontmatter
    const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/)
    const frontmatter = fmMatch ? fmMatch[0] : ''
    const written = await this.writeFile(mdPath, frontmatter + newSOP.trim() + '\n')

    if (written) {
      // 重置 fitness baseline
      const data = await this.loadSOPFitness(nexusId)
      data.baselineEma = data.ema
      data.executionsSinceRewrite = 0
      await this.saveSOPFitness(nexusId, data)

      // 重建 tracker
      const tracker = this.sopTrackers.get(nexusId)
      if (tracker) {
        this.createSOPTracker(nexusId, tracker.nexusLabel, newSOP)
      }

      console.log(`[SOPEvolution] SOP rewritten for Nexus: ${nexusId}`)
      return true
    }
    return false
  }

  // ═══ Golden Path ═══

  private async loadGoldenPath(nexusId: string): Promise<GoldenPath | null> {
    const content = await this.readFile(this.nexusFilePath(nexusId, EVO.GOLDEN_PATH_FILE))
    if (!content) return null
    try { return JSON.parse(content) as GoldenPath } catch { return null }
  }

  private async loadGoldenPathSummary(nexusId: string): Promise<GoldenPathSummary | null> {
    const content = await this.readFile(this.nexusFilePath(nexusId, EVO.GOLDEN_SUMMARY_FILE))
    if (!content) return null
    try { return JSON.parse(content) as GoldenPathSummary } catch { return null }
  }

  /** 判断 Nexus 是否达到 Golden 状态：EMA ≥ 0.7 且有高置信度 GoldenPathSummary */
  async isGoldenNexus(nexusId: string): Promise<boolean> {
    const fitness = await this.loadSOPFitness(nexusId)
    if (fitness.ema < EVO.GOLDEN_EMA_THRESHOLD) return false

    const summary = await this.loadGoldenPathSummary(nexusId)
    return summary !== null && summary.confidence >= EVO.GOLDEN_CONFIDENCE_THRESHOLD
  }

  /** 获取 NexusEntity.sopEvolutionData 的快照（供 UI 读取） */
  async getEvolutionSnapshot(nexusId: string): Promise<{
    isGolden: boolean
    ema: number
    totalExecutions: number
    goldenPathSummary?: GoldenPathSummary
  }> {
    const fitness = await this.loadSOPFitness(nexusId)
    const summary = await this.loadGoldenPathSummary(nexusId)
    const isGolden = fitness.ema >= EVO.GOLDEN_EMA_THRESHOLD
      && summary !== null
      && summary.confidence >= EVO.GOLDEN_CONFIDENCE_THRESHOLD

    return {
      isGolden,
      ema: fitness.ema,
      totalExecutions: fitness.totalExecutions,
      goldenPathSummary: summary ?? undefined,
    }
  }

  /** 从历史执行中通过 LLM 语义分析提炼 GoldenPathSummary */
  async distillGoldenPathSummary(nexusId: string, sopContent: string): Promise<GoldenPathSummary | null> {
    const fitness = await this.loadSOPFitness(nexusId)
    const successTraces = fitness.recentTraces.filter(t => t.success)
    if (successTraces.length < EVO.MIN_SUCCESSES_FOR_GOLDEN_PATH) return null

    // 构建执行历史摘要供 LLM 分析
    const traceSummaries = fitness.recentTraces.map(t => ({
      success: t.success,
      toolChain: t.toolChain.join(' -> '),
      errorTools: t.errorTools.join(', ') || 'none',
      durationMs: t.durationMs,
      phaseReached: t.phaseReached,
      taskSummary: t.taskSummary || 'unknown',
    }))

    // 解析 SOP phases 名称
    const phases = this.parseSOP(sopContent)
    const phaseNames = phases.map(p => `Phase ${p.index}: ${p.name}`)

    const analysisPrompt = `You are analyzing execution history for a Nexus (AI agent specialization).

## SOP Phases
${phaseNames.join('\n')}

## Execution History (last ${traceSummaries.length} executions)
${JSON.stringify(traceSummaries, null, 2)}

## Task
Analyze the execution patterns and produce a structured JSON summary:

{
  "taskCategories": [
    {
      "name": "category name (e.g., 'code review', 'bug fix')",
      "typicalToolChain": ["tool1", "tool2"],
      "estimatedDurationMs": 30000,
      "tips": "brief best practice tip"
    }
  ],
  "phaseInsights": [
    {
      "phaseName": "Phase N: Name",
      "status": "golden|stable|bottleneck",
      "insight": "brief observation about this phase's performance"
    }
  ],
  "commonPitfalls": ["pitfall description"],
  "confidence": 0.75
}

Rules:
- "golden": phase has >80% success rate with consistent tool usage
- "stable": phase works well but has room for improvement
- "bottleneck": phase has >40% failure rate or frequent errors
- confidence: 0-1, based on data quality and consistency
- Keep insights concise (under 50 words each)
- Only output valid JSON, no markdown fences`

    try {
      const messages: SimpleChatMessage[] = [
        { role: 'user', content: analysisPrompt },
      ]
      const response = await simpleChat(messages)
      if (!response) return null

      // 提取 JSON（兼容 markdown 代码块包裹）
      let jsonStr = response.trim()
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) jsonStr = jsonMatch[1].trim()

      const parsed = JSON.parse(jsonStr) as Omit<GoldenPathSummary, 'lastSummarizedAt' | 'basedOnExecutions'>

      const summary: GoldenPathSummary = {
        taskCategories: Array.isArray(parsed.taskCategories) ? parsed.taskCategories.slice(0, 6) : [],
        phaseInsights: Array.isArray(parsed.phaseInsights) ? parsed.phaseInsights.slice(0, 10) : [],
        commonPitfalls: Array.isArray(parsed.commonPitfalls) ? parsed.commonPitfalls.slice(0, 5) : [],
        confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
        lastSummarizedAt: Date.now(),
        basedOnExecutions: fitness.totalExecutions,
      }

      await this.writeFile(
        this.nexusFilePath(nexusId, EVO.GOLDEN_SUMMARY_FILE),
        JSON.stringify(summary, null, 2),
      )
      console.log(`[SOPEvolution] GoldenPathSummary distilled for ${nexusId} (confidence: ${Math.round(summary.confidence * 100)}%)`)
      return summary
    } catch (err) {
      console.warn('[SOPEvolution] LLM distillation failed:', err)
      return null
    }
  }

  /** 旧版统计式 Golden Path 提炼（保留作为降级方案） */
  async distillGoldenPath(nexusId: string): Promise<GoldenPath | null> {
    const fitness = await this.loadSOPFitness(nexusId)
    const successTraces = fitness.recentTraces.filter(t => t.success)

    const additionalChains: string[][] = []
    const successContent = await this.readFile(this.nexusFilePath(nexusId, 'experience/successes.md'))
    if (successContent) {
      for (const entry of successContent.split(/\n###\s+/).filter(e => e.trim())) {
        const m = entry.match(/\*\*Tools\*\*:\s*(.+)/)
        if (m && m[1] !== 'none') {
          const tools = m[1].split(',').map(t => t.trim()).filter(Boolean)
          if (tools.length > 0) additionalChains.push(tools)
        }
      }
    }

    const allChains = [...successTraces.map(t => t.toolChain), ...additionalChains]
    if (allChains.length < EVO.MIN_SUCCESSES_FOR_GOLDEN_PATH) return null

    const toolPresence = new Map<string, number>()
    for (const chain of allChains) {
      for (const tool of new Set(chain)) {
        toolPresence.set(tool, (toolPresence.get(tool) || 0) + 1)
      }
    }

    const coreThreshold = Math.ceil(allChains.length * 0.6)
    const coreTools: Array<{ tool: string; count: number }> = []
    for (const [tool, count] of toolPresence) {
      if (count >= coreThreshold) coreTools.push({ tool, count })
    }
    if (coreTools.length === 0) return null

    coreTools.sort((a, b) => b.count - a.count)
    const ordered = this.inferToolOrder(coreTools.map(c => c.tool), allChains)

    const confidence = Math.round(
      (coreTools.reduce((s, c) => s + c.count / allChains.length, 0) / coreTools.length) * 100
    ) / 100

    const coreSet = new Set(ordered)
    const matching = successTraces.filter(t => {
      const ts = new Set(t.toolChain)
      for (const c of coreSet) { if (!ts.has(c)) return false }
      return true
    })
    const avgDuration = matching.length > 0
      ? Math.round(matching.reduce((s, t) => s + t.durationMs, 0) / matching.length)
      : 0

    const pitfalls: string[] = []
    const errFreq = new Map<string, number>()
    for (const t of fitness.recentTraces.filter(t => !t.success)) {
      for (const e of t.errorTools) errFreq.set(e, (errFreq.get(e) || 0) + 1)
    }
    for (const [tool, count] of errFreq) {
      if (count >= 2) pitfalls.push(`${tool} frequently fails (${count} times)`)
    }

    const failContent = await this.readFile(this.nexusFilePath(nexusId, 'experience/failures.md'))
    if (failContent) {
      for (const entry of failContent.split(/\n###\s+/).filter(e => e.trim()).slice(-5)) {
        const em = entry.match(/\*\*Error\*\*:\s*(.+)/)
        if (em) {
          const txt = em[1].trim().slice(0, 80)
          if (!pitfalls.some(p => p.includes(txt.slice(0, 20)))) pitfalls.push(txt)
        }
      }
    }

    const gp: GoldenPath = {
      recommendedToolChain: ordered,
      confidence,
      averageDurationMs: avgDuration,
      knownPitfalls: pitfalls.slice(0, 5),
      basedOnSuccesses: allChains.length,
      lastDistilledAt: Date.now(),
    }

    await this.writeFile(this.nexusFilePath(nexusId, EVO.GOLDEN_PATH_FILE), JSON.stringify(gp, null, 2))
    return gp
  }

  /** 基于成对投票推断工具执行顺序 */
  private inferToolOrder(coreTools: string[], chains: string[][]): string[] {
    if (coreTools.length <= 1) return coreTools

    const before = new Map<string, Map<string, number>>()
    for (const tool of coreTools) before.set(tool, new Map())

    for (const chain of chains) {
      const pos = new Map<string, number>()
      for (let i = 0; i < chain.length; i++) {
        if (!pos.has(chain[i])) pos.set(chain[i], i)
      }
      for (let i = 0; i < coreTools.length; i++) {
        for (let j = i + 1; j < coreTools.length; j++) {
          const pa = pos.get(coreTools[i]), pb = pos.get(coreTools[j])
          if (pa === undefined || pb === undefined) continue
          const [first, second] = pa < pb ? [coreTools[i], coreTools[j]] : [coreTools[j], coreTools[i]]
          before.get(first)!.set(second, (before.get(first)!.get(second) || 0) + 1)
        }
      }
    }

    return [...coreTools].sort((a, b) => {
      const ab = before.get(a)?.get(b) || 0
      const ba = before.get(b)?.get(a) || 0
      return ba - ab
    })
  }

  // ═══ SOP Reminder ═══

  /** 构建 SOP 中途提醒 — 循环中每隔 N 轮注入 */
  buildSOPReminder(nexusId: string, toolsUsed: string[], lastToolResult?: string): string {
    const tracker = this.sopTrackers.get(nexusId)
    if (!tracker || tracker.phases.length === 0) return ''

    const cur = tracker.phases[tracker.currentPhaseIndex]
    if (!cur) return ''

    const next = tracker.currentPhaseIndex + 1 < tracker.phases.length
      ? tracker.phases[tracker.currentPhaseIndex + 1]
      : null

    const parts: string[] = []
    parts.push(`[SOP 进度提醒 - ${tracker.nexusLabel}]`)
    parts.push(`当前: Phase ${tracker.currentPhaseIndex + 1}/${tracker.phases.length} — ${cur.name}`)
    for (const s of cur.steps) parts.push(`  ${s.index}. ${s.text}`)
    if (next) parts.push(`下一阶段: Phase ${next.index} — ${next.name}`)
    parts.push(`已使用工具: ${toolsUsed.length > 0 ? toolsUsed.join(', ') : '无'}`)
    if (lastToolResult) parts.push(`上一工具结果摘要: ${lastToolResult.slice(0, 200)}`)
    parts.push('请继续按 SOP 执行，完成当前阶段后自动进入下一阶段。')
    return parts.join('\n')
  }

  /** SOP Reminder 间隔轮次 */
  get reminderInterval(): number {
    return EVO.REMINDER_INTERVAL_TURNS
  }

  // ═══ SOP Directive (首轮指引) ═══

  buildSOPDirective(nexusId: string): string {
    const tracker = this.sopTrackers.get(nexusId)
    if (!tracker || tracker.phases.length === 0) return ''

    let d = `[SOP 执行指令 - ${tracker.nexusLabel}]\n`
    d += `你已激活 Nexus "${tracker.nexusLabel}"，必须严格按照 SOP 流程执行。\n`
    d += '注意：根据任务实际需求灵活调整执行深度。对于简单任务，可以快速通过或跳过分析/验证类阶段；对于复杂任务，每个阶段都应充分执行。\n'
    const first = tracker.phases[0]
    if (first) {
      d += `从 Phase 1 "${first.name}" 开始:\n`
      for (const s of first.steps) d += `  ${s.index}. ${s.text}\n`
    }
    d += '完成一个阶段后立即进入下一个阶段，不要停下来询问用户。'
    return d
  }

  // ═══ 完整后处理入口 ═══

  /** 任务结束后调用：fitness 计算 + 持久化 + Golden Path 提炼 + rewrite 检测
   *  @param updateNexusCallback 可选回调，用于同步更新 NexusEntity 的 sopEvolutionData + sopRewriteInfo */
  async afterTaskCompletion(
    nexusId: string,
    traceTools: ToolTrace[],
    isSuccess: boolean,
    finalResponse?: string,
    userPrompt?: string,
    sopContent?: string,
    updateNexusCallback?: (
      evolutionData: {
        isGolden: boolean
        ema: number
        totalExecutions: number
        goldenPathSummary?: GoldenPathSummary
      },
      rewriteInfo?: {
        rewrittenAt: number
        triggerLevel?: string
        basedOnExecutions?: number
      },
    ) => void,
  ): Promise<void> {
    try {
      const { fitness, traceSummary } = this.computeSessionFitness(nexusId, traceTools, isSuccess, userPrompt)
      const updated = await this.updateAndPersistFitness(nexusId, traceSummary)
      console.log(
        `[SOPEvolution] Fitness: ${(fitness * 100).toFixed(0)}%, EMA: ${(updated.ema * 100).toFixed(0)}% (${updated.totalExecutions} executions)`
      )

      // Rewrite 检测
      let rewriteApplied = false
      let rewriteTriggerLevel: string | undefined
      if (finalResponse) {
        // 检测当前 rewrite 触发级别（用于 sopRewriteInfo）
        rewriteTriggerLevel = await this.detectRewriteTriggerLevel(nexusId)
        rewriteApplied = await this.detectAndApplyRewrite(finalResponse, nexusId)
      }

      // Golden Path 蒸馏：优先 LLM 语义分析，降级到统计式
      if (isSuccess && sopContent) {
        const existingSummary = await this.loadGoldenPathSummary(nexusId)
        if (!existingSummary || Date.now() - existingSummary.lastSummarizedAt > EVO.GOLDEN_PATH_COOLDOWN_MS) {
          const summary = await this.distillGoldenPathSummary(nexusId, sopContent)
          if (summary) {
            console.log(`[SOPEvolution] GoldenPathSummary: ${summary.taskCategories.length} categories, confidence ${Math.round(summary.confidence * 100)}%`)
          }
        }
      } else if (isSuccess) {
        // 无 sopContent 时降级到旧版统计式
        const existing = await this.loadGoldenPath(nexusId)
        if (!existing || Date.now() - existing.lastDistilledAt > EVO.GOLDEN_PATH_COOLDOWN_MS) {
          const gp = await this.distillGoldenPath(nexusId)
          if (gp) {
            console.log(`[SOPEvolution] Golden Path (legacy): ${gp.recommendedToolChain.join(' -> ')} (${Math.round(gp.confidence * 100)}%)`)
          }
        }
      }

      // 同步更新 NexusEntity 的 sopEvolutionData + sopRewriteInfo
      if (updateNexusCallback) {
        const snapshot = await this.getEvolutionSnapshot(nexusId)
        const rewriteInfo = rewriteApplied
          ? {
              rewrittenAt: Date.now(),
              triggerLevel: rewriteTriggerLevel,
              basedOnExecutions: updated.totalExecutions,
            }
          : undefined
        updateNexusCallback(snapshot, rewriteInfo)

        if (rewriteApplied) {
          console.log(`[SOPEvolution] SOP rewrite applied (trigger: ${rewriteTriggerLevel}), UI notified`)
        }
      }
    } catch (err) {
      console.warn('[SOPEvolution] afterTaskCompletion failed:', err)
    }
  }

  /** 检测当前应触发的 rewrite 级别（不构建完整请求，仅返回级别字符串） */
  private async detectRewriteTriggerLevel(nexusId: string): Promise<string | undefined> {
    const data = await this.loadSOPFitness(nexusId)
    const last3 = data.recentTraces.slice(-3)
    if (last3.length >= 3 && last3.every(t => !t.success)) return 'EMERGENCY'
    if (data.totalExecutions >= 5 && data.ema < 0.5) return 'STANDARD'
    if (data.totalExecutions >= 10 && data.ema < 0.7) {
      const recentSlice = data.recentTraces.slice(-5)
      if (recentSlice.length > 0) {
        const recentAvg = recentSlice.reduce((s, t) => s + t.fitness, 0) / recentSlice.length
        if (recentAvg < data.ema) return 'GRADUAL'
      }
    }
    return undefined
  }
}

export const sopEvolutionService = new SOPEvolutionService()
