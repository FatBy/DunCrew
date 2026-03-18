/**
 * 安装服务 - 从 Registry 安装 SKILL 和 MCP 服务器
 * 
 * 特点：
 * - 一键安装，无需手动配置
 * - 安装后自动热重载
 * - 支持环境变量配置（MCP）
 */

import { searchOnlineSkills, type RegistrySkillResult, type RegistryMCPResult } from './onlineSearchService'

// 安装结果类型
export interface InstallResult {
  success: boolean
  message: string
  path?: string
}

// 获取服务器 URL
function getServerUrl(): string {
  return localStorage.getItem('duncrew_server_url') || 'http://localhost:3001'
}

/**
 * 安装 SKILL
 * @param skill 要安装的 SKILL 信息
 */
export async function installSkill(skill: RegistrySkillResult): Promise<InstallResult> {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/skills/install`
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        name: skill.name,
        source: skill.downloadUrl,
      }),
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return {
        success: false,
        message: errorData.error || `安装失败: HTTP ${response.status}`,
      }
    }
    
    const data = await response.json()
    return {
      success: true,
      message: data.message || '安装成功',
      path: data.path,
    }
  } catch (error) {
    console.error('[InstallService] Error installing skill:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : '网络错误',
    }
  }
}

/**
 * 安装 MCP 服务器
 * @param mcp 要安装的 MCP 信息
 * @param envValues 环境变量值（如 GITHUB_TOKEN）
 */
export async function installMCP(
  mcp: RegistryMCPResult,
  envValues?: Record<string, string>
): Promise<InstallResult> {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/mcp/install`
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        id: mcp.id,
        name: mcp.name,
        command: mcp.command,
        args: mcp.args,
        env: envValues || {},
      }),
    })
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      return {
        success: false,
        message: errorData.error || `安装失败: HTTP ${response.status}`,
      }
    }
    
    const data = await response.json()
    return {
      success: true,
      message: data.message || '安装成功',
      path: data.configPath,
    }
  } catch (error) {
    console.error('[InstallService] Error installing MCP:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : '网络错误',
    }
  }
}

/**
 * 触发热重载（重新扫描已安装的 SKILL 和 MCP）
 */
export async function triggerHotReload(): Promise<InstallResult> {
  const serverUrl = getServerUrl()
  const url = `${serverUrl}/reload`
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Accept': 'application/json' },
    })
    
    if (!response.ok) {
      return {
        success: false,
        message: `热重载失败: HTTP ${response.status}`,
      }
    }
    
    const data = await response.json()
    return {
      success: true,
      message: data.message || '热重载成功',
    }
  } catch (error) {
    console.error('[InstallService] Error triggering hot reload:', error)
    return {
      success: false,
      message: error instanceof Error ? error.message : '网络错误',
    }
  }
}

// ============================================
// 批量自动安装（Nexus 创建时使用）
// ============================================

export interface AutoInstallResult {
  skillName: string
  /** 实际安装后的技能名称（可能与 skillName 不同） */
  installedName?: string
  status: 'installed' | 'already' | 'not_found' | 'failed'
  message: string
}

/**
 * 批量搜索并安装技能
 * - 跳过已安装的技能
 * - 并行安装，最多5个
 * - 任何单个失败不影响整体
 * - 有新安装时自动触发热重载
 */
export async function autoInstallSkills(
  suggestedSkills: string[],
  installedSkillNames: string[]
): Promise<AutoInstallResult[]> {
  const normalizedInstalled = installedSkillNames.map(n => n.toLowerCase())

  // 过滤出未安装的
  const toInstall = suggestedSkills.filter(
    s => !normalizedInstalled.some(name =>
      name === s.toLowerCase() || name.includes(s.toLowerCase()) || s.toLowerCase().includes(name)
    )
  )

  const results: AutoInstallResult[] = []

  // 标记已安装的
  for (const s of suggestedSkills) {
    if (!toInstall.includes(s)) {
      results.push({ skillName: s, status: 'already', message: '已安装' })
    }
  }

  if (toInstall.length === 0) return results

  // 并行搜索+安装（最多5个）
  const installResults = await Promise.allSettled(
    toInstall.slice(0, 5).map(async (skillName): Promise<AutoInstallResult> => {
      try {
        const searchResults = await searchOnlineSkills(skillName)
        if (searchResults.length === 0) {
          return { skillName, status: 'not_found', message: '注册表中未找到' }
        }
        const matched = searchResults[0]
        const result = await installSkill(matched)
        if (result.success) {
          return { skillName, installedName: matched.name, status: 'installed', message: result.message }
        }
        // 409 = already exists，视为成功
        if (result.message.includes('409') || result.message.includes('already') || result.message.includes('已存在')) {
          return { skillName, installedName: matched.name, status: 'already', message: '已安装' }
        }
        return { skillName, status: 'failed', message: result.message }
      } catch (e) {
        return { skillName, status: 'failed', message: String(e) }
      }
    })
  )

  for (const r of installResults) {
    results.push(r.status === 'fulfilled' ? r.value : { skillName: '?', status: 'failed', message: 'unexpected' })
  }

  // 有新安装的，触发热重载
  if (results.some(r => r.status === 'installed')) {
    await triggerHotReload().catch(() => {})
  }

  return results
}
