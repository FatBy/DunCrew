/**
 * ClawHub API 客户端 - 直接调用 ClawHub REST API
 *
 * 功能:
 * - 搜索技能市场
 * - 获取技能详情
 * - 下载技能包
 * - 发布技能 (需要 Bearer token)
 * - 验证当前身份
 *
 * 限流: 120 reads/min, 30 writes/min
 */

import { getServerUrl as _getServerUrl } from '@/utils/env'
import type {
  ClawHubSearchResult,
  ClawHubSkillDetail,
  SkillPublishPayload,
  ClawHubPublishResult,
  ClawHubUser,
} from '@/types'

const CLAWHUB_BASE_URL = 'https://clawhub.ai'
const REQUEST_TIMEOUT = 15000
const MAX_RETRIES = 3

function getServerUrl(): string {
  return localStorage.getItem('duncrew_server_url') || _getServerUrl()
}

class ClawHubService {
  private static instance: ClawHubService | null = null
  private token: string | null = null

  static getInstance(): ClawHubService {
    if (!ClawHubService.instance) {
      ClawHubService.instance = new ClawHubService()
    }
    return ClawHubService.instance
  }

  constructor() {
    // 启动时从 localStorage 恢复 token
    this.token = localStorage.getItem('clawhub_auth_token')
  }

  // ============================================
  // 认证管理
  // ============================================

  setToken(token: string): void {
    this.token = token
    localStorage.setItem('clawhub_auth_token', token)
  }

  clearToken(): void {
    this.token = null
    localStorage.removeItem('clawhub_auth_token')
  }

  isAuthenticated(): boolean {
    return !!this.token
  }

  getToken(): string | null {
    return this.token
  }

  // ============================================
  // API 方法
  // ============================================

  /** 搜索 ClawHub 技能市场 */
  async searchSkills(query: string, options?: { tag?: string; page?: number }): Promise<ClawHubSearchResult> {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (options?.tag) params.set('tag', options.tag)
    if (options?.page) params.set('page', String(options.page))

    const data = await this.request<ClawHubSearchResult>(
      `/api/v1/search?${params.toString()}`,
      { method: 'GET' }
    )
    return data ?? { skills: [], total: 0, page: 1, pageSize: 20 }
  }

  /** 获取技能详情 */
  async getSkillDetail(slug: string): Promise<ClawHubSkillDetail | null> {
    return this.request<ClawHubSkillDetail>(
      `/api/v1/skills/${encodeURIComponent(slug)}`,
      { method: 'GET' }
    )
  }

  /** 下载技能包 (返回 Blob) */
  async downloadSkill(slug: string): Promise<Blob | null> {
    try {
      const resp = await this.fetchWithTimeout(
        `${getServerUrl()}/clawhub/proxy/api/v1/download/${encodeURIComponent(slug)}`,
        {
          method: 'GET',
          headers: this.buildHeaders(),
        }
      )

      if (!resp.ok) {
        console.error(`[ClawHub] Download failed: ${resp.status}`)
        return null
      }

      return resp.blob()
    } catch (error) {
      console.error('[ClawHub] Download error:', error)
      return null
    }
  }

  /** 发布技能到 ClawHub (需要认证) */
  async publishSkill(payload: SkillPublishPayload): Promise<ClawHubPublishResult | null> {
    if (!this.token) {
      console.error('[ClawHub] Cannot publish: not authenticated')
      return null
    }

    const formData = new FormData()
    formData.append('name', payload.name)
    formData.append('slug', payload.slug)
    formData.append('description', payload.description)
    formData.append('version', payload.version)
    formData.append('archive', payload.skillArchive, `${payload.slug}.tar.gz`)
    if (payload.tags?.length) {
      formData.append('tags', JSON.stringify(payload.tags))
    }

    try {
      const resp = await this.fetchWithTimeout(
        `${CLAWHUB_BASE_URL}/api/v1/skills`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
          },
          body: formData,
        }
      )

      if (resp.status === 401) {
        this.clearToken()
        return null
      }

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}))
        console.error('[ClawHub] Publish failed:', errData)
        return null
      }

      return resp.json()
    } catch (error) {
      console.error('[ClawHub] Publish error:', error)
      return null
    }
  }

  /** 验证当前 token 身份 */
  async whoami(): Promise<ClawHubUser | null> {
    if (!this.token) return null
    return this.request<ClawHubUser>('/api/v1/whoami', { method: 'GET' })
  }

  // ============================================
  // 通过本地后端安装/打包
  // ============================================

  /** 通过本地后端安装 ClawHub 技能 */
  async installViaBackend(slug: string, archiveUrl: string): Promise<{ success: boolean; message: string; path?: string }> {
    const serverUrl = getServerUrl()
    try {
      const resp = await fetch(`${serverUrl}/clawhub/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, archive_url: archiveUrl }),
      })

      const data = await resp.json()
      if (!resp.ok) {
        return { success: false, message: data.error || `HTTP ${resp.status}` }
      }
      return { success: true, message: data.message, path: data.path }
    } catch (error) {
      return { success: false, message: `安装失败: ${String(error)}` }
    }
  }

  /** 通过本地后端打包本地技能 */
  async packageViaBackend(skillName: string): Promise<{
    success: boolean
    archive_base64?: string
    name?: string
    description?: string
    version?: string
    tags?: string[]
    file_list?: string[]
    error?: string
  }> {
    const serverUrl = getServerUrl()
    try {
      const resp = await fetch(`${serverUrl}/clawhub/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skill_name: skillName }),
      })

      const data = await resp.json()
      if (!resp.ok) {
        return { success: false, error: data.error || `HTTP ${resp.status}` }
      }
      return { success: true, ...data }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  /** 获取本地技能原始文件列表 */
  async getSkillRaw(skillName: string): Promise<{
    name: string
    path: string
    files: Array<{ path: string; size: number; content: string }>
  } | null> {
    const serverUrl = getServerUrl()
    try {
      const resp = await fetch(`${serverUrl}/skills/${encodeURIComponent(skillName)}/raw`)
      if (!resp.ok) return null
      return resp.json()
    } catch {
      return null
    }
  }

  // ============================================
  // 内部方法
  // ============================================

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`
    }
    return headers
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      return await fetch(url, { ...init, signal: controller.signal })
    } finally {
      clearTimeout(timeout)
    }
  }

  /** 通用请求，支持 429 指数退避重试 */
  private async request<T>(path: string, init: RequestInit): Promise<T | null> {
    const url = `${getServerUrl()}/clawhub/proxy${path}`
    const headers = this.buildHeaders()

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await this.fetchWithTimeout(url, {
          ...init,
          headers: { ...headers, ...(init.headers as Record<string, string> || {}) },
        })

        if (resp.status === 401) {
          this.clearToken()
          console.warn('[ClawHub] Token expired, cleared')
          return null
        }

        if (resp.status === 429) {
          const delay = Math.pow(2, attempt) * 1000
          console.warn(`[ClawHub] Rate limited, retrying in ${delay}ms`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }

        if (!resp.ok) {
          console.error(`[ClawHub] Request failed: ${resp.status} ${path}`)
          return null
        }

        return resp.json()
      } catch (error) {
        if (attempt === MAX_RETRIES - 1) {
          console.error(`[ClawHub] Request error after ${MAX_RETRIES} attempts:`, error)
          return null
        }
        const delay = Math.pow(2, attempt) * 500
        await new Promise(r => setTimeout(r, delay))
      }
    }

    return null
  }
}

export const clawHubService = ClawHubService.getInstance()
export { ClawHubService }
