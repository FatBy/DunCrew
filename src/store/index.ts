import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ViewType } from '@/types'
import type { MemorySearchResult } from '@/types'
import { createConnectionSlice, type ConnectionSlice } from './slices/connectionSlice'
import { createSessionsSlice, type SessionsSlice } from './slices/sessionsSlice'
import { createChannelsSlice, type ChannelsSlice } from './slices/channelsSlice'
import { createAgentSlice, type AgentSlice, MEMORY_CACHE_STORAGE_KEY } from './slices/agentSlice'
import { createDevicesSlice, type DevicesSlice } from './slices/devicesSlice'
import { createAiSlice, type AiSlice } from './slices/aiSlice'
import { createWorldSlice, type WorldSlice } from './slices/worldSlice'
import { createObserverSlice, type ObserverSlice } from './slices/observerSlice'
import { createThemeSlice, type ThemeSlice } from './slices/themeSlice'
import { createClawHubSlice, type ClawHubSlice } from './slices/clawHubSlice'
import { createSoulAmendmentSlice, type SoulAmendmentSlice } from './slices/soulAmendmentSlice'
import { createLinkStationSlice, type LinkStationSlice } from './slices/linkStationSlice'
import { createLibrarySlice, type LibrarySlice } from './slices/librarySlice'
import { createWikiSlice, type WikiSlice } from './slices/wikiSlice'

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
export type AppStore = ViewSlice & ConnectionSlice & SessionsSlice & ChannelsSlice & AgentSlice & DevicesSlice & AiSlice & WorldSlice & ObserverSlice & ThemeSlice & ClawHubSlice & SoulAmendmentSlice & LinkStationSlice & LibrarySlice & WikiSlice

// ============================================
// 创建 Store
// ============================================
export const useStore = create<AppStore>()(
  subscribeWithSelector((...args) => ({
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
    ...createLinkStationSlice(...args),
    ...createLibrarySlice(...args),
    ...createWikiSlice(...args),
  }))
)

// DEV: 暴露 store 到 window，方便控制台调试（统一挂载点，见下方 __DDOS_STORE__）

// ============================================
// 记忆缓存持久化 (stale-while-revalidate)
// memoryCacheVersion 变化时，防抖 2s 后写入 localStorage
// 恢复见 agentSlice.ts 的 restoreMemoryCacheFromStorage
// MEMORY_CACHE_STORAGE_KEY 统一从 agentSlice 导入，避免读写 key 不一致
// ============================================

let _memoryCachePersistTimer: ReturnType<typeof setTimeout> | null = null
useStore.subscribe(
  (state) => state.memoryCacheVersion,
  () => {
    if (_memoryCachePersistTimer) clearTimeout(_memoryCachePersistTimer)
    _memoryCachePersistTimer = setTimeout(() => {
      const raw = useStore.getState().memoryCacheRaw
      try {
        // 只缓存 L0 memory + L1，控制体积（约 0.5-1MB）
        const toCache: MemorySearchResult[] = raw
          .filter(r => r.source === 'memory' || r.source === 'l1_memory')
          .slice(0, 300)
        localStorage.setItem(MEMORY_CACHE_STORAGE_KEY, JSON.stringify(toCache))
      } catch { /* localStorage quota exceeded — 静默失败 */ }
    }, 2000)
  },
)

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
export const selectDunes = (state: AppStore) => state.duns
export const selectCamera = (state: AppStore) => state.camera
export const selectSelectedDunId = (state: AppStore) => state.selectedDunId
export const selectRenderSettings = (state: AppStore) => state.renderSettings

// Observer 选择器
export const selectCurrentProposal = (state: AppStore) => state.currentProposal
export const selectDunPanelOpen = (state: AppStore) => state.dunPanelOpen
export const selectSelectedDunForPanel = (state: AppStore) => state.selectedDunForPanel

// Theme 选择器
export const selectCurrentTheme = (state: AppStore) => state.currentTheme
export const selectCanvasPalette = (state: AppStore) => state.canvasPalette

// LinkStation 选择器
export const selectLinkStation = (state: AppStore) => state.linkStation
export const selectProviders = (state: AppStore) => state.linkStation.providers
export const selectChannelBindings = (state: AppStore) => state.linkStation.channelBindings

// Wiki 选择器
export const selectWikiEntitiesByDun = (state: AppStore) => state.wikiEntitiesByDun
export const selectWikiLoadingByDun = (state: AppStore) => state.wikiLoadingByDun

// ============================================
// 开发调试：暴露 store 到 window
// ============================================
if (typeof window !== 'undefined') {
  (window as unknown as { __DDOS_STORE__: typeof useStore }).__DDOS_STORE__ = useStore
}
