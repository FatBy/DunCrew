/**
 * memoryPromotion - 记忆晋升共享模块
 *
 * 提供 PROMOTION_PROMPT 和 parsePromotionResult，
 * 供 confidenceTracker（L1→L0 晋升）和 memoryStore（旧数据清理）共用。
 */

/** 记忆晋升/质量评估 Prompt */
export const PROMOTION_PROMPT = [
  '你是一个记忆提炼助手。判断以下工具执行记录是否值得作为长期记忆保留。',
  '',
  '## 值得保留的记忆',
  '- 用户的具体意图和目标（"用户想修复 config.json 的端口配置"）',
  '- 关键发现和结论（"发现端口 3001 被占用，改为 3002 后解决"）',
  '- 用户偏好和习惯（"用户偏好用 pnpm 而非 npm"）',
  '- 重要的项目上下文（"项目使用 Vite + React + TypeScript"）',
  '',
  '## 不值得保留的记忆',
  '- 纯粹的工具执行细节（"readFile 返回了 200 字节"）',
  '- 临时性操作（"列出了目录内容"）',
  '- 无上下文的碎片信息',
  '',
  '## 输出规则',
  '- 如果值得保留：用一两句自然语言概括核心信息，像人类笔记一样',
  '- 如果不值得保留：只输出"无"',
  '- 不要解释你的判断过程',
].join('\n')

/** 记忆分类 */
export type MemoryCategory = 'preference' | 'project_context' | 'discovery' | 'uncategorized'

/** 记忆分类标签（中文显示名） */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '偏好',
  project_context: '项目',
  discovery: '发现',
  uncategorized: '未分类',
}

/**
 * 解析 LLM 晋升结果
 *
 * @returns 提炼后的内容字符串，如果 LLM 判断不值得保留则返回 null
 */
export function parsePromotionResult(llmOutput: string): string | null {
  const trimmed = llmOutput.trim()

  // LLM 输出"无"或空 → 不值得保留
  if (!trimmed || trimmed === '无' || trimmed === '无。') {
    return null
  }

  // 过滤掉明显的工具日志格式（LLM 可能原样返回）
  if (/^(readFile|writeFile|runCmd|listDir|searchFiles)\s*[:：]/.test(trimmed)) {
    return null
  }

  return trimmed
}
