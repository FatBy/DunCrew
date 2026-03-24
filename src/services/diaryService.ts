/**
 * DiaryService - 每日日记聚合服务
 *
 * 从 memoryStore 中拉取当天的 session 记忆（对话级记忆），
 * 调用 LLM 聚合成一篇自然语言日记，写回 memoryStore（source: 'diary'）。
 *
 * 触发时机：
 * - 应用启动时自动检查昨天是否已生成日记
 * - 用户手动点击"生成日记"按钮
 *
 * 日记格式：
 * - 按天聚合，每天最多一篇
 * - content 为 LLM 生成的自然语言日记
 * - tags 包含日期标签 date:YYYY-MM-DD
 * - metadata 包含 sessionCount、generatedAt 等元信息
 */

import { memoryStore } from './memoryStore'
import { chat, isLLMConfigured } from './llmService'
import type { MemorySearchResult } from '@/types'

// ============================================
// 类型定义
// ============================================

/** 日记条目（UI 消费用） */
export interface DiaryEntry {
  id: string
  date: string
  content: string
  sessionCount: number
  generatedAt: number
  raw: MemorySearchResult
}

// ============================================
// 日期工具函数
// ============================================

/** 获取某天的起止时间戳 */
function getDayRange(date: Date): { start: number; end: number } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const end = start + 24 * 60 * 60 * 1000 - 1
  return { start, end }
}

/** 格式化日期为 YYYY-MM-DD */
function formatDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 获取昨天的 Date 对象 */
function getYesterday(): Date {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return yesterday
}

// ============================================
// 日记生成逻辑
// ============================================

const DIARY_STORAGE_KEY = 'duncrew_diary_last_generated'

class DiaryServiceImpl {
  /** 检查某天的日记是否已生成 */
  async isDiaryGenerated(dateStr: string): Promise<boolean> {
    const diaries = await memoryStore.search({
      query: `date:${dateStr}`,
      sources: ['diary'],
      maxResults: 1,
      minScore: 0,
      useMmr: false,
    })
    return diaries.some(d =>
      Array.isArray(d.tags) && d.tags.includes(`date:${dateStr}`),
    )
  }

  /** 拉取某天的所有 session 记忆 */
  async fetchSessionsForDay(date: Date): Promise<MemorySearchResult[]> {
    const { start, end } = getDayRange(date)
    const results = await memoryStore.search({
      query: '*',
      sources: ['session'],
      since: start,
      maxResults: 200,
      minScore: 0,
      useMmr: false,
    })
    // 过滤确保在当天范围内
    return results.filter(r => {
      const ts = r.createdAt || 0
      return ts >= start && ts <= end
    })
  }

  /** 调用 LLM 将多条 session 记忆聚合成日记 */
  private async generateDiaryContent(
    sessions: MemorySearchResult[],
    dateStr: string,
  ): Promise<string> {
    const sessionTexts = sessions
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((s, index) => {
        const time = s.createdAt
          ? new Date(s.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
          : '未知时间'
        const content = s.snippet || s.content || ''
        const responsePreview = (s.metadata?.responsePreview as string) || ''
        return `${index + 1}. [${time}] ${content}${responsePreview ? `\n   → ${responsePreview}` : ''}`
      })
      .join('\n')

    if (isLLMConfigured()) {
      const result = await chat([
        {
          role: 'system',
          content: [
            `你是一个私人日记助手。请根据以下 ${dateStr} 的对话记录，写一篇简洁的每日回顾日记。`,
            '',
            '## 写作要求',
            '- 用第一人称"我"来写，像真实的日记',
            '- 按时间线梳理当天做了什么、讨论了什么、有什么收获',
            '- 提炼关键主题和成果，不要逐条复述',
            '- 如果有技术工作，简要提及技术要点',
            '- 语气自然、温暖，像写给未来的自己看的笔记',
            '- 控制在 200-400 字',
            '- 直接输出日记内容，不要加标题或日期前缀',
          ].join('\n'),
        },
        { role: 'user', content: sessionTexts },
      ])
      return result?.trim() || this.fallbackDiaryContent(sessions, dateStr)
    }

    return this.fallbackDiaryContent(sessions, dateStr)
  }

  /** 无 LLM 时的 fallback 日记生成 */
  private fallbackDiaryContent(sessions: MemorySearchResult[], dateStr: string): string {
    const topics = new Set<string>()
    for (const session of sessions) {
      const content = session.snippet || session.content || ''
      // 从 [对话] 前缀中提取话题关键词
      const cleaned = content.replace(/^\[对话\]\s*/, '')
      if (cleaned.length > 5) {
        topics.add(cleaned.slice(0, 50))
      }
    }

    const topicList = Array.from(topics).slice(0, 5)
    if (topicList.length === 0) {
      return `${dateStr}，进行了 ${sessions.length} 次对话交互。`
    }

    return `${dateStr}，进行了 ${sessions.length} 次对话，主要话题：\n${topicList.map(t => `- ${t}`).join('\n')}`
  }

  /**
   * 为指定日期生成日记
   * @returns 生成的日记内容，如果当天无 session 记忆则返回 null
   */
  async generateDiary(date: Date): Promise<string | null> {
    const dateStr = formatDate(date)

    // 检查是否已生成
    const alreadyGenerated = await this.isDiaryGenerated(dateStr)
    if (alreadyGenerated) {
      console.log(`[DiaryService] Diary for ${dateStr} already exists, skipping`)
      return null
    }

    // 拉取当天 session 记忆
    const sessions = await this.fetchSessionsForDay(date)
    if (sessions.length === 0) {
      console.log(`[DiaryService] No sessions found for ${dateStr}, skipping`)
      return null
    }

    console.log(`[DiaryService] Generating diary for ${dateStr} from ${sessions.length} sessions`)

    // 聚合生成日记
    const diaryContent = await this.generateDiaryContent(sessions, dateStr)

    // 写入 memoryStore
    const writeSuccess = await memoryStore.write({
      source: 'diary',
      content: diaryContent,
      tags: [`date:${dateStr}`, 'diary'],
      metadata: {
        date: dateStr,
        sessionCount: sessions.length,
        generatedAt: Date.now(),
      },
    })

    if (writeSuccess) {
      localStorage.setItem(DIARY_STORAGE_KEY, dateStr)
      console.log(`[DiaryService] Diary for ${dateStr} generated and saved`)
    } else {
      console.warn(`[DiaryService] Failed to save diary for ${dateStr}`)
    }

    return diaryContent
  }

  /**
   * 应用启动时自动检查：如果昨天有 session 记忆但没有日记，自动生成
   */
  async autoGenerateYesterdayDiary(): Promise<void> {
    const yesterday = getYesterday()
    const dateStr = formatDate(yesterday)

    // 检查是否今天已经尝试过
    const lastGenerated = localStorage.getItem(DIARY_STORAGE_KEY)
    if (lastGenerated === dateStr) return

    try {
      await this.generateDiary(yesterday)
    } catch (error) {
      console.warn('[DiaryService] Auto-generate yesterday diary failed:', error)
    }
  }

  /**
   * 获取所有已生成的日记列表
   */
  async listDiaries(): Promise<DiaryEntry[]> {
    const results = await memoryStore.search({
      query: '*',
      sources: ['diary'],
      maxResults: 100,
      minScore: 0,
      useMmr: false,
    })

    return results
      .map(result => {
        const dateTag = Array.isArray(result.tags)
          ? result.tags.find(t => t.startsWith('date:'))
          : undefined
        const date = dateTag?.replace('date:', '') || ''
        return {
          id: result.id,
          date,
          content: result.content || result.snippet || '',
          sessionCount: (result.metadata?.sessionCount as number) || 0,
          generatedAt: (result.metadata?.generatedAt as number) || result.createdAt || 0,
          raw: result,
        }
      })
      .filter(entry => entry.date)
      .sort((a, b) => b.date.localeCompare(a.date))
  }

  /**
   * 为今天生成日记（手动触发，即使当天还没结束也可以生成"截至目前"的日记）
   */
  async generateTodayDiary(): Promise<string | null> {
    const today = new Date()
    const dateStr = formatDate(today)

    // 今天的日记允许覆盖（因为当天还在进行中）
    const sessions = await this.fetchSessionsForDay(today)
    if (sessions.length === 0) {
      return null
    }

    const diaryContent = await this.generateDiaryContent(sessions, dateStr)

    await memoryStore.write({
      source: 'diary',
      content: diaryContent,
      tags: [`date:${dateStr}`, 'diary'],
      metadata: {
        date: dateStr,
        sessionCount: sessions.length,
        generatedAt: Date.now(),
        isPartial: true,
      },
    })

    return diaryContent
  }
}

// 导出单例
export const diaryService = new DiaryServiceImpl()
