// ============================================
// DunCrew i18n 核心翻译模块（无 store 依赖，可安全被 store slices 导入）
// ============================================

import zh, { type TranslationKey } from './locales/zh'
import en from './locales/en'

export type Locale = 'zh' | 'en'

type InterpolationParams = Record<string, string | number> | (string | number)[]

const locales: Record<Locale, Record<TranslationKey, string>> = { zh, en }

const LOCALE_STORAGE_KEY = 'duncrew_locale'

/**
 * 插值替换：支持 {0} {1} 位置参数 和 {name} 命名参数
 */
function interpolate(template: string, params?: InterpolationParams): string {
  if (!params) return template
  if (Array.isArray(params)) {
    return template.replace(/\{(\d+)\}/g, (_, idx) => {
      const val = params[Number(idx)]
      return val !== undefined ? String(val) : `{${idx}}`
    })
  }
  return template.replace(/\{([a-zA-Z_]\w*)\}/g, (_, key) => {
    const val = params[key]
    return val !== undefined ? String(val) : `{${key}}`
  })
}

/**
 * 翻译函数 (非 Hook，直接获取)
 */
export function translate(key: TranslationKey, locale: Locale, params?: InterpolationParams): string {
  const template = locales[locale]?.[key] ?? locales.zh[key] ?? key
  return interpolate(template, params)
}

/**
 * 获取当前 locale（从 localStorage 读取，避免循环依赖 store）
 * 用于服务层、工具函数等非 React 组件环境
 */
export function getCurrentLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* SSR or localStorage unavailable */ }
  return 'zh'
}

/**
 * 服务层翻译简写：自动读取当前 locale
 */
export function tt(key: TranslationKey, params?: InterpolationParams): string {
  return translate(key, getCurrentLocale(), params)
}

export type { TranslationKey }
