import type { StateCreator } from 'zustand'
import type { ClawHubSkillSummary, ClawHubUser, ClawHubSuggestion } from '@/types'
import { clawHubService } from '@/services/clawHubService'
import { clawHubAuthService } from '@/services/clawHubAuthService'

export interface ClawHubSlice {
  // 认证状态
  clawHubAuthenticated: boolean
  clawHubUser: ClawHubUser | null
  clawHubAuthLoading: boolean

  // 搜索状态
  clawHubSearchResults: ClawHubSkillSummary[]
  clawHubSearchQuery: string
  clawHubSearchLoading: boolean

  // 安装状态
  clawHubInstalling: Record<string, boolean>

  // 发布状态
  clawHubPublishing: string | null

  // 自动发现建议
  clawHubSuggestions: ClawHubSuggestion[]

  // Actions
  clawHubLogin: () => Promise<void>
  clawHubLogout: () => void
  clawHubValidateToken: () => Promise<void>
  clawHubSearch: (query: string) => Promise<void>
  clawHubInstallSkill: (slug: string, archiveUrl: string) => Promise<{ success: boolean; message: string }>
  clawHubSetPublishing: (skillName: string | null) => void
  addClawHubSuggestion: (suggestion: ClawHubSuggestion) => void
  dismissClawHubSuggestion: (id: string) => void
  clearClawHubSuggestions: () => void
}

export const createClawHubSlice: StateCreator<ClawHubSlice> = (set) => ({
  clawHubAuthenticated: clawHubAuthService.isAuthenticated(),
  clawHubUser: null,
  clawHubAuthLoading: false,
  clawHubSearchResults: [],
  clawHubSearchQuery: '',
  clawHubSearchLoading: false,
  clawHubInstalling: {},
  clawHubPublishing: null,
  clawHubSuggestions: [],

  clawHubLogin: async () => {
    set({ clawHubAuthLoading: true })
    try {
      const token = await clawHubAuthService.startOAuthFlow()
      if (token) {
        const user = await clawHubService.whoami()
        set({
          clawHubAuthenticated: true,
          clawHubUser: user,
          clawHubAuthLoading: false,
        })
      } else {
        set({ clawHubAuthLoading: false })
      }
    } catch (error) {
      console.error('[ClawHub] Login failed:', error)
      set({ clawHubAuthLoading: false })
    }
  },

  clawHubLogout: () => {
    clawHubAuthService.logout()
    set({
      clawHubAuthenticated: false,
      clawHubUser: null,
    })
  },

  clawHubValidateToken: async () => {
    if (!clawHubAuthService.isAuthenticated()) return
    set({ clawHubAuthLoading: true })
    const user = await clawHubAuthService.validateToken()
    set({
      clawHubAuthenticated: !!user,
      clawHubUser: user,
      clawHubAuthLoading: false,
    })
  },

  clawHubSearch: async (query: string) => {
    set({ clawHubSearchQuery: query, clawHubSearchLoading: true })
    try {
      const result = await clawHubService.searchSkills(query)
      set({
        clawHubSearchResults: result?.skills ?? [],
        clawHubSearchLoading: false,
      })
    } catch (error) {
      console.error('[ClawHub] Search failed:', error)
      set({ clawHubSearchLoading: false })
    }
  },

  clawHubInstallSkill: async (slug: string, archiveUrl: string) => {
    set(state => ({
      clawHubInstalling: { ...state.clawHubInstalling, [slug]: true },
    }))
    try {
      const result = await clawHubService.installViaBackend(slug, archiveUrl)
      set(state => {
        const installing = { ...state.clawHubInstalling }
        delete installing[slug]
        return { clawHubInstalling: installing }
      })
      return result
    } catch (error) {
      set(state => {
        const installing = { ...state.clawHubInstalling }
        delete installing[slug]
        return { clawHubInstalling: installing }
      })
      return { success: false, message: String(error) }
    }
  },

  clawHubSetPublishing: (skillName: string | null) => {
    set({ clawHubPublishing: skillName })
  },

  addClawHubSuggestion: (suggestion: ClawHubSuggestion) => {
    set(state => ({
      clawHubSuggestions: [...state.clawHubSuggestions, suggestion],
    }))
  },

  dismissClawHubSuggestion: (id: string) => {
    set(state => ({
      clawHubSuggestions: state.clawHubSuggestions.map(s =>
        s.id === id ? { ...s, dismissed: true } : s
      ),
    }))
  },

  clearClawHubSuggestions: () => {
    set({ clawHubSuggestions: [] })
  },
})
