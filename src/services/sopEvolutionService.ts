/**
 * SOP Evolution Service — SOP 自进化机制本地实现
 *
 * 从 openclaw-extension 移植完整的 SOP 自进化闭环：
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
import { simpleChatBackground } from '@/services/llmService'
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
  dunId: string
  dunLabel: string
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
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${this.serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'readFile', args: { path } }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return null
      const data = await res.json()
      return data.status === 'error' ? null : (data.result ?? null)
    } catch {
      return null
    }
  }

  private async writeFile(path: string, content: string): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${this.serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'writeFile', args: { path, content } }),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return false
      const data = await res.json()
      return data.status !== 'error'
    } catch {
      return false
    }
  }

  private dunFilePath(dunId: string, filename: string): string {
    return `duns/${dunId}/${filename}`
  }

  // ═══ SOPTracker 管理 ═══

  createSOPTracker(dunId: string, dunLabel: string, sopContent: string): SOPTracker {
    const phases = this.parseSOP(sopContent)
    const tracker: SOPTracker = {
      phases,
      currentPhaseIndex: phases.length > 0 ? 0 : -1,
      dunId,
      dunLabel,
    }
    this.sopTrackers.set(dunId, tracker)
    return tracker
  }

  getSOPTracker(dunId: string): SOPTracker | undefined {
    return this.sopTrackers.get(dunId)
  }

  /** 推断 SOP 进度 — 工具执行后调用，关键词匹配前进 Phase */
  inferSOPProgress(dunId: string, toolName: string, toolResult: string): void {
    const tracker = this.sopTrackers.get(dunId)
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

  async loadSOPFitness(dunId: string): Promise<SOPFitness> {
    const cached = this.fitnessCache.get(dunId)
    if (cached && Date.now() - cached.ts < this.CACHE_TTL) return cached.data

    const content = await this.readFile(this.dunFilePath(dunId, EVO.FITNESS_FILE))
    if (!content) return createDefaultFitness()
    try {
      const data = JSON.parse(content) as SOPFitness
      this.fitnessCache.set(dunId, { data, ts: Date.now() })
      return data
    } catch {
      return createDefaultFitness()
    }
  }

  private async saveSOPFitness(dunId: string, data: SOPFitness): Promise<void> {
    data.lastUpdatedAt = Date.now()
    await this.writeFile(this.dunFilePath(dunId, EVO.FITNESS_FILE), JSON.stringify(data, null, 2))
    this.fitnessCache.set(dunId, { data, ts: Date.now() })
  }

  // ═══ Fitness 计算 ═══

  computeSessionFitness(
    dunId: string,
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

    const tracker = this.sopTrackers.get(dunId)
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
  private async updateAndPersistFitness(dunId: string, traceSummary: TraceSummary): Promise<SOPFitness> {
    const data = await this.loadSOPFitness(dunId)

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

    await this.saveSOPFitness(dunId, data)
    return data
  }

  // ═══ 上下文 Hints 注入 ═══

  /** 供 buildDynamicContext() 调用 — 返回所有 SOP 进化 hints */
  async getContextHints(dunId: string): Promise<string | null> {
    const parts: string[] = []

    const hints = await this.buildSOPImprovementHints(dunId)
    if (hints) parts.push(hints)

    const rewriteReq = await this.buildSOPRewriteRequest(dunId)
    if (rewriteReq) parts.push(rewriteReq)

    const gp = await this.buildGoldenPathHint(dunId)
    if (gp) parts.push(gp)

    return parts.length > 0 ? parts.join('\n\n') : null
  }

  private async buildSOPImprovementHints(dunId: string): Promise<string | null> {
    const data = await this.loadSOPFitness(dunId)
    if (data.totalExecutions < EVO.MIN_EXECUTIONS_FOR_HINTS) return null

    let shouldInject = false
    if (data.ema < 0.6) shouldInject = true

    const recent3 = data.recentTraces.slice(-3)
    if (recent3.length >= 3 && recent3.every(t => !t.success)) shouldInject = true

    const phaseHints: string[] = []
    const tracker = this.sopTrackers.get(dunId)
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

    const label = tracker?.dunLabel || dunId
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
  private async buildSOPRewriteRequest(dunId: string): Promise<string | null> {
    const data = await this.loadSOPFitness(dunId)
    const isGolden = await this.isGoldenDun(dunId)

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

    const label = this.sopTrackers.get(dunId)?.dunLabel || dunId
    const tracker = this.sopTrackers.get(dunId)

    const parts: string[] = []
    parts.push(`[SOP Rewrite Request — ${triggerLevel.toUpperCase()}]`)
    parts.push(`The current SOP for Dun "${label}" needs improvement.`)
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

  private async buildGoldenPathHint(dunId: string): Promise<string | null> {
    // 优先使用新版 GoldenPathSummary
    const summary = await this.loadGoldenPathSummary(dunId)
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
    const gp = await this.loadGoldenPath(dunId)
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

  /** 将旧版 SOP 保存到 sop-history，返回版本号 */
  private async saveOldSopToHistory(dunId: string, oldContent: string): Promise<string | null> {
    try {
      // 获取已有版本列表来确定下一个版本号
      const res = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/sop-history`)
      let nextVersion = 1
      if (res.ok) {
        const data = await res.json()
        const versions: string[] = data.versions || []
        // versions 格式为 ['v1', 'v2', ...], 取最大 + 1
        for (const v of versions) {
          const num = parseInt(v.replace('v', ''), 10)
          if (!isNaN(num) && num >= nextVersion) nextVersion = num + 1
        }
      }

      const saveRes = await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/sop-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: String(nextVersion), content: oldContent }),
      })
      if (saveRes.ok) {
        console.log(`[SOPEvolution] Old SOP saved to history as v${nextVersion}`)
        return String(nextVersion)
      }
      return null
    } catch (err) {
      console.warn('[SOPEvolution] Failed to save SOP to history:', err)
      return null
    }
  }

  /** 检测 LLM 输出中的 <SOP_REWRITE> 标签并写回 DUN.md
   *  改写前先将旧版 SOP 保存到 sop-history */
  async detectAndApplyRewrite(llmOutput: string, dunId: string): Promise<{
    rewritten: boolean
    newSopContent?: string
    historyVersion?: string
  }> {
    const m = llmOutput.match(/<SOP_REWRITE>([\s\S]*?)<\/SOP_REWRITE>/)
    if (!m) return { rewritten: false }

    const newSOP = m[1].trim()
    if (newSOP.length < 50) return { rewritten: false }

    const mdPath = this.dunFilePath(dunId, 'DUN.md')
    const raw = await this.readFile(mdPath)
    if (!raw) return { rewritten: false }

    // 改写前保存旧版本到 sop-history
    const historyVersion = await this.saveOldSopToHistory(dunId, raw)

    // 保留 frontmatter
    const fmMatch = raw.match(/^---\n[\s\S]*?\n---\n/)
    const frontmatter = fmMatch ? fmMatch[0] : ''

    // 剥离 LLM 输出中可能夹带的 frontmatter（防止双重 frontmatter）
    let cleanedSOP = newSOP.trim()
    const sopFmMatch = cleanedSOP.match(/^---\n[\s\S]*?\n---\n?/)
    if (sopFmMatch) {
      cleanedSOP = cleanedSOP.slice(sopFmMatch[0].length).trim()
    }

    const fullNewContent = frontmatter + cleanedSOP + '\n'
    const written = await this.writeFile(mdPath, fullNewContent)

    if (written) {
      // 重置 fitness baseline
      const data = await this.loadSOPFitness(dunId)
      data.baselineEma = data.ema
      data.executionsSinceRewrite = 0
      await this.saveSOPFitness(dunId, data)

      // 重建 tracker
      const tracker = this.sopTrackers.get(dunId)
      if (tracker) {
        this.createSOPTracker(dunId, tracker.dunLabel, newSOP)
      }

      console.log(`[SOPEvolution] SOP rewritten for Dun: ${dunId}`)
      return { rewritten: true, newSopContent: fullNewContent, historyVersion: historyVersion ?? undefined }
    }
    return { rewritten: false }
  }

  // ═══ Golden Path ═══

  private async loadGoldenPath(dunId: string): Promise<GoldenPath | null> {
    const content = await this.readFile(this.dunFilePath(dunId, EVO.GOLDEN_PATH_FILE))
    if (!content) return null
    try { return JSON.parse(content) as GoldenPath } catch { return null }
  }

  private async loadGoldenPathSummary(dunId: string): Promise<GoldenPathSummary | null> {
    const content = await this.readFile(this.dunFilePath(dunId, EVO.GOLDEN_SUMMARY_FILE))
    if (!content) return null
    try { return JSON.parse(content) as GoldenPathSummary } catch { return null }
  }

  /** 判断 Dun 是否达到 Golden 状态：EMA ≥ 0.7 且有高置信度 GoldenPathSummary */
  async isGoldenDun(dunId: string): Promise<boolean> {
    const fitness = await this.loadSOPFitness(dunId)
    if (fitness.ema < EVO.GOLDEN_EMA_THRESHOLD) return false

    const summary = await this.loadGoldenPathSummary(dunId)
    return summary !== null && summary.confidence >= EVO.GOLDEN_CONFIDENCE_THRESHOLD
  }

  /** 获取 DunEntity.sopEvolutionData 的快照（供 UI 读取） */
  async getEvolutionSnapshot(dunId: string): Promise<{
    isGolden: boolean
    ema: number
    totalExecutions: number
    goldenPathSummary?: GoldenPathSummary
  }> {
    const fitness = await this.loadSOPFitness(dunId)
    const summary = await this.loadGoldenPathSummary(dunId)
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
  async distillGoldenPathSummary(dunId: string, sopContent: string): Promise<GoldenPathSummary | null> {
    const fitness = await this.loadSOPFitness(dunId)
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

    const analysisPrompt = `You are analyzing execution history for a Dun (AI agent specialization).

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
      const response = await simpleChatBackground(messages)
      if (!response) return null

      // 提取 JSON（兼容 <think> 思维链标签和 markdown 代码块包裹）
      let jsonStr = response.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
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
        this.dunFilePath(dunId, EVO.GOLDEN_SUMMARY_FILE),
        JSON.stringify(summary, null, 2),
      )
      console.log(`[SOPEvolution] GoldenPathSummary distilled for ${dunId} (confidence: ${Math.round(summary.confidence * 100)}%)`)
      return summary
    } catch (err) {
      console.warn('[SOPEvolution] LLM distillation failed:', err)
      return null
    }
  }

  /** 旧版统计式 Golden Path 提炼（保留作为降级方案） */
  async distillGoldenPath(dunId: string): Promise<GoldenPath | null> {
    const fitness = await this.loadSOPFitness(dunId)
    const successTraces = fitness.recentTraces.filter(t => t.success)

    const additionalChains: string[][] = []
    const successContent = await this.readFile(this.dunFilePath(dunId, 'experience/successes.md'))
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

    const failContent = await this.readFile(this.dunFilePath(dunId, 'experience/failures.md'))
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

    await this.writeFile(this.dunFilePath(dunId, EVO.GOLDEN_PATH_FILE), JSON.stringify(gp, null, 2))
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
  buildSOPReminder(dunId: string, toolsUsed: string[], lastToolResult?: string): string {
    const tracker = this.sopTrackers.get(dunId)
    if (!tracker || tracker.phases.length === 0) return ''

    const cur = tracker.phases[tracker.currentPhaseIndex]
    if (!cur) return ''

    const next = tracker.currentPhaseIndex + 1 < tracker.phases.length
      ? tracker.phases[tracker.currentPhaseIndex + 1]
      : null

    const parts: string[] = []
    parts.push(`[SOP 进度提醒 - ${tracker.dunLabel}]`)
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

  buildSOPDirective(dunId: string): string {
    const tracker = this.sopTrackers.get(dunId)
    if (!tracker || tracker.phases.length === 0) return ''

    let d = `[SOP 执行指令 - ${tracker.dunLabel}]\n`
    d += `你已激活 Dun "${tracker.dunLabel}"，必须严格按照 SOP 流程执行。\n`
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
   *  @param updateDunCallback 可选回调，用于同步更新 DunEntity 的 sopEvolutionData + sopRewriteInfo + sopContent */
  async afterTaskCompletion(
    dunId: string,
    traceTools: ToolTrace[],
    isSuccess: boolean,
    finalResponse?: string,
    userPrompt?: string,
    sopContent?: string,
    updateDunCallback?: (
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
        historyVersion?: string
      },
      newSopContent?: string,
    ) => void,
  ): Promise<void> {
    try {
      const { fitness, traceSummary } = this.computeSessionFitness(dunId, traceTools, isSuccess, userPrompt)
      const updated = await this.updateAndPersistFitness(dunId, traceSummary)
      console.log(
        `[SOPEvolution] Fitness: ${(fitness * 100).toFixed(0)}%, EMA: ${(updated.ema * 100).toFixed(0)}% (${updated.totalExecutions} executions)`
      )

      // Rewrite 检测
      let rewriteResult: { rewritten: boolean; newSopContent?: string; historyVersion?: string } = { rewritten: false }
      let rewriteTriggerLevel: string | undefined
      if (finalResponse) {
        rewriteTriggerLevel = await this.detectRewriteTriggerLevel(dunId)
        rewriteResult = await this.detectAndApplyRewrite(finalResponse, dunId)
      }

      // Golden Path 蒸馏：优先 LLM 语义分析，降级到统计式
      if (isSuccess && sopContent) {
        const existingSummary = await this.loadGoldenPathSummary(dunId)
        if (!existingSummary || Date.now() - existingSummary.lastSummarizedAt > EVO.GOLDEN_PATH_COOLDOWN_MS) {
          const summary = await this.distillGoldenPathSummary(dunId, sopContent)
          if (summary) {
            console.log(`[SOPEvolution] GoldenPathSummary: ${summary.taskCategories.length} categories, confidence ${Math.round(summary.confidence * 100)}%`)
          }
        }
      } else if (isSuccess) {
        const existing = await this.loadGoldenPath(dunId)
        if (!existing || Date.now() - existing.lastDistilledAt > EVO.GOLDEN_PATH_COOLDOWN_MS) {
          const gp = await this.distillGoldenPath(dunId)
          if (gp) {
            console.log(`[SOPEvolution] Golden Path (legacy): ${gp.recommendedToolChain.join(' -> ')} (${Math.round(gp.confidence * 100)}%)`)
          }
        }
      }

      // 同步更新 DunEntity 的 sopEvolutionData + sopRewriteInfo + sopContent
      if (updateDunCallback) {
        const snapshot = await this.getEvolutionSnapshot(dunId)
        const rewriteInfo = rewriteResult.rewritten
          ? {
              rewrittenAt: Date.now(),
              triggerLevel: rewriteTriggerLevel,
              basedOnExecutions: updated.totalExecutions,
              historyVersion: rewriteResult.historyVersion,
            }
          : undefined
        updateDunCallback(snapshot, rewriteInfo, rewriteResult.newSopContent)

        if (rewriteResult.rewritten) {
          console.log(`[SOPEvolution] SOP rewrite applied (trigger: ${rewriteTriggerLevel}), UI notified`)
        }
      }
    } catch (err) {
      console.warn('[SOPEvolution] afterTaskCompletion failed:', err)
    }
  }

  /** 检测当前应触发的 rewrite 级别（不构建完整请求，仅返回级别字符串） */
  private async detectRewriteTriggerLevel(dunId: string): Promise<string | undefined> {
    const data = await this.loadSOPFitness(dunId)
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

  // ═══ Consolidator 适配层 ═══

  /**
   * 计算本次执行的 fitness 并持久化到 sop-fitness.json
   * 包装 computeSessionFitness + updateAndPersistFitness，供 Consolidator Phase 3 调用
   */
  async computeAndPersistFitness(
    dunId: string,
    traceTools: ToolTrace[],
    isSuccess: boolean,
    userPrompt?: string,
  ): Promise<{ fitness: number; ema: number; totalExecutions: number }> {
    const { fitness, traceSummary } = this.computeSessionFitness(dunId, traceTools, isSuccess, userPrompt)
    const updated = await this.updateAndPersistFitness(dunId, traceSummary)
    console.log(
      `[SOPEvolution] Fitness: ${(fitness * 100).toFixed(0)}%, EMA: ${(updated.ema * 100).toFixed(0)}% (${updated.totalExecutions} executions)`
    )
    return { fitness, ema: updated.ema, totalExecutions: updated.totalExecutions }
  }

  /**
   * 检测 LLM 输出中的 SOP 改写并应用
   * 包装 detectRewriteTriggerLevel + detectAndApplyRewrite，供 Consolidator Phase 3 调用
   */
  async detectRewrite(dunId: string, finalResponse: string): Promise<{
    rewritten: boolean
    triggerLevel?: string
    basedOnExecutions?: number
    historyVersion?: string
    newSopContent?: string
  }> {
    const triggerLevel = await this.detectRewriteTriggerLevel(dunId)
    const rewriteResult = await this.detectAndApplyRewrite(finalResponse, dunId)

    if (rewriteResult.rewritten) {
      const data = await this.loadSOPFitness(dunId)
      console.log(`[SOPEvolution] SOP rewrite applied (trigger: ${triggerLevel})`)
      return {
        rewritten: true,
        triggerLevel,
        basedOnExecutions: data.totalExecutions,
        historyVersion: rewriteResult.historyVersion,
        newSopContent: rewriteResult.newSopContent,
      }
    }

    return { rewritten: false }
  }

  /**
   * 构建 SOP 执行历史上下文文本，供 Consolidator Prompt 的"SOP 执行历史"段使用
   * 复用 distillGoldenPathSummary 中的数据收集逻辑（但不调用 LLM）
   */
  async buildGoldenPathContext(dunId: string, sopContent: string): Promise<string | null> {
    const fitness = await this.loadSOPFitness(dunId)
    const successTraces = fitness.recentTraces.filter(t => t.success)
    if (successTraces.length < EVO.MIN_SUCCESSES_FOR_GOLDEN_PATH) return null

    // 构建执行历史摘要
    const traceSummaries = fitness.recentTraces.map(t => ({
      success: t.success,
      toolChain: t.toolChain.join(' -> '),
      errorTools: t.errorTools.join(', ') || 'none',
      phaseReached: t.phaseReached,
      taskSummary: t.taskSummary || 'unknown',
    }))

    // 解析 SOP phases 名称
    const phases = this.parseSOP(sopContent)
    const phaseNames = phases.map(p => `Phase ${p.index}: ${p.name}`)

    const lines = [
      `EMA: ${(fitness.ema * 100).toFixed(0)}%, Total: ${fitness.totalExecutions} 次, Since Rewrite: ${fitness.executionsSinceRewrite}`,
      '',
      'Phases: ' + phaseNames.join(', '),
      '',
      `Recent ${traceSummaries.length} executions:`,
      ...traceSummaries.map((t, i) =>
        `  ${i + 1}. ${t.success ? '✓' : '✗'} [${t.toolChain || 'no tools'}] phase=${t.phaseReached} task="${t.taskSummary}"`
      ),
    ]
    return lines.join('\n')
  }

  /**
   * 将 Consolidator 的 SOP_FEEDBACK 结果写入 golden-path-summary.json
   * 仅处理数据写入，不调用 LLM
   */
  async applyGoldenPathFromConsolidator(
    dunId: string,
    sopFeedback: { action: string; suggestion?: string; phaseInsights?: Array<{ phaseName: string; status: string; insight: string }>; confidence?: number },
  ): Promise<void> {
    if (sopFeedback.action === 'noop') return

    const fitness = await this.loadSOPFitness(dunId)

    const summary: GoldenPathSummary = {
      taskCategories: [],  // Consolidator 不提供 taskCategories，保留空
      phaseInsights: (sopFeedback.phaseInsights || []).map(pi => ({
        phaseName: pi.phaseName,
        status: pi.status as 'golden' | 'stable' | 'bottleneck',
        insight: pi.insight,
      })),
      commonPitfalls: sopFeedback.suggestion ? [sopFeedback.suggestion] : [],
      confidence: sopFeedback.confidence ?? 0.5,
      lastSummarizedAt: Date.now(),
      basedOnExecutions: fitness.totalExecutions,
    }

    await this.writeFile(
      this.dunFilePath(dunId, EVO.GOLDEN_SUMMARY_FILE),
      JSON.stringify(summary, null, 2),
    )
    console.log(`[SOPEvolution] GoldenPathSummary written from Consolidator for ${dunId} (action: ${sopFeedback.action})`)
  }
}

export const sopEvolutionService = new SOPEvolutionService()
