// ============================================
// Nexus 管理服务 (从 LocalClawService 提取)
// 职责: Nexus 路由匹配、工具装配、性能统计、上下文构建、经验系统、SOP 执行追踪
// ============================================

import type { NexusEntity, ToolInfo, ExecTrace } from '@/types'
import { nexusRuleEngine, type NexusStats } from './nexusRuleEngine'
import { genePoolService } from './genePoolService'
import { chat, isLLMConfigured } from './llmService'

type NexusStatsMap = Record<string, NexusStats>

// ---- SOP 结构化类型 ----

export interface SOPStep {
  text: string       // 步骤原文
  index: number      // 步骤序号 (1-based)
  keywords: string[] // 从步骤文本提取的关键词 (用于推断进度)
}

export interface SOPPhase {
  name: string       // Phase 名称 (e.g. "需求分析与规划")
  index: number      // Phase 序号 (1-based)
  steps: SOPStep[]
}

export interface SOPTracker {
  phases: SOPPhase[]
  currentPhaseIndex: number  // 推断的当前 Phase (0-based, -1=未开始)
  nexusId: string
  nexusLabel: string
}

// ---- SOP 自适应演进类型 ----

export interface SOPAnnotation {
  phase: number           // 目标 Phase 序号 (1-based)
  type: 'recommend' | 'warning' | 'deprecated'
  text: string
  evidence: number        // 支撑次数
}

export interface SOPPhaseStats {
  successes: number
  failures: number
  topToolChains: string[][] // 最成功的工具链 (按频次排序)
}

export interface SOPFitnessData {
  currentVersion: number
  ema: number                         // 指数移动平均适应度 (0~1)
  executionsSinceRewrite: number
  totalExecutions: number
  lastRewriteTime: string | null      // ISO date string
  baselineEmaBeforeRewrite: number    // 重写前的 ema 基准 (用于回滚判定)
  tier1Annotations: SOPAnnotation[]
  phaseStats: Record<string, SOPPhaseStats>
  history: Array<{
    version: number
    ema: number
    executions: number
    rewriteReason: string | null
  }>
}

// ---- IO 依赖接口 ----

export interface NexusManagerIO {
  executeTool(call: { name: string; args: Record<string, unknown> }): Promise<{ status: string; result?: string }>
  readFileWithCache(path: string): Promise<string | null>
  getActiveNexusId(): string | null
  getNexuses(): Map<string, NexusEntity> | undefined
  getAvailableTools(): ToolInfo[]
  getServerUrl(): string
  addToast?(toast: { type: string; title: string; message: string }): void
  // 优化5: 语义匹配能力 (由 LocalClawService 注入)
  embedText?(text: string): Promise<number[]>
  cosineSimilarity?(a: number[], b: number[]): number
}

// ---- Nexus 管理服务 ----

export class NexusManagerService {
  private statsCache: NexusStatsMap = {}
  private io: NexusManagerIO | null = null
  // 优化5: Nexus 描述向量缓存
  private nexusVectorCache: Map<string, number[]> = new Map()
  // 断点2修复: 统计持久化重试机制
  private statsSaveRetries = 0
  private statsSaveTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly STATS_MAX_RETRIES = 3
  private static readonly STATS_RETRY_DELAYS = [2000, 5000, 15000] // 递增重试延迟

  setIO(io: NexusManagerIO): void {
    this.io = io
  }

  // ============================================
  // 性能统计系统
  // ============================================

  async loadStats(): Promise<void> {
    if (!this.io) return
    try {
      const result = await this.io.executeTool({
        name: 'readFile',
        args: { path: 'memory/nexus_stats.json' },
      })
      if (result.status === 'success' && result.result) {
        this.statsCache = JSON.parse(result.result)
        console.log(`[NexusManager] Loaded stats for ${Object.keys(this.statsCache).length} nexuses`)
      }
    } catch {
      // 文件不存在，从空开始
    }
  }

  /**
   * 🧬 Phase 4: 注册所有 Nexus 的能力基因
   * 让其他 Nexus 能通过 Gene Pool 发现可协作的节点
   */
  async registerAllNexusCapabilities(): Promise<void> {
    if (!this.io) return
    
    const nexuses = this.io.getNexuses()
    if (!nexuses || nexuses.size === 0) return

    let registeredCount = 0
    for (const [nexusId, nexus] of nexuses) {
      // 提取能力关键词
      const capabilities: string[] = []
      
      // 从 label 和 flavorText 提取关键词
      if (nexus.label) {
        capabilities.push(...nexus.label.split(/[,，、\s]+/).filter(s => s.length > 1))
      }
      if (nexus.flavorText) {
        capabilities.push(...nexus.flavorText.split(/[,，、\s]+/).filter(s => s.length > 1 && s.length < 10))
      }
      
      // 从 triggers 提取
      if (nexus.triggers && nexus.triggers.length > 0) {
        capabilities.push(...nexus.triggers)
      }
      
      // 从绑定的技能推断能力
      if (nexus.boundSkillIds && nexus.boundSkillIds.length > 0) {
        capabilities.push(...nexus.boundSkillIds.map(s => s.replace(/-/g, ' ')))
      }

      // 去重
      const uniqueCapabilities = [...new Set(capabilities.map(c => c.toLowerCase()))]
        .filter(c => c.length > 1)
        .slice(0, 15)

      if (uniqueCapabilities.length === 0) continue

      // 构建目录路径
      const dirPath = `nexuses/${nexusId}/`

      genePoolService.registerNexusCapability({
        nexusId,
        nexusName: nexus.label || nexusId,
        description: nexus.flavorText || nexus.objective || '',
        capabilities: uniqueCapabilities,
        dirPath,
      })
      
      registeredCount++
    }

    console.log(`[NexusManager] Registered ${registeredCount} Nexus capability genes`)
  }

  private async saveStats(): Promise<void> {
    if (!this.io) return
    try {
      await this.io.executeTool({
        name: 'writeFile',
        args: {
          path: 'memory/nexus_stats.json',
          content: JSON.stringify(this.statsCache, null, 2),
        },
      })
      // 成功: 重置重试状态
      this.statsSaveRetries = 0
    } catch (err) {
      console.warn('[NexusManager] Failed to save stats:', err)
      // 调度重试
      this.scheduleStatsRetry()
    }
  }

  /**
   * 调度统计持久化重试 (递增延迟)
   */
  private scheduleStatsRetry(): void {
    if (this.statsSaveRetries >= NexusManagerService.STATS_MAX_RETRIES) {
      console.error(`[NexusManager] Stats save failed after ${this.statsSaveRetries} retries, data only in memory`)
      return
    }
    if (this.statsSaveTimer) return // 已有重试在排队

    const delay = NexusManagerService.STATS_RETRY_DELAYS[this.statsSaveRetries] || 15000
    this.statsSaveRetries++

    console.log(`[NexusManager] Scheduling stats retry #${this.statsSaveRetries} in ${delay}ms`)
    this.statsSaveTimer = setTimeout(() => {
      this.statsSaveTimer = null
      this.saveStats().catch(() => {})
    }, delay)
  }

  recordPerformance(trace: ExecTrace): void {
    const nexusId = trace.activeNexusId || '_global'

    if (!this.statsCache[nexusId]) {
      this.statsCache[nexusId] = {
        nexusId,
        totalTasks: 0,
        successCount: 0,
        failureCount: 0,
        toolUsage: {},
        totalTurns: 0,
        totalDuration: 0,
        topErrors: [],
        lastUpdated: Date.now(),
      }
    }

    const stats = this.statsCache[nexusId]
    stats.totalTasks++
    stats.totalTurns += trace.turnCount || 0
    stats.totalDuration += trace.duration || 0
    stats.lastUpdated = Date.now()

    if (trace.success) {
      stats.successCount++
    } else {
      stats.failureCount++
    }

    for (const tool of trace.tools) {
      if (!stats.toolUsage[tool.name]) {
        stats.toolUsage[tool.name] = { calls: 0, errors: 0 }
      }
      stats.toolUsage[tool.name].calls++
      if (tool.status === 'error') {
        stats.toolUsage[tool.name].errors++
        const errSnippet = (tool.result || '').slice(0, 60)
        if (errSnippet && !stats.topErrors.includes(errSnippet)) {
          stats.topErrors.push(errSnippet)
          if (stats.topErrors.length > 5) stats.topErrors.shift()
        }
      }
    }

    // 异步持久化 (内部含重试逻辑)
    this.saveStats()

    // 触发规则引擎评估
    nexusRuleEngine.evaluateAndActivateRules(nexusId, stats)

    // 🔄 优化1: Manager → Gene Pool 反馈信号
    // 当某工具错误率飙升时，提升相关修复基因的权重
    for (const tool of trace.tools) {
      if (tool.status === 'error') {
        const usage = stats.toolUsage[tool.name]
        if (usage && usage.calls >= 3) {
          const errorRate = usage.errors / usage.calls
          if (errorRate > 0.5) {
            // 高错误率 → 触发 gene pool 强化匹配（让相关基因更容易被推荐）
            genePoolService.boostGenesForTool(tool.name, errorRate)
          }
        }
      }
    }
  }

  buildInsight(nexusId?: string | null): string {
    const id = nexusId || '_global'
    const stats = this.statsCache[id]
    if (!stats || stats.totalTasks < 2) return ''

    const successRate = Math.round((stats.successCount / stats.totalTasks) * 100)
    const avgTurns = Math.round(stats.totalTurns / stats.totalTasks)
    const avgDuration = Math.round(stats.totalDuration / stats.totalTasks / 1000)

    const lines: string[] = [`## 📊 历史表现 (${stats.totalTasks}次任务)`]

    if (successRate >= 80) {
      lines.push(`成功率: ${successRate}% — 表现稳定`)
    } else if (successRate >= 50) {
      lines.push(`成功率: ${successRate}% — 有改进空间，注意失败模式`)
    } else {
      lines.push(`成功率: ${successRate}% — 失败率偏高，执行前仔细规划`)
    }

    lines.push(`平均轮次: ${avgTurns} | 平均耗时: ${avgDuration}s`)

    const sortedTools = Object.entries(stats.toolUsage)
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 3)
    if (sortedTools.length > 0) {
      const toolHints = sortedTools.map(([name, u]) => {
        const errRate = u.calls > 0 ? Math.round((u.errors / u.calls) * 100) : 0
        return errRate > 30
          ? `${name}(${u.calls}次, ⚠️错误率${errRate}%)`
          : `${name}(${u.calls}次)`
      })
      lines.push(`常用工具: ${toolHints.join(', ')}`)
    }

    const riskyTools = Object.entries(stats.toolUsage)
      .filter(([, u]) => u.calls >= 3 && (u.errors / u.calls) > 0.4)
      .map(([name]) => name)
    if (riskyTools.length > 0) {
      lines.push(`⚠️ 高风险工具: ${riskyTools.join(', ')} — 使用前确认参数正确`)
    }

    if (successRate < 60 && avgTurns > 15) {
      lines.push(`建议: 失败率高且轮次多，优先拆分为更小的子任务`)
    } else if (avgTurns > 20) {
      lines.push(`建议: 平均轮次偏高，考虑更精确的工具选择`)
    }

    return lines.join('\n') + '\n'
  }

  // ============================================
  // Nexus 路由匹配 (三层)
  // ============================================

  matchForTask(userInput: string): NexusEntity | null {
    if (!this.io) return null
    const nexuses = this.io.getNexuses()
    if (!nexuses || nexuses.size === 0) return null

    const inputLower = userInput.toLowerCase()

    // P0: 显式激活
    const activeNexusId = this.io.getActiveNexusId()
    if (activeNexusId) {
      const active = nexuses.get(activeNexusId)
      if (active) return active
    }

    const nexusList = Array.from(nexuses.values()).filter(n => n.constructionProgress >= 1)

    // P1: 触发词命中
    for (const nexus of nexusList) {
      const triggers = nexus.triggers || []
      if (triggers.length > 0 && triggers.some(t => inputLower.includes(t.toLowerCase()))) {
        console.log(`[NexusRouter] P1 trigger match: "${nexus.label}" via triggers`)
        return nexus
      }
    }

    // P1.5 优化5: 语义匹配 (异步启动，结果缓存)
    // 由于 matchForTask 是同步的，语义匹配在后台预热
    // 这里检查是否有缓存的语义匹配结果
    if (this.io.embedText && this.io.cosineSimilarity) {
      const semanticMatch = this.findSemanticMatch(inputLower, nexusList)
      if (semanticMatch) {
        console.log(`[NexusRouter] P1.5 semantic match: "${semanticMatch.label}"`)
        return semanticMatch
      }
    }

    // P2: 关键词综合评分
    let bestMatch: NexusEntity | null = null
    let bestScore = 0

    for (const nexus of nexusList) {
      let score = 0
      const triggers = nexus.triggers || []
      score += triggers.filter(t => inputLower.includes(t.toLowerCase())).length * 3

      const skills = nexus.boundSkillIds || []
      score += skills.filter(s => {
        const parts = s.toLowerCase().split('-')
        return parts.some(p => p.length > 2 && inputLower.includes(p))
      }).length * 2

      const desc = `${nexus.flavorText || ''} ${nexus.label || ''}`
      const descWords = desc.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      score += descWords.filter(w => inputLower.includes(w)).length

      if (score > bestScore) {
        bestScore = score
        bestMatch = nexus
      }
    }

    if (bestScore >= 3 && bestMatch) {
      console.log(`[NexusRouter] P2 keyword match: "${bestMatch.label}" (score: ${bestScore})`)
      return bestMatch
    }

    console.log('[NexusRouter] No Nexus matched, using full toolset')
    return null
  }

  /**
   * 优化5: 语义匹配 — 利用向量相似度找最匹配的 Nexus
   * 使用缓存的 Nexus 描述向量，避免每次都重新 embed
   */
  private findSemanticMatch(queryLower: string, nexusList: NexusEntity[]): NexusEntity | null {
    // 检查是否有预热的查询向量
    const queryKey = `__query:${queryLower.slice(0, 100)}`
    const queryVector = this.nexusVectorCache.get(queryKey)
    if (!queryVector) {
      // 异步预热: 不阻塞当前匹配
      this.preheatSemanticVectors(queryLower, nexusList)
      return null
    }

    let bestMatch: NexusEntity | null = null
    let bestScore = 0.45 // 语义匹配阈值

    for (const nexus of nexusList) {
      const nexusVector = this.nexusVectorCache.get(nexus.id)
      if (!nexusVector) continue

      const score = this.io?.cosineSimilarity?.(queryVector, nexusVector) ?? 0
      if (score > bestScore) {
        bestScore = score
        bestMatch = nexus
      }
    }

    return bestMatch
  }

  /**
   * 优化5: 异步预热 Nexus 描述向量 + 查询向量
   */
  private async preheatSemanticVectors(queryLower: string, nexusList: NexusEntity[]): Promise<void> {
    if (!this.io?.embedText) return

    try {
      // 预热查询向量
      const queryKey = `__query:${queryLower.slice(0, 100)}`
      if (!this.nexusVectorCache.has(queryKey)) {
        const qv = await this.io.embedText(queryLower)
        if (qv.length > 0) {
          this.nexusVectorCache.set(queryKey, qv)
        }
      }

      // 预热 Nexus 描述向量 (只做一次)
      for (const nexus of nexusList) {
        if (this.nexusVectorCache.has(nexus.id)) continue
        const desc = `${nexus.label || ''} ${nexus.flavorText || ''} ${nexus.objective || ''} ${(nexus.triggers || []).join(' ')}`
        const nv = await this.io.embedText(desc)
        if (nv.length > 0) {
          this.nexusVectorCache.set(nexus.id, nv)
        }
      }
    } catch (err) {
      console.warn('[NexusRouter] Semantic preheat failed:', err)
    }
  }

  /**
   * 标准化技能名称：统一 kebab-case 和 snake_case
   * NEXUS.md 的 skill_dependencies 用 kebab-case (e.g. "powerpoint-pptx")
   * 后端 ToolRegistry 注册时转成 snake_case (e.g. "powerpoint_pptx")
   * 需要双向匹配才能正确绑定
   */
  private normalizeSkillName(name: string): string {
    return name.replace(/-/g, '_').toLowerCase()
  }

  /**
   * 轻量意图检测：判断 query 是否需要完整 SOP 执行
   * - 简单问答/闲聊 → false (light 模式)
   * - 任务指令 → true (full 模式)
   */
  private isTaskIntent(query: string): boolean {
    const trimmed = query.trim()

    // 短句且以问号结尾 → 大概率是问答
    if (trimmed.length < 20 && /[？?]$/.test(trimmed)) return false

    // 任务动词关键词（中文）
    const taskVerbs = /(?:^|[，。；\s])(?:做|生成|分析|创建|修改|制作|编写|设计|开发|实现|执行|运行|构建|部署|优化|重构|编辑|写|画|搜索|查找|对比|整理|汇总|导出|转换|合并|拆分|安装|配置|调试|测试|检查|审核|评估|规划|策划|撰写|起草|翻译|总结|提炼|梳理|搭建|接入|集成|迁移|升级|下载|上传|发送|推送|抓取|爬取|采集|处理|清洗|统计|计算|绘制|渲染|录制|压缩|解压|加密|解密|备份|恢复|启动|停止|重启|帮我|请你|开始|继续执行|按照|根据|依据)/
    if (taskVerbs.test(trimmed)) return true

    // 任务动词关键词（英文）
    const engTaskVerbs = /\b(?:create|make|build|generate|write|design|develop|implement|run|execute|deploy|analyze|compare|export|convert|merge|install|test|fix|debug|optimize|refactor|search|find|fetch|download|upload|send|start|stop|continue)\b/i
    if (engTaskVerbs.test(trimmed)) return true

    // 较长文本（>50字）大概率是复杂任务描述
    if (trimmed.length > 50) return true

    // 包含文件路径、URL 等 → 大概率是任务
    if (/[\/\\][\w.-]+\.\w+/.test(trimmed) || /https?:\/\//.test(trimmed)) return true

    // 默认：短句无动词 → 问答
    return false
  }

  assembleToolsForNexus(nexus: NexusEntity): ToolInfo[] {
    if (!this.io) return []
    const availableTools = this.io.getAvailableTools()
    const result: ToolInfo[] = []
    const included = new Set<string>()

    // 1. 基础工具
    for (const tool of availableTools) {
      if (tool.type === 'builtin') {
        result.push(tool)
        included.add(tool.name)
      }
    }

    // 2. 绑定工具 — 双向标准化匹配
    // boundSkillIds 来自 NEXUS.md (kebab-case), tool.name 来自后端 (snake_case)
    const rawBoundIds = nexus.boundSkillIds || []
    const normalizedBoundMap = new Map<string, string>() // normalized → original
    for (const bid of rawBoundIds) {
      normalizedBoundMap.set(this.normalizeSkillName(bid), bid)
    }

    for (const tool of availableTools) {
      if (included.has(tool.name)) continue
      const normalizedToolName = this.normalizeSkillName(tool.name)
      if (normalizedBoundMap.has(normalizedToolName)) {
        result.push(tool)
        included.add(tool.name)
      }
    }

    // 3. MCP 工具
    for (const tool of availableTools) {
      if (tool.type === 'mcp' && !included.has(tool.name)) {
        const mcpServer = tool.name.split('__')[0] || ''
        const normalizedServer = this.normalizeSkillName(mcpServer)
        if (normalizedBoundMap.has(normalizedServer) ||
            Array.from(normalizedBoundMap.keys()).some(nid => this.normalizeSkillName(tool.name).includes(nid))) {
          result.push(tool)
          included.add(tool.name)
        }
      }
    }

    // 4. 模糊补充 (仅当绑定匹配不足时)
    const nonBuiltinCount = result.filter(t => t.type !== 'builtin').length
    if (nonBuiltinCount < 3) {
      const nexusKeywords = [
        ...(nexus.triggers || []),
        ...(nexus.label ? nexus.label.toLowerCase().split(/\s+/) : []),
      ].map(k => k.toLowerCase()).filter(k => k.length > 2)

      for (const tool of availableTools) {
        if (included.has(tool.name)) continue
        if (result.length >= 15) break

        const toolLower = tool.name.toLowerCase()
        const descLower = (tool.description || '').toLowerCase()
        if (nexusKeywords.some(k => toolLower.includes(k) || descLower.includes(k))) {
          result.push(tool)
          included.add(tool.name)
        }
      }
    }

    const boundMatched = result.filter(t => t.type !== 'builtin').map(t => t.name)
    console.log(`[NexusRouter] Assembled ${result.length} tools for "${nexus.label}" (bound: ${rawBoundIds.join(',')} → matched: ${boundMatched.join(', ')})`)
    return result
  }

  expandToolsForReflexion(
    currentTools: ToolInfo[],
    failedToolName: string,
    errorMsg: string,
  ): ToolInfo[] | null {
    if (!this.io) return null
    const isToolMissing = /unknown tool|tool not found|不支持|no such tool|未找到工具|not available/i.test(errorMsg)
    if (!isToolMissing) return null

    const currentNames = new Set(currentTools.map(t => t.name))
    const availableTools = this.io.getAvailableTools()
    const missingTool = availableTools.find(t => t.name === failedToolName && !currentNames.has(t.name))

    if (missingTool) {
      console.log(`[NexusRouter] Runtime expansion: adding "${failedToolName}" to toolset`)
      return [...currentTools, missingTool]
    }

    return null
  }

  prepareToolsForTask(userInput: string): {
    tools: ToolInfo[]
    matchedNexus: NexusEntity | null
    isFiltered: boolean
  } {
    if (!this.io) return { tools: [], matchedNexus: null, isFiltered: false }
    const matchedNexus = this.matchForTask(userInput)
    const availableTools = this.io.getAvailableTools()

    if (matchedNexus) {
      const filteredTools = this.assembleToolsForNexus(matchedNexus)
      const nonBuiltin = filteredTools.filter(t => t.type !== 'builtin').length
      if (nonBuiltin === 0) {
        console.log('[NexusRouter] Safety fallback: no non-builtin tools after filtering, using full toolset')
        return { tools: availableTools, matchedNexus, isFiltered: false }
      }
      return { tools: filteredTools, matchedNexus, isFiltered: true }
    }

    return { tools: availableTools, matchedNexus: null, isFiltered: false }
  }

  // ============================================
  // Nexus 上下文 & 经验
  // ============================================

  async buildContext(nexusId: string, userQuery: string): Promise<string | null> {
    if (!this.io) return null
    const nexuses = this.io.getNexuses()
    const nexus = nexuses?.get(nexusId)

    // 轻量意图检测：区分简单问答 vs 任务执行
    const needsFullSOP = this.isTaskIntent(userQuery)

    let sopContent = nexus?.sopContent

    if (!sopContent) {
      try {
        const res = await fetch(`${this.io.getServerUrl()}/nexuses/${nexusId}`)
        if (res.ok) {
          const detail = await res.json()
          sopContent = detail.sopContent
        }
      } catch {
        // 静默失败
      }
    }

    // Light 模式：仅返回 Nexus 身份 + 目标，不注入 SOP
    if (!needsFullSOP) {
      let ctx = `## 🌌 Active Nexus: ${nexus?.label || nexusId}\n\n`
      if (nexus?.objective) {
        ctx += `核心目标: ${nexus.objective}\n`
      }
      if (nexus?.flavorText) {
        ctx += `职能: ${nexus.flavorText}\n`
      }
      ctx += `\n（当前为简单问答模式，如需执行完整任务请明确指示）\n`
      return ctx
    }

    if (!sopContent) return null

    let ctx = `## 🌌 Active Nexus: ${nexus?.label || nexusId}\n\n`

    const objective = nexus?.objective
    const metrics = nexus?.metrics
    const strategy = nexus?.strategy

    if (objective) {
      ctx += `### 🎯 核心目标 (Objective)\n${objective}\n\n`
      if (metrics && metrics.length > 0) {
        ctx += `### ✓ 验收标准 (Metrics)\n`
        ctx += `执行过程中，请自我检查是否满足以下条件：\n`
        metrics.forEach((m: string, i: number) => {
          ctx += `${i + 1}. ${m}\n`
        })
        ctx += `\n`
      }
      if (strategy) {
        ctx += `### 🔄 动态调整策略\n${strategy}\n\n`
      }
      ctx += `---\n\n`
    }

    // SOP 注入策略：结构化摘要 + 完整原文 (提高上限)
    const phases = this.parseSOP(sopContent)

    if (phases.length > 0) {
      // 先注入结构化执行路线图（简洁、模型容易跟踪）
      ctx += `### 📋 SOP 执行路线图\n\n`
      ctx += `**执行原则**: 按顺序执行各阶段。如果用户指定了从某个 Phase 继续，或者对话历史中已完成某些 Phase，则直接从指定/下一个 Phase 开始，不要重复已完成的步骤。\n\n`
      for (const phase of phases) {
        ctx += `**Phase ${phase.index}: ${phase.name}**\n`
        for (const step of phase.steps) {
          ctx += `  ${step.index}. ${step.text}\n`
        }
        ctx += `\n`
      }
      ctx += `---\n\n`
    }

    // 然后注入完整 SOP 原文作为参考细节（提高上限到 16000 字符）
    const maxChars = 16000
    const trimmedSOP = sopContent.length > maxChars
      ? sopContent.slice(0, maxChars) + '\n... [SOP 原文过长，已截断。请严格参照上方路线图执行]'
      : sopContent
    ctx += trimmedSOP

    const experiences = await this.searchExperiences(nexusId, userQuery)
    if (experiences.length > 0) {
      ctx += `\n\n### 相关历史经验\n${experiences.join('\n---\n')}`
    }

    return ctx
  }

  private async searchExperiences(nexusId: string, query: string): Promise<string[]> {
    if (!this.io) return []

    // 优化4: 优先使用结构化索引检索
    const indexResults = await this.searchExperienceIndex(nexusId, query)
    if (indexResults.length > 0) {
      return indexResults
    }

    // Fallback: 原始 Markdown 检索
    const matched: { text: string; score: number; index: number }[] = []
    let globalIndex = 0

    for (const fileName of ['successes.md', 'failures.md']) {
      const content = await this.io.readFileWithCache(`nexuses/${nexusId}/experience/${fileName}`)
      if (!content) continue

      const entries = content.split('\n### ').filter(e => e.trim())
      const queryWords = query.split(/\s+/).filter(w => w.length > 1)
      const prefix = fileName.includes('success') ? '[SUCCESS]' : '[FAILURE]'

      for (const entry of entries) {
        const entryLower = entry.toLowerCase()
        let score = 0
        // 关键词匹配 (放宽到 length > 1)
        for (const w of queryWords) {
          if (entryLower.includes(w.toLowerCase())) score += 2
        }
        // 双字符 n-gram 交叉匹配 (中文友好)
        score += this.ngramOverlapScore(query, entry)
        matched.push({
          text: `${prefix} ### ${entry.slice(0, 500)}`,
          score,
          index: globalIndex++,
        })
      }
    }

    if (matched.length === 0) return []

    // 按相关性排序（相关性相同时，越新的条目越靠前）
    const sortedByRelevance = [...matched].sort((a, b) => b.score - a.score || b.index - a.index)

    // 关键词匹配的前3条
    const keywordMatched = sortedByRelevance.filter(m => m.score > 0).slice(0, 3)
    // 始终包含最近3条（确保最新经验始终可见，不论关键词是否匹配）
    const recent = [...matched].sort((a, b) => b.index - a.index).slice(0, 3)

    const seen = new Set<string>()
    const results: string[] = []
    for (const item of [...keywordMatched, ...recent]) {
      if (!seen.has(item.text)) {
        seen.add(item.text)
        results.push(item.text)
      }
    }

    return results.slice(0, 5)
  }

  /**
   * 优化4: 结构化索引检索 — 先查 index.json 过滤，再定位详情
   * 改进: 使用 n-gram 交叉匹配 + 始终注入最近经验
   */
  private async searchExperienceIndex(nexusId: string, query: string): Promise<string[]> {
    if (!this.io) return []

    const indexContent = await this.io.readFileWithCache(`nexuses/${nexusId}/experience/index.json`)
    if (!indexContent) return []

    try {
      const index: Array<{
        type: string
        task: string
        tools: string[]
        insight: string
        timestamp: string
        category: string
      }> = JSON.parse(indexContent)

      if (!Array.isArray(index) || index.length === 0) return []

      const queryWords = query.split(/\s+/).filter(w => w.length > 1).map(w => w.toLowerCase())

      // 按相关性评分 (多维度)
      const scored = index.map((entry, i) => {
        const text = `${entry.task} ${entry.insight} ${entry.tools.join(' ')} ${entry.category}`.toLowerCase()
        let score = 0

        // 1. 关键词匹配 (放宽 length > 1)
        for (const word of queryWords) {
          if (text.includes(word)) score += 2
        }
        // 2. 类别精确匹配加分
        if (queryWords.some(w => entry.category.toLowerCase().includes(w))) score += 3
        // 3. 工具名匹配加分
        for (const tool of entry.tools) {
          if (queryWords.some(w => tool.toLowerCase().includes(w))) score += 2
        }
        // 4. n-gram 交叉匹配 (中文2字符组合，英文3字符组合)
        score += this.ngramOverlapScore(query, `${entry.task} ${entry.insight}`)
        // 5. 时间衰减加分：最近的经验天然更相关
        //    index 末尾 = 最新，给予轻微加分
        score += Math.min(i * 0.1, 1)

        return { entry, score, index: i }
      })

      // 关键词/n-gram 匹配的前 3 条
      const relevant = [...scored]
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score || b.index - a.index)
        .slice(0, 3)

      // 始终包含最新 2 条 (保证最近经验不因关键词不匹配而丢失)
      const recent = [...scored]
        .sort((a, b) => b.index - a.index)
        .slice(0, 2)

      const seen = new Set<number>()
      const results: string[] = []

      for (const item of [...relevant, ...recent]) {
        if (seen.has(item.index)) continue
        seen.add(item.index)

        const e = item.entry
        const prefix = e.type === 'success' ? '[SUCCESS]' : '[FAILURE]'
        const toolSeq = e.tools.length > 0 ? e.tools.join(' → ') : 'N/A'
        results.push(`${prefix} [${e.timestamp}] ${e.task}\n- Tools: ${toolSeq}\n- Category: ${e.category}\n- Insight: ${e.insight}`)
      }

      return results.slice(0, 5)
    } catch {
      return [] // JSON 解析失败，回退到 Markdown 检索
    }
  }

  /**
   * n-gram 交叉匹配评分 — 解决中文关键词不完全匹配的问题
   * 将两段文本都分解为 2-gram 集合，计算交集大小
   * 例: "生成分析报告" → {"生成","成分","分析","析报","报告"}
   *     "股票分析推荐" → {"股票","票分","分析","析推","推荐"}
   *     交集: {"分析"} → score += 1
   */
  private ngramOverlapScore(text1: string, text2: string): number {
    const extractNgrams = (text: string, n: number): Set<string> => {
      const clean = text.replace(/\s+/g, '').toLowerCase()
      const grams = new Set<string>()
      for (let i = 0; i <= clean.length - n; i++) {
        grams.add(clean.slice(i, i + n))
      }
      return grams
    }
    const grams1 = extractNgrams(text1, 2)
    const grams2 = extractNgrams(text2, 2)
    let overlap = 0
    for (const g of grams1) {
      if (grams2.has(g)) overlap++
    }
    // 归一化：避免长文本天然高分
    const minSize = Math.min(grams1.size, grams2.size)
    if (minSize === 0) return 0
    // 返回 0~3 范围的分数
    return Math.min(Math.round((overlap / minSize) * 3), 3)
  }

  buildSkillContext(): string {
    if (!this.io) return ''
    const activeNexusId = this.io.getActiveNexusId()
    if (!activeNexusId) return ''

    const nexuses = this.io.getNexuses()
    const nexus = nexuses?.get(activeNexusId)
    if (!nexus) return ''

    const boundSkills = nexus.boundSkillIds || []
    const availableSkillNames = this.io.getAvailableTools()
      .filter((t: ToolInfo) => t.type === 'instruction' || t.type === 'plugin')
      .map((t: ToolInfo) => t.name)

    return `\n当前 Nexus: ${nexus.label || activeNexusId}
已绑定技能: ${boundSkills.join(', ') || '无'}
可用技能库: ${availableSkillNames.slice(0, 15).join(', ')}${availableSkillNames.length > 15 ? '...' : ''}`
  }

  async recordExperience(
    nexusId: string,
    task: string,
    toolsUsed: string[],
    success: boolean,
    finalResponse: string
  ): Promise<void> {
    if (!this.io) return
    try {
      const insight = this.extractKeyInsight(toolsUsed, finalResponse)
      await fetch(`${this.io.getServerUrl()}/nexuses/${nexusId}/experience`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: task.slice(0, 200),
          tools_used: toolsUsed,
          outcome: success ? 'success' : 'failure',
          key_insight: insight,
        }),
      })
      console.log(`[NexusManager] Recorded ${success ? 'success' : 'failure'} experience for Nexus: ${nexusId}`)
    } catch (e) {
      console.warn('[NexusManager] Failed to record experience:', e)
    }
  }

  private extractKeyInsight(toolsUsed: string[], finalResponse: string): string {
    if (toolsUsed.length === 0) return 'Direct response without tool usage'
    const toolSeq = toolsUsed.join(' → ')
    const summary = finalResponse.slice(0, 100).replace(/\n/g, ' ')
    return `Tool sequence: ${toolSeq}. Result: ${summary}...`
  }

  // ============================================
  // SOP 步骤解析 & 执行追踪
  // ============================================

  /**
   * 从 SOP 文本中解析出结构化的 Phase/Step 列表
   * 支持格式:
   *   ### Phase 1: 名称  /  ### Phase 1: 名称  /  ### 1. 名称
   *   1. 步骤内容
   *   - 步骤内容
   */
  parseSOP(sopContent: string): SOPPhase[] {
    if (!sopContent) return []

    const phases: SOPPhase[] = []
    const lines = sopContent.split('\n')

    let currentPhase: SOPPhase | null = null
    let stepCounter = 0

    for (const line of lines) {
      const trimmed = line.trim()

      // 匹配 Phase 标题: "### Phase N: xxx" 或 "### N. xxx" 或 "### xxx"（在 SOP 区域内）
      const phaseMatch = trimmed.match(
        /^#{2,3}\s+(?:Phase\s+(\d+)\s*[:：]\s*|(\d+)\.\s*)?(.+)/i
      )
      if (phaseMatch) {
        const phaseName = phaseMatch[3].trim()
        // 跳过非步骤类标题 (Mission, Constraints, 技能应用指南 等)
        if (/^(Mission|Constraints|常见用例|技能应用|个性特点|专业特点)/i.test(phaseName)) {
          currentPhase = null
          continue
        }
        // 跳过一级标题（Nexus 名称）
        if (trimmed.startsWith('# ') && !trimmed.startsWith('## ')) continue

        currentPhase = {
          name: phaseName,
          index: phases.length + 1,
          steps: [],
        }
        phases.push(currentPhase)
        stepCounter = 0
        continue
      }

      // 匹配步骤: "1. xxx" 或 "- xxx" (需在 Phase 内)
      if (currentPhase) {
        const stepMatch = trimmed.match(/^(?:(\d+)\.\s+|\-\s+)\*{0,2}(.+?)\*{0,2}$/)
        if (stepMatch && stepMatch[2]) {
          stepCounter++
          const stepText = stepMatch[2].replace(/\*{1,2}/g, '').trim()
          // 提取关键词: 中文词组或英文单词, 过滤短词和停用词
          const keywords = this.extractStepKeywords(stepText)
          currentPhase.steps.push({
            text: stepText,
            index: stepCounter,
            keywords,
          })
        }
      }
    }

    // 只保留有步骤的 Phase
    return phases.filter(p => p.steps.length > 0)
  }

  /**
   * 从步骤文本提取关键词 (用于后续推断执行进度)
   */
  private extractStepKeywords(text: string): string[] {
    const stopWords = new Set([
      '的', '了', '和', '与', '或', '是', '在', '将', '把', '对', '从', '到', '以', '等',
      '进行', '使用', '确保', '确定', '检查', '选择', '提供', '如果', '根据',
      'the', 'a', 'an', 'is', 'are', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'if',
    ])

    // 提取中文词组 (2-6字) + 英文单词 (3+字符)
    const chineseWords = text.match(/[\u4e00-\u9fff]{2,6}/g) || []
    const englishWords = (text.match(/[a-zA-Z_-]{3,}/g) || []).map(w => w.toLowerCase())

    return [...chineseWords, ...englishWords]
      .filter(w => !stopWords.has(w))
      .slice(0, 8) // 每步最多 8 个关键词
  }

  /**
   * 为 Nexus 创建 SOP 执行追踪器
   */
  createSOPTracker(nexusId: string): SOPTracker | null {
    if (!this.io) return null
    const nexuses = this.io.getNexuses()
    const nexus = nexuses?.get(nexusId)
    if (!nexus?.sopContent) return null

    const phases = this.parseSOP(nexus.sopContent)
    if (phases.length === 0) return null

    return {
      phases,
      currentPhaseIndex: 0, // 从第一个 Phase 开始
      nexusId,
      nexusLabel: nexus.label || nexusId,
    }
  }

  /**
   * 根据工具调用和返回内容，推断当前 SOP 执行进度
   * 返回推断后的 phase index (0-based)
   */
  inferSOPProgress(
    tracker: SOPTracker,
    toolsUsed: string[],
    lastToolResult: string,
  ): number {
    if (tracker.phases.length === 0) return -1

    // 构建已有信号文本 (工具名 + 结果摘要)
    const signalText = [
      ...toolsUsed.map(t => t.toLowerCase()),
      lastToolResult.slice(0, 500).toLowerCase(),
    ].join(' ')

    // 从当前 Phase 开始向后扫描，找到关键词匹配最多的 Phase
    let bestPhaseIdx = tracker.currentPhaseIndex
    let bestScore = 0

    for (let pi = tracker.currentPhaseIndex; pi < tracker.phases.length; pi++) {
      const phase = tracker.phases[pi]
      let phaseScore = 0
      for (const step of phase.steps) {
        for (const kw of step.keywords) {
          if (signalText.includes(kw.toLowerCase())) {
            phaseScore++
          }
        }
      }
      if (phaseScore > bestScore) {
        bestScore = phaseScore
        bestPhaseIdx = pi
      }
    }

    // 只允许前进不允许后退 (SOP 是单向流程)
    return Math.max(bestPhaseIdx, tracker.currentPhaseIndex)
  }

  /**
   * 生成 SOP 进度提醒文本 (注入到 ReAct 循环消息中)
   */
  buildSOPReminder(tracker: SOPTracker, toolsUsed: string[], lastToolResult: string): string | null {
    if (!tracker || tracker.phases.length === 0) return null

    // 推断进度
    const inferredIdx = this.inferSOPProgress(tracker, toolsUsed, lastToolResult)
    tracker.currentPhaseIndex = inferredIdx

    const currentPhase = tracker.phases[inferredIdx]
    if (!currentPhase) return null

    const totalPhases = tracker.phases.length
    const completedPhases = tracker.phases.slice(0, inferredIdx).map(p => p.name)
    const nextPhase = inferredIdx + 1 < totalPhases ? tracker.phases[inferredIdx + 1] : null

    // 构建简洁的提醒
    let reminder = `\n[SOP 执行追踪 - ${tracker.nexusLabel}]\n`
    reminder += `当前阶段: Phase ${currentPhase.index}/${totalPhases} - ${currentPhase.name}\n`

    if (completedPhases.length > 0) {
      reminder += `已完成: ${completedPhases.join(' → ')}\n`
    }

    // 列出当前 Phase 的具体步骤
    reminder += `待执行步骤:\n`
    for (const step of currentPhase.steps) {
      reminder += `  ${step.index}. ${step.text}\n`
    }

    if (nextPhase) {
      reminder += `下一阶段: ${nextPhase.name}\n`
    }

    if (nextPhase) {
      reminder += `⚠️ 重要指令：当前阶段完成后，你必须立即开始执行下一阶段「${nextPhase.name}」的工具调用。不要停下来汇报进度，不要输出建议选项，不要询问用户是否继续。直接调用工具继续执行。只有所有阶段全部完成后才可以停下来输出最终总结。`
    } else {
      reminder += `这是最后一个阶段。完成后请输出最终总结。`
    }
    return reminder
  }

  matchByTriggers(userQuery: string): string | null {
    if (!this.io) return null
    const query = userQuery.toLowerCase()
    const nexuses = this.io.getNexuses()
    if (!nexuses) return null

    for (const [, nexus] of nexuses) {
      if (nexus.triggers && nexus.triggers.length > 0) {
        for (const trigger of nexus.triggers) {
          if (query.includes(trigger.toLowerCase())) {
            return nexus.id
          }
        }
      }
    }
    return null
  }

  // ============================================
  // 🧬 SOP 自适应演进系统
  // Tier 1: 统计驱动微调 (每次执行后)
  // Tier 2: LLM 异步重写 (条件触发)
  // ============================================

  // -- 常量 --
  private static readonly SOP_EMA_ALPHA = 0.3          // EMA 平滑系数
  private static readonly TIER1_MIN_EVIDENCE = 3       // Tier1 批注最少证据次数
  private static readonly TIER2_MIN_EXECUTIONS = 10    // Tier2 最少执行次数
  private static readonly TIER2_FITNESS_THRESHOLD = 0.55 // Tier2 触发适应度阈值
  private static readonly TIER2_MIN_ANNOTATIONS = 5    // Tier2 至少累积批注数
  private static readonly TIER2_COOLDOWN_DAYS = 3      // Tier2 重写冷却天数
  private static readonly ROLLBACK_MARGIN = 0.15       // 回滚阈值 (ema 降幅)
  private static readonly ROLLBACK_MIN_EXECUTIONS = 3  // 回滚前最少执行次数

  /**
   * 计算单次执行的适应度分数 (0~1)
   */
  computeFitness(trace: ExecTrace, maxTurns: number): number {
    const success = trace.success ? 1 : 0
    const turns = trace.turnCount || 0
    const totalCalls = trace.tools.length
    const errorCalls = trace.tools.filter(t => t.status === 'error').length
    const errorRate = totalCalls > 0 ? errorCalls / totalCalls : 0
    const efficiency = maxTurns > 0 ? Math.max(0, 1 - turns / maxTurns) : 0.5

    return 0.5 * success + 0.3 * efficiency + 0.2 * (1 - errorRate)
  }

  /**
   * 加载 Nexus 的 sop-fitness.json
   */
  private async loadFitness(nexusId: string): Promise<SOPFitnessData> {
    if (!this.io) return this.defaultFitness()
    try {
      const content = await this.io.readFileWithCache(`nexuses/${nexusId}/sop-fitness.json`)
      if (content) return JSON.parse(content)
    } catch { /* 不存在或解析失败 */ }
    return this.defaultFitness()
  }

  private defaultFitness(): SOPFitnessData {
    return {
      currentVersion: 1,
      ema: 0.5,
      executionsSinceRewrite: 0,
      totalExecutions: 0,
      lastRewriteTime: null,
      baselineEmaBeforeRewrite: 0.5,
      tier1Annotations: [],
      phaseStats: {},
      history: [{ version: 1, ema: 0.5, executions: 0, rewriteReason: null }],
    }
  }

  /**
   * 持久化 sop-fitness.json
   */
  private async saveFitness(nexusId: string, data: SOPFitnessData): Promise<boolean> {
    if (!this.io) return false
    let retries = 2
    while (retries >= 0) {
      try {
        await this.io.executeTool({
          name: 'writeFile',
          args: {
            path: `nexuses/${nexusId}/sop-fitness.json`,
            content: JSON.stringify(data, null, 2),
          },
        })
        return true
      } catch (err) {
        retries--
        if (retries < 0) {
          console.warn(`[SOP-Evolution] Failed to save fitness for "${nexusId}" after retries:`, err)
          return false
        }
        // 等待后重试
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    return false
  }

  /**
   * 🧬 SOP 演进主入口 — 在每次任务执行完成后调用
   * 1. 更新 fitness EMA
   * 2. 更新 phase 统计
   * 3. Tier 1: 生成/更新批注
   * 4. 检查回滚条件
   * 5. 检查 Tier 2 触发条件
   */
  async evolveSOPAfterExecution(
    nexusId: string,
    trace: ExecTrace,
    sopTracker: SOPTracker | null,
    maxTurns: number
  ): Promise<void> {
    if (!this.io) return

    try {
      const fitness = this.computeFitness(trace, maxTurns)
      const data = await this.loadFitness(nexusId)

      // 更新 EMA
      const alpha = NexusManagerService.SOP_EMA_ALPHA
      data.ema = alpha * fitness + (1 - alpha) * data.ema
      data.executionsSinceRewrite++
      data.totalExecutions++

      console.log(`[SOP-Evolution] Nexus "${nexusId}" fitness=${fitness.toFixed(3)}, ema=${data.ema.toFixed(3)}, execSinceRewrite=${data.executionsSinceRewrite}`)

      // 更新 Phase 统计
      this.updatePhaseStats(data, trace, sopTracker)

      // Tier 1: 统计驱动批注
      this.tier1UpdateAnnotations(data, trace, sopTracker)

      // 检查回滚 (仅在重写后观察期内)
      if (data.currentVersion > 1 && data.executionsSinceRewrite >= NexusManagerService.ROLLBACK_MIN_EXECUTIONS) {
        if (data.ema < data.baselineEmaBeforeRewrite - NexusManagerService.ROLLBACK_MARGIN) {
          console.log(`[SOP-Evolution] 🔄 Rollback triggered! ema=${data.ema.toFixed(3)} < baseline=${data.baselineEmaBeforeRewrite.toFixed(3)} - ${NexusManagerService.ROLLBACK_MARGIN}`)
          await this.rollbackSOP(nexusId, data)
          // 回滚后保存 fitness 即使 rollbackSOP 内部也会保存，双保险
          const saved = await this.saveFitness(nexusId, data)
          if (!saved) console.error(`[SOP-Evolution] Critical: fitness save failed after rollback for "${nexusId}"`)
          return
        }
      }

      // 持久化 fitness (回滚/Tier2前先保存)
      const saved = await this.saveFitness(nexusId, data)
      if (!saved) {
        console.error(`[SOP-Evolution] Fitness save failed for "${nexusId}", skipping Tier 1/2 writes to avoid inconsistency`)
        return  // fitness 写不进去就不要继续写 SOP，避免数据不一致
      }

    // Tier 1: 将批注写入 NEXUS.md (每次都更新)
    if (data.tier1Annotations.length > 0) {
      await this.tier1WriteAnnotationsToSOP(nexusId, data)
    }

      // Tier 2: 检查是否需要 LLM 重写
      if (this.shouldTriggerTier2(data)) {
        console.log(`[SOP-Evolution] 🧬 Tier 2 triggered for "${nexusId}" — launching async SOP rewrite`)
        // 异步执行，不阻塞当前任务
        this.tier2RewriteSOP(nexusId, data).catch(err => {
          console.warn('[SOP-Evolution] Tier 2 rewrite failed:', err)
        })
      }
    } catch (err) {
      // 顶层守卫: SOP 演进整体失败不应影响主流程
      console.error(`[SOP-Evolution] evolveSOPAfterExecution failed for "${nexusId}":`, err)
    }
  }

  /**
   * 更新各 Phase 的统计数据
   */
  private updatePhaseStats(data: SOPFitnessData, trace: ExecTrace, sopTracker: SOPTracker | null): void {
    if (!sopTracker || sopTracker.phases.length === 0) return

    // 简化: 根据工具调用顺序和 sopTracker 的 currentPhaseIndex 归类
    // 将所有工具调用归到 currentPhaseIndex 指向的 phase
    const phaseKey = String(sopTracker.currentPhaseIndex + 1) // 1-based
    if (!data.phaseStats[phaseKey]) {
      data.phaseStats[phaseKey] = { successes: 0, failures: 0, topToolChains: [] }
    }

    const stats = data.phaseStats[phaseKey]
    if (trace.success) {
      stats.successes++
    } else {
      stats.failures++
    }

    // 记录工具链
    const toolChain = trace.tools.filter(t => t.status === 'success').map(t => t.name)
    if (toolChain.length > 0) {
      stats.topToolChains.push(toolChain)
      // 保留最近 20 条
      if (stats.topToolChains.length > 20) {
        stats.topToolChains = stats.topToolChains.slice(-20)
      }
    }
  }

  /**
   * Tier 1: 从统计数据生成/更新批注
   */
  private tier1UpdateAnnotations(data: SOPFitnessData, trace: ExecTrace, sopTracker: SOPTracker | null): void {
    if (!sopTracker || sopTracker.phases.length === 0) return

    // 分析失败的工具: 反复失败的工具 → warning 批注
    const failedTools = new Map<string, number>()
    for (const tool of trace.tools) {
      if (tool.status === 'error') {
        failedTools.set(tool.name, (failedTools.get(tool.name) || 0) + 1)
      }
    }

    // 查找已有的 warning 批注并增加证据
    for (const [toolName, count] of failedTools) {
      const errorSnippet = trace.tools.find(t => t.name === toolName && t.status === 'error')?.result?.slice(0, 80) || ''
      const warningText = `${toolName} 失败 (${errorSnippet})`
      const phaseIndex = (sopTracker.currentPhaseIndex >= 0 ? sopTracker.currentPhaseIndex : 0) + 1

      const existing = data.tier1Annotations.find(
        a => a.type === 'warning' && a.text.startsWith(toolName) && a.phase === phaseIndex
      )
      if (existing) {
        existing.evidence += count
      } else {
        data.tier1Annotations.push({
          phase: phaseIndex,
          type: 'warning',
          text: warningText,
          evidence: count,
        })
      }
    }

    // 分析成功的工具链 → recommend 批注
    const successTools = trace.tools.filter(t => t.status === 'success').map(t => t.name)
    if (trace.success && successTools.length > 0) {
      const chainStr = successTools.join(' → ')
      const phaseIndex = (sopTracker.currentPhaseIndex >= 0 ? sopTracker.currentPhaseIndex : 0) + 1

      const existing = data.tier1Annotations.find(
        a => a.type === 'recommend' && a.text.includes(chainStr) && a.phase === phaseIndex
      )
      if (existing) {
        existing.evidence++
      } else {
        data.tier1Annotations.push({
          phase: phaseIndex,
          type: 'recommend',
          text: `推荐工具链: ${chainStr}`,
          evidence: 1,
        })
      }
    }

    // 过滤掉证据不足的批注 (保留但不写入 SOP)
    // 只在写入时过滤，这里全保留以积累证据
  }

  /**
   * Tier 1: 将已达到证据阈值的批注写入 NEXUS.md 的系统区段
   */
  private async tier1WriteAnnotationsToSOP(nexusId: string, data: SOPFitnessData): Promise<void> {
    if (!this.io) return

    const minEvidence = NexusManagerService.TIER1_MIN_EVIDENCE
    const activeAnnotations = data.tier1Annotations.filter(a => a.evidence >= minEvidence)
    if (activeAnnotations.length === 0) return

    // 读取当前 NEXUS.md
    const nexusContent = await this.io.readFileWithCache(`nexuses/${nexusId}/NEXUS.md`)
    if (!nexusContent) return

    // 构建批注区段
    const annotationSection = this.buildAnnotationSection(activeAnnotations)

    // 替换或追加系统区段
    const marker = '## 🧬 执行经验 (自动更新)'
    let newContent: string
    if (nexusContent.includes(marker)) {
      // 替换已有区段 (从 marker 到文件末尾或下一个 ## 标题)
      const markerIndex = nexusContent.indexOf(marker)
      const beforeMarker = nexusContent.slice(0, markerIndex).trimEnd()
      newContent = beforeMarker + '\n\n' + annotationSection
    } else {
      // 追加
      newContent = nexusContent.trimEnd() + '\n\n' + annotationSection
    }

    // 写回
    try {
      await this.io.executeTool({
        name: 'writeFile',
        args: { path: `nexuses/${nexusId}/NEXUS.md`, content: newContent },
      })
      console.log(`[SOP-Evolution] Tier 1: wrote ${activeAnnotations.length} annotations to NEXUS.md`)
    } catch (err) {
      console.warn('[SOP-Evolution] Tier 1: failed to write annotations:', err)
    }
  }

  /**
   * 构建批注 markdown 区段
   */
  private buildAnnotationSection(annotations: SOPAnnotation[]): string {
    const lines = ['## 🧬 执行经验 (自动更新)', '']

    // 按 phase 分组
    const grouped = new Map<number, SOPAnnotation[]>()
    for (const a of annotations) {
      if (!grouped.has(a.phase)) grouped.set(a.phase, [])
      grouped.get(a.phase)!.push(a)
    }

    for (const [phase, anns] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`### Phase ${phase} 经验`)
      for (const a of anns) {
        const icon = a.type === 'recommend' ? '✅' : a.type === 'warning' ? '⚠️' : '❌'
        lines.push(`- ${icon} ${a.text} (${a.evidence}次执行验证)`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  /**
   * 检查是否应触发 Tier 2 重写
   */
  private shouldTriggerTier2(data: SOPFitnessData): boolean {
    // 基本门槛
    if (data.totalExecutions < NexusManagerService.TIER2_MIN_EXECUTIONS) return false
    if (data.ema >= NexusManagerService.TIER2_FITNESS_THRESHOLD) return false

    // 批注积累足够
    const minEvidence = NexusManagerService.TIER1_MIN_EVIDENCE
    const activeAnnotations = data.tier1Annotations.filter(a => a.evidence >= minEvidence)
    if (activeAnnotations.length < NexusManagerService.TIER2_MIN_ANNOTATIONS) return false

    // 冷却期
    if (data.lastRewriteTime) {
      const daysSince = (Date.now() - new Date(data.lastRewriteTime).getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince < NexusManagerService.TIER2_COOLDOWN_DAYS) return false
    }

    // LLM 可用
    if (!isLLMConfigured()) return false

    return true
  }

  /**
   * Tier 2: LLM 异步重写 SOP
   */
  private async tier2RewriteSOP(nexusId: string, data: SOPFitnessData): Promise<void> {
    if (!this.io) return

    // 1. 读取当前 SOP
    const currentSOP = await this.io.readFileWithCache(`nexuses/${nexusId}/NEXUS.md`)
    if (!currentSOP) return

    // 2. 构建 Phase 统计摘要
    const phaseReport = this.buildPhaseReport(data)

    // 3. 构建批注摘要
    const minEvidence = NexusManagerService.TIER1_MIN_EVIDENCE
    const activeAnnotations = data.tier1Annotations.filter(a => a.evidence >= minEvidence)
    const annotationReport = activeAnnotations.map(a => {
      const icon = a.type === 'recommend' ? '✅' : '⚠️'
      return `Phase ${a.phase}: ${icon} ${a.text} (${a.evidence}次)`
    }).join('\n')

    // 4. 备份当前版本
    try {
      await this.io.executeTool({
        name: 'writeFile',
        args: {
          path: `nexuses/${nexusId}/sop-history/v${data.currentVersion}.md`,
          content: currentSOP,
        },
      })
    } catch (err) {
      console.warn('[SOP-Evolution] Failed to backup SOP version:', err)
    }

    // 5. LLM 重写
    const prompt = `你是 SOP 优化器。基于以下执行数据，重写这个 Nexus 的 SOP。

## 当前 SOP
${currentSOP}

## 执行统计 (最近 ${data.totalExecutions} 次)
- 总体适应度 EMA: ${data.ema.toFixed(3)}
- 重写后执行次数: ${data.executionsSinceRewrite}

## 各阶段表现
${phaseReport}

## 系统发现的模式
${annotationReport}

## 重写规则
1. 保留 frontmatter (--- 之间的 YAML) 完全不动
2. 保留 Mission 的核心目标不变
3. 将已验证的成功模式融入步骤描述（作为正文，不是注释）
4. 删除或替换已证实不可用的步骤（如不存在的技能）
5. 失败率高的阶段需要补充具体指引或替代方案
6. 输出格式必须与原 SOP 一致（Markdown，Phase/Step 结构）
7. 不要添加系统中不存在的工具或技能名称
8. 不要输出 "## 🧬 执行经验 (自动更新)" 区段，该区段由系统管理
9. 只输出完整的新 NEXUS.md 内容，不要输出任何解释`

    try {
      const newSOP = await chat([
        { role: 'system', content: '你是一个 SOP 优化器。只输出优化后的完整 NEXUS.md 内容，不要输出解释。' },
        { role: 'user', content: prompt },
      ])

      if (!newSOP || newSOP.length < 100) {
        console.warn('[SOP-Evolution] Tier 2: LLM output too short, skipping')
        return
      }

      // 清理可能的 markdown code fence
      const cleaned = newSOP.replace(/^```(?:markdown)?\n?/i, '').replace(/\n?```$/i, '').trim()

      // 6. 写入新 SOP
      await this.io.executeTool({
        name: 'writeFile',
        args: { path: `nexuses/${nexusId}/NEXUS.md`, content: cleaned },
      })

      // 7. 更新 fitness 数据
      const newVersion = data.currentVersion + 1
      data.history.push({
        version: data.currentVersion,
        ema: data.ema,
        executions: data.executionsSinceRewrite,
        rewriteReason: `ema=${data.ema.toFixed(3)} < ${NexusManagerService.TIER2_FITNESS_THRESHOLD}`,
      })
      data.baselineEmaBeforeRewrite = data.ema
      data.currentVersion = newVersion
      data.executionsSinceRewrite = 0
      data.lastRewriteTime = new Date().toISOString()
      // 清空 Tier 1 批注 (已融入新 SOP)
      data.tier1Annotations = []

      await this.saveFitness(nexusId, data)

      console.log(`[SOP-Evolution] Tier 2: SOP rewritten to v${newVersion} for "${nexusId}"`)

      // 8. 通知用户
      this.io.addToast?.({
        type: 'info',
        title: 'SOP 已自动优化',
        message: `Nexus "${nexusId}" 的 SOP 已从 v${newVersion - 1} 演进到 v${newVersion}（适应度: ${data.ema.toFixed(2)}）`,
      })
    } catch (err) {
      console.warn('[SOP-Evolution] Tier 2: LLM rewrite failed:', err)
    }
  }

  /**
   * 回滚到上一版本的 SOP
   */
  private async rollbackSOP(nexusId: string, data: SOPFitnessData): Promise<void> {
    if (!this.io || data.currentVersion <= 1) return

    const prevVersion = data.currentVersion - 1
    try {
      const prevContent = await this.io.readFileWithCache(`nexuses/${nexusId}/sop-history/v${prevVersion}.md`)
      if (!prevContent) {
        console.warn(`[SOP-Evolution] Rollback failed: v${prevVersion}.md not found`)
        return
      }

      await this.io.executeTool({
        name: 'writeFile',
        args: { path: `nexuses/${nexusId}/NEXUS.md`, content: prevContent },
      })

      // 更新 fitness
      const prevHistory = data.history.find(h => h.version === prevVersion)
      data.currentVersion = prevVersion
      data.executionsSinceRewrite = 0
      data.baselineEmaBeforeRewrite = prevHistory?.ema || data.ema
      data.lastRewriteTime = new Date().toISOString()

      console.log(`[SOP-Evolution] 🔄 Rolled back to v${prevVersion} for "${nexusId}"`)

      this.io.addToast?.({
        type: 'warning',
        title: 'SOP 已回滚',
        message: `Nexus "${nexusId}" 的 SOP 从 v${prevVersion + 1} 回滚到 v${prevVersion}（适应度下降）`,
      })
    } catch (err) {
      console.warn('[SOP-Evolution] Rollback failed:', err)
    }
  }

  /**
   * 构建 Phase 统计报告 (给 LLM 重写用)
   */
  private buildPhaseReport(data: SOPFitnessData): string {
    const lines: string[] = []
    for (const [phaseKey, stats] of Object.entries(data.phaseStats)) {
      const total = stats.successes + stats.failures
      const rate = total > 0 ? Math.round((stats.successes / total) * 100) : 0
      lines.push(`Phase ${phaseKey}: 成功率 ${rate}% (${stats.successes}成功/${stats.failures}失败)`)

      // 统计最常见的工具链
      if (stats.topToolChains.length > 0) {
        const chainCounts = new Map<string, number>()
        for (const chain of stats.topToolChains) {
          const key = chain.join(' → ')
          chainCounts.set(key, (chainCounts.get(key) || 0) + 1)
        }
        const sorted = [...chainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
        for (const [chain, count] of sorted) {
          lines.push(`  常用工具链: ${chain} (${count}次)`)
        }
      }
    }
    return lines.length > 0 ? lines.join('\n') : '暂无足够的阶段统计数据'
  }
}

export const nexusManager = new NexusManagerService()
