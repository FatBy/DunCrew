/**
 * 执行日志管理器
 * 提供结构化的任务执行日志记录和查询功能
 */

// 执行事件类型
export type ExecutionEvent =
  | 'task_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_paused'
  | 'task_resumed'
  | 'task_retrying'
  | 'task_terminated'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'tool_called'
  | 'tool_succeeded'
  | 'tool_failed'
  | 'checkpoint_saved'
  | 'checkpoint_restored'

// 日志级别
export type LogLevel = 'info' | 'warn' | 'error' | 'debug'

// 执行日志条目
export interface ExecutionLogEntry {
  id: string
  taskId: string
  timestamp: number
  level: LogLevel
  event: ExecutionEvent
  message?: string
  data?: Record<string, unknown>
}

// 执行统计
export interface ExecutionStats {
  totalTasks: number
  runningTasks: number
  successCount: number
  failureCount: number
  avgDuration: number      // 毫秒
  successRate: number      // 0-100
  queueDepth: number
}

// 任务持续时间追踪
interface TaskDuration {
  taskId: string
  startTime: number
  endTime?: number
  success?: boolean
}

const STORAGE_KEY = 'duncrew_execution_logs'
const MAX_LOGS = 500
const MAX_DURATIONS = 100

class ExecutionLoggerClass {
  private logs: ExecutionLogEntry[] = []
  private taskDurations: TaskDuration[] = []
  private listeners: Set<(logs: ExecutionLogEntry[]) => void> = new Set()

  constructor() {
    this.loadFromStorage()
  }

  /**
   * 从 localStorage 加载日志
   */
  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored) {
        const data = JSON.parse(stored)
        this.logs = data.logs || []
        this.taskDurations = data.durations || []
      }
    } catch (e) {
      console.warn('[ExecutionLogger] Failed to load from storage:', e)
    }
  }

  /**
   * 保存日志到 localStorage
   */
  private saveToStorage(): void {
    try {
      const data = {
        logs: this.logs.slice(-MAX_LOGS),
        durations: this.taskDurations.slice(-MAX_DURATIONS)
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (e) {
      console.warn('[ExecutionLogger] Failed to save to storage:', e)
    }
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * 记录日志
   */
  log(
    taskId: string,
    event: ExecutionEvent,
    data?: Record<string, unknown>,
    level: LogLevel = 'info',
    message?: string
  ): void {
    const entry: ExecutionLogEntry = {
      id: this.generateId(),
      taskId,
      timestamp: Date.now(),
      level,
      event,
      message,
      data
    }

    this.logs.push(entry)

    // 处理任务开始/结束时间追踪
    if (event === 'task_started') {
      this.taskDurations.push({ taskId, startTime: Date.now() })
    } else if (event === 'task_completed' || event === 'task_failed' || event === 'task_terminated') {
      const duration = this.taskDurations.find(d => d.taskId === taskId && !d.endTime)
      if (duration) {
        duration.endTime = Date.now()
        duration.success = event === 'task_completed'
      }
    }

    // 限制日志数量
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(-MAX_LOGS)
    }
    if (this.taskDurations.length > MAX_DURATIONS) {
      this.taskDurations = this.taskDurations.slice(-MAX_DURATIONS)
    }

    // 保存并通知监听器
    this.saveToStorage()
    this.notifyListeners()
  }

  /**
   * 快捷方法：记录任务开始
   */
  taskStarted(taskId: string, title?: string): void {
    this.log(taskId, 'task_started', { title }, 'info', `任务开始: ${title || taskId}`)
  }

  /**
   * 快捷方法：记录任务完成
   */
  taskCompleted(taskId: string, result?: string): void {
    this.log(taskId, 'task_completed', { result }, 'info', '任务完成')
  }

  /**
   * 快捷方法：记录任务失败
   */
  taskFailed(taskId: string, error: string): void {
    this.log(taskId, 'task_failed', { error }, 'error', `任务失败: ${error}`)
  }

  /**
   * 快捷方法：记录工具调用
   */
  toolCalled(taskId: string, toolName: string, args?: Record<string, unknown>): void {
    this.log(taskId, 'tool_called', { toolName, args }, 'debug', `调用工具: ${toolName}`)
  }

  /**
   * 快捷方法：记录工具成功
   */
  toolSucceeded(taskId: string, toolName: string, result?: unknown): void {
    this.log(taskId, 'tool_succeeded', { toolName, result }, 'info', `工具成功: ${toolName}`)
  }

  /**
   * 快捷方法：记录工具失败
   */
  toolFailed(taskId: string, toolName: string, error: string): void {
    this.log(taskId, 'tool_failed', { toolName, error }, 'warn', `工具失败: ${toolName} - ${error}`)
  }

  /**
   * 获取指定任务的日志
   */
  getTaskLogs(taskId: string): ExecutionLogEntry[] {
    return this.logs.filter(log => log.taskId === taskId)
  }

  /**
   * 获取最近日志
   */
  getRecentLogs(limit: number = 50): ExecutionLogEntry[] {
    return this.logs.slice(-limit)
  }

  /**
   * 获取指定级别的日志
   */
  getLogsByLevel(level: LogLevel): ExecutionLogEntry[] {
    return this.logs.filter(log => log.level === level)
  }

  /**
   * 获取执行统计
   */
  getStats(runningTaskIds: string[] = [], queuedTaskIds: string[] = []): ExecutionStats {
    const completedDurations = this.taskDurations.filter(d => d.endTime)
    const successCount = completedDurations.filter(d => d.success).length
    const failureCount = completedDurations.filter(d => d.success === false).length
    const totalCompleted = successCount + failureCount

    // 计算平均耗时
    let avgDuration = 0
    if (completedDurations.length > 0) {
      const totalDuration = completedDurations.reduce((sum, d) => {
        return sum + ((d.endTime || 0) - d.startTime)
      }, 0)
      avgDuration = totalDuration / completedDurations.length
    }

    return {
      totalTasks: this.taskDurations.length,
      runningTasks: runningTaskIds.length,
      successCount,
      failureCount,
      avgDuration,
      successRate: totalCompleted > 0 ? Math.round((successCount / totalCompleted) * 100) : 0,
      queueDepth: queuedTaskIds.length
    }
  }

  /**
   * 清除所有日志
   */
  clear(): void {
    this.logs = []
    this.taskDurations = []
    this.saveToStorage()
    this.notifyListeners()
  }

  /**
   * 清除指定任务的日志
   */
  clearTaskLogs(taskId: string): void {
    this.logs = this.logs.filter(log => log.taskId !== taskId)
    this.taskDurations = this.taskDurations.filter(d => d.taskId !== taskId)
    this.saveToStorage()
    this.notifyListeners()
  }

  /**
   * 订阅日志更新
   */
  subscribe(listener: (logs: ExecutionLogEntry[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.logs)
      } catch (e) {
        console.error('[ExecutionLogger] Listener error:', e)
      }
    })
  }

  /**
   * 获取所有日志（用于调试）
   */
  getAllLogs(): ExecutionLogEntry[] {
    return [...this.logs]
  }
}

// 导出单例
export const executionLogger = new ExecutionLoggerClass()
