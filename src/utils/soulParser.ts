/**
 * SOUL.md 解析器
 * 将 SOUL.md Markdown 内容解析为结构化数据
 */

import type { SoulIdentity, SoulTruth, SoulBoundary } from '@/types'

export interface ParsedSoul {
  title: string           // "Who You Are" 部分的标题
  subtitle: string        // "You're not a chatbot..." 描述
  coreTruths: SoulTruth[]
  boundaries: SoulBoundary[]
  vibeStatement: string
  continuityNote: string
  rawContent: string      // 原始内容备份
}

/**
 * 解析 SOUL.md 内容
 */
export function parseSoulMd(content: string): ParsedSoul {
  const result: ParsedSoul = {
    title: '',
    subtitle: '',
    coreTruths: [],
    boundaries: [],
    vibeStatement: '',
    continuityNote: '',
    rawContent: content,
  }

  if (!content || typeof content !== 'string') {
    return result
  }

  const lines = content.split('\n')
  let currentSection = ''
  let currentTruthText = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    
    // 跳过空行
    if (!line) {
      // 如果在解析 truth，空行可能意味着当前 truth 结束
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }
      continue
    }

    // 解析标题行 (# SOUL.md - Who You Are)
    if (line.startsWith('# ')) {
      const titleMatch = line.match(/^#\s*SOUL\.md\s*[-–—]\s*(.+)$/i)
      if (titleMatch) {
        result.title = titleMatch[1].trim()
      } else {
        result.title = line.slice(2).trim()
      }
      continue
    }

    // 解析二级标题 (## Section)
    if (line.startsWith('## ')) {
      // 保存之前的 truth
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }

      const sectionName = line.slice(3).trim().toLowerCase()
      // 支持多种格式: Core Truths, Core Principles, Core Values 等
      if (sectionName.includes('core truth') || sectionName.includes('core principle') || sectionName.includes('core value') || sectionName.includes('principles')) {
        currentSection = 'truths'
      // 支持多种格式: Boundaries, Safety Rules, Constraints 等
      } else if (sectionName.includes('boundar') || sectionName.includes('safety') || sectionName.includes('rule') || sectionName.includes('constraint')) {
        currentSection = 'boundaries'
      } else if (sectionName.includes('vibe') || sectionName.includes('personality') || sectionName.includes('style')) {
        currentSection = 'vibe'
      } else if (sectionName.includes('continuit') || sectionName.includes('memory') || sectionName.includes('context')) {
        currentSection = 'continuity'
      } else {
        currentSection = sectionName
      }
      continue
    }

    // 检测非标题的章节标识 (Core Truths 没有 ## 前缀的情况)
    if (line === 'Core Truths') {
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }
      currentSection = 'truths'
      continue
    }
    if (line === 'Boundaries') {
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }
      currentSection = 'boundaries'
      continue
    }
    if (line === 'Vibe') {
      currentSection = 'vibe'
      continue
    }
    if (line === 'Continuity') {
      currentSection = 'continuity'
      continue
    }

    // 解析副标题 (You're not a chatbot...)
    if (!result.subtitle && line.startsWith("You're") && !currentSection) {
      result.subtitle = line
      continue
    }

    // 根据当前章节解析内容
    switch (currentSection) {
      case 'truths':
        // Core Truths - 每条以粗体开头、列表项或普通段落
        // 支持 - 或 * 开头的列表项
        const truthLine = line.replace(/^[-\*]\s*/, '').trim()
        if (line.startsWith('-') || line.startsWith('*')) {
          // 列表项格式
          if (currentTruthText) {
            const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
            if (truth) result.coreTruths.push(truth)
          }
          currentTruthText = truthLine
        } else if (line.startsWith('**') || line.match(/^[A-Z][a-z]/)) {
          // 保存之前的 truth
          if (currentTruthText) {
            const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
            if (truth) result.coreTruths.push(truth)
          }
          currentTruthText = line
        } else if (currentTruthText) {
          // 继续当前 truth 的描述
          currentTruthText += ' ' + line
        } else {
          currentTruthText = line
        }
        break

      case 'boundaries':
        // Boundaries - 以 ● 或 - 或 * 开头
        const boundaryText = line.replace(/^[●\-\*]\s*/, '').trim()
        if (boundaryText) {
          result.boundaries.push({
            id: `boundary-${result.boundaries.length}`,
            rule: boundaryText,
          })
        }
        break

      case 'vibe':
        // Vibe 通常是一段话
        if (!result.vibeStatement) {
          result.vibeStatement = line
        } else {
          result.vibeStatement += ' ' + line
        }
        break

      case 'continuity':
        // Continuity 说明
        if (!result.continuityNote) {
          result.continuityNote = line
        } else {
          result.continuityNote += ' ' + line
        }
        break
    }
  }

  // 处理最后一个 truth
  if (currentTruthText && currentSection === 'truths') {
    const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
    if (truth) result.coreTruths.push(truth)
  }

  return result
}

/**
 * 解析单条 Core Truth
 * 格式: "**Title.** Description..." 或 "Title. Description..."
 */
function parseTruthLine(text: string, index: number): SoulTruth | null {
  if (!text) return null

  // 尝试匹配 **Bold title.** description 格式
  const boldMatch = text.match(/^\*\*(.+?)\*\*\.?\s*(.*)$/)
  if (boldMatch) {
    return {
      id: `truth-${index}`,
      title: extractTitle(boldMatch[1]),
      principle: boldMatch[1].trim(),
      description: boldMatch[2].trim() || boldMatch[1].trim(),
    }
  }

  // 尝试匹配 "Sentence. More sentences." 格式
  // 第一句作为 principle，其余作为 description
  const sentences = text.split(/(?<=[.!?])\s+/)
  if (sentences.length >= 1) {
    const firstSentence = sentences[0].trim()
    const rest = sentences.slice(1).join(' ').trim()
    
    return {
      id: `truth-${index}`,
      title: extractTitle(firstSentence),
      principle: firstSentence,
      description: rest || firstSentence,
    }
  }

  return {
    id: `truth-${index}`,
    title: text.slice(0, 30),
    principle: text,
    description: text,
  }
}

/**
 * 从句子中提取简短标题
 */
function extractTitle(sentence: string): string {
  // 移除 markdown 格式
  let clean = sentence.replace(/\*\*/g, '').trim()
  
  // 如果以 "Be " 开头，提取关键词
  if (clean.toLowerCase().startsWith('be ')) {
    const words = clean.split(' ').slice(1, 3)
    return words.join(' ')
  }
  
  // 如果以 "Have " 开头
  if (clean.toLowerCase().startsWith('have ')) {
    return clean.split(' ').slice(1, 2).join(' ')
  }
  
  // 如果以 "Remember " 开头
  if (clean.toLowerCase().startsWith('remember ')) {
    return 'Remember'
  }
  
  // 如果以 "Earn " 开头
  if (clean.toLowerCase().startsWith('earn ')) {
    return 'Earn trust'
  }

  // 默认取前几个词
  const words = clean.split(' ')
  if (words.length <= 3) return clean
  return words.slice(0, 3).join(' ') + '...'
}

/**
 * 从 ParsedSoul 生成用于 UI 显示的 SoulIdentity
 */
export function parsedSoulToIdentity(
  parsed: ParsedSoul,
  agentName?: string,
  agentEmoji?: string
): SoulIdentity {
  return {
    name: agentName || 'DunCrew Agent',
    essence: parsed.subtitle || parsed.title || 'AI Assistant',
    vibe: extractVibeKeywords(parsed.vibeStatement),
    symbol: agentEmoji || '🤖',
  }
}

/**
 * 从 vibe statement 中提取关键词
 */
function extractVibeKeywords(vibeStatement: string): string {
  if (!vibeStatement) return ''
  
  // 提取描述性词汇
  const keywords: string[] = []
  
  if (vibeStatement.toLowerCase().includes('concise')) keywords.push('简洁')
  if (vibeStatement.toLowerCase().includes('thorough')) keywords.push('深入')
  if (vibeStatement.toLowerCase().includes('good')) keywords.push('可靠')
  if (vibeStatement.toLowerCase().includes('helpful')) keywords.push('乐于助人')
  if (vibeStatement.toLowerCase().includes('not a sycophant')) keywords.push('真诚')
  
  return keywords.length > 0 ? keywords.join('、') : vibeStatement.slice(0, 50)
}
