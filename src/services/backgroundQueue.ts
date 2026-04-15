/**
 * 后台 LLM 串行执行队列
 *
 * 所有后台 LLM 调用（flush、ingest、soul evolution 等）通过此队列串行执行，
 * 避免多个后台服务同时轰炸 API 导致限流。
 *
 * 特性：
 * - 串行执行（maxConcurrent = 1）
 * - 请求间最小间隔（正常 2s，限流后自适应拉长）
 * - 优先级排序（数字越小越优先）
 * - 渐进式限流退避（连续 429 时暂停时间递增）
 * - AbortSignal 支持（可取消排队中的任务）
 * - 队列长度保护（超过 MAX_QUEUE_SIZE 时丢弃低优先级）
 */

import type { LLMConfig } from '@/types'
import type { SimpleChatMessage } from './llmService'
import { withExponentialBackoff, is429Error } from '@/utils/retryUtils'

// ============================================
// 配置
// ============================================

const MIN_INTERVAL_MS = 2000
/** 限流后的冷却间隔：连续 429 后拉大请求间距 */
const COOLDOWN_INTERVAL_MS = 8000
/** 冷却状态持续时间：最后一次 429 后多久恢复正常间隔 */
const COOLDOWN_DECAY_MS = 120_000
const BASE_PAUSE_MS = 30_000
/** 渐进式暂停上限 */
const MAX_PAUSE_MS = 180_000
const MAX_QUEUE_SIZE = 30

// ============================================
// Types
// ============================================

interface EnqueueOptions {
  config?: Partial<LLMConfig>
  signal?: AbortSignal
  priority?: number
}

interface QueueTask {
  messages: SimpleChatMessage[]
  config?: Partial<LLMConfig>
  signal?: AbortSignal
  priority: number
  resolve: (value: string | null) => void
  reject: (reason: unknown) => void
}

// ============================================
// chat 函数注入（避免循环依赖）
// ============================================

type ChatFn = (
  messages: SimpleChatMessage[],
  config?: Partial<LLMConfig>,
) => Promise<string>

let _chatFn: ChatFn | null = null

/** 由 llmService 初始化时调用，注入 chat 函数引用 */
export function injectChatFn(fn: ChatFn): void {
  _chatFn = fn
}

function getChatFn(): ChatFn {
  if (!_chatFn) {
    throw new Error('[BackgroundQueue] chat 函数未注入，请确保 llmService 已初始化')
  }
  return _chatFn
}

// ============================================
// BackgroundQueue
// ============================================

class BackgroundQueue {
  private queue: QueueTask[] = []
  private processing = false
  private pausedUntil = 0
  /** 连续 429 次数，用于渐进式退避 */
  private consecutive429Count = 0
  /** 最后一次 429 的时间戳 */
  private last429Timestamp = 0

  /** 当前排队数量 */
  get pendingCount(): number {
    return this.queue.length
  }

  /** 当前是否处于限流冷却状态 */
  get isInCooldown(): boolean {
    return Date.now() - this.last429Timestamp < COOLDOWN_DECAY_MS
  }

  /**
   * 将一个后台 LLM 调用入队
   *
   * @returns LLM 响应文本，失败时返回 null（不向上抛异常）
   */
  enqueue(
    messages: SimpleChatMessage[],
    options?: EnqueueOptions,
  ): Promise<string | null> {
    const { config, signal, priority = 10 } = options ?? {}

    // 已取消的任务直接返回 null
    if (signal?.aborted) {
      return Promise.resolve(null)
    }

    return new Promise<string | null>((resolve, reject) => {
      const task: QueueTask = {
        messages,
        config,
        signal,
        priority,
        resolve,
        reject,
      }

      // 按优先级插入（低数字 = 高优先级 → 排在前面）
      const insertIdx = this.queue.findIndex(t => t.priority > priority)
      if (insertIdx === -1) {
        this.queue.push(task)
      } else {
        this.queue.splice(insertIdx, 0, task)
      }

      // 队列过长时丢弃尾部（最低优先级）
      while (this.queue.length > MAX_QUEUE_SIZE) {
        const dropped = this.queue.pop()!
        dropped.resolve(null)
        console.warn(`[BackgroundQueue] 队列已满，丢弃低优先级任务 (priority=${dropped.priority})`)
      }

      // 启动处理循环
      if (!this.processing) {
        this.processNext()
      }
    })
  }

  /** 触发全局暂停（429 限流时调用），暂停时间随连续 429 次数递增 */
  pauseForRateLimit(): void {
    this.consecutive429Count++
    this.last429Timestamp = Date.now()
    // 渐进式暂停: 30s → 60s → 120s → 180s (上限)
    const pauseMs = Math.min(
      BASE_PAUSE_MS * Math.pow(2, this.consecutive429Count - 1),
      MAX_PAUSE_MS,
    )
    const until = Date.now() + pauseMs
    if (until > this.pausedUntil) {
      this.pausedUntil = until
      console.warn(`[BackgroundQueue] 检测到 API 限流 (连续第${this.consecutive429Count}次)，全局暂停 ${pauseMs / 1000}s`)
    }
  }

  /** 取消所有排队中的任务（新任务开始时调用） */
  cancelAll(): void {
    const count = this.queue.length
    for (const task of this.queue) {
      task.resolve(null)
    }
    this.queue = []
    if (count > 0) {
      console.log(`[BackgroundQueue] 已取消 ${count} 个排队任务`)
    }
  }

  // ---- 内部处理循环 ----

  private async processNext(): Promise<void> {
    // 队列空检查（首次进入 + sleep 后重新检查）
    if (this.queue.length === 0) {
      this.processing = false
      return
    }

    this.processing = true

    // 全局暂停检查
    const now = Date.now()
    if (now < this.pausedUntil) {
      const waitMs = this.pausedUntil - now
      console.log(`[BackgroundQueue] 限流暂停中，等待 ${Math.ceil(waitMs / 1000)}s`)
      await sleep(waitMs)
    }

    // ★ 关键修复：sleep 期间 cancelAll() 可能清空队列，必须重新检查
    if (this.queue.length === 0) {
      this.processing = false
      return
    }

    // 取出最高优先级任务
    const task = this.queue.shift()!

    // 检查是否已被取消
    if (task.signal?.aborted) {
      console.log('[BackgroundQueue] 任务已取消，跳过')
      task.resolve(null)
      // 立即处理下一个（不需要间隔）
      this.processNext()
      return
    }

    // 执行 LLM 调用（带指数退避重试）
    try {
      const chatFn = getChatFn()
      const result = await withExponentialBackoff(
        () => chatFn(task.messages, task.config),
        {
          maxAttempts: 3,
          baseDelayMs: 4000,
          maxDelayMs: 60000,
          signal: task.signal,
          on429: () => this.pauseForRateLimit(),
        },
      )
      // 成功后重置连续 429 计数
      this.consecutive429Count = 0
      task.resolve(result)
    } catch (err) {
      // AbortError → resolve null（不算错误）
      if (err instanceof DOMException && err.name === 'AbortError') {
        task.resolve(null)
      } else {
        const isRL = is429Error(err)
        console.warn(`[BackgroundQueue] 后台 LLM 调用失败 (rateLimit=${isRL}):`, err)
        task.resolve(null)
      }
    }

    // 请求间间隔：限流冷却期内使用更长间隔
    if (this.queue.length > 0) {
      const interval = this.isInCooldown ? COOLDOWN_INTERVAL_MS : MIN_INTERVAL_MS
      await sleep(interval)
    }

    // 处理下一个
    this.processNext()
  }
}

// ============================================
// Helpers
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ============================================
// 单例导出
// ============================================

export const backgroundQueue = new BackgroundQueue()
