/**
 * memoryPromotion - 记忆晋升共享模块
 *
 * 提供 PROMOTION_PROMPT 和 parsePromotionResult，
 * 供 confidenceTracker（L1→L0 晋升）和 memoryStore（旧数据清理）共用。
 */

/** 响应知识提取 Prompt — 从 AI 的分析性响应中提取领域知识和数据洞察 */
export const RESPONSE_KNOWLEDGE_PROMPT = [
  '你是一个知识提取器。从以下对话的 AI 响应中，提取核心知识和有价值的认知。',
  '',
  '## 提取重点（按优先级）',
  '1. 研究成果与结论（经过搜索/分析验证的发现，这类知识价值最高）',
  '2. 数据洞察（数字、百分比、趋势、规模、对比）',
  '3. 领域知识体系（分类框架、因果关系、结构性判断、行业规律）',
  '4. 政策/规则解读（法规要点、适用条件、关键限制）',
  '5. 反直觉发现或关键差异对比',
  '6. 可复用的方法论或分析框架',
  '',
  '## 输出格式',
  '- 提取 1-8 条最有价值的知识点',
  '- 每条知识点应自包含（脱离原文后仍可理解）',
  '- 保留关键数据、条件和限定语',
  '- 多条知识点之间用换行分隔',
  '',
  '## 不值得提取的',
  '- 日常寒暄、确认性回复（"好的"、"没问题"）',
  '- 纯操作描述（"我帮你创建了文件"、"搜索完成"）',
  '- 没有实质信息量的过渡性内容',
  '- 对前文的简单复述',
  '',
  '## 输出规则',
  '- 如果能提取到有价值的知识：直接输出知识点（不要解释判断过程）',
  '- 宁多提取不遗漏：只要内容有复用价值，就应该提取',
  '- 如果没有值得提取的知识：只输出"无"',
].join('\n')

/** 记忆晋升/质量评估 Prompt — V2: 行为共识提炼 */
export const PROMOTION_PROMPT = [
  '你是一个行为模式分析器。从以下操作记录中，提炼出可复用的行为准则或关键认知。',
  '',
  '## 输出两种格式（由你判断哪种更合适）',
  '',
  '### 格式 A：行为准则（优先使用）',
  '当操作记录中能提炼出"遇到 X 场景该怎么做"的模式时，使用此格式：',
  '  "[场景触发条件] → [应该怎么做]（因为[原因]）"',
  '示例：',
  '- "当用户项目中端口冲突时 → 优先尝试 3002 端口（因为该用户环境中 3001 长期被占用）"',
  '- "当用户要求修改配置文件时 → 先读取当前内容再修改（因为该用户多次因覆盖写入丢失过配置）"',
  '- "当用户说"帮我部署"时 → 先确认目标环境再执行（因为该用户有多个部署环境）"',
  '',
  '### 格式 B：环境事实（仅当无法提炼行为准则时使用）',
  '当操作记录只包含纯事实性信息（如技术栈、项目结构）时，用一句话陈述：',
  '- "项目使用 Vite + React + TypeScript"',
  '- "用户偏好使用 pnpm 而非 npm"',
  '',
  '### 格式 C：产出知识（当操作记录中包含文件产出时使用）',
  '当操作记录中包含 writeFile/appendFile 的产出内容摘要时，提炼产出的核心结论或关键发现：',
  '- "竞品分析发现：X 产品的核心优势在于 Y，我们的差距主要在 Z"',
  '- "用户项目的性能瓶颈在数据库查询层，P99 延迟 > 500ms"',
  '- "整理的资料显示：行业趋势是 A → B → C，关键转折点在 2025 年"',
  '注意：提炼的是产出内容中的核心知识，而不是"产出了一个文件"这个事实本身。',
  '',
  '## 不值得保留的',
  '- 纯粹的工具执行细节（"readFile 返回了 200 字节"）',
  '- 临时性操作（"列出了目录内容"）',
  '- 无上下文的碎片信息',
  '- 没有可复用价值的一次性操作',
  '',
  '## 输出规则',
  '- 如果能提炼出行为准则或关键认知：直接输出内容（不要解释判断过程）',
  '- 如果只是常规操作、没有可复用价值：只输出"无"',
].join('\n')

/** 记忆分类 */
export type MemoryCategory = 'preference' | 'project_context' | 'discovery' | 'uncategorized'

/** 知识层级：global（环境/偏好，跨 Dun 共享）| local（领域/工具，Per-Dun） */
export type KnowledgeLayer = 'global' | 'local'

/** 分类结果：包含类别和知识层级 */
export interface MemoryClassification {
  category: MemoryCategory
  layer: KnowledgeLayer
}

/** 记忆分类标签（中文显示名） */
export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: '偏好共识',
  project_context: '环境上下文',
  discovery: '行为准则',
  uncategorized: '观察备忘',
}

/**
 * 清洗 LLM 输出中的 <think>/<thinking> 标签及其内容
 * 完整移除 think 标签及其包裹的内容，只保留标签外的实际输出
 */
export function cleanThinkTags(text: string): string {
  // 移除 <think>...</think> 和 <thinking>...</thinking> 及其内容（支持多段）
  let cleaned = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
  // 移除未闭合的标签（LLM 有时只输出开标签）
  cleaned = cleaned.replace(/<\/?think(?:ing)?>/gi, '')
  return cleaned.trim()
}

/**
 * 自动分类记忆内容
 * 基于内容特征判断属于哪个类别及知识层级
 *
 * layer 路由规则：
 * - preference / project_context → global（跨 Dun 共享）
 * - discovery / uncategorized → local（Per-Dun）
 */
export function classifyMemoryContent(content: string): MemoryClassification {
  // 行为准则：包含 "→" 且不是纯工具链格式（如 readFile→writeFile）
  if (content.includes('→')) {
    const isToolChain = /^[\w]+(?:→[\w]+)+$/.test(content.trim())
    if (!isToolChain) return { category: 'discovery', layer: 'local' }
  }

  // 用户偏好
  if (/偏好|喜欢|习惯|prefer|always use|优先使用|而非|而不是|倾向于/.test(content)) {
    return { category: 'preference', layer: 'global' }
  }

  // 环境上下文：技术栈、项目结构、配置等事实性信息
  if (/项目使用|版本|端口|目录结构|环境|配置|tech.?stack|架构|依赖/.test(content)) {
    return { category: 'project_context', layer: 'global' }
  }

  return { category: 'uncategorized', layer: 'local' }
}

/**
 * 解析 LLM 晋升结果
 *
 * 内置 cleanThinkTags 清洗，所有调用方自动受益。
 * @returns 提炼后的内容字符串，如果 LLM 判断不值得保留则返回 null
 */
export function parsePromotionResult(llmOutput: string): string | null {
  const trimmed = cleanThinkTags(llmOutput).trim()

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
