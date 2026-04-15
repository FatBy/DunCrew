/**
 * BaseLedgerService — 碱基 Ledger 一等公民服务
 *
 * 将碱基序列从 ReAct 循环的局部变量提升为独立服务：
 * - Ledger CRUD + 15 维特征实时更新
 * - 里程碑（Milestone）事件管理
 * - 累积事实（Facts）管理（纯规则提取，不调用 LLM）
 * - 快照/合并（为 Phase 2 多 Agent 准备）
 *
 * 生物学类比：碱基 Ledger = DNA 行为账本
 */

import type {
  BaseSequenceEntry,
  BaseLedger,
  LedgerMilestone,
  LedgerMilestoneType,
  ExecTraceToolCall,
} from '@/types'
import { extractFeaturesV2 } from './featureRegistry'

// ============================================
// 常量
// ============================================

/** Ledger 池最大容量（LRU 淘汰） */
const MAX_ACTIVE_LEDGERS = 10
/** Facts.completedActions 滚动窗口大小 */
const MAX_COMPLETED_ACTIONS = 20
/** Facts.discoveredResources 最大数量 */
const MAX_DISCOVERED_RESOURCES = 50
/** Facts.failedApproaches 最大数量 */
const MAX_FAILED_APPROACHES = 20

// ============================================
// Facts 规则提取器
// ============================================

/** 从工具调用结果中提取资源路径 */
function extractResources(tool: ExecTraceToolCall): string[] {
  const resources: string[] = []
  if (tool.status !== 'success') return resources

  // 文件操作 → 文件路径
  if (['writeFile', 'appendFile', 'readFile', 'deleteFile'].includes(tool.name)) {
    const path = tool.args?.filePath || tool.args?.path
    if (typeof path === 'string') resources.push(path)
  }

  // 目录列表 → 目录路径
  if (tool.name === 'listDir') {
    const path = tool.args?.path || tool.args?.dirPath
    if (typeof path === 'string') resources.push(path)
  }

  // Web 操作 → URL
  if (['webSearch', 'webFetch'].includes(tool.name)) {
    const url = tool.args?.url || tool.args?.query
    if (typeof url === 'string') resources.push(url)
  }

  return resources
}

/** 从工具调用结果中提取操作摘要 */
function extractActionSummary(tool: ExecTraceToolCall): string | null {
  if (tool.status !== 'success') return null

  const name = tool.name
  if (name === 'writeFile' || name === 'appendFile') {
    const path = tool.args?.filePath || tool.args?.path || '?'
    return `${name}(${String(path).slice(0, 60)})`
  }
  if (name === 'runCmd') {
    const cmd = tool.args?.command || '?'
    return `runCmd(${String(cmd).slice(0, 60)})`
  }
  if (name === 'deleteFile' || name === 'renameFile') {
    const path = tool.args?.filePath || tool.args?.path || '?'
    return `${name}(${String(path).slice(0, 60)})`
  }
  // 读取类操作不记录为 completedAction
  return null
}

/** 从失败的工具调用中提取失败摘要 */
function extractFailureSummary(tool: ExecTraceToolCall): string | null {
  if (tool.status !== 'error') return null
  const name = tool.name
  const resultSnippet = tool.result ? tool.result.slice(0, 100).replace(/\n/g, ' ') : 'unknown error'
  return `${name} failed: ${resultSnippet}`
}

// ============================================
// BaseLedgerService
// ============================================

class BaseLedgerService {
  /** 活跃 Ledger 池 */
  private ledgers = new Map<string, BaseLedger>()
  /** LRU 访问顺序 */
  private accessOrder: string[] = []

  // ═══ CRUD ═══

  /** 创建新 Ledger */
  createLedger(runId: string, dunId: string, parentRunId?: string): BaseLedger {
    // LRU 淘汰
    if (this.ledgers.size >= MAX_ACTIVE_LEDGERS) {
      const oldest = this.accessOrder.shift()
      if (oldest) this.ledgers.delete(oldest)
    }

    const ledger: BaseLedger = {
      runId,
      parentRunId,
      dunId,
      entries: [],
      features: {},
      milestones: [],
      facts: {
        completedActions: [],
        discoveredResources: [],
        failedApproaches: [],
        currentObjective: '',
        subObjectives: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.ledgers.set(runId, ledger)
    this.touchAccess(runId)
    return ledger
  }

  /** 追加碱基条目（同时更新 15 维特征快照） */
  appendEntry(runId: string, entry: BaseSequenceEntry): void {
    const ledger = this.ledgers.get(runId)
    if (!ledger) return

    // 设置 ledgerIndex
    entry.ledgerIndex = ledger.entries.length
    ledger.entries.push(entry)

    // 实时更新特征（O(n)，n 通常 <25）
    ledger.features = extractFeaturesV2(ledger.entries)
    ledger.updatedAt = Date.now()
    this.touchAccess(runId)
  }

  /** 记录里程碑事件 */
  addMilestone(
    runId: string,
    type: LedgerMilestoneType,
    baseIndex: number,
    metadata: Record<string, unknown> = {},
  ): void {
    const ledger = this.ledgers.get(runId)
    if (!ledger) return

    const milestone: LedgerMilestone = {
      type,
      baseIndex,
      timestamp: Date.now(),
      metadata,
    }
    ledger.milestones.push(milestone)
    ledger.updatedAt = Date.now()
  }

  /**
   * 从最近的工具调用批次中增量更新 Facts
   *
   * 纯规则提取，不调用 LLM。建议每 5 轮调用一次。
   */
  updateFactsFromTools(runId: string, recentTools: ExecTraceToolCall[]): void {
    const ledger = this.ledgers.get(runId)
    if (!ledger) return

    for (const tool of recentTools) {
      // 提取已完成操作
      const action = extractActionSummary(tool)
      if (action) {
        ledger.facts.completedActions.push(action)
        if (ledger.facts.completedActions.length > MAX_COMPLETED_ACTIONS) {
          ledger.facts.completedActions = ledger.facts.completedActions.slice(-MAX_COMPLETED_ACTIONS)
        }
      }

      // 提取发现的资源
      const resources = extractResources(tool)
      for (const r of resources) {
        if (!ledger.facts.discoveredResources.includes(r)) {
          ledger.facts.discoveredResources.push(r)
          if (ledger.facts.discoveredResources.length > MAX_DISCOVERED_RESOURCES) {
            ledger.facts.discoveredResources.shift()
          }
        }
      }

      // 提取失败尝试
      const failure = extractFailureSummary(tool)
      if (failure) {
        ledger.facts.failedApproaches.push(failure)
        if (ledger.facts.failedApproaches.length > MAX_FAILED_APPROACHES) {
          ledger.facts.failedApproaches = ledger.facts.failedApproaches.slice(-MAX_FAILED_APPROACHES)
        }
      }
    }

    ledger.updatedAt = Date.now()
  }

  /** 设置当前目标 */
  setObjective(runId: string, objective: string): void {
    const ledger = this.ledgers.get(runId)
    if (!ledger) return
    ledger.facts.currentObjective = objective
    ledger.updatedAt = Date.now()
  }

  /** 深拷贝快照（用于 Context Refresh / 子 Agent 上下文传递） */
  snapshot(runId: string): BaseLedger | undefined {
    const ledger = this.ledgers.get(runId)
    if (!ledger) return undefined
    return JSON.parse(JSON.stringify(ledger)) as BaseLedger
  }

  /** 获取 Ledger（引用，非拷贝） */
  getLedger(runId: string): BaseLedger | undefined {
    this.touchAccess(runId)
    return this.ledgers.get(runId)
  }

  /**
   * 合并子 Agent Ledger 到父 Ledger
   *
   * 子碱基序列标记为 childRunId，按时间戳排序插入。
   * Phase 2 使用，Phase 1 预留接口。
   */
  mergeLedger(parentRunId: string, childLedger: BaseLedger): void {
    const parent = this.ledgers.get(parentRunId)
    if (!parent) return

    // 标记子碱基
    const childEntries = childLedger.entries.map(e => ({
      ...e,
      childRunId: childLedger.runId,
    }))

    // 追加到父序列末尾（保持时间顺序）
    parent.entries.push(...childEntries)

    // 合并 facts（增量合并）
    for (const action of childLedger.facts.completedActions) {
      parent.facts.completedActions.push(action)
    }
    if (parent.facts.completedActions.length > MAX_COMPLETED_ACTIONS) {
      parent.facts.completedActions = parent.facts.completedActions.slice(-MAX_COMPLETED_ACTIONS)
    }

    for (const r of childLedger.facts.discoveredResources) {
      if (!parent.facts.discoveredResources.includes(r)) {
        parent.facts.discoveredResources.push(r)
      }
    }

    for (const f of childLedger.facts.failedApproaches) {
      parent.facts.failedApproaches.push(f)
    }
    if (parent.facts.failedApproaches.length > MAX_FAILED_APPROACHES) {
      parent.facts.failedApproaches = parent.facts.failedApproaches.slice(-MAX_FAILED_APPROACHES)
    }

    // 添加合并里程碑
    this.addMilestone(parentRunId, 'child_complete', parent.entries.length - 1, {
      childRunId: childLedger.runId,
      childEntriesCount: childEntries.length,
    })

    // 重新计算特征
    parent.features = extractFeaturesV2(parent.entries)
    parent.updatedAt = Date.now()
  }

  /** 释放 Ledger */
  dispose(runId: string): void {
    this.ledgers.delete(runId)
    this.accessOrder = this.accessOrder.filter(id => id !== runId)
  }

  /** 清理所有 Ledger */
  disposeAll(): void {
    this.ledgers.clear()
    this.accessOrder = []
  }

  // ═══ 内部方法 ═══

  private touchAccess(runId: string): void {
    this.accessOrder = this.accessOrder.filter(id => id !== runId)
    this.accessOrder.push(runId)
  }
}

// 导出单例
export const baseLedgerService = new BaseLedgerService()
