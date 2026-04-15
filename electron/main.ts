import { app, BrowserWindow, ipcMain, clipboard, nativeImage, Menu } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import { PythonManager } from './python-manager'
import { initAutoUpdater } from './auto-updater'

// Windows 高 DPI 修复：
// force-device-scale-factor=1 让 Chromium 以 1:1 像素渲染（禁止 Windows 位图缩放）
// 然后通过 zoomFactor 补偿系统缩放比例，使内容大小正常
let nativeScaleFactor = 1
if (process.platform === 'win32') {
  // 在 force-device-scale-factor 覆盖之前，从注册表读取系统真实 DPI
  try {
    const result = execSync(
      'reg query "HKCU\\Control Panel\\Desktop\\WindowMetrics" /v AppliedDPI',
      { encoding: 'utf8', timeout: 3000 }
    )
    const match = result.match(/AppliedDPI\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
    if (match) {
      nativeScaleFactor = parseInt(match[1], 16) / 96
    }
  } catch {
    try {
      const result = execSync(
        'reg query "HKCU\\Control Panel\\Desktop" /v LogPixels',
        { encoding: 'utf8', timeout: 3000 }
      )
      const match = result.match(/LogPixels\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
      if (match) {
        nativeScaleFactor = parseInt(match[1], 16) / 96
      }
    } catch {
      // 无法读取 DPI，保持默认 1（不影响 100% 缩放的用户）
    }
  }

  app.commandLine.appendSwitch('high-dpi-support', '1')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
}

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
const pythonManager = new PythonManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: Math.round(1280 * nativeScaleFactor),
    height: Math.round(800 * nativeScaleFactor),
    minWidth: Math.round(1024 * nativeScaleFactor),
    minHeight: Math.round(600 * nativeScaleFactor),
    center: true,
    title: 'DunCrew',
    icon: path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: nativeScaleFactor,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  // 右键上下文菜单：提供复制/粘贴/全选等基础编辑能力
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = []

    if (params.isEditable) {
      menuItems.push(
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      )
    } else {
      if (params.selectionText) {
        menuItems.push(
          { label: '复制', role: 'copy' },
        )
      }
      menuItems.push(
        { label: '全选', role: 'selectAll' },
      )
    }

    if (menuItems.length > 0) {
      const menu = Menu.buildFromTemplate(menuItems)
      menu.popup()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// IPC handlers
ipcMain.handle('get-server-url', () => {
  return 'http://127.0.0.1:3001'
})

ipcMain.handle('get-app-info', () => {
  return {
    version: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
  }
})

// ============================================
// 剪贴板 IPC handlers
// ============================================

// 读取剪贴板中的文件路径（Windows 资源管理器复制文件时可用）
ipcMain.handle('clipboard:read-file-paths', () => {
  try {
    const formats = clipboard.availableFormats()

    // Windows: CF_HDROP 格式 —— 通过 readBuffer('FileNameW') 读取
    if (process.platform === 'win32') {
      const rawBuf = clipboard.readBuffer('FileNameW')
      if (rawBuf && rawBuf.length > 0) {
        // Windows 宽字符 (UTF-16LE)，以双 \0 分隔路径
        const decoded = rawBuf.toString('utf16le')
        const paths = decoded.split('\0').filter(p => p.length > 0 && fs.existsSync(p))
        if (paths.length > 0) return paths
      }
    }

    // macOS / Linux: text/uri-list 格式
    if (formats.some(f => f.includes('uri-list') || f.includes('text/uri-list'))) {
      const uriList = clipboard.read('text/uri-list')
      if (uriList) {
        const paths = uriList
          .split(/\r?\n/)
          .filter(Boolean)
          .map(uri => {
            try {
              return decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''))
            } catch {
              return ''
            }
          })
          .filter(p => p && fs.existsSync(p))
        if (paths.length > 0) return paths
      }
    }

    return []
  } catch (err) {
    console.error('[Clipboard] read-file-paths error:', err)
    return []
  }
})

// 读取剪贴板中的图片（截图工具截图后可用）
ipcMain.handle('clipboard:read-image', () => {
  try {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return img.toDataURL()
  } catch (err) {
    console.error('[Clipboard] read-image error:', err)
    return null
  }
})

// 获取剪贴板当前包含的格式列表
ipcMain.handle('clipboard:available-formats', () => {
  try {
    return clipboard.availableFormats()
  } catch {
    return []
  }
})

app.whenReady().then(async () => {
  // 生产模式下移除默认菜单栏（File/Edit/View/Help）
  if (!isDev) {
    Menu.setApplicationMenu(null)
  }

  // 先创建窗口，让用户立刻看到界面
  createWindow()

  // 初始化自动更新（生产模式下检查 GitHub Releases）
  initAutoUpdater(mainWindow, pythonManager)

  // Python 后台启动，不阻塞窗口显示
  try {
    await pythonManager.start()
    await pythonManager.waitForReady()
    console.log('[Electron] Python backend is ready')
    mainWindow?.webContents.send('python-ready')
  } catch (err) {
    console.error('[Electron] Failed to start Python backend:', err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  pythonManager.stop()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  pythonManager.stop()
})
