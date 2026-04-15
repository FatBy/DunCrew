/**
 * Task Complexity Classifier
 *
 * 多维度评分分类器，替代旧的字符串长度 + 正则判断。
 * 输出三档分类 + ContextNeeds，驱动后续的 Planning 和按需上下文加载。
 *
 * 分类结果：
 *   chat    — 纯对话/问答，跳过 ReAct 循环
 *   normal  — 标准工具任务，走 ReAct + system prompt 软约束规划
 *   complex — 多步骤复杂任务，先做 Planning LLM 调用再走 ReAct
 */

import type { DunEntity } from '@/types'

// ============================================
// 类型定义
// ============================================

/** 按需上下文加载配置 */
export interface ContextNeeds {
  /** Dun SOP + 规则引擎 + 性能洞察 + dunCommunicationHint + sopEvolution */
  dunSOP: boolean
  /** L0 核心记忆 + Dun 最近记忆 */
  memory: boolean
  /** 历史成功案例 + exec_trace */
  execTraces: boolean
  /** 已知文件路径注册表 */
  fileRegistry: boolean
  /** 技能文档匹配 */
  skills: boolean
  /** 用户偏好修正案 */
  amendments: boolean
}

/** 各维度评分明细 */
export interface ClassificationSignals {
  /** 纯对话信号强度（越高越像对话） */
  chatScore: number
  /** 多步骤信号强度（越高越复杂） */
  multiStepScore: number
  /** 操作范围信号（涉及的操作类型数） */
  scopeScore: number
  /** Dun 匹配信号 */
  dunScore: number
  /** 上下文信号（续联/粘贴等修正） */
  contextScore: number
}

/** 分类结果 */
export interface TaskClassification {
  level: 'chat' | 'normal' | 'complex'
  signals: ClassificationSignals
  contextNeeds: ContextNeeds
}

// ============================================
// 多步骤结构信号模式
// ============================================

const MULTI_STEP_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  // 复合连接词（用户明确描述了多步顺序）— 高权重
  { pattern: /先.*然后.*再/, weight: 3 },
  { pattern: /先.*然后.*最后/, weight: 3 },
  { pattern: /先.*接着.*再/, weight: 3 },
  { pattern: /first.*then.*finally/i, weight: 3 },

  // 用户自己列了步骤 — 高权重
  { pattern: /第[一二三四五六七八九十]步/, weight: 3 },
  { pattern: /\d+[.、]\s*.+[\n,，]\s*\d+[.、]/, weight: 3 },
  { pattern: /step\s+\d+/i, weight: 3 },

  // 双连接词（两个动作的顺序关系）— 中权重
  { pattern: /然后.*再|先.*然后|接着.*最后/, weight: 2 },
  { pattern: /then.*after that|first.*then/i, weight: 2 },
  { pattern: /批量|全部|所有文件|每个|逐一|遍历/, weight: 2 },
  { pattern: /完整的|从头到尾|端到端|全流程/, weight: 2 },
  { pattern: /并且.*同时|一方面.*另一方面/, weight: 2 },

  // 单连接词（弱顺序信号）— 低权重
  { pattern: /然后|接着|之后|最后|完成后|做完/, weight: 1 },
  { pattern: /同时|还要|另外|此外/, weight: 1 },
  { pattern: /then|after that|finally|afterwards|and then|next/i, weight: 1 },
  { pattern: /additionally|also|moreover/i, weight: 1 },
]

// ============================================
// 操作类型分类
// ============================================

const OPERATION_CATEGORIES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'file_read', pattern: /读取|查看|打开|看看|read|view|open|cat/i },
  { name: 'file_write', pattern: /写入|创建|修改|编辑|保存|替换|write|create|modify|edit|save|replace/i },
  { name: 'file_delete', pattern: /删除|移除|清理|delete|remove|clean/i },
  { name: 'search', pattern: /搜索|查找|查询|检索|search|find|query|grep/i },
  { name: 'execute', pattern: /运行|执行|启动|部署|测试|run|execute|start|deploy|test/i },
  { name: 'analyze', pattern: /分析|检查|审查|诊断|analyze|check|review|diagnose/i },
  { name: 'web', pattern: /网页|网站|URL|下载|爬取|web|url|download|fetch|crawl/i },
  { name: 'config', pattern: /配置|设置|安装|环境|config|setup|install|env/i },
]

// ============================================
// 纯对话检测模式
// ============================================

/** 问候/确认/感谢 — 强对话信号 */
const GREETING_PATTERN = /^(你好|嗨|hi|hello|hey|谢谢|感谢|thanks|thank you|ok|好的|嗯|明白|收到|了解|知道了|没问题|可以|行|对|是的|不是|不用|算了)[\s!！。.？?~～]*$/i

/** 纯疑问句开头 — 中对话信号 */
const QUESTION_PREFIX_PATTERN = /^(什么是|怎么理解|为什么|是不是|有没有|能不能解释|你觉得|你认为|请问|what is|what are|how does|how do|why|explain|could you explain|can you tell me|do you think)/i

/** 操作动词 — 如果出现则不是纯对话 */
const ACTION_VERB_PATTERN = /帮我|请.*(?:创建|修改|搜索|分析|部署|配置|运行|执行|写|读|删|查|找|改|加|装|替换|重命名|移动|复制)|代码|文件|创建|修改|搜索|分析|部署|配置|运行|执行|写入|读取|删除|安装|下载|编译|构建|create|modify|search|analyze|deploy|run|write|read|delete|fix|install|add|build|compile|execute|replace|rename|move|copy/i

// ============================================
// 主分类函数
// ============================================

/**
 * 多维度任务复杂度分类器
 *
 * @param query - 用户输入
 * @param matchedDun - dunManager.matchForTask() 自动匹配的 Dun（可能为 null）
 * @param activeDunId - 用户当前所在的 Dun 会话 ID（通过 dunId 参数或 getActiveDunId）
 * @param conversationHistory - 当前会话的历史消息
 */
export function classifyTaskComplexity(
  query: string,
  matchedDun: DunEntity | null,
  activeDunId: string | null,
  conversationHistory?: Array<{ role: string; content: string }>,
): TaskClassification {
  const queryTrimmed = query.trim()
  const queryLower = queryTrimmed.toLowerCase()

  const signals: ClassificationSignals = {
    chatScore: 0,
    multiStepScore: 0,
    scopeScore: 0,
    dunScore: 0,
    contextScore: 0,
  }

  // ═══════════════════════════════════════
  // 维度 1: 纯对话信号（正向 = 更像对话）
  // ═══════════════════════════════════════

  if (GREETING_PATTERN.test(queryTrimmed)) {
    signals.chatScore += 5
  }

  if (QUESTION_PREFIX_PATTERN.test(queryTrimmed) && !ACTION_VERB_PATTERN.test(queryTrimmed)) {
    signals.chatScore += 3
  }

  // 短文本 + 无操作动词
  if (queryTrimmed.length < 15 && !ACTION_VERB_PATTERN.test(queryTrimmed)) {
    signals.chatScore += 2
  }

  // ═══════════════════════════════════════
  // 维度 2: 多步骤结构信号（正向 = 更复杂）
  // ═══════════════════════════════════════

  for (const { pattern, weight } of MULTI_STEP_PATTERNS) {
    if (pattern.test(query)) {
      signals.multiStepScore += weight
    }
  }

  // ═══════════════════════════════════════
  // 维度 3: 操作范围信号
  // ═══════════════════════════════════════

  const matchedCategoryCount = OPERATION_CATEGORIES.filter(
    category => category.pattern.test(queryLower),
  ).length

  if (matchedCategoryCount >= 3) {
    signals.scopeScore += 3
  } else if (matchedCategoryCount >= 2) {
    signals.scopeScore += 1
  }

  // ═══════════════════════════════════════
  // 维度 4: Dun 匹配信号
  // ═══════════════════════════════════════

  const hasDun = !!matchedDun || !!activeDunId

  if (hasDun) {
    signals.dunScore += 1
    if (matchedDun?.sopContent) {
      signals.dunScore += 1
    }
  }

  // ═══════════════════════════════════════
  // 维度 5: 会话上下文信号
  // ═══════════════════════════════════════

  if (conversationHistory && conversationHistory.length > 0) {
    const isContinuation = /^(继续|接着|上次|还有|然后|go on|continue|resume)/i.test(queryTrimmed)
    if (isContinuation) {
      signals.contextScore -= 2
    }
  }

  // 用户粘贴了大段代码/报错 — 不代表任务复杂，防止误判
  const hasLargeCodeBlock = /```[\s\S]{200,}```/.test(query)
    || /\n\s{2,}\S[\s\S]{200,}/.test(query)
  if (hasLargeCodeBlock) {
    signals.contextScore -= 1
  }

  // ═══════════════════════════════════════
  // 综合判定
  // ═══════════════════════════════════════

  const complexScore = signals.multiStepScore
    + signals.scopeScore
    + signals.dunScore
    + signals.contextScore

  let level: 'chat' | 'normal' | 'complex'

  if (signals.chatScore >= 4) {
    level = 'chat'
  } else if (
    complexScore >= 4
    || (signals.multiStepScore >= 2 && signals.scopeScore >= 1)
  ) {
    level = 'complex'
  } else {
    level = 'normal'
  }

  // ═══════════════════════════════════════
  // 按分类生成 ContextNeeds
  // ═══════════════════════════════════════

  const contextNeeds: ContextNeeds = level === 'chat'
    ? {
        dunSOP: false,
        memory: false,
        execTraces: false,
        fileRegistry: false,
        skills: false,
        amendments: false,
      }
    : {
        dunSOP: hasDun,
        memory: true,
        execTraces: level === 'complex',
        fileRegistry: true,
        skills: true,
        amendments: level === 'complex',
      }

  return { level, signals, contextNeeds }
}
