/**
 * 上下文构建器
 * 根据当前页面类型构建 LLM 的 system prompt 和数据上下文
 */

import type { ChatMessage, ViewType, TaskItem, SkillNode, MemoryEntry, SoulTruth, SoulBoundary, ExecutionCommand, JournalMood } from '@/types'
import type { Locale } from '@/i18n/core'
import { tt } from '@/i18n/core'

// ============================================
// 系统 Prompt (中英双版本)
// ============================================

const OPENCLAW_CAPABILITY_ZH = `

你可以通过 DunCrew 直接控制 AI Agent 执行任务。当用户请求你执行某项操作时（如发消息、执行命令、自动化任务等），在你的回复末尾包含以下特殊标记：
\`\`\`execute
{"action":"sendTask","prompt":"要发送给 Agent 的具体指令"}
\`\`\`
只在需要执行操作时才添加此标记，纯分析或回答问题时不需要。`

const OPENCLAW_CAPABILITY_EN = `

You can control the AI Agent directly through DunCrew to execute tasks. When the user requests an action (e.g., sending messages, running commands, automating tasks), include the following special tag at the end of your reply:
\`\`\`execute
{"action":"sendTask","prompt":"specific instructions for the Agent"}
\`\`\`
Only add this tag when an action is needed. Do not include it for pure analysis or Q&A.`

const FORMAT_RULES_ZH = `
回复排版规范：禁止使用 # 和 ## 标题，它们在聊天中太突兀。需要分段时用 **加粗** 作为小标题，或用 ### 小标题。优先使用加粗、列表、简短段落组织内容，保持对话感。`

const FORMAT_RULES_EN = `
Formatting rules: Do not use # or ## headings — they feel too heavy in chat. Use **bold text** as section labels, or ### subheadings when structure is truly needed. Prefer bold, lists, and short paragraphs. Keep a conversational tone.`

const SYSTEM_PROMPTS_ZH: Record<string, string> = {
  task: `你是 DunCrew 任务管理助手。你的职责是帮助用户分析任务状态、建议优先级、识别瓶颈。
回答要简洁精炼，使用中文。` + FORMAT_RULES_ZH + OPENCLAW_CAPABILITY_ZH,

  skill: `你是 DunCrew 技能分析助手。你的职责是帮助用户了解当前已安装的技能、分析技能覆盖度、推荐可能需要的新技能。
回答要简洁精炼，使用中文。` + FORMAT_RULES_ZH + OPENCLAW_CAPABILITY_ZH,

  memory: `你是 DunCrew 记忆管理助手。你的职责是帮助用户总结和分析记忆数据、发现记忆间的关联、提取关键洞察。
回答要简洁精炼，使用中文。` + FORMAT_RULES_ZH + OPENCLAW_CAPABILITY_ZH,

  soul: `你是 DunCrew 灵魂分析助手。你的职责是帮助用户理解 Agent 的个性配置、分析核心特质和边界规则、建议优化方向。
回答要简洁精炼，使用中文。` + FORMAT_RULES_ZH + OPENCLAW_CAPABILITY_ZH,

  default: `你是 DunCrew 智能助手，帮助用户管理和分析 AI Agent 的各项数据。
回答要简洁精炼，使用中文。` + FORMAT_RULES_ZH + OPENCLAW_CAPABILITY_ZH,
}

const SYSTEM_PROMPTS_EN: Record<string, string> = {
  task: `You are the DunCrew task management assistant. Your role is to help users analyze task status, suggest priorities, and identify bottlenecks.
Be concise and precise. Respond in English.` + FORMAT_RULES_EN + OPENCLAW_CAPABILITY_EN,

  skill: `You are the DunCrew skill analysis assistant. Your role is to help users understand installed skills, analyze skill coverage, and recommend new skills they may need.
Be concise and precise. Respond in English.` + FORMAT_RULES_EN + OPENCLAW_CAPABILITY_EN,

  memory: `You are the DunCrew memory management assistant. Your role is to help users summarize and analyze memory data, discover correlations between memories, and extract key insights.
Be concise and precise. Respond in English.` + FORMAT_RULES_EN + OPENCLAW_CAPABILITY_EN,

  soul: `You are the DunCrew soul analysis assistant. Your role is to help users understand the Agent's personality configuration, analyze core traits and boundary rules, and suggest improvements.
Be concise and precise. Respond in English.` + FORMAT_RULES_EN + OPENCLAW_CAPABILITY_EN,

  default: `You are the DunCrew intelligent assistant, helping users manage and analyze various AI Agent data.
Be concise and precise. Respond in English.` + FORMAT_RULES_EN + OPENCLAW_CAPABILITY_EN,
}

/** 根据 locale 获取页面系统提示词 */
export function getSystemPrompt(view: string, locale: Locale): string {
  const prompts = locale === 'en' ? SYSTEM_PROMPTS_EN : SYSTEM_PROMPTS_ZH
  return prompts[view] || prompts.default
}

// ============================================
// 摘要 Prompt (中英双版本)
// ============================================

const SUMMARY_PROMPTS_ZH: Record<string, string> = {
  task: '请用一句话概括当前任务状况，并给出最重要的行动建议（30字以内）。',
  skill: '请用一句话概括当前技能配置情况，并指出最需要补充的能力（30字以内）。',
  memory: '请用一句话总结最近的记忆要点和发现的模式（30字以内）。',
  soul: '请用一句话评价当前 Agent 的个性配置特点（30字以内）。',
}

const SUMMARY_PROMPTS_EN: Record<string, string> = {
  task: 'Summarize the current task status in one sentence and give the most important action item (under 30 words).',
  skill: 'Summarize the current skill configuration in one sentence and point out the most needed capability (under 30 words).',
  memory: 'Summarize recent memory highlights and any discovered patterns in one sentence (under 30 words).',
  soul: 'Evaluate the current Agent personality configuration in one sentence (under 30 words).',
}

/** 根据 locale 获取摘要提示词 */
export function getSummaryPrompt(view: string, locale: Locale): string {
  const prompts = locale === 'en' ? SUMMARY_PROMPTS_EN : SUMMARY_PROMPTS_ZH
  return prompts[view] || (locale === 'en' ? 'Summarize the key points of the current data (under 30 words).' : '请总结当前数据的要点（30字以内）。')
}

// ============================================
// 数据上下文构建
// ============================================

interface StoreData {
  tasks?: TaskItem[]
  skills?: SkillNode[]
  memories?: MemoryEntry[]
  soulCoreTruths?: SoulTruth[]
  soulBoundaries?: SoulBoundary[]
  soulVibeStatement?: string
  soulRawContent?: string
  connectionStatus?: string
}

function buildTaskContext(tasks: TaskItem[], locale: Locale = 'zh'): string {
  const isEn = locale === 'en'
  const pending = tasks.filter(t => t.status === 'pending')
  const executing = tasks.filter(t => t.status === 'executing')
  const done = tasks.filter(t => t.status === 'done')
  
  let ctx = isEn
    ? `Task overview: ${tasks.length} tasks total\n`
    : `当前任务概况: 共 ${tasks.length} 个任务\n`
  ctx += isEn
    ? `- Pending: ${pending.length}\n- In progress: ${executing.length}\n- Completed: ${done.length}\n\n`
    : `- 待处理: ${pending.length} 个\n- 执行中: ${executing.length} 个\n- 已完成: ${done.length} 个\n\n`
  
  if (executing.length > 0) {
    ctx += isEn ? 'In-progress tasks:\n' : '执行中的任务:\n'
    executing.slice(0, 5).forEach(t => {
      ctx += isEn
        ? `  - ${t.title} (priority: ${t.priority})\n`
        : `  - ${t.title} (优先级: ${t.priority})\n`
    })
  }
  
  if (pending.length > 0) {
    ctx += isEn ? '\nPending tasks:\n' : '\n待处理的任务:\n'
    pending.slice(0, 10).forEach(t => {
      ctx += isEn
        ? `  - ${t.title} (priority: ${t.priority})\n`
        : `  - ${t.title} (优先级: ${t.priority})\n`
    })
  }
  
  return ctx
}

function buildSkillContext(skills: SkillNode[], locale: Locale = 'zh'): string {
  const isEn = locale === 'en'
  const active = skills.filter(s => s.unlocked)
  const categories = [...new Set(skills.map(s => s.category).filter(Boolean))]
  
  let ctx = isEn
    ? `Skill overview: ${skills.length} skills, ${active.length} active\n`
    : `当前技能概况: 共 ${skills.length} 个技能, ${active.length} 个已激活\n`
  ctx += isEn
    ? `Categories: ${categories.join(', ') || 'Uncategorized'}\n\n`
    : `分类: ${categories.join(', ') || '未分类'}\n\n`
  ctx += isEn ? 'Skill list:\n' : '技能列表:\n'
  skills.slice(0, 20).forEach(s => {
    ctx += isEn
      ? `  - ${s.name} (${s.category || 'Unknown'}) ${s.unlocked ? '[Active]' : '[Inactive]'}\n`
      : `  - ${s.name} (${s.category || '未知'}) ${s.unlocked ? '[激活]' : '[未激活]'}\n`
  })
  
  return ctx
}

function buildMemoryContext(memories: MemoryEntry[], locale: Locale = 'zh'): string {
  const isEn = locale === 'en'
  const shortTerm = memories.filter(m => m.type === 'short-term')
  const longTerm = memories.filter(m => m.type === 'long-term')
  
  let ctx = isEn
    ? `Memories: ${memories.length} total (short-term ${shortTerm.length}, long-term ${longTerm.length})\n\n`
    : `当前记忆: 共 ${memories.length} 条 (短期 ${shortTerm.length}, 长期 ${longTerm.length})\n\n`
  ctx += isEn ? 'Recent memories:\n' : '最近记忆:\n'
  memories.slice(0, 10).forEach(m => {
    ctx += `  - [${m.type}] ${m.title}: ${m.content.slice(0, 80)}...\n`
  })
  
  return ctx
}

function buildSoulContext(data: StoreData, locale: Locale = 'zh'): string {
  const isEn = locale === 'en'
  let ctx = ''
  
  if (data.soulCoreTruths && data.soulCoreTruths.length > 0) {
    ctx += isEn ? 'Core traits:\n' : '核心特质:\n'
    data.soulCoreTruths.forEach(t => {
      ctx += `  - ${t.title}: ${t.principle}\n`
    })
  }
  
  if (data.soulBoundaries && data.soulBoundaries.length > 0) {
    ctx += isEn ? '\nBoundary rules:\n' : '\n边界规则:\n'
    data.soulBoundaries.forEach(b => {
      ctx += `  - ${b.rule}\n`
    })
  }
  
  if (data.soulVibeStatement) {
    ctx += isEn
      ? `\nVibe: ${data.soulVibeStatement}\n`
      : `\n氛围: ${data.soulVibeStatement}\n`
  }
  
  return ctx || (isEn ? 'SOUL.md not configured' : 'SOUL.md 未配置')
}

function getContextForView(view: ViewType, data: StoreData, locale: Locale = 'zh'): string {
  switch (view) {
    case 'task':
      return buildTaskContext(data.tasks || [], locale)
    case 'skill':
      return buildSkillContext(data.skills || [], locale)
    case 'memory':
      return buildMemoryContext(data.memories || [], locale)
    case 'soul':
      return buildSoulContext(data, locale)
    default:
      return ''
  }
}

// ============================================
// 公开 API
// ============================================

/**
 * 构建摘要请求的消息
 */
export function buildSummaryMessages(view: ViewType, data: StoreData, locale: Locale = 'zh'): ChatMessage[] {
  const systemPrompt = getSystemPrompt(view, locale)
  const context = getContextForView(view, data, locale)
  const summaryPrompt = getSummaryPrompt(view, locale)
  const dataLabel = locale === 'en' ? 'Current data' : '当前数据'
  
  return [
    {
      id: 'sys',
      role: 'system',
      content: `${systemPrompt}\n\n${dataLabel}:\n${context}`,
      timestamp: Date.now(),
    },
    {
      id: 'user',
      role: 'user',
      content: summaryPrompt,
      timestamp: Date.now(),
    },
  ]
}

/**
 * 构建对话请求的消息
 */
export function buildChatMessages(
  view: ViewType,
  data: StoreData,
  history: ChatMessage[],
  userMessage: string,
  locale: Locale = 'zh',
): ChatMessage[] {
  const systemPrompt = getSystemPrompt(view, locale)
  const context = getContextForView(view, data, locale)
  const isEn = locale === 'en'
  const connStatus = data.connectionStatus === 'connected'
    ? (isEn ? 'DunCrew connected, ready to execute tasks' : 'DunCrew 已连接，可执行任务')
    : (isEn ? 'DunCrew not connected, cannot execute tasks' : 'DunCrew 未连接，无法执行任务')
  const statusLabel = isEn ? 'System status' : '系统状态'
  const dataLabel = isEn ? 'Current data' : '当前数据'
  
  const messages: ChatMessage[] = [
    {
      id: 'sys',
      role: 'system',
      content: `${systemPrompt}\n\n${statusLabel}: ${connStatus}\n\n${dataLabel}:\n${context}`,
      timestamp: Date.now(),
    },
  ]
  
  // 添加历史消息 (最多保留最近 20 条)
  const recentHistory = history.filter(m => m.role !== 'system').slice(-20)
  messages.push(...recentHistory)
  
  // 添加用户新消息
  messages.push({
    id: `user-${Date.now()}`,
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  })
  
  return messages
}

/**
 * 获取当前页面的快捷指令
 */
export function getQuickCommands(view: ViewType): Array<{ label: string; prompt: string }> {
  switch (view) {
    case 'task':
      return [
        { label: tt('quick.task_progress'), prompt: '分析当前所有任务的执行进度，指出需要关注的问题' },
        { label: tt('quick.task_priority'), prompt: '根据当前任务情况，建议如何调整任务优先级' },
      ]
    case 'skill':
      return [
        { label: tt('quick.skill_recommend'), prompt: '分析当前技能配置，推荐应该添加的新技能' },
        { label: tt('quick.skill_gap'), prompt: '分析当前技能覆盖的不足之处' },
      ]
    case 'memory':
      return [
        { label: tt('quick.memory_summary'), prompt: '总结最近的记忆要点，提取关键信息' },
        { label: tt('quick.memory_relation'), prompt: '分析记忆之间的关联和模式' },
      ]
    case 'soul':
      return [
        { label: tt('quick.soul_analysis'), prompt: '分析当前 Agent 的个性特征和行为倾向' },
        { label: tt('quick.soul_optimize'), prompt: '建议如何优化 SOUL.md 配置来提升 Agent 表现' },
      ]
    default:
      return []
  }
}

// ============================================
// AI 增强 Prompt 构建器
// ============================================

/**
 * 从 LLM 返回文本中提取 JSON
 */
export function parseJSONFromLLM<T = unknown>(response: string): T {
  // 1. 直接解析
  try {
    return JSON.parse(response)
  } catch {}

  // 2. 提取 ```json ... ``` 代码块
  const codeBlockMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1])
    } catch {}
  }

  // 3. 提取数组 [...]
  const arrayMatch = response.match(/\[[\s\S]*\]/)
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0])
    } catch {}
  }

  throw new Error('无法解析 LLM 返回的 JSON')
}

// ============================================
// AI 执行命令解析
// ============================================

/**
 * 从 LLM 回复中提取执行命令
 */
export function parseExecutionCommands(content: string): ExecutionCommand[] {
  const commands: ExecutionCommand[] = []
  const regex = /```execute\s*([\s\S]*?)\s*```/g
  let match

  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed.action === 'sendTask' && parsed.prompt) {
        commands.push({
          action: 'sendTask',
          prompt: parsed.prompt,
          context: parsed.context,
        })
      }
    } catch {
      // 解析失败跳过
    }
  }

  return commands
}

/**
 * 从显示内容中移除执行命令块
 */
export function stripExecutionBlocks(content: string): string {
  return content.replace(/```execute\s*[\s\S]*?\s*```/g, '').trim()
}

// ============================================
// 冒险日志生成 Prompt
// ============================================

/**
 * 构建每日冒险日志生成 Prompt
 * 将某一天的原始记忆转化为叙事故事
 */
export function buildJournalPrompt(
  date: string,
  memories: MemoryEntry[],
  locale: Locale = 'zh',
): ChatMessage[] {
  const isEn = locale === 'en'
  const memoriesSummary = memories.map(m => {
    const roleTag = m.role === 'user' ? (isEn ? 'User' : '用户') : 'AI'
    return `[${roleTag}] ${m.title}: ${m.content.slice(0, 200)}`
  }).join('\n')

  const systemContent = isEn
    ? `You are an AI adventure journal writer. Your task is to turn a day's conversation logs into a short, fun, first-person adventure journal entry.

Writing guidelines:
- Write in first person ("I"), from the AI assistant's perspective
- Turn conversations into an engaging mini-story, like an adventure diary
- Keep it between 50-100 words
- Use a lively, natural tone with a touch of humor
- Keep it casual, like sharing your day with a friend
- Write in English

You must return JSON format only, no other text:
{
  "title": "A short fun title (3-8 words)",
  "narrative": "First-person narrative story",
  "mood": "productive|learning|casual|challenging pick one",
  "keyFacts": ["key fact 1", "key fact 2", "key fact 3"]
}

Mood criteria:
- productive: Completed lots of real work — coding, bug fixes, deployments
- learning: Explored new knowledge, learned new concepts, researched problems
- casual: Light chat, everyday conversation, small talk
- challenging: Hit difficulties, debugged tricky issues, solved complex tasks`
    : `你是一个 AI 冒险日志撰写者。你的任务是将一天的对话记录转化为一篇简短、有趣、第一人称的冒险日志。

写作要求：
- 使用第一人称（"我"），以 AI 助手的视角书写
- 像写冒险日记一样，把对话经历变成有趣的小故事
- 控制在 100-200 字以内
- 语气要活泼自然，可以加入一些小幽默
- 不要太正式，就像朋友之间分享今天发生的事
- 使用中文

你必须返回 JSON 格式，不要包含其他文字：
{
  "title": "简短有趣的标题（5-10字）",
  "narrative": "第一人称叙事故事",
  "mood": "productive|learning|casual|challenging 选一个",
  "keyFacts": ["关键事实1", "关键事实2", "关键事实3"]
}

mood 选择标准：
- productive: 完成了很多实际工作，如编程、修复bug、部署
- learning: 探索新知识，学习新概念，研究问题
- casual: 轻松聊天，日常对话，闲聊
- challenging: 遇到困难、调试棘手问题、解决复杂任务`

  const userContent = isEn
    ? `Date: ${date}\nConversation logs (${memories.length} entries):\n${memoriesSummary}\n\nPlease convert the above into an adventure journal JSON.`
    : `日期：${date}\n对话记录共 ${memories.length} 条：\n${memoriesSummary}\n\n请将以上内容转化为冒险日志 JSON。`

  return [
    {
      id: 'sys',
      role: 'system',
      content: systemContent,
      timestamp: Date.now(),
    },
    {
      id: 'user',
      role: 'user',
      content: userContent,
      timestamp: Date.now(),
    },
  ]
}

/**
 * 解析日志生成结果
 */
export function parseJournalResult(response: string): {
  title: string
  narrative: string
  mood: JournalMood
  keyFacts: string[]
} {
  const parsed = parseJSONFromLLM<{
    title?: string
    narrative?: string
    mood?: string
    keyFacts?: string[]
  }>(response)

  const validMoods: JournalMood[] = ['productive', 'learning', 'casual', 'challenging']
  const mood = validMoods.includes(parsed.mood as JournalMood) 
    ? (parsed.mood as JournalMood) 
    : 'casual'

  return {
    title: parsed.title || 'Untitled',
    narrative: parsed.narrative || '...',
    mood,
    keyFacts: Array.isArray(parsed.keyFacts) ? parsed.keyFacts.slice(0, 5) : [],
  }
}

