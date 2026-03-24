/**
 * Gene Pool Service — DunCrew 自愈基因库
 * 
 * 捕获工具失败→修复的模式为"基因"，在后续遇到相似错误时
 * 自动注入修复策略到 Reflexion 提示中。
 * 
 * Phase 1: 基因存储/加载/匹配/注入
 * Phase 2: 自动收割 (failure→success 模式检测)
 * Phase 3: 跨 Nexus 基因共享与置信度排名
 * (Phase 4 已迁移至 nexusManager — capability/artifact 不属于基因范畴)
 */

import type { Gene, GeneMatch, Capsule, ExecTraceToolCall } from '@/types'
import { extractSignals, rankGenes, signalOverlap, classifyErrorType } from '@/utils/signalMatcher'
import { nexusRuleEngine } from './nexusRuleEngine'
import { getServerUrl } from '@/utils/env'

const SERVER_URL = getServerUrl()

// localStorage 存储 key
const LS_KEY_GENES = 'duncrew:gene_pool'
const LS_KEY_CAPSULES = 'duncrew:capsules'

// 配置常量
const MAX_GENE_HINTS = 3              // Reflexion 中最多注入的基因数
const MAX_CAPSULE_HISTORY = 100       // 内存中保留的胶囊数
const HARVEST_MIN_CONFIDENCE = 0.3    // 自动收割的初始置信度
const DUPLICATE_OVERLAP_THRESHOLD = 0.85  // 信号重叠超过此阈值视为重复 (从 0.7 提高，让更多不同场景的基因能被创建)
const CONFIDENCE_DECAY = 0.8          // 失败时置信度衰减系数 (默认)
const CONFIDENCE_BOOST = 0.1          // 成功时置信度增量
const CONFIDENCE_CAP = 1.0            // 置信度上限
const RETIRED_THRESHOLD = 0.1         // 低于此置信度且使用次数 > 5 视为废弃
const TIME_DECAY_HALFLIFE_DAYS = 60   // 时间衰减半衰期 (天)
const MAX_REPAIR_GENES = 200            // Repair 基因上限，超过时淘汰低置信度废弃基因

// 优化2: 按错误类型分级的置信度衰减系数
const ERROR_TYPE_DECAY: Record<string, number> = {
  transient: 0.95,       // 网络超时等临时错误 — 基因本身没错，轻微衰减
  missing_resource: 0.7, // 资源缺失 — 基因可能需要调整
  bad_input: 0.6,        // 参数错误 — 基因质量有问题，快速淘汰
  permission: 0.75,      // 权限问题 — 环境相关
  unknown: 0.8,          // 未知错误 — 默认衰减
}

// ============================================
// V2: 内置种子基因 — 解决冷启动问题
// 基于高频错误模式手动沉淀，用户无需任何操作
// ============================================
const SEED_GENES: Omit<Gene, 'metadata'>[] = [
  {
    id: 'seed-readfile-missing-path',
    category: 'repair',
    signals_match: ['readFile', 'readFile:missing_input', 'missing_input', 'empty', 'cannot be empty'],
    strategy: ['readFile 的 path 参数为空。先用 listDir 探索项目目录结构，获取正确的文件路径后再重试。'],
    preconditions: ['当前 session 中还没有成功的 listDir 调用'],
    antiPatterns: ['已经用 listDir 探索过目录但仍然失败 — 此时问题不是路径未知，而是文件确实不存在'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-readfile-not-found',
    category: 'repair',
    signals_match: ['readFile', 'readFile:missing_resource', 'not found', 'enoent', 'no such file'],
    strategy: ['文件路径不存在。用 listDir 确认目标目录的实际内容，检查文件名拼写和大小写是否正确，然后用正确路径重试。'],
    preconditions: ['readFile 返回了文件不存在的错误'],
    antiPatterns: ['错误是权限问题而非路径问题'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-readfile-permission',
    category: 'repair',
    signals_match: ['readFile', 'readFile:permission', 'permission', 'eacces', 'access denied', 'forbidden'],
    strategy: ['文件访问被拒绝。检查路径是否在允许的工作目录内，避免读取系统目录或受保护的文件。尝试读取项目根目录下的文件。'],
    preconditions: ['readFile 返回了权限相关的错误'],
    antiPatterns: ['错误是文件不存在而非权限问题'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-writefile-permission',
    category: 'repair',
    signals_match: ['writeFile', 'writeFile:permission', 'permission', 'eacces', 'access denied'],
    strategy: ['文件写入被拒绝。确保目标路径在项目工作目录内，不要写入系统目录。如果目标目录不存在，先创建目录。'],
    preconditions: ['writeFile 返回了权限错误'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-runcmd-empty',
    category: 'repair',
    signals_match: ['runCmd', 'runCmd:missing_input', 'missing_input', 'empty', 'command cannot be empty'],
    strategy: ['runCmd 的 command 参数为空。确保命令字符串非空且格式正确，包含完整的可执行命令。'],
    preconditions: ['runCmd 因为空命令而失败'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-runcmd-not-found',
    category: 'repair',
    signals_match: ['runCmd', 'runCmd:missing_resource', 'not found', 'is not recognized', 'command not found'],
    strategy: ['命令不存在或未安装。检查命令名拼写，确认该工具已安装。Windows 下注意使用正确的命令名（如 dir 而非 ls，findstr 而非 grep）。'],
    preconditions: ['runCmd 因为命令不存在而失败'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-search-plugin-crash',
    category: 'repair',
    signals_match: ['search_files', 'failed', 'crash', 'exit code', 'plugin exited'],
    strategy: ['search_files 插件崩溃。改用 readFile + listDir 组合手动搜索目标文件，或使用 runCmd 执行 findstr/grep 命令搜索。'],
    preconditions: ['search_files 因为插件崩溃而失败（非参数错误）'],
    antiPatterns: ['search_files 因为参数错误而失败 — 此时应修正参数而非换工具'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-encoding-error',
    category: 'repair',
    signals_match: ['readFile', 'readFile:encoding_error', 'encoding_error', 'codec', 'decode', 'utf-8', 'gbk'],
    strategy: ['文件编码不匹配。尝试指定 encoding 参数为其他编码（如 latin-1 或 gbk）重新读取。Windows 系统下中文文件常用 GBK 编码。'],
    preconditions: ['readFile 返回了编码相关的错误'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-path-separator',
    category: 'repair',
    signals_match: ['readFile', 'writeFile', 'readFile:missing_resource', 'not found', 'enoent'],
    strategy: ['检查文件路径分隔符。Windows 下使用反斜杠 \\ 或正斜杠 / 均可，但避免混用。确保路径中没有多余的斜杠或空格。'],
    preconditions: ['文件路径看起来正确但仍然找不到文件，且运行环境是 Windows'],
    antiPatterns: ['路径明显为空或格式完全错误'],
    source: { createdAt: 0, isSeed: true },
  },
  {
    id: 'seed-transient-retry',
    category: 'repair',
    signals_match: ['transient', 'timeout', 'etimedout', 'econnrefused', 'econnreset', 'fetch failed'],
    strategy: ['网络或连接超时，通常是临时性问题。等待几秒后直接重试相同操作，大概率会成功。'],
    preconditions: ['错误消息包含超时或连接相关的关键词'],
    antiPatterns: ['连续多次超时 — 此时可能是服务端问题，不应无限重试'],
    source: { createdAt: 0, isSeed: true },
  },
]

// ============================================
// V2: Thompson Sampling — 基因选择优化
// 用 Beta 分布采样替代确定性排序，平衡探索与利用
// ============================================

/**
 * 从 Beta(alpha, beta) 分布近似采样
 * 使用均值 + 正态扰动近似，无需引入额外依赖
 */
function betaSample(alpha: number, beta: number): number {
  const mean = alpha / (alpha + beta)
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1))
  const std = Math.sqrt(variance)
  // Box-Muller 变换生成正态随机数，clamp 到 [0,1]
  const u1 = Math.random()
  const u2 = Math.random()
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return Math.max(0, Math.min(1, mean + std * normal))
}

/**
 * Thompson Sampling 选择：对匹配基因做一次采样排序，取前 N
 * 采样值 = Beta采样(successCount+1, failureCount+1) × 信号匹配分
 */
function thompsonSelect(matches: GeneMatch[], count: number): GeneMatch[] {
  if (matches.length <= count) return matches

  const scored = matches.map(m => ({
    match: m,
    sample: betaSample(
      m.gene.metadata.successCount + 1,
      (m.gene.metadata.useCount - m.gene.metadata.successCount) + 1
    ) * m.score
  }))
  scored.sort((a, b) => b.sample - a.sample)
  return scored.slice(0, count).map(s => s.match)
}

class GenePoolService {
  private genes: Gene[] = []
  private capsules: Capsule[] = []
  private loaded = false
  private loading: Promise<void> | null = null
  private capsuleDirty = false
  private capsuleFlushTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 确保基因库已加载 (幂等，懒加载)
   */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    if (this.loading) return this.loading

    this.loading = this.loadAll()
    try {
      await this.loading
      this.loaded = true
    } catch (err) {
      console.warn('[GenePool] Failed to load genes, starting with empty pool:', err)
      this.genes = []
      this.loaded = true
    } finally {
      this.loading = null
    }

    // V2: 注入种子基因（仅当 repair 基因不足时）
    this.injectSeedGenes()
  }

  /**
   * V2: 注入内置种子基因
   * 仅当 repair 基因数量 < 5 时注入，避免与用户积累的基因冲突
   * 种子基因不会覆盖已有的同 ID 基因
   */
  private injectSeedGenes(): void {
    const repairCount = this.genes.filter(g => g.category === 'repair').length
    if (repairCount >= 5) return

    let injected = 0
    for (const seed of SEED_GENES) {
      if (this.genes.some(g => g.id === seed.id)) continue

      const gene: Gene = {
        ...seed,
        metadata: {
          confidence: 0.75,
          useCount: 0,
          successCount: 0,
        },
      }
      this.genes.push(gene)
      this.saveGene(gene).catch(() => {})
      injected++
    }

    if (injected > 0) {
      console.log(`[GenePool] Injected ${injected} seed genes (repair pool had ${repairCount} genes)`)
    }
  }

  /**
   * 从后端加载全部基因 + 胶囊
   */
  private async loadAll(): Promise<void> {
    await Promise.all([this.loadGenes(), this.loadCapsules()])
  }

  /**
   * 从后端加载全部基因
   * 优先后端 API，失败时从 localStorage 兜底
   * 后端非空 + localStorage 非空时按 gene.id 去重合并
   */
  private async loadGenes(): Promise<void> {
    let backendGenes: Gene[] | null = null

    // 1. 尝试从后端加载
    try {
      const res = await fetch(`${SERVER_URL}/api/genes/load`)
      if (res.ok) {
        const data = await res.json()
        const all = Array.isArray(data) ? data : []
        backendGenes = all.filter((g: Gene) => g.category === 'repair')
        const skipped = all.length - backendGenes.length
        console.log(`[GenePool] Loaded ${backendGenes.length} repair genes from backend${skipped > 0 ? ` (skipped ${skipped} non-repair)` : ''}`)
      }
    } catch {
      console.warn('[GenePool] Backend unavailable, falling back to localStorage')
    }

    // 2. 从 localStorage 读取缓存
    const localGenes = this.loadGenesFromLocalStorage()

    // 3. 合并策略
    if (backendGenes !== null && backendGenes.length > 0) {
      // 后端有数据: 以后端为主，合并 localStorage 中后端不存在的基因
      if (localGenes.length > 0) {
        const backendIds = new Set(backendGenes.map(g => g.id))
        const localOnly = localGenes.filter(g => !backendIds.has(g.id))
        if (localOnly.length > 0) {
          backendGenes.push(...localOnly)
          console.log(`[GenePool] Merged ${localOnly.length} offline genes from localStorage`)
          for (const gene of localOnly) {
            this.saveGeneToBackend(gene).catch(() => {})
          }
        }
      }
      this.genes = backendGenes
    } else if (backendGenes !== null && backendGenes.length === 0 && localGenes.length > 0) {
      // 后端返回空但 localStorage 有数据: 用 localStorage，回写后端
      this.genes = localGenes
      console.log(`[GenePool] Restored ${localGenes.length} genes from localStorage to empty backend`)
      for (const gene of localGenes) {
        this.saveGeneToBackend(gene).catch(() => {})
      }
    } else if (backendGenes === null && localGenes.length > 0) {
      // 后端不可用: 用 localStorage 兜底
      this.genes = localGenes
      console.log(`[GenePool] Loaded ${localGenes.length} repair genes from localStorage (offline)`)
    } else {
      this.genes = []
    }

    // 4. 同步快照到 localStorage
    this.syncGenesToLocalStorage()
  }

  /** 从 localStorage 读取基因缓存 */
  private loadGenesFromLocalStorage(): Gene[] {
    try {
      const raw = localStorage.getItem(LS_KEY_GENES)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((g: Gene) => g.id && g.category === 'repair') : []
    } catch {
      return []
    }
  }

  /** 将当前 this.genes 整体写入 localStorage 作为镜像快照 */
  private syncGenesToLocalStorage(): void {
    try {
      localStorage.setItem(LS_KEY_GENES, JSON.stringify(this.genes))
    } catch {
      // localStorage 满或不可用，静默忽略
    }
  }

  /**
   * 从后端加载胶囊历史
   * 优先后端 API，失败时从 localStorage 兜底
   */
  private async loadCapsules(): Promise<void> {
    let loaded = false
    try {
      const res = await fetch(`${SERVER_URL}/api/capsules/load`)
      if (res.ok) {
        const data = await res.json()
        this.capsules = Array.isArray(data) ? data : []
        loaded = true
        console.log(`[GenePool] Loaded ${this.capsules.length} capsules from backend`)
      }
    } catch {
      // 后端不可用
    }

    if (!loaded) {
      // 从 localStorage 兜底
      try {
        const raw = localStorage.getItem(LS_KEY_CAPSULES)
        if (raw) {
          const parsed = JSON.parse(raw)
          this.capsules = Array.isArray(parsed) ? parsed : []
          console.log(`[GenePool] Loaded ${this.capsules.length} capsules from localStorage (offline)`)
        }
      } catch {
        this.capsules = []
      }
    }

    // 保留上限
    if (this.capsules.length > MAX_CAPSULE_HISTORY) {
      this.capsules = this.capsules.slice(-MAX_CAPSULE_HISTORY)
    }

    // 同步到 localStorage
    this.syncCapsulesToLocalStorage()
  }

  /**
   * 批量保存胶囊到后端 (防抖: 5秒内多次写入只执行一次)
   */
  private scheduleCapsuleFlush(): void {
    this.capsuleDirty = true
    if (this.capsuleFlushTimer) return
    this.capsuleFlushTimer = setTimeout(() => {
      this.capsuleFlushTimer = null
      if (this.capsuleDirty) {
        this.flushCapsules()
      }
    }, 5000)
  }

  private async flushCapsules(): Promise<void> {
    this.capsuleDirty = false
    // 无论后端是否可用，都同步 localStorage
    this.syncCapsulesToLocalStorage()
    try {
      const res = await fetch(`${SERVER_URL}/api/capsules/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.capsules),
      })
      if (res.ok) {
        console.log(`[GenePool] Flushed ${this.capsules.length} capsules to backend`)
      }
    } catch (err) {
      console.warn('[GenePool] Failed to flush capsules to backend (localStorage fallback active):', err)
      this.capsuleDirty = true // 标记重试
    }
  }

  /** 将当前 this.capsules 写入 localStorage 作为镜像快照 */
  private syncCapsulesToLocalStorage(): void {
    try {
      localStorage.setItem(LS_KEY_CAPSULES, JSON.stringify(this.capsules))
    } catch {
      // localStorage 满或不可用，静默忽略
    }
  }

  /**
   * 保存单个基因到后端 + 同步 localStorage 快照
   * 无论后端成功或失败，都更新 localStorage 镜像
   */
  private async saveGene(gene: Gene): Promise<void> {
    this.saveGeneToBackend(gene).catch(() => {})
    // 无论后端是否可用，都同步 localStorage 快照
    this.syncGenesToLocalStorage()
  }

  /** 仅写后端，不触发 localStorage 同步 (供 loadGenes 合并回写时使用) */
  private async saveGeneToBackend(gene: Gene): Promise<void> {
    try {
      const res = await fetch(`${SERVER_URL}/api/genes/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gene),
      })
      if (res.ok) {
        console.log(`[GenePool] Gene saved to backend: ${gene.id} (${gene.signals_match.length} signals)`)
      }
    } catch (err) {
      console.warn('[GenePool] Backend save failed (localStorage fallback active):', err)
    }
  }

  // ============================================
  // Phase 1: 基因匹配与 Reflexion 注入
  // ============================================

  /**
   * 查找与当前错误匹配的基因 (Phase 1 核心)
   * 仅匹配 repair 类基因，避免 activity/capability 污染
   */
  findMatchingGenes(toolName: string, errorMsg: string): GeneMatch[] {
    if (this.genes.length === 0) return []

    const repairGenes = this.genes.filter(g => g.category === 'repair')
    if (repairGenes.length === 0) return []

    const signals = extractSignals(toolName, errorMsg)
    const matches = rankGenes(signals, repairGenes)

    // V2: Thompson Sampling 替代确定性 top-N，平衡探索与利用
    return thompsonSelect(matches, MAX_GENE_HINTS)
  }

  /**
   * Phase 3: 跨 Nexus 基因共享 — 带加权的匹配 (含时间衰减)
   * 仅匹配 repair 类基因，避免 activity/capability 污染
   */
  findCrossNexusGenes(toolName: string, errorMsg: string, currentNexusId?: string): GeneMatch[] {
    if (this.genes.length === 0) return []

    const repairGenes = this.genes.filter(g => g.category === 'repair')
    if (repairGenes.length === 0) return []

    const signals = extractSignals(toolName, errorMsg)
    const matches = rankGenes(signals, repairGenes)

    // Phase 3 加权 + 优化2 时间衰减
    for (const match of matches) {
      let weight = 1.0

      // 同 Nexus 产生的基因: 更可信
      if (currentNexusId && match.gene.source.nexusId === currentNexusId) {
        weight *= 1.5
      } else if (match.gene.signals_match.some(s => s.toLowerCase() === toolName.toLowerCase())) {
        // 不同 Nexus 但匹配同工具名: 中等可信
        weight *= 1.2
      }

      // 高置信度基因加权
      if (match.gene.metadata.confidence > 0.7) {
        weight *= 1.3
      }

      // 经过验证的基因 (使用次数 > 3) 微加权
      if (match.gene.metadata.useCount > 3) {
        weight *= 1.1
      }

      // 优化2: 时间衰减 — 老基因权重降低
      weight *= this.timeDecayFactor(match.gene.source.createdAt)

      match.score *= weight
    }

    // 重新排序
    matches.sort((a, b) => b.score - a.score)

    // V2: Thompson Sampling 替代确定性 top-N
    return thompsonSelect(matches, MAX_GENE_HINTS)
  }

  /**
   * V2: 将匹配基因格式化为 Reflexion 注入的提示文本
   * 只注入修复动作，不注入原始错误数据（Agent 已经知道错误了）
   * 加入反模式提示，避免误用
   */
  buildGeneHint(matches: GeneMatch[]): string {
    if (matches.length === 0) return ''

    const hints = matches.map((m, i) => {
      const confidence = Math.round(m.gene.metadata.confidence * 100)
      // V2: 只输出策略核心内容，不输出 "Error encountered:" 等冗余信息
      const strategyText = m.gene.strategy
        .filter(s => !s.startsWith('Error encountered:') && !s.startsWith('Recovery result:'))
        .join('; ')

      let hint = `${i + 1}. [${confidence}%] ${strategyText}`

      // V2: 如果有反模式，附加警告
      if (m.gene.antiPatterns && m.gene.antiPatterns.length > 0) {
        hint += `\n   ⚠ 不适用于: ${m.gene.antiPatterns[0]}`
      }

      return hint
    })

    return `\n[Gene Pool] 历史修复经验:\n${hints.join('\n')}\n根据当前情况判断是否适用。`
  }

  /**
   * 记录基因使用结果 (Capsule)，并更新基因元数据
   */
  recordCapsule(geneId: string, trigger: string[], outcome: 'success' | 'failure', nexusId?: string): void {
    // 记录胶囊
    const capsule: Capsule = {
      id: `capsule-${Date.now()}`,
      geneId,
      trigger,
      outcome,
      nexusId,
      timestamp: Date.now(),
    }
    this.capsules.push(capsule)
    if (this.capsules.length > MAX_CAPSULE_HISTORY) {
      this.capsules.shift()
    }

    // 持久化胶囊 (防抖批量写入)
    this.scheduleCapsuleFlush()

    // 更新基因元数据
    const gene = this.genes.find(g => g.id === geneId)
    if (gene) {
      gene.metadata.useCount++
      gene.metadata.lastUsedAt = Date.now()

      if (outcome === 'success') {
        gene.metadata.successCount++
        gene.metadata.confidence = Math.min(CONFIDENCE_CAP, gene.metadata.confidence + CONFIDENCE_BOOST)

        // 优化1: Gene → Rule 反馈信号
        // 基因成功使用 → 通知规则引擎降级相关错误规则
        const toolSignal = gene.signals_match.find(s => !s.includes(' ') && s.length < 30)
        if (toolSignal && nexusId) {
          nexusRuleEngine.deactivateRelatedRules(nexusId, toolSignal)
        }
      } else {
        // 优化2: 按错误类型分级衰减
        const errorContext = trigger.join(' ')
        const errorType = this.classifyError(errorContext)
        const decay = ERROR_TYPE_DECAY[errorType] ?? CONFIDENCE_DECAY
        gene.metadata.confidence *= decay
      }

      // 持久化更新后的基因
      this.saveGene(gene).catch(() => {})
    }
  }

  /**
   * 优化2: 按错误类型分级衰减 — 委托给 signalMatcher 的统一分类器
   */
  private classifyError(errorMsg: string): string {
    return classifyErrorType(errorMsg)
  }

  /**
   * 优化2: 时间衰减因子
   * 越老的基因权重越低，半衰期 = TIME_DECAY_HALFLIFE_DAYS
   */
  private timeDecayFactor(createdAt: number): number {
    const daysOld = (Date.now() - createdAt) / (1000 * 60 * 60 * 24)
    return Math.exp(-daysOld * Math.LN2 / TIME_DECAY_HALFLIFE_DAYS)
  }

  // ============================================
  // Phase 2: 自动基因收割
  // ============================================

  /**
   * 从执行追踪中自动收割基因
   * 检测 error → ... → success 模式 (同一工具名)
   */
  harvestGene(traceTools: ExecTraceToolCall[], _userPrompt: string, nexusId?: string): void {
    if (traceTools.length < 2) return

    // 按 order 排序
    const sorted = [...traceTools].sort((a, b) => a.order - b.order)

    // 查找 error → success 配对 (同一工具名)
    const harvested: Gene[] = []

    for (let i = 0; i < sorted.length; i++) {
      const failedTool = sorted[i]
      if (failedTool.status !== 'error') continue

      // V2: 过滤插件崩溃类错误，不收割无意义基因
      const errorMsg = failedTool.result || ''
      if (/plugin exited|exit code|3221225794|segfault|stack overflow/i.test(errorMsg)) {
        continue
      }

      // 在后续调用中找同名成功调用
      for (let j = i + 1; j < sorted.length; j++) {
        const recoveryTool = sorted[j]
        if (recoveryTool.name !== failedTool.name) continue
        if (recoveryTool.status !== 'success') continue

        // 找到 error→success 配对
        const signals = extractSignals(failedTool.name, errorMsg)

        // 检查重复: 与已有 repair 基因的信号重叠度
        const isDuplicate = this.genes.filter(g => g.category === 'repair').some(existing => {
          const overlap = signalOverlap(signals, existing.signals_match)
          if (overlap >= DUPLICATE_OVERLAP_THRESHOLD) {
            // 已有类似基因 → 增加其置信度
            existing.metadata.confidence = Math.min(
              CONFIDENCE_CAP,
              existing.metadata.confidence + 0.05
            )
            this.saveGene(existing).catch(() => {})
            return true
          }
          return false
        })

        if (isDuplicate) break

        // 构建修复策略: 对比失败和成功的参数差异
        const strategy = this.buildStrategyFromDiff(failedTool, recoveryTool, sorted.slice(i + 1, j))

        if (strategy.length === 0) break

        // V2: 自动生成前置条件
        const errorType = classifyErrorType(failedTool.result || '')
        const preconditions = [`${failedTool.name} 返回了 ${errorType} 类型的错误`]

        const gene: Gene = {
          id: `gene-${Date.now()}-${harvested.length}`,
          category: 'repair',
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
        }

        harvested.push(gene)
        break // 每个失败工具只配对第一个成功恢复
      }
    }

    // 保存收割的基因
    for (const gene of harvested) {
      this.genes.push(gene)
      this.saveGene(gene).catch(() => {})
      console.log(`[GenePool] Harvested gene: ${gene.id} from ${gene.signals_match[0]} error`)
    }

    // Repair 基因数量控制：超过上限时淘汰最低置信度的废弃基因
    if (harvested.length > 0) {
      this.pruneRetiredGenes()
    }
  }

  /**
   * 淘汰废弃的 repair 基因，防止无限增长
   * 当 repair 基因数量超过 MAX_REPAIR_GENES 时，按有效置信度排序淘汰最低分的
   */
  private pruneRetiredGenes(): void {
    const repairGenes = this.genes.filter(g => g.category === 'repair')
    if (repairGenes.length <= MAX_REPAIR_GENES) return

    // 按有效置信度排序 (考虑时间衰减)
    const scored = repairGenes.map(g => ({
      gene: g,
      effectiveConfidence: g.metadata.confidence * this.timeDecayFactor(g.source.createdAt),
    }))
    scored.sort((a, b) => a.effectiveConfidence - b.effectiveConfidence)

    // 淘汰最低分的基因，直到回到上限
    const toRemove = scored.slice(0, repairGenes.length - MAX_REPAIR_GENES)
    for (const { gene } of toRemove) {
      const index = this.genes.indexOf(gene)
      if (index >= 0) {
        this.genes.splice(index, 1)
        console.log(`[GenePool] Pruned retired gene: ${gene.id} (confidence: ${gene.metadata.confidence.toFixed(2)})`)
      }
    }
  }

  /**
   * V2: 从失败/成功工具调用对比中生成抽象修复策略
   * 不记录具体参数值，而是记录参数变化的模式和修复路径
   */
  private buildStrategyFromDiff(
    failed: ExecTraceToolCall,
    success: ExecTraceToolCall,
    intermediate: ExecTraceToolCall[]
  ): string[] {
    const strategy: string[] = []
    const failedArgs = failed.args || {}
    const successArgs = success.args || {}

    // 1. 分析参数变化模式（抽象化，不记录具体值）
    const paramPatterns: string[] = []
    for (const key of Object.keys(successArgs)) {
      const failedVal = failedArgs[key]
      const successVal = successArgs[key]
      const failedStr = JSON.stringify(failedVal ?? '')
      const successStr = JSON.stringify(successVal)

      if (failedStr === successStr) continue

      // 判断变化模式
      if (!failedVal || failedStr === '""' || failedStr === 'null') {
        paramPatterns.push(`参数 "${key}" 从空值变为有效值 — 需要先获取正确的 ${key}`)
      } else if (typeof failedVal === 'string' && typeof successVal === 'string') {
        if (failedVal.includes('/') || failedVal.includes('\\') || successVal.includes('/') || successVal.includes('\\')) {
          paramPatterns.push(`参数 "${key}" 的路径被修正 — 先确认正确路径再重试`)
        } else {
          paramPatterns.push(`参数 "${key}" 的值被修正 — 检查参数格式和内容是否正确`)
        }
      } else {
        paramPatterns.push(`参数 "${key}" 被修改 — 检查参数类型和格式`)
      }
    }

    // 2. 生成修复策略（一句话总结）
    const errorType = classifyErrorType(failed.result || '')
    const toolName = failed.name

    // 构建核心修复建议
    if (paramPatterns.length > 0) {
      strategy.push(`${toolName} 失败（${errorType}）: ${paramPatterns.join('；')}`)
    }

    // 3. 记录修复路径（中间使用的工具及其作用）
    if (intermediate.length > 0) {
      const successfulIntermediates = intermediate.filter(t => t.status === 'success' && t.name !== failed.name)
      const uniqueTools = [...new Set(successfulIntermediates.map(t => t.name))]
      if (uniqueTools.length > 0) {
        strategy.push(`修复路径: 先用 ${uniqueTools.join(' → ')} 获取信息，然后用正确参数重试 ${toolName}`)
      }
    }

    // 4. 如果没有发现参数差异，生成基于错误类型的通用策略
    if (strategy.length === 0) {
      const errorTypeStrategies: Record<string, string> = {
        missing_resource: `${toolName} 找不到目标资源，先用 listDir 确认路径存在`,
        missing_input: `${toolName} 缺少必要参数，确保所有必填参数非空`,
        permission: `${toolName} 权限被拒绝，检查路径是否在允许的工作目录内`,
        bad_input: `${toolName} 参数格式错误，检查参数类型和格式`,
        parse_error: `${toolName} 解析错误，检查输入数据的格式是否正确`,
        encoding_error: `${toolName} 编码错误，尝试指定其他编码格式`,
        transient: `${toolName} 临时性错误，直接重试大概率成功`,
        unknown: `${toolName} 失败后重新尝试成功，可能是临时性错误`,
      }
      strategy.push(errorTypeStrategies[errorType] || errorTypeStrategies.unknown)
    }

    return strategy
  }

  /**
   * 优化1: Manager → Gene Pool 反馈信号
   * 当 Nexus Manager 检测到某工具错误率飙升时，提升相关修复基因的权重
   * 让 Gene Pool 在后续匹配时更容易推荐这些基因
   */
  boostGenesForTool(toolName: string, errorRate: number): void {
    const toolLower = toolName.toLowerCase()
    let boosted = 0
    for (const gene of this.genes) {
      if (gene.category !== 'repair') continue
      // 只提升包含该工具信号的修复基因
      if (gene.signals_match.some(s => s.toLowerCase().includes(toolLower))) {
        const boostAmount = Math.min(0.1, errorRate * 0.1)
        gene.metadata.confidence = Math.min(CONFIDENCE_CAP, gene.metadata.confidence + boostAmount)
        boosted++
      }
    }
    if (boosted > 0) {
      console.log(`[GenePool] Boosted ${boosted} repair genes for high-error tool: ${toolName} (errorRate: ${Math.round(errorRate * 100)}%)`)
    }
  }

  // ============================================
  // 诊断接口
  // ============================================

  /** 当前基因数量 */
  get geneCount(): number {
    return this.genes.length
  }

  /** 获取所有活跃基因 (排除废弃的，含时间衰减) */
  getActiveGenes(): Gene[] {
    return this.genes.filter(g => {
      // 排除已废弃的
      if (g.metadata.confidence < RETIRED_THRESHOLD && g.metadata.useCount > 5) return false
      // 优化2: 考虑时间衰减后的有效置信度
      const effectiveConfidence = g.metadata.confidence * this.timeDecayFactor(g.source.createdAt)
      return effectiveConfidence >= RETIRED_THRESHOLD
    })
  }

  // ============================================
  // Phase 4: [已迁移至 nexusManager]
  // Nexus 通讯能力 (capability/artifact) 不再属于基因池
  // ============================================
}

// 单例导出
export const genePoolService = new GenePoolService()
