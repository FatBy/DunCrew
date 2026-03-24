import { create } from 'zustand'
import type { ViewType } from '@/types'
import { createConnectionSlice, type ConnectionSlice } from './slices/connectionSlice'
import { createSessionsSlice, type SessionsSlice } from './slices/sessionsSlice'
import { createChannelsSlice, type ChannelsSlice } from './slices/channelsSlice'
import { createAgentSlice, type AgentSlice } from './slices/agentSlice'
import { createDevicesSlice, type DevicesSlice } from './slices/devicesSlice'
import { createAiSlice, type AiSlice } from './slices/aiSlice'
import { createWorldSlice, type WorldSlice } from './slices/worldSlice'
import { createObserverSlice, type ObserverSlice } from './slices/observerSlice'
import { createThemeSlice, type ThemeSlice } from './slices/themeSlice'
import { createClawHubSlice, type ClawHubSlice } from './slices/clawHubSlice'
import { createSoulAmendmentSlice, type SoulAmendmentSlice } from './slices/soulAmendmentSlice'

// ============================================
// 视图状态
// ============================================
interface ViewSlice {
  currentView: ViewType
  setView: (view: ViewType) => void
}

// ============================================
// 合并后的 Store 类型
// ============================================
export type AppStore = ViewSlice & ConnectionSlice & SessionsSlice & ChannelsSlice & AgentSlice & DevicesSlice & AiSlice & WorldSlice & ObserverSlice & ThemeSlice & ClawHubSlice & SoulAmendmentSlice

// ============================================
// 创建 Store
// ============================================
export const useStore = create<AppStore>()((...args) => ({
  // 视图状态
  currentView: 'world',
  setView: (view) => args[0]({ currentView: view }),
  
  // 合并各业务 slice
  ...createConnectionSlice(...args),
  ...createSessionsSlice(...args),
  ...createChannelsSlice(...args),
  ...createAgentSlice(...args),
  ...createDevicesSlice(...args),
  ...createAiSlice(...args),
  ...createWorldSlice(...args),
  ...createObserverSlice(...args),
  ...createThemeSlice(...args),
  ...createClawHubSlice(...args),
  ...createSoulAmendmentSlice(...args),
}))

// ============================================
// 导出选择器 (性能优化)
// ============================================
export const selectCurrentView = (state: AppStore) => state.currentView
export const selectConnectionStatus = (state: AppStore) => state.connectionStatus

// 原始数据选择器
export const selectSessions = (state: AppStore) => state.sessions
export const selectChannels = (state: AppStore) => state.channels
export const selectHealth = (state: AppStore) => state.health
export const selectDevices = (state: AppStore) => state.devices

// 映射后的 UI 数据选择器
export const selectTasks = (state: AppStore) => state.tasks
export const selectSkills = (state: AppStore) => state.skills
export const selectMemories = (state: AppStore) => state.memories
export const selectJournalEntries = (state: AppStore) => state.journalEntries
export const selectSoulDimensions = (state: AppStore) => state.soulDimensions
export const selectSoulPrompts = (state: AppStore) => state.soulPrompts

// Soul Amendment 选择器
export const selectAmendments = (state: AppStore) => state.amendments
export const selectDraftAmendments = (state: AppStore) => state.draftAmendments

export const selectToasts = (state: AppStore) => state.toasts
export const selectLogs = (state: AppStore) => state.logs

// AI 选择器
export const selectLlmConfig = (state: AppStore) => state.llmConfig
export const selectChatStreaming = (state: AppStore) => state.chatStreaming

// World 选择器
export const selectNexuses = (state: AppStore) => state.nexuses
export const selectCamera = (state: AppStore) => state.camera
export const selectSelectedNexusId = (state: AppStore) => state.selectedNexusId
export const selectRenderSettings = (state: AppStore) => state.renderSettings

// Observer 选择器
export const selectCurrentProposal = (state: AppStore) => state.currentProposal
export const selectNexusPanelOpen = (state: AppStore) => state.nexusPanelOpen
export const selectSelectedNexusForPanel = (state: AppStore) => state.selectedNexusForPanel

// Theme 选择器
export const selectCurrentTheme = (state: AppStore) => state.currentTheme
export const selectCanvasPalette = (state: AppStore) => state.canvasPalette

// ============================================
// 开发调试：暴露 store 到 window
// ============================================
if (typeof window !== 'undefined') {
  (window as unknown as { __DDOS_STORE__: typeof useStore }).__DDOS_STORE__ = useStore
}
