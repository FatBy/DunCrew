// ============================================
// DunCrew 国际化系统 - 入口
// 核心翻译函数从 core.ts 导出（无 store 依赖）
// React Hooks 在此定义（依赖 store，仅供组件使用）
// ============================================

import { useCallback } from 'react'
import { useStore } from '@/store'
import { translate } from './core'
import type { TranslationKey } from './locales/zh'

// 重导出 core 模块的所有内容
export { translate, getCurrentLocale, tt } from './core'
export type { Locale, TranslationKey } from './core'

type InterpolationParams = Record<string, string | number> | (string | number)[]

/**
 * React Hook: 获取当前语言的翻译函数
 */
export function useT() {
  const locale = useStore((s) => s.locale)

  const t = useCallback(
    (key: TranslationKey, params?: InterpolationParams): string => {
      return translate(key, locale, params)
    },
    [locale]
  )

  return t
}

/**
 * 获取当前语言
 */
export function useLocale() {
  return useStore((s) => s.locale)
}
