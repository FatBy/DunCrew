import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import { PythonManager } from './python-manager'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
const pythonManager = new PythonManager()

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    center: true,
    title: 'DunCrew',
    icon: path.join(__dirname, '..', 'src-tauri', 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

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

app.whenReady().then(async () => {
  // 启动 Python 后端
  try {
    await pythonManager.start()
    await pythonManager.waitForReady()
    console.log('[Electron] Python backend is ready')
  } catch (err) {
    console.error('[Electron] Failed to start Python backend:', err)
    // 继续启动窗口，前端会显示连接失败状态
  }

  createWindow()

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
