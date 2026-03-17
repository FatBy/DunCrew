// ============================================
// DD-OS 主题配置
// ============================================

import type { Theme, ThemeName } from '@/types/theme'

// ============================================
// 暖色治愈主题 (唯一 UI 主题)
// ============================================
const warmTheme: Theme = {
  name: 'warm',
  label: '暖阳治愈',
  description: '奶油暖色调，柔和治愈，养成系首选',
  colors: {
    // 背景系 - 奶油暖色
    bgPrimary: '253 251 245',       // #fdfbf5 暖白
    bgSecondary: '247 243 233',     // #f7f3e9 米色
    bgPanel: '255 253 248',         // #fffdf8 近白
    bgElevated: '239 233 218',      // #efe9da 浅卡其

    // 文本系 - 深暖色
    textPrimary: '60 50 40',        // #3c3228 深棕
    textSecondary: '120 105 85',    // #786955 中棕
    textMuted: '170 155 135',       // #aa9b87 浅棕
    textTertiary: '150 135 115',    // #968773 第三级棕

    // 边框 - 暖灰
    borderSubtle: '180 165 140',    // 暖灰
    borderMedium: '160 145 120',

    // 强调色 - 暖色系
    accentCyan: '94 186 174',       // #5ebab0 薄荷青绿
    accentAmber: '232 168 56',      // #e8a838 暖金
    accentEmerald: '108 180 120',   // #6cb478 草绿
    accentPurple: '178 132 190',    // #b284be 薰衣草紫
    accentRed: '220 120 100',       // #dc7864 珊瑚红
  },
  canvas: {
    spaceGradient: ['#fdfbf5', '#f7f3e9', '#faf6ee'],
    gridColor: '180, 165, 140',
    gridOpacity: 0.06,
    starColor: '#c8b898',
    labelSelected: 'rgba(60,50,40,0.9)',
    labelDefault: 'rgba(120,105,85,0.6)',
    glowHue: 35,    // 暖金色系
    coreHue: 30,
  },
  dashboard: {
    // 节点 - 奶油卡片
    nodeGradientFrom: '#fffdf8',
    nodeGradientTo: '#f7f3e9',
    nodeBorder: 'rgba(200,185,160,0.3)',
    nodeGlow: 'rgba(232,168,56,0.25)',

    // 连接线
    linkColor: 'rgba(180,165,140,0.15)',
    linkActiveColor: 'rgba(232,168,56,0.35)',

    // 成长阶段色 - 暖色渐进
    stageEgg: '#c8b898',           // 蛋壳米色
    stageHatchling: '#94c9a0',     // 嫩芽绿
    stageYouth: '#e8a838',         // 阳光金
    stageAdult: '#d97740',         // 暖橙
    stageMaster: '#c94050',        // 炽焰红

    // 情绪色
    emotionHappy: '#f0c040',       // 向日葵黄
    emotionSad: '#a89880',         // 灰棕
    emotionNeutral: '#c8b898',     // 中性米

    // 成就徽章
    achievementGold: '#e8a838',
    achievementSilver: '#b8a898',
    achievementBronze: '#c88040',

    // 悬浮卡片
    hoverCardBg: 'rgba(255,253,248,0.97)',
    hoverCardBorder: 'rgba(200,185,160,0.25)',

    // 角色基因色
    roleResearcher: '#C9A96E',
    roleCoder: '#6CB478',
    roleAnalyst: '#B284BE',
    roleCreator: '#DC7864',
    roleOperator: '#5EBAB0',
    roleGeneral: '#C8B898',
    cellPatternColor: 'rgba(200,185,160,0.04)',
  },
}

// ============================================
// 导出
// ============================================

export const themes: Record<ThemeName, Theme> = {
  warm: warmTheme,
}

export function getTheme(name: ThemeName): Theme {
  return themes[name] || warmTheme
}

export const themeNames: ThemeName[] = ['warm']
