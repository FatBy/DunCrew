/**
 * DunCrew Auto-Updater 模块
 *
 * 使用 electron-updater 从阿里云 OSS 检查并下载更新。
 * - Windows / Linux: 完整自动下载 + 安装
 * - macOS: 未签名应用无法自动替换，仅通知用户前往下载
 */

import { app, ipcMain, BrowserWindow, shell } from 'electron'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import type { PythonManager } from './python-manager'

/** 检查间隔: 4 小时 */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
/** 首次检查延迟: 10 秒（等 Python 后端启动完成） */
const INITIAL_DELAY_MS = 10 * 1000

export function initAutoUpdater(
  mainWindow: BrowserWindow | null,
  pythonManager: PythonManager
): void {
  // 开发模式不初始化
  if (!app.isPackaged) {
    console.log('[AutoUpdater] Skipped in dev mode')
    return
  }

  // ── 配置 ──────────────────────────────────────────
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false

  // 日志
  autoUpdater.logger = {
    info: (msg: unknown) => console.log('[AutoUpdater]', msg),
    warn: (msg: unknown) => console.warn('[AutoUpdater]', msg),
    error: (msg: unknown) => console.error('[AutoUpdater]', msg),
    debug: (msg: unknown) => console.log('[AutoUpdater:debug]', msg),
  }

  // ── 工具函数 ──────────────────────────────────────
  function send(payload: Record<string, unknown>) {
    try {
      mainWindow?.webContents.send('updater:status', payload)
    } catch {
      // 窗口可能已关闭
    }
  }

  // ── 事件绑定 ──────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    send({ status: 'checking' })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[AutoUpdater] Update available: v${info.version}`)
    send({
      status: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      releaseDate: info.releaseDate ?? '',
      // macOS 未签名无法自动更新，需要手动下载
      macOSManualOnly: process.platform === 'darwin',
    })
  })

  autoUpdater.on('update-not-available', () => {
    send({ status: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    send({
      status: 'downloading',
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log(`[AutoUpdater] Update downloaded: v${info.version}`)
    send({
      status: 'downloaded',
      version: info.version,
    })
  })

  autoUpdater.on('error', (err: Error) => {
    console.error('[AutoUpdater] Error:', err.message)
    send({
      status: 'error',
      message: err.message,
    })
  })

  // ── IPC handlers ──────────────────────────────────
  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.error('[AutoUpdater] Check failed:', err)
    }
  })

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      console.error('[AutoUpdater] Download failed:', err)
    }
  })

  ipcMain.handle('updater:install', async () => {
    console.log('[AutoUpdater] Installing update, stopping Python backend...')
    // 1. 关停 Python 后端，释放文件锁
    pythonManager.stop()
    // 2. 等待进程树完全退出
    await new Promise((r) => setTimeout(r, 500))
    // 3. 退出并安装
    autoUpdater.quitAndInstall(false, true)
  })

  // macOS 手动下载：打开 OSS 下载页面
  ipcMain.handle('updater:open-releases', async () => {
    try {
      await shell.openExternal('https://duncrew.oss-accelerate.aliyuncs.com')
    } catch (err) {
      console.error('[AutoUpdater] Failed to open download page:', err)
    }
  })

  // ── 定时检查 ──────────────────────────────────────
  setTimeout(() => {
    console.log('[AutoUpdater] Initial check...')
    autoUpdater.checkForUpdates().catch(() => {})
  }, INITIAL_DELAY_MS)

  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {})
  }, CHECK_INTERVAL_MS)

  console.log('[AutoUpdater] Initialized')
}
