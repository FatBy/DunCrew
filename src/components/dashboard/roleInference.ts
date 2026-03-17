// ============================================
// 角色基因系统 — 8 角色 + lucide-react 图标 + CSS 花纹
// 严格复刻原型 ROLE_GENETICS 定义
// ============================================

import React from 'react'
import {
  Cpu,
  Palette,
  Sparkles,
  PieChart,
  Database,
  Code,
  TerminalSquare,
  ShieldCheck,
} from 'lucide-react'
import type { NexusEntity } from '@/types'
import type { GrowthStage } from './nexusGrowth'

// ==========================================
// 类型
// ==========================================

export type NexusRole = 'CORE' | 'CREATOR' | 'DESIGN' | 'ANALYST' | 'DBA' | 'CODER' | 'ENGINE' | 'QA'

export interface RoleGenetics {
  theme: string                    // Tailwind 色系名 e.g. 'amber'
  bg: string                       // Tailwind gradient classes e.g. 'from-amber-300 to-orange-500'
  icon: React.ReactElement         // lucide-react JSX element
  pattern: React.CSSProperties     // CSS background pattern object
}

// ==========================================
// 基因图谱：角色 → 颜色、花纹与图标 (逐字复制原型)
// ==========================================

export const ROLE_GENETICS: Record<NexusRole, RoleGenetics> = {
  CORE: {
    theme: 'amber',
    bg: 'from-amber-300 to-orange-500',
    icon: React.createElement(Cpu, { className: 'w-5 h-5 text-amber-500' }),
    pattern: { backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.8) 10%, transparent 60%)' },
  },
  CREATOR: {
    theme: 'fuchsia',
    bg: 'from-fuchsia-300 to-purple-500',
    icon: React.createElement(Palette, { className: 'w-5 h-5 text-fuchsia-500' }),
    pattern: { backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,0.15) 0px, rgba(255,255,255,0.15) 6px, transparent 6px, transparent 12px)' },
  },
  DESIGN: {
    theme: 'pink',
    bg: 'from-pink-300 to-rose-400',
    icon: React.createElement(Sparkles, { className: 'w-5 h-5 text-pink-500' }),
    pattern: { backgroundImage: 'radial-gradient(rgba(255,255,255,0.4) 2px, transparent 2px)', backgroundSize: '8px 8px' },
  },
  ANALYST: {
    theme: 'cyan',
    bg: 'from-cyan-300 to-blue-500',
    icon: React.createElement(PieChart, { className: 'w-5 h-5 text-cyan-500' }),
    pattern: { backgroundImage: 'linear-gradient(rgba(255,255,255,0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.25) 1px, transparent 1px)', backgroundSize: '6px 6px' },
  },
  DBA: {
    theme: 'blue',
    bg: 'from-blue-400 to-indigo-600',
    icon: React.createElement(Database, { className: 'w-5 h-5 text-blue-500' }),
    pattern: { backgroundImage: 'repeating-radial-gradient(circle at 50% 50%, transparent 0, transparent 4px, rgba(255,255,255,0.15) 4px, rgba(255,255,255,0.15) 8px)' },
  },
  CODER: {
    theme: 'emerald',
    bg: 'from-emerald-300 to-teal-500',
    icon: React.createElement(Code, { className: 'w-5 h-5 text-emerald-500' }),
    pattern: { backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,0.15) 0px, rgba(255,255,255,0.15) 2px, transparent 2px, transparent 6px)' },
  },
  ENGINE: {
    theme: 'violet',
    bg: 'from-violet-400 to-purple-600',
    icon: React.createElement(TerminalSquare, { className: 'w-5 h-5 text-violet-500' }),
    pattern: { backgroundImage: 'repeating-linear-gradient(90deg, rgba(255,255,255,0.1) 0px, rgba(255,255,255,0.1) 8px, transparent 8px, transparent 12px)' },
  },
  QA: {
    theme: 'lime',
    bg: 'from-lime-300 to-green-500',
    icon: React.createElement(ShieldCheck, { className: 'w-5 h-5 text-lime-500' }),
    pattern: { backgroundImage: 'linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.15) 75%, rgba(255,255,255,0.15)), linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.15) 75%, rgba(255,255,255,0.15))', backgroundSize: '10px 10px', backgroundPosition: '0 0, 5px 5px' },
  },
}

export const ALL_ROLES: NexusRole[] = ['CORE', 'CREATOR', 'DESIGN', 'ANALYST', 'DBA', 'CODER', 'ENGINE', 'QA']

// ==========================================
// 角色推断关键词
// ==========================================

const ROLE_SKILL_KEYWORDS: Record<NexusRole, string[]> = {
  CODER: ['coding-agent', 'code-runner', 'code-search', 'github', 'git', 'npm', 'python', 'typescript', 'javascript', 'code-gen', 'code'],
  ANALYST: ['deep-research', 'web-search', 'search', 'python-dataviz', 'critical-evaluation', 'data', 'analysis', 'chart', 'statistics', 'research'],
  CREATOR: ['openai-image-gen', 'powerpoint', 'prose', 'video', 'write', 'creative', 'image', 'audio', 'content'],
  DESIGN: ['frontend-design', 'ui', 'ux', 'figma', 'css', 'tailwind', 'component', 'layout', 'style', 'design'],
  DBA: ['database', 'sql', 'postgres', 'mysql', 'sqlite', 'redis', 'mongo', 'prisma', 'drizzle', 'schema', 'migration', 'db'],
  ENGINE: ['tmux', 'slack', 'discord', 'automation', 'deploy', 'docker', 'k8s', 'ci', 'cd', 'pipeline', 'devops', 'shell'],
  QA: ['test', 'qa', 'e2e', 'playwright', 'cypress', 'jest', 'vitest', 'assert', 'benchmark', 'testing'],
  CORE: [],  // fallback, 不做匹配
}

const ROLE_TEXT_KEYWORDS: Record<NexusRole, string[]> = {
  CODER: ['代码', '编程', '开发', 'code', 'programming', 'coding', 'react', 'vue', 'python'],
  ANALYST: ['搜索', '研究', '分析', '数据', 'research', 'search', 'analysis', 'data', 'insight'],
  CREATOR: ['创作', '绘图', '写作', '生成图', 'creative', 'write', 'create', 'content', 'story'],
  DESIGN: ['设计', '界面', '样式', 'UI', 'UX', 'design', 'layout', 'component', 'visual'],
  DBA: ['数据库', 'SQL', 'database', 'schema', 'migration', 'query'],
  ENGINE: ['运维', '部署', '自动化', 'deploy', 'automation', 'pipeline', 'monitor'],
  QA: ['测试', '质量', '验证', 'test', 'QA', 'quality', 'verify', 'assert'],
  CORE: [],
}

// ==========================================
// inferRole: NexusEntity → NexusRole
// ==========================================

export function inferRole(nexus: NexusEntity): NexusRole {
  const skills = nexus.boundSkillIds ?? []

  // 阶段 1: boundSkillIds 关键词匹配
  if (skills.length > 0) {
    const scores: Partial<Record<NexusRole, number>> = {}
    for (const skillId of skills) {
      const lower = skillId.toLowerCase()
      for (const [role, keywords] of Object.entries(ROLE_SKILL_KEYWORDS) as [NexusRole, string[]][]) {
        if (role === 'CORE') continue
        for (const kw of keywords) {
          if (lower.includes(kw)) {
            scores[role] = (scores[role] ?? 0) + 1
          }
        }
      }
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0]
    if (best && best[1] > 0) return best[0] as NexusRole
  }

  // 阶段 2: 文本语义匹配 (objective + label + sopContent)
  const textSources = [
    nexus.objective ?? '',
    nexus.label ?? '',
    (nexus as any).sopContent ?? '',
  ].join(' ').toLowerCase()

  if (textSources.length > 0) {
    for (const role of ALL_ROLES) {
      if (role === 'CORE') continue
      const keywords = ROLE_TEXT_KEYWORDS[role]
      for (const kw of keywords) {
        if (textSources.includes(kw.toLowerCase())) return role
      }
    }
  }

  // 兜底
  return 'CORE'
}

// ==========================================
// 辅助映射函数
// ==========================================

/** 5 阶段 → 3 阶段映射 (nexusGrowth → 原型) */
export function mapToPrototypeStage(stage: GrowthStage): 'dormant' | 'awakening' | 'evolved' {
  switch (stage) {
    case 'egg': return 'dormant'
    case 'hatchling':
    case 'youth': return 'awakening'
    case 'adult':
    case 'master': return 'evolved'
    default: return 'dormant'
  }
}

/** 成长阶段 → 等级数字 */
export function stageToLevel(stage: GrowthStage): number {
  switch (stage) {
    case 'egg': return 1
    case 'hatchling': return 2
    case 'youth': return 4
    case 'adult': return 6
    case 'master': return 10
    default: return 1
  }
}
