/**
 * DunCrew 本地服务通信模块
 * 通过 HTTP API 与 duncrew-server.py 通信
 * 用于执行任务（绕过 WebSocket chat 层，直接调用 claw CLI）
 *
 * 远程访问策略：
 * - 本地开发时直连 http://localhost:3001
 * - 远程访问时通过 Vite 代理 /local-api → localhost:3001
 *   这样浏览器只需连接 Vite dev server 端口，无需额外开放 3001 端口
 *
 * 输出流式策略：
 * - 使用 offset 参数增量读取日志
 * - 每次只获取新产生的内容，避免全量传输
 */

// 自动推断本地服务地址
function getDefaultServerUrl(): string {
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    // 本地开发：直连 3001 端口
    return 'http://localhost:3001'
  }
  // 远程访问：走 Vite 代理，使用相对路径
  // /local-api/* → 代理到 localhost:3001/*
  return '/local-api'
}

// 默认本地服务地址
const DEFAULT_LOCAL_SERVER = getDefaultServerUrl()

// 配置 key
const STORAGE_KEY = 'duncrew_local_server_url'

export interface TaskExecuteResponse {
  taskId: string
  status: 'running' | 'done' | 'error'
}

export interface IncrementalTaskResponse {
  taskId: string
  status: 'running' | 'done' | 'error'
  content: string      // 增量内容 (仅 offset 之后的部分)
  offset: number       // 新的游标位置
  hasMore: boolean     // 是否还有更多内容
  fileSize: number     // 当前日志文件总大小
}

class LocalServerService {
  private baseUrl: string

  constructor() {
    this.baseUrl = localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCAL_SERVER
  }

  /**
   * 设置本地服务地址
   */
  setServerUrl(url: string) {
    this.baseUrl = url.replace(/\/+$/, '') // 移除尾部斜杠
    localStorage.setItem(STORAGE_KEY, this.baseUrl)
  }

  /**
   * 获取当前服务地址
   */
  getServerUrl(): string {
    return this.baseUrl
  }

  /**
   * 检查本地服务是否可用
   */
  async checkStatus(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/status`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * 执行任务
   * POST /task/execute
   */
  async executeTask(prompt: string): Promise<TaskExecuteResponse> {
    const response = await fetch(`${this.baseUrl}/task/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * 查询任务状态 (支持增量读取)
   * GET /task/status/<taskId>?offset=N
   */
  async getTaskStatus(taskId: string, offset = 0): Promise<IncrementalTaskResponse> {
    const response = await fetch(`${this.baseUrl}/task/status/${taskId}?offset=${offset}`, {
      method: 'GET',
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * 轮询任务状态直到完成 (增量模式)
   * @param taskId 任务 ID
   * @param onUpdate 增量更新回调
   * @param intervalMs 轮询间隔 (默认 1500ms)
   * @param maxAttempts 最大尝试次数 (默认 200 次 = 5 分钟)
   */
  async pollTaskStatus(
    taskId: string,
    onUpdate: (response: IncrementalTaskResponse) => void,
    intervalMs = 1500,
    maxAttempts = 200
  ): Promise<IncrementalTaskResponse> {
    let attempts = 0
    let currentOffset = 0

    while (attempts < maxAttempts) {
      try {
        const response = await this.getTaskStatus(taskId, currentOffset)
        
        // 更新游标
        currentOffset = response.offset
        
        // 有新内容或状态变化时回调
        if (response.content || response.status !== 'running') {
          onUpdate(response)
        }

        // 完成条件: 状态已结束 且 没有更多内容
        if ((response.status === 'done' || response.status === 'error') && !response.hasMore) {
          return response
        }
        
        // 还有未读内容时立即继续读取，不等待
        if (response.hasMore) {
          continue
        }
      } catch (error) {
        console.error('[LocalServer] Poll error:', error)
        // 继续重试
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs))
      attempts++
    }

    // 超时
    const timeoutResult: IncrementalTaskResponse = {
      taskId,
      status: 'error',
      content: `\n\n[轮询超时 (${maxAttempts * intervalMs / 1000}s)]`,
      offset: currentOffset,
      hasMore: false,
      fileSize: 0,
    }
    onUpdate(timeoutResult)
    return timeoutResult
  }

  // ============================================
  // 数据持久化 API (存储到 ~/.duncrew/data/)
  // ============================================

  /**
   * 从后端读取持久化数据
   */
  async getData<T>(key: string): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}/data/${key}`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return null
      const result = await response.json()
      return result.exists ? result.value : null
    } catch (error) {
      console.warn(`[LocalServer] Failed to get data "${key}":`, error)
      return null
    }
  }

  /**
   * 向后端写入持久化数据
   */
  async setData<T>(key: string, value: T): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/data/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
        signal: AbortSignal.timeout(10000),
      })
      return response.ok
    } catch (error) {
      console.warn(`[LocalServer] Failed to set data "${key}":`, error)
      return false
    }
  }

  /**
   * 删除后端持久化数据
   */
  async deleteData(key: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/data/${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: null }),
        signal: AbortSignal.timeout(5000),
      })
      return response.ok
    } catch (error) {
      console.warn(`[LocalServer] Failed to delete data "${key}":`, error)
      return false
    }
  }

  // ============================================
  // 对话持久化 API (每对话独立文件存储)
  // ============================================

  /**
   * 获取所有对话元数据列表
   */
  async getConversationMetaList(): Promise<import('@/types').ConversationMeta[]> {
    const meta = await this.getData<import('@/types').ConversationMeta[]>('conversations_meta')
    return meta || []
  }

  /**
   * 获取单个对话完整数据（含 messages）
   */
  async getConversation(id: string): Promise<import('@/types').Conversation | null> {
    return this.getData<import('@/types').Conversation>(`conv_${id}`)
  }

  /**
   * 保存单个对话（完整数据写入 conv_{id}，同时更新元数据列表）
   */
  async saveConversation(conv: import('@/types').Conversation): Promise<boolean> {
    // 写入完整对话数据
    const saved = await this.setData(`conv_${conv.id}`, conv)
    if (!saved) return false

    // 更新元数据列表
    const metaList = await this.getConversationMetaList()
    const meta: import('@/types').ConversationMeta = {
      id: conv.id,
      type: conv.type,
      title: conv.title,
      nexusId: conv.nexusId,
      messageCount: conv.messages.length,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      pinned: conv.pinned,
      autoTitled: conv.autoTitled,
    }

    const idx = metaList.findIndex(m => m.id === conv.id)
    if (idx >= 0) {
      metaList[idx] = meta
    } else {
      metaList.push(meta)
    }
    await this.setData('conversations_meta', metaList)
    return true
  }

  /**
   * 删除对话（删除文件 + 从元数据列表移除）
   */
  async deleteConversation(id: string): Promise<boolean> {
    // 删除对话数据文件
    await this.deleteData(`conv_${id}`)

    // 从元数据列表移除
    const metaList = await this.getConversationMetaList()
    const filtered = metaList.filter(m => m.id !== id)
    await this.setData('conversations_meta', filtered)
    return true
  }
}

// 导出单例
export const localServerService = new LocalServerService()
