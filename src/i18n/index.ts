// ============================================
// DunCrew 国际化系统
// ============================================

import { useCallback } from 'react'
import { useStore } from '@/store'
import zh, { type TranslationKey } from './locales/zh'
import en from './locales/en'

export type Locale = 'zh' | 'en'

const locales: Record<Locale, Record<TranslationKey, string>> = { zh, en }

/**
 * 翻译函数 (非 Hook，直接获取)
 */
export function translate(key: TranslationKey, locale: Locale): string {
  return locales[locale]?.[key] ?? locales.zh[key] ?? key
}

/**
 * React Hook: 获取当前语言的翻译函数
 */
export function useT() {
  const locale = useStore((s) => s.locale)

  const t = useCallback(
    (key: TranslationKey): string => {
      return locales[locale]?.[key] ?? locales.zh[key] ?? key
    },
    [locale]
  )

  return t
}

/**
 * 获取当前语言
 */
export function useLocale(): Locale {
  return useStore((s) => s.locale)
}

// 导出类型
export type { TranslationKey }
