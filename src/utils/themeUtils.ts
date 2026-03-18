// ============================================
// DunCrew 主题工具函数
// ============================================

import type { Theme, ThemeColors, CanvasPalette } from '@/types/theme'

/**
 * 将主题颜色注入到 DOM 的 CSS 变量中
 */
export function applyThemeToDOM(theme: Theme): void {
  const root = document.documentElement
  const { colors, canvas } = theme

  // 背景系
  root.style.setProperty('--color-bg-primary', colors.bgPrimary)
  root.style.setProperty('--color-bg-secondary', colors.bgSecondary)
  root.style.setProperty('--color-bg-panel', colors.bgPanel)
  root.style.setProperty('--color-bg-elevated', colors.bgElevated)

  // 文本系
  root.style.setProperty('--color-text-primary', colors.textPrimary)
  root.style.setProperty('--color-text-secondary', colors.textSecondary)
  root.style.setProperty('--color-text-muted', colors.textMuted)

  // 边框
  root.style.setProperty('--color-border-subtle', colors.borderSubtle)
  root.style.setProperty('--color-border-medium', colors.borderMedium)

  // 强调色
  root.style.setProperty('--color-accent-cyan', colors.accentCyan)
  root.style.setProperty('--color-accent-amber', colors.accentAmber)
  root.style.setProperty('--color-accent-emerald', colors.accentEmerald)
  root.style.setProperty('--color-accent-purple', colors.accentPurple)
  root.style.setProperty('--color-accent-red', colors.accentRed)

  // Canvas 专用
  root.style.setProperty('--canvas-space-1', canvas.spaceGradient[0])
  root.style.setProperty('--canvas-space-2', canvas.spaceGradient[1])
  root.style.setProperty('--canvas-space-3', canvas.spaceGradient[2])
  root.style.setProperty('--canvas-grid', canvas.gridColor)
  root.style.setProperty('--canvas-grid-opacity', String(canvas.gridOpacity))
  root.style.setProperty('--canvas-star', canvas.starColor)

  // 设置 data-theme 属性（用于 CSS 选择器）
  root.setAttribute('data-theme', theme.name)

  console.log(`[Theme] Applied theme: ${theme.name}`)
}

/**
 * 从主题中获取 Canvas 色板
 */
export function getCanvasPalette(theme: Theme): CanvasPalette {
  return theme.canvas
}

/**
 * RGB 字符串转 HEX
 * "255 255 255" -> "#ffffff"
 */
export function rgbStringToHex(rgb: string): string {
  const parts = rgb.split(' ').map(Number)
  if (parts.length !== 3) return '#000000'
  const [r, g, b] = parts
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

/**
 * HEX 转 RGB 字符串
 * "#ffffff" -> "255 255 255"
 */
export function hexToRgbString(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return '0 0 0'
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
  ].join(' ')
}

/**
 * 获取 CSS 变量值（带透明度）
 */
export function getCssVarWithAlpha(varName: string, alpha: number): string {
  return `rgb(var(${varName}) / ${alpha})`
}

/**
 * 从 ThemeColors 生成 CSS 变量对象
 * 用于 Tailwind 配置
 */
export function generateCssVars(colors: ThemeColors): Record<string, string> {
  return {
    '--color-bg-primary': colors.bgPrimary,
    '--color-bg-secondary': colors.bgSecondary,
    '--color-bg-panel': colors.bgPanel,
    '--color-bg-elevated': colors.bgElevated,
    '--color-text-primary': colors.textPrimary,
    '--color-text-secondary': colors.textSecondary,
    '--color-text-muted': colors.textMuted,
    '--color-text-tertiary': colors.textTertiary,
    '--color-border-subtle': colors.borderSubtle,
    '--color-border-medium': colors.borderMedium,
    '--color-accent-cyan': colors.accentCyan,
    '--color-accent-amber': colors.accentAmber,
    '--color-accent-emerald': colors.accentEmerald,
    '--color-accent-purple': colors.accentPurple,
    '--color-accent-red': colors.accentRed,
  }
}
