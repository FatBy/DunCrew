import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true as const,
  getServerUrl: () => 'http://127.0.0.1:3001',
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  // 剪贴板 API
  clipboard: {
    readFilePaths: (): Promise<string[]> => ipcRenderer.invoke('clipboard:read-file-paths'),
    readImage: (): Promise<string | null> => ipcRenderer.invoke('clipboard:read-image'),
    availableFormats: (): Promise<string[]> => ipcRenderer.invoke('clipboard:available-formats'),
  },
  // 自动更新 API
  updater: {
    onStatus: (cb: (data: Record<string, unknown>) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, data: Record<string, unknown>) => cb(data)
      ipcRenderer.on('updater:status', listener)
      return () => { ipcRenderer.removeListener('updater:status', listener) }
    },
    check: (): Promise<void> => ipcRenderer.invoke('updater:check'),
    download: (): Promise<void> => ipcRenderer.invoke('updater:download'),
    install: (): Promise<void> => ipcRenderer.invoke('updater:install'),
    openReleases: (): Promise<void> => ipcRenderer.invoke('updater:open-releases'),
  },
})
