/**
 * 数字免疫服务 (Digital Immune Service)
 * 
 * 精简版：只保留失败签名匹配 + 自愈脚本执行
 */

// ============================================
// 类型定义 (内联，不依赖外部)
// ============================================

export type FailureCategory = 'network' | 'permission' | 'timeout' | 'resource' | 'logic' | 'dependency'
export type FailureSeverity = 'low' | 'medium' | 'high' | 'critical'
export type HealingAction = 'retry' | 'fallback' | 'prompt' | 'escalate' | 'skip'

export interface FailureSignature {
  id: string
  pattern: string
  category: FailureCategory
  severity: FailureSeverity
  healingScriptId?: string
}

export interface HealingScript {
  id: string
  name: string
  targetSignatures: string[]
  action: HealingAction
  params?: Record<string, unknown>
  maxRetries?: number
  cooldownMs?: number
}

export interface HealingResult {
  action: HealingAction
  shouldRetry: boolean
  message: string
  params?: Record<string, unknown>
}

// ============================================
// 配置常量
// ============================================

const DEFAULT_HEALING_COOLDOWN = 30000  // 30秒

// 默认失败签名库
const FAILURE_SIGNATURES: FailureSignature[] = [
  {
    id: 'FS-NET-001',
    pattern: 'ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network error|Failed to fetch',
    category: 'network',
    severity: 'medium',
    healingScriptId: 'HS-RETRY-001',
  },
  {
    id: 'FS-PERM-001',
    pattern: 'EACCES|permission denied|access denied|forbidden|401|403',
    category: 'permission',
    severity: 'high',
    healingScriptId: 'HS-ESCALATE-001',
  },
  {
    id: 'FS-TIMEOUT-001',
    pattern: 'timeout|timed out|deadline exceeded|aborted',
    category: 'timeout',
    severity: 'medium',
    healingScriptId: 'HS-RETRY-002',
  },
  {
    id: 'FS-RES-001',
    pattern: 'out of memory|disk full|no space|resource exhausted|ENOMEM|ENOSPC',
    category: 'resource',
    severity: 'critical',
    healingScriptId: 'HS-ESCALATE-002',
  },
  {
    id: 'FS-DEP-001',
    pattern: 'module not found|import error|dependency missing|not installed|Cannot find module',
    category: 'dependency',
    severity: 'high',
    healingScriptId: 'HS-PROMPT-001',
  },
]

// 默认自愈脚本库
const HEALING_SCRIPTS: HealingScript[] = [
  {
    id: 'HS-RETRY-001',
    name: '网络重试',
    targetSignatures: ['FS-NET-001'],
    action: 'retry',
    maxRetries: 3,
    cooldownMs: 2000,
    params: { backoffMultiplier: 1.5 },
  },
  {
    id: 'HS-RETRY-002',
    name: '超时重试',
    targetSignatures: ['FS-TIMEOUT-001'],
    action: 'retry',
    maxRetries: 2,
    cooldownMs: 5000,
    params: { extendTimeout: true },
  },
  {
    id: 'HS-ESCALATE-001',
    name: '权限升级',
    targetSignatures: ['FS-PERM-001'],
    action: 'escalate',
    params: { notifyUser: true },
  },
  {
    id: 'HS-ESCALATE-002',
    name: '资源告警',
    targetSignatures: ['FS-RES-001'],
    action: 'escalate',
    params: { notifyUser: true, pauseExecution: true },
  },
  {
    id: 'HS-PROMPT-001',
    name: '依赖提示',
    targetSignatures: ['FS-DEP-001'],
    action: 'prompt',
    params: { suggestInstall: true },
  },
]

// ============================================
// 数字免疫服务类
// ============================================

class ImmuneService {
  private healingState: Map<string, { lastHealingAt: number; retryCount: number }> = new Map()

  /**
   * 匹配失败签名
   */
  matchFailure(errorMessage: string): { 
    signature: FailureSignature
    healingScript?: HealingScript 
  } | null {
    const lowerError = errorMessage.toLowerCase()
    
    for (const sig of FAILURE_SIGNATURES) {
      const patterns = sig.pattern.split('|').map(p => p.toLowerCase().trim())
      const matched = patterns.some(p => lowerError.includes(p))
      
      if (matched) {
        const healingScript = sig.healingScriptId
          ? HEALING_SCRIPTS.find(h => h.id === sig.healingScriptId)
          : undefined
        
        console.log(`[ImmuneService] Matched: ${sig.id} (${sig.category})`)
        return { signature: sig, healingScript }
      }
    }
    
    return null
  }

  /**
   * 执行自愈
   */
  executeHealing(
    toolName: string,
    signature: FailureSignature,
    healingScript: HealingScript
  ): HealingResult {
    const stateKey = `${toolName}-${signature.id}`
    const state = this.healingState.get(stateKey) || { lastHealingAt: 0, retryCount: 0 }
    
    // 检查冷却
    const cooldown = healingScript.cooldownMs || DEFAULT_HEALING_COOLDOWN
    const timeSinceLastHealing = Date.now() - state.lastHealingAt
    if (state.retryCount > 0 && timeSinceLastHealing < cooldown) {
      return { 
        action: 'skip', 
        shouldRetry: false, 
        message: `冷却中 (${Math.ceil((cooldown - timeSinceLastHealing) / 1000)}s)` 
      }
    }

    // 检查重试次数
    const maxRetries = healingScript.maxRetries || 3
    if (state.retryCount >= maxRetries) {
      this.healingState.delete(stateKey)  // 重置
      return { 
        action: 'escalate', 
        shouldRetry: false, 
        message: `已达最大重试次数 (${maxRetries})` 
      }
    }

    // 更新状态
    state.lastHealingAt = Date.now()
    state.retryCount++
    this.healingState.set(stateKey, state)

    // 返回自愈建议
    switch (healingScript.action) {
      case 'retry':
        return {
          action: 'retry',
          shouldRetry: true,
          message: `${healingScript.name} (${state.retryCount}/${maxRetries})`,
          params: healingScript.params,
        }

      case 'fallback':
        return {
          action: 'fallback',
          shouldRetry: false,
          message: `切换备用方案: ${healingScript.name}`,
          params: healingScript.params,
        }

      case 'prompt':
        return {
          action: 'prompt',
          shouldRetry: false,
          message: `需要用户操作: ${signature.pattern.split('|')[0]}`,
          params: healingScript.params,
        }

      case 'escalate':
        return {
          action: 'escalate',
          shouldRetry: false,
          message: `严重错误 (${signature.severity})，需要人工介入`,
          params: healingScript.params,
        }

      default:
        return {
          action: 'skip',
          shouldRetry: false,
          message: '跳过',
        }
    }
  }

  /**
   * 重置工具的自愈状态（成功后调用）
   */
  resetState(toolName: string): void {
    for (const key of this.healingState.keys()) {
      if (key.startsWith(`${toolName}-`)) {
        this.healingState.delete(key)
      }
    }
  }

  /**
   * 获取统计信息
   */
  getStats(): { activeHealings: number } {
    return { activeHealings: this.healingState.size }
  }
}

// 单例导出
export const immuneService = new ImmuneService()
