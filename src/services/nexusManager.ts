// ============================================
// Nexus 管理服务 (从 LocalClawService 提取)
// 职责: Nexus 路由匹配、工具装配、性能统计、上下文构建、经验系统、SOP 执行追踪
// ============================================

import type { NexusEntity, ToolInfo, ExecTrace, NexusCapabilityInfo, NexusArtifactInfo } from '@/types'
import { nexusRuleEngine, type NexusStats } from './nexusRuleEngine'
import { genePoolService } from './genePoolService'


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
  // Nexus 能力/产出物注册 (从 genePoolService 迁移)
  private capabilitiesMap: Map<string, NexusCapabilityInfo> = new Map()
  private artifactsMap: Map<string, NexusArtifactInfo[]> = new Map()
  private artifactsDirty = false
  private artifactsSaveTimer: ReturnType<typeof setTimeout> | null = null

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
    // 加载产出物索引
    await this.loadArtifacts()
  }

  /**
   * 注册所有 Nexus 的能力信息 (纯内存，不持久化)
   * 每次启动从 Nexus 元数据重建
   */
  async registerAllNexusCapabilities(): Promise<void> {
    if (!this.io) return
    
    const nexuses = this.io.getNexuses()
    if (!nexuses || nexuses.size === 0) return

    this.capabilitiesMap.clear()
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

      this.capabilitiesMap.set(nexusId, {
        nexusId,
        nexusName: nexus.label || nexusId,
        description: nexus.flavorText || nexus.objective || '',
        capabilities: uniqueCapabilities,
        dirPath: `nexuses/${nexusId}/`,
      })
      
      registeredCount++
    }

    console.log(`[NexusManager] Registered ${registeredCount} Nexus capabilities`)
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

    const nexusList = Array.from(nexuses.values()).filter(n => n.constructionProgress >= 1 || (Date.now() - n.createdAt >= 3000))

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

      // P2.1: label 子串匹配 (中文友好 — 逐字符拆分匹配)
      const label = (nexus.label || '').toLowerCase()
      if (label.length >= 2) {
        // 完整匹配加权最高
        if (inputLower.includes(label)) {
          score += 5
        } else {
          // 逐字/词拆分: 对中文做字级别匹配，对英文做空格分词
          const labelChunks: string[] = []
          // 提取连续中文字符组（2字以上）和英文单词
          const chunkPattern = /[\u4e00-\u9fff]{2,}|[a-z]{3,}/g
          let chunkMatch: RegExpExecArray | null
          while ((chunkMatch = chunkPattern.exec(label)) !== null) {
            labelChunks.push(chunkMatch[0])
          }
          for (const chunk of labelChunks) {
            if (inputLower.includes(chunk)) {
              score += 2
            }
          }
        }
      }

      const skills = nexus.boundSkillIds || []
      score += skills.filter(s => {
        const parts = s.toLowerCase().split('-')
        return parts.some(p => p.length > 2 && inputLower.includes(p))
      }).length * 2

      const desc = `${nexus.flavorText || ''}`
      // 对描述文本同样做中文友好的子串匹配
      const descChunks: string[] = []
      const descChunkPattern = /[\u4e00-\u9fff]{2,}|[a-z]{3,}/gi
      let descMatch: RegExpExecArray | null
      while ((descMatch = descChunkPattern.exec(desc.toLowerCase())) !== null) {
        descChunks.push(descMatch[0])
      }
      score += descChunks.filter(w => inputLower.includes(w)).length

      if (score > bestScore) {
        bestScore = score
        bestMatch = nexus
      }
    }

    if (bestScore >= 2 && bestMatch) {
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
          // 维度变更检测 — 清除不兼容的旧缓存 (如从 TF-IDF 2000维切换到 bge 1024维)
          const firstCached = this.nexusVectorCache.values().next().value
          if (firstCached && firstCached.length !== qv.length) {
            console.log(`[NexusRouter] Embedding dimension changed (${firstCached.length} → ${qv.length}), clearing vector cache`)
            this.nexusVectorCache.clear()
          }
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
        const res = await fetch(`${this.io.getServerUrl()}/nexuses/${encodeURIComponent(nexusId)}`)
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
      if (nexus?.projectPath) {
        ctx += `项目路径: ${nexus.projectPath}\n`
      }
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

    if (nexus?.projectPath) {
      ctx += `项目路径: ${nexus.projectPath}\n\n`
    }

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

    // SOP 作为参考资料注入（Session 级别，仅注入一次）
    // 不再强制要求模型按 Phase 顺序执行，而是让模型根据任务需要自主参考
    const phases = this.parseSOP(sopContent)

    if (phases.length > 0) {
      ctx += `### 📋 SOP 参考流程\n\n`
      ctx += `以下是该 Nexus 的标准操作流程，供你参考。请根据用户的具体任务灵活运用，不必强制按顺序执行。\n\n`
      for (const phase of phases) {
        ctx += `**Phase ${phase.index}: ${phase.name}**\n`
        for (const step of phase.steps) {
          ctx += `  ${step.index}. ${step.text}\n`
        }
        ctx += `\n`
      }
      ctx += `---\n\n`
    }

    // 注入 SOP 原文作为补充参考（限制在 8000 字符以内，减少上下文膨胀）
    const maxChars = 8000
    const trimmedSOP = sopContent.length > maxChars
      ? sopContent.slice(0, maxChars) + '\n... [SOP 原文较长，已截断]'
      : sopContent
    ctx += trimmedSOP

    const experiences = await this.searchExperiences(nexusId, userQuery)
    if (experiences.length > 0) {
      ctx += `\n\n### 相关历史经验\n${experiences.join('\n---\n')}`
    }

    // 首次使用时要求 Agent 确认技能配置
    if (nexus && !nexus.skillsConfirmed) {
      const boundSkills = nexus.boundSkillIds || []
      const availableTools = this.io?.getAvailableTools?.() || []
      const installableSkills = availableTools
        .filter(t => t.type !== 'builtin')
        .map(t => `${t.name}: ${t.description || ''}`.slice(0, 80))
        .slice(0, 15)

      ctx += '\n\n---\n### ⚠️ 首次技能配置确认\n'
      ctx += '这是此 Nexus 的首次使用，请在执行任何任务之前先确认技能配置。\n\n'

      if (boundSkills.length > 0) {
        ctx += `当前已绑定技能: ${boundSkills.join(', ')}\n`
        ctx += '请向用户简要介绍这些技能的用途，询问是否需要调整。\n'
      } else {
        ctx += '当前未绑定任何技能。\n'
        ctx += '可用技能列表（前15个）:\n'
        for (const s of installableSkills) {
          ctx += `- ${s}\n`
        }
        ctx += `\n请基于此 Nexus 的职能（${nexus.label || nexusId}），向用户推荐合适的技能并询问是否绑定。\n`
        ctx += '绑定技能使用 nexusBindSkill 工具。\n'
      }

      ctx += '\n用户确认后，请调用 nexusBindSkill（如需调整）并告知用户技能已配置完成。\n'
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
      await fetch(`${this.io.getServerUrl()}/nexuses/${encodeURIComponent(nexusId)}/experience`, {
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

  // ============================================
  // Nexus 产出物索引
  // ============================================

  /**
   * 注册一个产出物 (writeFile 成功后调用)
   */
  registerArtifact(artifact: NexusArtifactInfo, _keywords?: string[]): void {
    const list = this.artifactsMap.get(artifact.nexusId) || []
    // 去重: 同路径的 artifact 更新
    const existingIdx = list.findIndex(a => a.path === artifact.path)
    if (existingIdx >= 0) {
      list[existingIdx] = artifact
    } else {
      list.push(artifact)
    }
    this.artifactsMap.set(artifact.nexusId, list)
    console.log(`[NexusManager] Registered artifact: ${artifact.name} from ${artifact.nexusId}`)
    this.scheduleArtifactsSave()
  }

  /**
   * 获取指定 Nexus 的所有产出物
   */
  getNexusArtifacts(nexusId: string): NexusArtifactInfo[] {
    return this.artifactsMap.get(nexusId) || []
  }

  /**
   * 获取所有已注册的 Nexus 能力列表
   */
  getAllNexusCapabilities(): NexusCapabilityInfo[] {
    return [...this.capabilitiesMap.values()]
  }

  // ============================================
  // Nexus 协作路由
  // ============================================

  /**
   * 构建 Nexus 通讯提示 (注入到动态上下文)
   * 根据用户查询找到相关的 Nexus 能力和产出物
   */
  buildNexusCommunicationHint(query: string, currentNexusId?: string): string {
    const signals = query.toLowerCase().split(/[,，、\s]+/).filter(s => s.length > 1)
    if (signals.length === 0) return ''

    // 匹配 capabilities
    const capMatches: Array<{ cap: NexusCapabilityInfo; score: number }> = []
    for (const [nid, cap] of this.capabilitiesMap) {
      if (nid === currentNexusId) continue // 排除当前 Nexus
      const allSignals = [
        cap.nexusName.toLowerCase(),
        ...cap.capabilities,
        ...cap.description.toLowerCase().split(/[,，、\s]+/).filter(s => s.length > 1),
      ]
      const matched = signals.filter(s => allSignals.some(gs => gs.includes(s) || s.includes(gs)))
      if (matched.length === 0) continue
      capMatches.push({ cap, score: matched.length / Math.max(signals.length, 1) })
    }
    capMatches.sort((a, b) => b.score - a.score)

    // 匹配 artifacts
    const artMatches: Array<{ art: NexusArtifactInfo; score: number }> = []
    for (const arts of this.artifactsMap.values()) {
      for (const art of arts) {
        const artSignals = [
          art.name.toLowerCase(),
          art.type.toLowerCase(),
          ...(art.description?.toLowerCase().split(/[,，、\s]+/).filter(s => s.length > 1) || []),
        ]
        const matched = signals.filter(s => artSignals.some(as => as.includes(s) || s.includes(as)))
        if (matched.length === 0) continue
        let score = matched.length / Math.max(signals.length, 1)
        if (currentNexusId && art.nexusId !== currentNexusId) score *= 0.9
        artMatches.push({ art, score })
      }
    }
    artMatches.sort((a, b) => b.score - a.score)

    if (capMatches.length === 0 && artMatches.length === 0) return ''

    const hints: string[] = ['## Nexus 协作资源']

    if (capMatches.length > 0) {
      hints.push('\n### 可协作的 Nexus 节点')
      for (const m of capMatches.slice(0, 5)) {
        hints.push(`- **${m.cap.nexusName}** (${m.cap.nexusId})`)
        hints.push(`  能力: ${m.cap.capabilities.join(', ')}`)
        hints.push(`  路径: ${m.cap.dirPath}`)
      }
    }

    if (artMatches.length > 0) {
      hints.push('\n### 相关产出物')
      for (const m of artMatches.slice(0, 5)) {
        hints.push(`- **${m.art.name}** (来自 ${m.art.nexusId})`)
        hints.push(`  路径: ${m.art.path}`)
        hints.push(`  类型: ${m.art.type}`)
        if (m.art.description) {
          hints.push(`  描述: ${m.art.description}`)
        }
      }
    }

    hints.push('\n如需访问其他 Nexus 的产出物，直接使用 readFile(路径) 读取。')
    return hints.join('\n')
  }

  // ============================================
  // 产出物持久化
  // ============================================

  private async loadArtifacts(): Promise<void> {
    if (!this.io) return
    try {
      const result = await this.io.executeTool({
        name: 'readFile',
        args: { path: 'memory/nexus_artifacts.json' },
      })
      if (result.status === 'success' && result.result) {
        const data: Record<string, NexusArtifactInfo[]> = JSON.parse(result.result)
        this.artifactsMap.clear()
        for (const [nexusId, arts] of Object.entries(data)) {
          if (Array.isArray(arts)) {
            this.artifactsMap.set(nexusId, arts)
          }
        }
        const total = [...this.artifactsMap.values()].reduce((s, a) => s + a.length, 0)
        console.log(`[NexusManager] Loaded ${total} artifacts for ${this.artifactsMap.size} nexuses`)
        return
      }
    } catch {
      // 文件不存在
    }

    // 首次启动: 从 gene_pool.jsonl 中迁移 artifact 数据
    await this.migrateArtifactsFromGenePool()
  }

  /**
   * 一次性迁移: 从 gene_pool.jsonl 中提取 artifact 数据
   */
  private async migrateArtifactsFromGenePool(): Promise<void> {
    if (!this.io) return
    try {
      const result = await this.io.executeTool({
        name: 'readFile',
        args: { path: 'memory/gene_pool.jsonl' },
      })
      if (result.status !== 'success' || !result.result) return

      let migrated = 0
      for (const line of result.result.split('\n')) {
        if (!line.trim()) continue
        try {
          const gene = JSON.parse(line)
          if (gene.category === 'artifact' && gene.artifactInfo) {
            const art: NexusArtifactInfo = gene.artifactInfo
            const list = this.artifactsMap.get(art.nexusId) || []
            if (!list.some(a => a.path === art.path)) {
              list.push(art)
              this.artifactsMap.set(art.nexusId, list)
              migrated++
            }
          }
        } catch {
          // skip malformed line
        }
      }

      if (migrated > 0) {
        console.log(`[NexusManager] Migrated ${migrated} artifacts from gene_pool.jsonl`)
        await this.saveArtifacts()
      }
    } catch {
      // gene_pool.jsonl 不存在或读取失败
    }
  }

  private async saveArtifacts(): Promise<void> {
    if (!this.io) return
    const data: Record<string, NexusArtifactInfo[]> = {}
    for (const [nexusId, arts] of this.artifactsMap) {
      data[nexusId] = arts
    }
    try {
      await this.io.executeTool({
        name: 'writeFile',
        args: {
          path: 'memory/nexus_artifacts.json',
          content: JSON.stringify(data, null, 2),
        },
      })
      this.artifactsDirty = false
    } catch (err) {
      console.warn('[NexusManager] Failed to save artifacts:', err)
    }
  }

  private scheduleArtifactsSave(): void {
    this.artifactsDirty = true
    if (this.artifactsSaveTimer) return
    this.artifactsSaveTimer = setTimeout(() => {
      this.artifactsSaveTimer = null
      if (this.artifactsDirty) {
        this.saveArtifacts().catch(() => {})
      }
    }, 5000)
  }
}

export const nexusManager = new NexusManagerService()
