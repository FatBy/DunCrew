import { getServerUrl as _getServerUrl } from '@/utils/env'
/**
 * 在线搜索服务 - 从 Registry 搜索可安装的 SKILL 和 MCP 服务器
 * 
 * 特点：
 * - 零 LLM 调用，使用后端 TF-IDF 关键词匹配
 * - 响应速度快 (<100ms 本地, <500ms 网络)
 * - 支持中英文混合搜索
 */

// 搜索结果类型
export interface RegistrySkillResult {
  id: string
  name: string
  description: string
  keywords: string[]
  downloadUrl: string
  author?: string
  category?: string
  score?: number
}

export interface RegistryMCPResult {
  id: string
  name: string
  description: string
  keywords: string[]
  command: string
  args: string[]
  envRequired?: string[]
  category?: string
  source?: string
  score?: number
}

// 获取服务器 URL
function getServerUrl(): string {
  return localStorage.getItem('duncrew_server_url') || _getServerUrl()
}

/**
 * 搜索在线 SKILL
 */
export async function searchOnlineSkills(query: string): Promise<RegistrySkillResult[]> {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/api/registry/skills?q=${encodeURIComponent(query)}`
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    })
    
    if (!response.ok) {
      console.error('[OnlineSearch] Failed to search skills:', response.status)
      return []
    }
    
    const data = await response.json()
    return data.results || []
  } catch (error) {
    console.error('[OnlineSearch] Error searching skills:', error)
    return []
  }
}

/**
 * 搜索在线 MCP 服务器
 */
export async function searchOnlineMCP(query: string): Promise<RegistryMCPResult[]> {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/api/registry/mcp?q=${encodeURIComponent(query)}`
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    })
    
    if (!response.ok) {
      console.error('[OnlineSearch] Failed to search MCP:', response.status)
      return []
    }
    
    const data = await response.json()
    return data.results || []
  } catch (error) {
    console.error('[OnlineSearch] Error searching MCP:', error)
    return []
  }
}

/**
 * 获取所有可用的在线 SKILL（不带搜索）
 */
export async function getAllOnlineSkills(): Promise<RegistrySkillResult[]> {
  return searchOnlineSkills('')
}

/**
 * 获取所有可用的在线 MCP 服务器（不带搜索）
 */
export async function getAllOnlineMCP(): Promise<RegistryMCPResult[]> {
  return searchOnlineMCP('')
}
