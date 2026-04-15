/**
 * 指数退避重试工具
 *
 * 提供通用的指数退避重试逻辑，支持 429 限流检测和 AbortSignal 取消。
 * 供 BackgroundQueue 和其他需要重试的模块使用。
 */

// ============================================
// Types
// ============================================

export interface RetryOptions {
  /** 最大尝试次数（含首次），默认 3 */
  maxAttempts?: number
  /** 基础延迟（ms），默认 2000 */
  baseDelayMs?: number
  /** 最大延迟上限（ms），默认 30000 */
  maxDelayMs?: number
  /** 取消信号 */
  signal?: AbortSignal
  /** 检测到 429 时的回调（供队列注册全局暂停） */
  on429?: () => void
}

// ============================================
// 429 检测
// ============================================

/**
 * 精准的限流/过载错误 HTTP 状态码
 * 从错误消息中提取 `(NNN)` 格式的状态码进行匹配
 */
const RATE_LIMIT_STATUS_CODES = [429, 529]

/**
 * 文本级限流关键词（仅在无法提取状态码时使用）
 * 注意：只包含明确表示限流/过载的短语，避免误匹配普通错误
 */
const RATE_LIMIT_TEXT_PATTERNS = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'quota exceeded',
  'throttl',
  'overloaded_error',    // Anthropic 限流 error.type
  'overload_error',
  'capacity',            // 容量相关
  '请求过于频繁',
  '请求频率',
  '配额',
]

/** 判断 error 是否为限流/过载错误（429/529 或明确的限流文本） */
export function is429Error(error: unknown): boolean {
  if (!error) return false
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()

  // 优先：从错误消息中提取 HTTP 状态码 `(NNN)`
  const statusMatch = msg.match(/\((\d{3})\)/)
  if (statusMatch) {
    const code = parseInt(statusMatch[1], 10)
    if (RATE_LIMIT_STATUS_CODES.includes(code)) return true
  }

  // 兜底：文本模式匹配（仅限明确的限流关键词）
  return RATE_LIMIT_TEXT_PATTERNS.some(p => msg.includes(p))
}

// ============================================
// 指数退避重试
// ============================================

/**
 * 带指数退避的重试包装器
 *
 * - 退避公式：min(baseDelayMs * 2^attempt + jitter, maxDelayMs)
 * - 429 时使用更激进的退避：baseDelayMs * 4^attempt
 * - 每次重试前检查 signal.aborted
 */
export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 2000,
    maxDelayMs = 30000,
    signal,
    on429,
  } = options ?? {}

  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 检查取消
    if (signal?.aborted) {
      throw new DOMException('Background task aborted', 'AbortError')
    }

    try {
      return await fn()
    } catch (err) {
      lastError = err

      // 最后一次尝试，不再等待
      if (attempt >= maxAttempts - 1) break

      const isRateLimit = is429Error(err)

      // 通知调用方（队列层）触发全局暂停
      if (isRateLimit && on429) {
        on429()
      }

      // 计算延迟：429 用 4^attempt，普通错误用 2^attempt
      const base = isRateLimit
        ? baseDelayMs * Math.pow(4, attempt)
        : baseDelayMs * Math.pow(2, attempt)
      const jitter = Math.random() * 500
      const delay = Math.min(base + jitter, maxDelayMs)

      // 等待，期间可被 abort 打断
      await interruptibleSleep(delay, signal)
    }
  }

  throw lastError
}

// ============================================
// Helpers
// ============================================

/** 可被 AbortSignal 打断的 sleep */
function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Background task aborted', 'AbortError'))
  }

  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined

    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    if (signal) {
      onAbort = () => {
        clearTimeout(timer)
        reject(new DOMException('Background task aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
