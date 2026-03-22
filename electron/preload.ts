import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true as const,
  getServerUrl: () => 'http://127.0.0.1:3001',
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
})
