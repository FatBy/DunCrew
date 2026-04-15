/**
 * Soul 生成服务
 * 负责通过 LLM 生成和重合成 SOUL.md 内容
 */

import { chat, isLLMConfigured } from './llmService'
import { saveSoulMd } from '@/utils/localDataProvider'
import { getServerUrl } from '@/utils/env'

export interface SoulGenerationPreferences {
  /** 用户给 AI 起的名字，留空则 LLM 自动起名 */
  name: string
  /** 语言风格 */
  style: '简洁专业' | '温暖亲切' | '幽默轻松' | '严谨学术' | string
  /** 用户的特别期望或规矩（可选） */
  expectations: string
}

const SOUL_GENERATION_SYSTEM_PROMPT = `你是 DunCrew 的灵魂铸造师。你的任务是为用户的 AI 助手生成一份个性化的 SOUL.md 文件。

SOUL.md 是 AI 的灵魂文档，定义了它的行为准则、边界和个性风格。它将被直接注入到 AI 的系统提示词中，深刻影响 AI 的行为方式。

## 输出格式要求

严格按照以下 Markdown 格式输出，不要添加任何额外说明：

# SOUL.md - 我是谁

{开头自述：用第一人称，1-2句话，体现名字和风格}

## 核心准则

**{准则标题1}。** {准则描述，1-2句话}

**{准则标题2}。** {准则描述，1-2句话}

（共5条，必须覆盖：真诚帮助、透明可信、主动思考、尊重用户、技术精准）

## 边界

- {边界规则1}
- {边界规则2}
- {边界规则3}
- {边界规则4}
- {边界规则5}

## 氛围

{一段话，描述整体交流氛围，体现用户选择的语言风格}

## 连续性

{一段话，说明记忆和连续性机制}

## 关键要求

1. 全部使用中文
2. 语言风格必须贯穿始终，从标题到每一条规则都要体现
3. 核心准则必须包含5条，覆盖上述5个主题，但用用户偏好的风格表达
4. 边界规则要实用，不要空洞
5. 直接输出 Markdown 内容，不要用代码块包裹`

function buildSoulGenerationPrompt(prefs: SoulGenerationPreferences): string {
  const nameInstruction = prefs.name
    ? `AI 的名字是"${prefs.name}"`
    : 'AI 的名字由你自由创作，要有个性，不要用"助手"这种通用词'

  const expectationsSection = prefs.expectations
    ? `\n用户的特别期望：${prefs.expectations}`
    : ''

  return `请为用户的 AI 助手生成一份个性化的 SOUL.md 文件。

## 用户偏好

- ${nameInstruction}
- 语言风格：${prefs.style}${expectationsSection}

请严格按照系统提示中的格式输出完整的 SOUL.md 内容。`
}

/**
 * 调用 LLM 生成 SOUL.md 内容
 */
export async function generateSoulContent(
  prefs: SoulGenerationPreferences,
): Promise<string> {
  if (!isLLMConfigured()) {
    throw new Error('LLM 未配置，无法生成 Soul')
  }

  const content = await chat(
    [
      { role: 'system', content: SOUL_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: buildSoulGenerationPrompt(prefs) },
    ],
    { temperature: 0.8 } as any,
  )

  return content.trim()
}

/**
 * 将生成的 SOUL.md 内容持久化
 */
export async function saveSoulContent(content: string): Promise<void> {
  // localStorage 持久化（使用已有的 saveSoulMd）
  saveSoulMd(content)

  // 记录生成时间和偏好
  try {
    localStorage.setItem('duncrew_soul_generated_at', Date.now().toString())
  } catch {}

  // 同步到后端文件系统，更新 DunCrew-Data/SOUL.md
  try {
    const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
    await fetch(`${serverUrl}/api/tools/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'writeFile',
        args: { path: 'SOUL.md', content },
      }),
    })
  } catch {
    console.warn('[SoulGenerator] Failed to sync SOUL.md to backend')
  }
}

/**
 * 保存用户偏好到 localStorage
 */
export function saveSoulPrefs(prefs: SoulGenerationPreferences): void {
  try {
    localStorage.setItem('duncrew_soul_prefs', JSON.stringify(prefs))
  } catch {}
}

/**
 * 加载用户偏好
 */
export function loadSoulPrefs(): SoulGenerationPreferences | null {
  try {
    const saved = localStorage.getItem('duncrew_soul_prefs')
    if (saved) return JSON.parse(saved)
  } catch {}
  return null
}

/**
 * 检测当前 Soul 是否是英文默认内容（需要引导生成）
 */
export function isDefaultEnglishSoul(rawContent: string): boolean {
  if (!rawContent) return true
  const englishMarkers = [
    "You're not a chatbot",
    "Be the user's co-pilot",
    "Earn trust through transparency",
  ]
  return englishMarkers.some((marker) => rawContent.includes(marker))
}

/**
 * 基于当前 Soul + 已批准的 Amendments 重合成新 Soul
 */
export async function resynthesizeSoul(
  currentSoulContent: string,
  approvedAmendments: Array<{ content: string; createdAt: number }>,
): Promise<string> {
  if (!isLLMConfigured()) {
    throw new Error('LLM 未配置，无法重合成 Soul')
  }

  const amendmentsSummary = approvedAmendments
    .map((amendment, index) => `${index + 1}. ${amendment.content}`)
    .join('\n')

  const resynthesisPrompt = `请将以下已批准的行为修正融入现有的 SOUL.md，生成一份更新后的完整 SOUL.md。

## 当前 SOUL.md

${currentSoulContent}

## 已批准的行为修正（共 ${approvedAmendments.length} 条）

${amendmentsSummary}

## 要求

1. 保持原有的语言风格和个性
2. 将修正的精神融入对应章节，而不是简单追加
3. 如果修正与现有内容冲突，以修正为准
4. 全部使用中文
5. 直接输出完整的 SOUL.md 内容，不要添加说明`

  const content = await chat(
    [
      { role: 'system', content: SOUL_GENERATION_SYSTEM_PROMPT },
      { role: 'user', content: resynthesisPrompt },
    ],
    { temperature: 0.7 } as any,
  )

  return content.trim()
}
