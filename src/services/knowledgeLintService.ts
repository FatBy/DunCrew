/**
 * knowledgeLintService.ts - Wiki 知识库定期维护
 *
 * 每 20 次 ingest 或启动时自动审查知识库：
 * - 检测重叠页面 → 合并
 * - 检测过期页面 → 归档
 * - 检测矛盾摘要 → 标记警告
 */

import { chatBackground, isLLMConfigured } from './llmService'
import { knowledgeIngestService } from './knowledgeIngestService'
import { parseIndex, serializeIndex } from './knowledgeCompiler'
import { getServerUrl } from '@/utils/env'

// ============================================
// LINT_PROMPT
// ============================================

const LINT_PROMPT = [
  '你是知识库审计员。审查以下 wiki 索引，识别需要维护的问题。',
  '',
  '## 输入',
  '完整的 _index.md 内容，每行格式：filename | 摘要 | 最后使用日期',
  '',
  '## 输出',
  '严格输出 JSON 数组（不要用 markdown 代码块包裹）：',
  '',
  '可用 action：',
  '- {"op":"merge","source":"a.md","target":"b.md","reason":"内容主题高度重叠"}',
  '- {"op":"archive","page":"old.md","reason":"30天以上未使用且内容过时"}',
  '- {"op":"flag","pages":["a.md","b.md"],"description":"摘要之间存在矛盾"}',
  '',
  '如果没有问题，输出空数组：[]',
  '',
  '## 规则',
  '- 最多输出 5 个 action',
  '- merge：仅当两个页面的主题有 80%+ 重叠时才建议',
  '- archive：仅当页面 30+ 天未使用时才建议',
  '- flag：仅当两个页面的摘要描述明确矛盾时才标记',
  '- 保守判断：不确定时不操作',
].join('\n')

// ============================================
// Types
// ============================================

interface LintAction {
  op: 'merge' | 'archive' | 'flag'
  source?: string
  target?: string
  page?: string
  pages?: string[]
  reason?: string
  description?: string
}

// ============================================
// KnowledgeLintService
// ============================================

class KnowledgeLintService {
  private serverUrl = getServerUrl()
  private linting = false

  constructor() {
    // 注册 lint 回调到 ingest service
    knowledgeIngestService.onLintThresholdReached = () => {
      this.runLintAll().catch(err =>
        console.warn('[KnowledgeLint] Auto lint failed:', err)
      )
    }
  }

  /** 启动时检查是否需要 lint */
  checkOnStartup(): void {
    const count = knowledgeIngestService.getGlobalIngestCount()
    if (count >= 20) {
      console.log(`[KnowledgeLint] Startup: ${count} ingests since last lint, triggering`)
      this.runLintAll().catch(err =>
        console.warn('[KnowledgeLint] Startup lint failed:', err)
      )
    }
  }

  /** 对所有知识目录运行 lint */
  async runLintAll(): Promise<void> {
    if (this.linting || !isLLMConfigured()) return
    this.linting = true

    try {
      // Lint 全局知识
      await this.lintDirectory('global')

      // Lint 各 Dun 知识（通过 compilable-duns API 获取 Dun 列表）
      try {
        const res = await fetch(`${this.serverUrl}/api/memory/compilable-duns`)
        if (res.ok) {
          const duns: Array<{ dunId: string; hasKnowledge: boolean }> = await res.json()
          for (const dun of duns.filter(d => d.hasKnowledge)) {
            await this.lintDirectory('dun', dun.dunId)
          }
        }
      } catch { /* 静默 */ }

      // 重置计数
      knowledgeIngestService.resetGlobalIngestCount()
      console.log('[KnowledgeLint] Lint completed')
    } finally {
      this.linting = false
    }
  }

  /** 对单个知识目录运行 lint */
  private async lintDirectory(scope: 'global' | 'dun', dunId?: string): Promise<void> {
    const label = scope === 'global' ? 'global' : `Dun ${dunId}`

    // 1. 读取 _index.md
    const indexContent = scope === 'global'
      ? await this.readGlobalFile('_index.md')
      : await this.readDunFile(dunId!, '_index.md')

    if (!indexContent) return

    const entries = parseIndex(indexContent)
    if (entries.length < 2) return // 少于 2 页无需 lint

    // 2. 调用 LLM
    const messages = [
      { role: 'system' as const, content: LINT_PROMPT },
      { role: 'user' as const, content: `今天日期：${new Date().toISOString().slice(0, 10)}\n\n${indexContent}` },
    ]

    let result: string | null = null
    try {
      result = await chatBackground(messages, { priority: 9 })
    } catch {
      return
    }

    if (!result) return

    // 3. 解析 actions
    const actions = this.parseLintActions(result)
    if (actions.length === 0) {
      console.log(`[KnowledgeLint] ${label}: no issues found`)
      return
    }

    console.log(`[KnowledgeLint] ${label}: ${actions.length} actions to execute`)

    // 4. 执行 actions
    let modified = false
    for (const action of actions) {
      const executed = await this.executeAction(action, scope, dunId, entries)
      if (executed) modified = true
    }

    // 5. 更新 _index.md
    if (modified) {
      const newIndex = serializeIndex(entries)
      if (scope === 'global') {
        await this.writeGlobalIndex(newIndex)
      } else {
        await this.writeDunIndex(dunId!, newIndex)
      }
    }
  }

  private async executeAction(
    action: LintAction,
    scope: 'global' | 'dun',
    dunId: string | undefined,
    entries: ReturnType<typeof parseIndex>,
  ): Promise<boolean> {
    const logEntry = (msg: string) => {
      const entry = `[${new Date().toISOString().slice(0, 16)}] LINT ${msg}`
      if (scope === 'global') {
        this.appendGlobalLog(entry).catch(() => {})
      } else {
        this.appendDunLog(dunId!, entry).catch(() => {})
      }
    }

    switch (action.op) {
      case 'archive': {
        if (!action.page) return false
        // 从 _index.md 中移除
        const idx = entries.findIndex(e => e.filename === action.page)
        if (idx >= 0) {
          entries.splice(idx, 1)
          logEntry(`ARCHIVE ${action.page}: "${action.reason || 'stale'}"`)
          console.log(`[KnowledgeLint] Archived ${action.page}: ${action.reason}`)
          return true
        }
        return false
      }

      case 'flag': {
        if (!action.pages || action.pages.length < 2) return false
        // 在摘要前添加 [!] 标记
        for (const pageName of action.pages) {
          const entry = entries.find(e => e.filename === pageName)
          if (entry && !entry.summary.startsWith('[!] ')) {
            entry.summary = `[!] ${entry.summary}`
          }
        }
        logEntry(`FLAG ${action.pages.join(', ')}: "${action.description || 'contradiction'}"`)
        console.log(`[KnowledgeLint] Flagged ${action.pages.join(', ')}: ${action.description}`)
        return true
      }

      case 'merge': {
        if (!action.source || !action.target) return false

        // 读取两个页面
        const sourceContent = scope === 'global'
          ? await this.readGlobalFile(action.source)
          : await this.readDunFile(dunId!, action.source)
        const targetContent = scope === 'global'
          ? await this.readGlobalFile(action.target)
          : await this.readDunFile(dunId!, action.target)

        if (!sourceContent || !targetContent) return false

        // LLM 合并
        const mergeResult = await this.mergePages(sourceContent, targetContent)
        if (!mergeResult) return false

        // 写入 target
        if (scope === 'global') {
          await this.writeGlobalFile(action.target, mergeResult)
        } else {
          await this.writeDunFile(dunId!, action.target, mergeResult)
        }

        // 从 index 移除 source
        const srcIdx = entries.findIndex(e => e.filename === action.source)
        if (srcIdx >= 0) entries.splice(srcIdx, 1)

        logEntry(`MERGE ${action.source} -> ${action.target}: "${action.reason || 'overlap'}"`)
        console.log(`[KnowledgeLint] Merged ${action.source} → ${action.target}`)
        return true
      }

      default:
        return false
    }
  }

  private async mergePages(sourceContent: string, targetContent: string): Promise<string | null> {
    return chatBackground([
      {
        role: 'system',
        content: '将以下两个知识页面合并为一个。保留所有有价值的信息，去除重复。输出合并后的完整 markdown 文档（不超过 3000 字）。',
      },
      {
        role: 'user',
        content: `## 页面 A\n${sourceContent.slice(0, 2000)}\n\n## 页面 B\n${targetContent.slice(0, 2000)}`,
      },
    ], { priority: 9 })
  }

  // ---- JSON Parsing ----

  private parseLintActions(llmOutput: string): LintAction[] {
    let cleaned = llmOutput.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim()
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

    try {
      const parsed = JSON.parse(cleaned)
      if (Array.isArray(parsed)) {
        return parsed.filter(a => a && typeof a.op === 'string').slice(0, 5) as LintAction[]
      }
    } catch {
      console.warn('[KnowledgeLint] Failed to parse lint actions')
    }
    return []
  }

  // ---- I/O Methods ----

  private async readGlobalFile(filename: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.serverUrl}/knowledge/${encodeURIComponent(filename)}`)
      if (res.ok) {
        const data = await res.json()
        return data.exists ? data.content : null
      }
    } catch { /* 静默 */ }
    return null
  }

  private async readDunFile(dunId: string, filename: string): Promise<string | null> {
    try {
      const res = await fetch(
        `${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/${encodeURIComponent(filename)}`
      )
      if (res.ok) {
        const data = await res.json()
        return data.exists ? data.content : null
      }
    } catch { /* 静默 */ }
    return null
  }

  private async writeGlobalFile(filename: string, content: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      })
    } catch { /* 静默 */ }
  }

  private async writeDunFile(dunId: string, filename: string, content: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content }),
      })
    } catch { /* 静默 */ }
  }

  private async writeGlobalIndex(content: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/knowledge/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
    } catch { /* 静默 */ }
  }

  private async writeDunIndex(dunId: string, content: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
    } catch { /* 静默 */ }
  }

  private async appendGlobalLog(entry: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/knowledge/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry }),
      })
    } catch { /* 静默 */ }
  }

  private async appendDunLog(dunId: string, entry: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/duns/${encodeURIComponent(dunId)}/knowledge/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry }),
      })
    } catch { /* 静默 */ }
  }
}

/** 全局单例 */
export const knowledgeLintService = new KnowledgeLintService()

// 启动时检查
if (typeof window !== 'undefined') {
  setTimeout(() => knowledgeLintService.checkOnStartup(), 15000)
}
