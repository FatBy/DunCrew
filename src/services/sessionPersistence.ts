/**
 * SessionPersistence - 会话持久化服务
 *
 * 从 JSONL 增量 → SQLite 统一存储。
 * 提供：
 * - 会话创建/恢复/列表
 * - 增量消息保存（每条消息写入而非全量覆盖）
 * - 检查点保存/恢复（支持断点续作）
 * - 会话元数据管理
 */

import type { SessionMeta, ChatMessage, TaskCheckpoint } from '@/types'

// ============================================
// 类型定义
// ============================================

export interface CreateSessionParams {
  title: string
  type: 'general' | 'nexus'
  nexusId?: string
}

export interface AppendMessageParams {
  sessionId: string
  message: ChatMessage
}

export interface SessionWithMessages {
  meta: SessionMeta
  messages: ChatMessage[]
  checkpoint?: TaskCheckpoint
}

// ============================================
// SessionPersistence 服务
// ============================================

class SessionPersistenceService {
  private serverUrl: string = 'http://localhost:3001'

  /** 更新后端地址 */
  setServerUrl(url: string): void {
    this.serverUrl = url
  }

  // ═══ 会话生命周期 ═══

  /** 创建新会话 */
  async createSession(params: CreateSessionParams): Promise<SessionMeta | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: params.title,
          type: params.type,
          nexusId: params.nexusId,
          createdAt: Date.now(),
        }),
      })
      if (res.ok) {
        return await res.json()
      }
      console.warn('[SessionPersistence] Create session failed:', res.status)
      return null
    } catch (error: any) {
      console.warn('[SessionPersistence] Create session error:', error.message)
      return null
    }
  }

  /** 获取会话列表 */
  async listSessions(params?: {
    type?: 'general' | 'nexus'
    nexusId?: string
    limit?: number
    offset?: number
  }): Promise<SessionMeta[]> {
    try {
      const searchParams = new URLSearchParams()
      if (params?.type) searchParams.set('type', params.type)
      if (params?.nexusId) searchParams.set('nexusId', params.nexusId)
      if (params?.limit) searchParams.set('limit', String(params.limit))
      if (params?.offset) searchParams.set('offset', String(params.offset))

      const url = `${this.serverUrl}/api/sessions?${searchParams}`
      const res = await fetch(url)
      if (res.ok) {
        return await res.json()
      }
      return []
    } catch {
      return []
    }
  }

  /** 获取会话详情（含消息） */
  async getSession(sessionId: string): Promise<SessionWithMessages | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`)
      if (res.ok) {
        return await res.json()
      }
      return null
    } catch {
      return null
    }
  }

  /** 删除会话 */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** 更新会话元数据 */
  async updateSessionMeta(sessionId: string, updates: Partial<Pick<SessionMeta, 'title' | 'lastMessagePreview'>>): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updates,
          updatedAt: Date.now(),
        }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  // ═══ 增量消息保存 ═══

  /** 追加一条消息（增量写入） */
  async appendMessage(params: AppendMessageParams): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(params.sessionId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params.message),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** 批量追加消息 */
  async appendMessages(sessionId: string, messages: ChatMessage[]): Promise<number> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      })
      if (res.ok) {
        const data = await res.json()
        return data.appended || 0
      }
      return 0
    } catch {
      return 0
    }
  }

  /** 获取会话的消息列表 */
  async getMessages(sessionId: string, params?: {
    limit?: number
    offset?: number
    since?: number
  }): Promise<ChatMessage[]> {
    try {
      const searchParams = new URLSearchParams()
      if (params?.limit) searchParams.set('limit', String(params.limit))
      if (params?.offset) searchParams.set('offset', String(params.offset))
      if (params?.since) searchParams.set('since', String(params.since))

      const url = `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/messages?${searchParams}`
      const res = await fetch(url)
      if (res.ok) {
        return await res.json()
      }
      return []
    } catch {
      return []
    }
  }

  // ═══ 检查点管理 ═══

  /** 保存检查点 */
  async saveCheckpoint(sessionId: string, checkpoint: TaskCheckpoint): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(checkpoint),
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** 获取检查点 */
  async getCheckpoint(sessionId: string): Promise<TaskCheckpoint | null> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoint`)
      if (res.ok) {
        return await res.json()
      }
      return null
    } catch {
      return null
    }
  }

  /** 清除检查点 */
  async clearCheckpoint(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
        method: 'DELETE',
      })
      return res.ok
    } catch {
      return false
    }
  }

  // ═══ 搜索 ═══

  /** 搜索会话 */
  async searchSessions(query: string, limit: number = 10): Promise<SessionMeta[]> {
    try {
      const url = `${this.serverUrl}/api/sessions/search?query=${encodeURIComponent(query)}&limit=${limit}`
      const res = await fetch(url)
      if (res.ok) {
        return await res.json()
      }
      return []
    } catch {
      return []
    }
  }
}

// 导出单例
export const sessionPersistence = new SessionPersistenceService()
