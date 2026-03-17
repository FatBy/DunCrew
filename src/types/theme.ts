// ============================================
// DD-OS 主题系统类型定义
// ============================================

export type ThemeName = 'warm'

// CSS 变量键名映射
export interface ThemeColors {
  // 背景系 (RGB 格式，用于 Tailwind)
  bgPrimary: string      // 主背景 (原 slate-950 #020617)
  bgSecondary: string    // 次背景 (原 slate-900 #0f172a)
  bgPanel: string        // 面板背景 (原 black)
  bgElevated: string     // 提升背景

  // 文本系
  textPrimary: string    // 主文本 (原 white)
  textSecondary: string  // 次文本 (原 white/60)
  textMuted: string      // 弱文本 (原 white/30)
  textTertiary: string   // 第三级文本

  // 边框
  borderSubtle: string   // 浅边框 (原 white/10)
  borderMedium: string   // 中边框 (原 white/20)

  // 强调色 (RGB 格式)
  accentCyan: string
  accentAmber: string
  accentEmerald: string
  accentPurple: string
  accentRed: string
}

// Dashboard 专用配色 Token
export interface DashboardPalette {
  // 节点背景 (渐变起止色)
  nodeGradientFrom: string
  nodeGradientTo: string
  nodeBorder: string
  nodeGlow: string

  // 连接线
  linkColor: string
  linkActiveColor: string

  // 成长阶段色
  stageEgg: string
  stageHatchling: string
  stageYouth: string
  stageAdult: string
  stageMaster: string

  // 情绪色
  emotionHappy: string
  emotionSad: string
  emotionNeutral: string

  // 成就徽章底色
  achievementGold: string
  achievementSilver: string
  achievementBronze: string

  // 悬浮卡片
  hoverCardBg: string
  hoverCardBorder: string

  // 角色基因色 (仅生物态主题使用，其他主题可不填)
  roleResearcher?: string
  roleCoder?: string
  roleAnalyst?: string
  roleCreator?: string
  roleOperator?: string
  roleGeneral?: string
  cellPatternColor?: string
}

// GameCanvas 专用色板
export interface CanvasPalette {
  // 深空背景渐变 (HEX 格式)
  spaceGradient: [string, string, string]
  
  // 网格线 (RGB 格式)
  gridColor: string
  gridOpacity: number
  
  // 星空粒子
  starColor: string
  
  // 标签颜色
  labelSelected: string
  labelDefault: string
  
  // 光晕基色 (HSL hue)
  glowHue: number
  
  // 核心能量基色
  coreHue: number
}

// 完整主题配置
export interface Theme {
  name: ThemeName
  label: string
  description: string
  colors: ThemeColors
  canvas: CanvasPalette
  dashboard: DashboardPalette
}

// 主题存储状态
export interface ThemeState {
  currentTheme: ThemeName
}
