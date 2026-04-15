import type { StateCreator } from 'zustand'
import type { ConnectionStatus, Toast, NotificationRecord } from '@/types'

export interface ConnectionSlice {
  // 状态
  connectionStatus: ConnectionStatus
  connectionError: string | null
  reconnectAttempt: number
  reconnectCountdown: number | null
  toasts: Toast[]
  notificationHistory: NotificationRecord[]
  unreadNotifCount: number
  
  // Actions
  setConnectionStatus: (status: ConnectionStatus) => void
  setConnectionError: (error: string | null) => void
  setReconnectAttempt: (attempt: number) => void
  setReconnectCountdown: (countdown: number | null) => void
  addToast: (toast: Omit<Toast, 'id'>) => void
  removeToast: (id: string) => void
  markAllNotifsRead: () => void
  clearNotifHistory: () => void
}

export const createConnectionSlice: StateCreator<ConnectionSlice> = (set) => ({
  // 初始状态
  connectionStatus: 'disconnected',
  connectionError: null,
  reconnectAttempt: 0,
  reconnectCountdown: null,
  toasts: [],
  notificationHistory: [],
  unreadNotifCount: 0,

  // Actions
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  
  setConnectionError: (error) => set({ connectionError: error }),
  
  setReconnectAttempt: (attempt) => set({ reconnectAttempt: attempt }),
  
  setReconnectCountdown: (countdown) => set({ reconnectCountdown: countdown }),
  
  addToast: (toast) => set((state) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const record: NotificationRecord = {
      id,
      type: toast.type,
      title: toast.title,
      message: toast.message,
      timestamp: Date.now(),
      read: false,
    }
    const newHistory = [record, ...state.notificationHistory].slice(0, 50)
    return {
      toasts: [
        ...state.toasts,
        {
          ...toast,
          id,
          duration: toast.duration ?? 4000,
        },
      ],
      notificationHistory: newHistory,
      unreadNotifCount: state.unreadNotifCount + 1,
    }
  }),
  
  removeToast: (id) => set((state) => ({
    toasts: state.toasts.filter((t) => t.id !== id),
  })),

  markAllNotifsRead: () => set((state) => ({
    notificationHistory: state.notificationHistory.map(n => ({ ...n, read: true })),
    unreadNotifCount: 0,
  })),

  clearNotifHistory: () => set({
    notificationHistory: [],
    unreadNotifCount: 0,
  }),
})
