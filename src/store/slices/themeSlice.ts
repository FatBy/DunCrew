// ============================================
// DunCrew 主题 & 语言状态管理
// ============================================

import type { StateCreator } from 'zustand'
import type { ThemeName } from '@/types/theme'
import type { Locale } from '@/i18n/core'
import { themes, getTheme } from '@/themes'
import { applyThemeToDOM, getCanvasPalette } from '@/utils/themeUtils'
import type { CanvasPalette } from '@/types/theme'

// LocalStorage 键名
const THEME_STORAGE_KEY = 'duncrew_theme'
const LOCALE_STORAGE_KEY = 'duncrew_locale'

// 从 localStorage 读取主题
function loadTheme(): ThemeName {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved && saved in themes) {
      return saved as ThemeName
    }
  } catch (e) {
    console.warn('[Theme] Failed to load theme from localStorage:', e)
  }
  return 'warm'
}

// 保存主题到 localStorage
function saveTheme(name: ThemeName): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name)
  } catch (e) {
    console.warn('[Theme] Failed to save theme to localStorage:', e)
  }
}

// 从 localStorage 读取语言
function loadLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') {
      return saved
    }
  } catch (e) {
    console.warn('[Theme] Failed to load locale from localStorage:', e)
  }
  return 'zh'
}

// 保存语言到 localStorage
function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch (e) {
    console.warn('[Theme] Failed to save locale to localStorage:', e)
  }
}

export interface ThemeSlice {
  // 状态
  currentTheme: ThemeName
  locale: Locale
  
  // 计算属性
  canvasPalette: CanvasPalette
  
  // Actions
  setTheme: (name: ThemeName) => void
  setLocale: (locale: Locale) => void
  initTheme: () => void
}

export const createThemeSlice: StateCreator<ThemeSlice> = (set, get) => {
  // 初始主题
  const initialTheme = loadTheme()
  const initialPalette = getCanvasPalette(getTheme(initialTheme))
  
  return {
    currentTheme: initialTheme,
    locale: loadLocale(),
    canvasPalette: initialPalette,
    
    setTheme: (name) => {
      const theme = getTheme(name)
      applyThemeToDOM(theme)
      saveTheme(name)
      set({
        currentTheme: name,
        canvasPalette: getCanvasPalette(theme),
      })
    },

    setLocale: (locale) => {
      saveLocale(locale)
      set({ locale })
    },
    
    initTheme: () => {
      const { currentTheme } = get()
      const theme = getTheme(currentTheme)
      applyThemeToDOM(theme)
    },
  }
}
