/**
 * ClawHub OAuth 认证服务
 *
 * 流程:
 * 1. 打开浏览器到 ClawHub GitHub OAuth 页面
 * 2. 用户授权后，ClawHub 回调到 duncrew-server.py 的临时端点
 * 3. Token 通过 polling 获取并存储到 localStorage
 */

import type { ClawHubUser } from '@/types'
import { clawHubService } from './clawHubService'
import { getServerUrl as _getServerUrl } from '@/utils/env'

const CLAWHUB_AUTH_URL = 'https://clawhub.ai/auth/github'
const TOKEN_KEY = 'clawhub_auth_token'

function getServerUrl(): string {
  return localStorage.getItem('duncrew_server_url') || _getServerUrl()
}

class ClawHubAuthService {
  private static instance: ClawHubAuthService | null = null

  static getInstance(): ClawHubAuthService {
    if (!ClawHubAuthService.instance) {
      ClawHubAuthService.instance = new ClawHubAuthService()
    }
    return ClawHubAuthService.instance
  }

  /**
   * 启动 OAuth 登录流程
   * 1. 生成随机 state 参数
   * 2. 打开浏览器到 ClawHub 授权页
   * 3. 轮询本地后端获取回调 token
   */
  async startOAuthFlow(): Promise<string | null> {
    const state = crypto.randomUUID()

    // 构建授权 URL
    const serverUrl = getServerUrl()
    const callbackUrl = `${serverUrl}/auth/clawhub/callback`
    const authUrl = `${CLAWHUB_AUTH_URL}?state=${state}&redirect_uri=${encodeURIComponent(callbackUrl)}`

    // 打开浏览器
    window.open(authUrl, '_blank', 'width=600,height=700')

    // 轮询后端获取 token (最多等待 5 分钟)
    const maxAttempts = 60
    const interval = 5000

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, interval))

      try {
        const resp = await fetch(`${serverUrl}/auth/clawhub/token?state=${state}`)
        if (resp.ok) {
          const data = await resp.json()
          if (data.token) {
            this.saveToken(data.token)
            return data.token
          }
        }
      } catch {
        // 继续轮询
      }
    }

    console.warn('[ClawHubAuth] OAuth flow timed out')
    return null
  }

  /** 获取已存储的 token */
  getStoredToken(): string | null {
    return localStorage.getItem(TOKEN_KEY)
  }

  /** 保存 token 并同步到 clawHubService */
  saveToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token)
    clawHubService.setToken(token)
  }

  /** 验证 token 是否有效 */
  async validateToken(): Promise<ClawHubUser | null> {
    const token = this.getStoredToken()
    if (!token) return null

    // 确保 service 有 token
    clawHubService.setToken(token)

    const user = await clawHubService.whoami()
    if (!user) {
      // token 无效，清除
      this.logout()
    }
    return user
  }

  /** 登出 */
  logout(): void {
    localStorage.removeItem(TOKEN_KEY)
    clawHubService.clearToken()
  }

  /** 是否已认证 */
  isAuthenticated(): boolean {
    return !!this.getStoredToken()
  }
}

export const clawHubAuthService = ClawHubAuthService.getInstance()
export { ClawHubAuthService }
