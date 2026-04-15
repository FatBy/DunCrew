/**
 * 崩溃监控服务
 * 捕获全局错误、未处理的 Promise rejection，并记录崩溃日志
 */

interface CrashLog {
  timestamp: string
  type: 'error' | 'unhandledrejection' | 'react-error'
  message: string
  stack?: string
  componentStack?: string
  url: string
  userAgent: string
}

const CRASH_LOG_KEY = 'duncrew_crash_logs'
const MAX_CRASH_LOGS = 10

class CrashMonitor {
  private initialized = false
  private _unhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null
  private _beforeunloadHandler: (() => void) | null = null

  /**
   * 初始化崩溃监控
   */
  init(): void {
    if (this.initialized) return
    this.initialized = true

    // 监听全局 JavaScript 错误
    window.onerror = (message, source, lineno, colno, error) => {
      this.logCrash({
        type: 'error',
        message: typeof message === 'string' ? message : 'Unknown error',
        stack: error?.stack || `at ${source}:${lineno}:${colno}`,
      })
      // 返回 true 阻止默认处理，避免控制台重复输出
      return false
    }

    // 监听未处理的 Promise rejection（命名函数，支持 removeEventListener）
    this._unhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const reason = event.reason
      this.logCrash({
        type: 'unhandledrejection',
        message: reason?.message || String(reason) || 'Unhandled Promise rejection',
        stack: reason?.stack,
      })
    }
    window.addEventListener('unhandledrejection', this._unhandledRejectionHandler)

    // 监听 beforeunload 事件，检测非正常退出（命名函数，支持 removeEventListener）
    this._beforeunloadHandler = () => {
      // 标记正常退出
      sessionStorage.setItem('duncrew_clean_exit', 'true')
    }
    window.addEventListener('beforeunload', this._beforeunloadHandler)

    // 检查上次是否正常退出
    const cleanExit = sessionStorage.getItem('duncrew_clean_exit')
    if (cleanExit !== 'true') {
      // 上次非正常退出，可能是崩溃
      const lastSession = localStorage.getItem('duncrew_last_session_time')
      if (lastSession) {
        const elapsed = Date.now() - parseInt(lastSession, 10)
        // 如果上次会话时间距离现在不到 5 分钟，可能是崩溃重启
        if (elapsed < 5 * 60 * 1000) {
          console.warn('[CrashMonitor] Possible crash detected from previous session')
        }
      }
    }
    
    // 清除退出标记，记录新会话时间
    sessionStorage.removeItem('duncrew_clean_exit')
    localStorage.setItem('duncrew_last_session_time', String(Date.now()))

    console.log('[CrashMonitor] Initialized')
  }

  /**
   * 记录崩溃日志
   */
  logCrash(info: { type: CrashLog['type']; message: string; stack?: string; componentStack?: string }): void {
    const crashLog: CrashLog = {
      timestamp: new Date().toISOString(),
      type: info.type,
      message: info.message,
      stack: info.stack,
      componentStack: info.componentStack,
      url: window.location.href,
      userAgent: navigator.userAgent,
    }

    // 读取现有日志
    const logs = this.getCrashLogs()
    
    // 添加新日志，保留最近 N 条
    logs.unshift(crashLog)
    while (logs.length > MAX_CRASH_LOGS) {
      logs.pop()
    }

    // 保存
    try {
      localStorage.setItem(CRASH_LOG_KEY, JSON.stringify(logs))
    } catch (e) {
      // localStorage 可能已满，清理旧数据
      console.error('[CrashMonitor] Failed to save crash log:', e)
    }

    // 输出到控制台
    console.error(`[CrashMonitor] ${info.type}:`, info.message)
    if (info.stack) {
      console.error('[CrashMonitor] Stack:', info.stack)
    }
  }

  /**
   * 从 React ErrorBoundary 记录错误
   */
  logReactError(error: Error, componentStack?: string): void {
    this.logCrash({
      type: 'react-error',
      message: error.message,
      stack: error.stack,
      componentStack,
    })
  }

  /**
   * 获取崩溃日志
   */
  getCrashLogs(): CrashLog[] {
    try {
      const data = localStorage.getItem(CRASH_LOG_KEY)
      return data ? JSON.parse(data) : []
    } catch {
      return []
    }
  }

  /**
   * 清除崩溃日志
   */
  clearCrashLogs(): void {
    localStorage.removeItem(CRASH_LOG_KEY)
  }

  /**
   * 检查是否有最近的崩溃
   */
  hasRecentCrash(withinMs: number = 60000): boolean {
    const logs = this.getCrashLogs()
    if (logs.length === 0) return false
    
    const latest = new Date(logs[0].timestamp).getTime()
    return Date.now() - latest < withinMs
  }

  /**
   * 获取最近一次崩溃信息
   */
  getLatestCrash(): CrashLog | null {
    const logs = this.getCrashLogs()
    return logs[0] || null
  }

  /**
   * 销毁监控，移除事件监听器
   */
  destroy(): void {
    if (this._unhandledRejectionHandler) {
      window.removeEventListener('unhandledrejection', this._unhandledRejectionHandler)
      this._unhandledRejectionHandler = null
    }
    if (this._beforeunloadHandler) {
      window.removeEventListener('beforeunload', this._beforeunloadHandler)
      this._beforeunloadHandler = null
    }
    window.onerror = null
    this.initialized = false
  }
}

export const crashMonitor = new CrashMonitor()
