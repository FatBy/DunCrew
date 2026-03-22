/**
 * 统一环境检测工具
 * 集中管理所有运行环境判断和后端 URL 路由
 */

// TypeScript 全局类型声明
declare global {
  interface Window {
    electronAPI?: {
      isElectron: true
      getServerUrl: () => string
      platform: string
      getAppInfo: () => Promise<{ version: string; platform: string; isPackaged: boolean }>
    }
    __TAURI__?: unknown
  }
}

/** 开发模式 */
export const isDevMode: boolean = import.meta.env?.DEV ?? false

/** Electron 桌面应用模式 */
export const isElectronMode: boolean =
  typeof window !== 'undefined' && !!window.electronAPI?.isElectron

/** Tauri 桌面应用模式（保留兼容） */
export const isTauriMode: boolean =
  typeof window !== 'undefined' && '__TAURI__' in window

/** 任意桌面应用模式 */
export const isDesktopApp: boolean = isElectronMode || isTauriMode

/**
 * 获取后端服务器 URL
 * - Electron 模式：127.0.0.1:3001
 * - Tauri 模式：127.0.0.1:3001
 * - 开发模式：localhost:3001
 * - 浏览器直连生产模式：空字符串（相对路径，Python 同域托管）
 */
export function getServerUrl(): string {
  if (isElectronMode) return 'http://127.0.0.1:3001'
  if (isTauriMode) return 'http://127.0.0.1:3001'
  if (isDevMode) return 'http://localhost:3001'
  return '' // 生产模式: 相对路径
}
