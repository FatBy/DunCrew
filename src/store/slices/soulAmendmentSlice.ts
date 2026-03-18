import type { StateCreator } from 'zustand'
import type { SoulAmendment } from '@/types'
import { SOUL_EVOLUTION_CONFIG } from '@/types'

const STORAGE_KEY = 'duncrew_soul_amendments'
const SERVER_URL = 'http://localhost:3001'
const SAVE_DEBOUNCE_MS = 5000

export interface SoulAmendmentSlice {
  // State
  amendments: SoulAmendment[]
  draftAmendments: SoulAmendment[]
  amendmentsLoading: boolean

  // Actions
  loadAmendments: () => Promise<void>
  addDraft: (draft: SoulAmendment) => void
  approveDraft: (id: string) => void
  rejectDraft: (id: string) => void
  archiveAmendment: (id: string) => void
  incrementHitCount: (id: string) => void
  applyAmendmentDecay: () => void
  saveAmendmentsToBackend: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave(saveToBackend: () => void) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveToBackend, SAVE_DEBOUNCE_MS)
}

export const createSoulAmendmentSlice: StateCreator<SoulAmendmentSlice> = (set, get) => ({
  amendments: [],
  draftAmendments: [],
  amendmentsLoading: false,

  loadAmendments: async () => {
    set({ amendmentsLoading: true })
    try {
      const res = await fetch(`${SERVER_URL}/api/amendments/load`)
      if (res.ok) {
        const all: SoulAmendment[] = await res.json()
        const drafts = all.filter((a) => a.status === 'draft')
        const rest = all.filter((a) => a.status !== 'draft')
        set({ amendments: rest, draftAmendments: drafts, amendmentsLoading: false })
        // 同步到 localStorage 缓存
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch {}
        return
      }
    } catch {}
    // Fallback: localStorage
    try {
      const cached = localStorage.getItem(STORAGE_KEY)
      if (cached) {
        const all: SoulAmendment[] = JSON.parse(cached)
        const drafts = all.filter((a) => a.status === 'draft')
        const rest = all.filter((a) => a.status !== 'draft')
        set({ amendments: rest, draftAmendments: drafts })
      }
    } catch {}
    set({ amendmentsLoading: false })
  },

  addDraft: (draft) => {
    set((state) => ({ draftAmendments: [...state.draftAmendments, draft] }))
    scheduleSave(get().saveAmendmentsToBackend)
  },

  approveDraft: (id) => {
    set((state) => {
      const draft = state.draftAmendments.find((d) => d.id === id)
      if (!draft) return state
      const approved: SoulAmendment = {
        ...draft,
        status: 'approved',
        confirmedAt: Date.now(),
      }
      return {
        draftAmendments: state.draftAmendments.filter((d) => d.id !== id),
        amendments: [...state.amendments, approved],
      }
    })
    scheduleSave(get().saveAmendmentsToBackend)
  },

  rejectDraft: (id) => {
    set((state) => ({
      draftAmendments: state.draftAmendments.filter((d) => d.id !== id),
    }))
    scheduleSave(get().saveAmendmentsToBackend)
  },

  archiveAmendment: (id) => {
    set((state) => ({
      amendments: state.amendments.map((a) =>
        a.id === id ? { ...a, status: 'archived' as const } : a,
      ),
    }))
    scheduleSave(get().saveAmendmentsToBackend)
  },

  incrementHitCount: (id) => {
    const now = Date.now()
    set((state) => ({
      amendments: state.amendments.map((a) =>
        a.id === id ? { ...a, hitCount: a.hitCount + 1, lastHitAt: now } : a,
      ),
    }))
    // hitCount 更新频繁，使用防抖
    scheduleSave(get().saveAmendmentsToBackend)
  },

  applyAmendmentDecay: () => {
    const now = Date.now()
    const halfLifeMs = SOUL_EVOLUTION_CONFIG.DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000
    const recentHitWindow = 7 * 24 * 60 * 60 * 1000 // 7天

    set((state) => ({
      amendments: state.amendments.map((a) => {
        if (a.status !== 'approved') return a

        const referenceTime = a.lastHitAt || a.confirmedAt || a.createdAt
        const ageMs = now - referenceTime

        // 最近 7 天有 hit → 衰减速度减半
        const effectiveHalfLife = (a.lastHitAt && now - a.lastHitAt < recentHitWindow)
          ? halfLifeMs * 2
          : halfLifeMs

        const decayFactor = Math.pow(0.5, ageMs / effectiveHalfLife)
        const newWeight = a.weight * decayFactor

        // 低于阈值 → auto-archive
        if (newWeight < SOUL_EVOLUTION_CONFIG.MIN_WEIGHT_THRESHOLD) {
          return { ...a, weight: newWeight, status: 'archived' as const }
        }
        return { ...a, weight: newWeight }
      }),
    }))
    scheduleSave(get().saveAmendmentsToBackend)
  },

  saveAmendmentsToBackend: () => {
    const { amendments, draftAmendments } = get()
    const all = [...amendments, ...draftAmendments]

    // localStorage 缓存
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)) } catch {}

    // Backend 持久化
    fetch(`${SERVER_URL}/api/amendments/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(all),
    }).catch(() => {})
  },
})
