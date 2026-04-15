/**
 * SOUL.md 解析器
 * 将 SOUL.md Markdown 内容解析为结构化数据
 * 支持中英文章节标题
 */

import type { SoulIdentity, SoulTruth, SoulBoundary } from '@/types'

export interface ParsedSoul {
  title: string           // 标题部分
  subtitle: string        // 开头自述描述
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

    // 解析标题行 (# SOUL.md - Who You Are / # SOUL.md - 我是谁)
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
      // 支持中英文: Core Truths / 核心准则 / 核心原则
      if (sectionName.includes('core truth') || sectionName.includes('core principle') || sectionName.includes('core value') || sectionName.includes('principles')
        || sectionName.includes('核心准则') || sectionName.includes('核心原则') || sectionName.includes('核心价值')) {
        currentSection = 'truths'
      // 支持中英文: Boundaries / 边界 / 安全规则
      } else if (sectionName.includes('boundar') || sectionName.includes('safety') || sectionName.includes('rule') || sectionName.includes('constraint')
        || sectionName.includes('边界') || sectionName.includes('安全') || sectionName.includes('规则') || sectionName.includes('约束')) {
        currentSection = 'boundaries'
      // 支持中英文: Vibe / 氛围 / 风格
      } else if (sectionName.includes('vibe') || sectionName.includes('personality') || sectionName.includes('style')
        || sectionName.includes('氛围') || sectionName.includes('风格') || sectionName.includes('个性')) {
        currentSection = 'vibe'
      // 支持中英文: Continuity / 连续性 / 记忆
      } else if (sectionName.includes('continuit') || sectionName.includes('memory') || sectionName.includes('context')
        || sectionName.includes('连续') || sectionName.includes('记忆') || sectionName.includes('上下文')) {
        currentSection = 'continuity'
      } else {
        currentSection = sectionName
      }
      continue
    }

    // 检测非标题的章节标识
    if (line === 'Core Truths' || line === '核心准则' || line === '核心原则') {
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }
      currentSection = 'truths'
      continue
    }
    if (line === 'Boundaries' || line === '边界') {
      if (currentTruthText && currentSection === 'truths') {
        const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
        if (truth) result.coreTruths.push(truth)
        currentTruthText = ''
      }
      currentSection = 'boundaries'
      continue
    }
    if (line === 'Vibe' || line === '氛围') {
      currentSection = 'vibe'
      continue
    }
    if (line === 'Continuity' || line === '连续性') {
      currentSection = 'continuity'
      continue
    }

    // 解析副标题（支持中英文开头）
    if (!result.subtitle && !currentSection) {
      // 英文: "You're not a chatbot..."  中文: "我不是..." / "我是..."
      if (line.startsWith("You're") || line.startsWith('我不是') || line.startsWith('我是')) {
        result.subtitle = line
        continue
      }
    }

    // 根据当前章节解析内容
    switch (currentSection) {
      case 'truths': {
        // Core Truths - 每条以粗体开头、列表项或普通段落
        const truthLine = line.replace(/^[-\*]\s*/, '').trim()
        if (line.startsWith('-') || line.startsWith('*')) {
          // 列表项格式
          if (currentTruthText) {
            const truth = parseTruthLine(currentTruthText, result.coreTruths.length)
            if (truth) result.coreTruths.push(truth)
          }
          currentTruthText = truthLine
        } else if (line.startsWith('**') || line.match(/^[A-Z][a-z]/) || line.match(/^[\u4e00-\u9fff]/)) {
          // 粗体开头、英文句子开头、或中文开头 → 新的 truth
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
      }

      case 'boundaries': {
        // Boundaries - 以 ● 或 - 或 * 开头
        const boundaryText = line.replace(/^[●\-\*]\s*/, '').trim()
        if (boundaryText) {
          result.boundaries.push({
            id: `boundary-${result.boundaries.length}`,
            rule: boundaryText,
          })
        }
        break
      }

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

  // 尝试匹配 **Bold title.** description 格式（中英文句号）
  const boldMatch = text.match(/^\*\*(.+?)\*\*[.。]?\s*(.*)$/)
  if (boldMatch) {
    return {
      id: `truth-${index}`,
      title: extractTitle(boldMatch[1]),
      principle: boldMatch[1].trim(),
      description: boldMatch[2].trim() || boldMatch[1].trim(),
    }
  }

  // 尝试匹配 "Sentence. More sentences." 格式（中英文句号）
  const sentences = text.split(/(?<=[.!?。！？])\s*/)
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
  const clean = sentence.replace(/\*\*/g, '').trim()
  
  // 英文模式
  if (clean.toLowerCase().startsWith('be ')) {
    return clean.split(' ').slice(1, 3).join(' ')
  }
  if (clean.toLowerCase().startsWith('have ')) {
    return clean.split(' ').slice(1, 2).join(' ')
  }
  if (clean.toLowerCase().startsWith('remember ')) {
    return 'Remember'
  }
  if (clean.toLowerCase().startsWith('earn ')) {
    return 'Earn trust'
  }

  // 中文模式：取前 8 个字符（中文通常 2-8 字就够）
  if (/^[\u4e00-\u9fff]/.test(clean)) {
    // 如果有句号/逗号，取第一个分句
    const firstClause = clean.split(/[，。、]/)[0]
    if (firstClause && firstClause.length <= 10) return firstClause
    return clean.length <= 10 ? clean : clean.slice(0, 8) + '...'
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
    name: agentName || 'DunCrew 智能体',
    essence: parsed.subtitle || parsed.title || 'AI 助手',
    vibe: extractVibeKeywords(parsed.vibeStatement),
    symbol: agentEmoji || '🤖',
  }
}

/**
 * 从 vibe statement 中提取关键词
 */
function extractVibeKeywords(vibeStatement: string): string {
  if (!vibeStatement) return ''
  
  // 提取描述性词汇（中英文）
  const keywords: string[] = []
  
  if (vibeStatement.toLowerCase().includes('concise') || vibeStatement.includes('简洁')) keywords.push('简洁')
  if (vibeStatement.toLowerCase().includes('thorough') || vibeStatement.includes('深入')) keywords.push('深入')
  if (vibeStatement.toLowerCase().includes('good') || vibeStatement.includes('可靠')) keywords.push('可靠')
  if (vibeStatement.toLowerCase().includes('helpful') || vibeStatement.includes('乐于助人') || vibeStatement.includes('帮助')) keywords.push('乐于助人')
  if (vibeStatement.toLowerCase().includes('not a sycophant') || vibeStatement.includes('真诚') || vibeStatement.includes('诚实') || vibeStatement.includes('应声虫')) keywords.push('真诚')
  if (vibeStatement.includes('精准') || vibeStatement.toLowerCase().includes('precise')) keywords.push('精准')
  
  // 去重
  const unique = [...new Set(keywords)]
  return unique.length > 0 ? unique.join('、') : vibeStatement.slice(0, 50)
}
