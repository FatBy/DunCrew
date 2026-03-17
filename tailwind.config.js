/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  safelist: [
    // IncubatorPod 原型中 8 个角色色系的动态 Tailwind 类名
    // 原型使用 `border-${theme}-100` 模板字面量，JIT 无法静态扫描
    ...['amber','fuchsia','pink','cyan','blue','emerald','violet','lime','stone',
        'orange','purple','rose','indigo','teal','green'].flatMap(c => [
      `border-${c}-100`, `border-${c}-200`, `border-${c}-200/50`,
      `text-${c}-400`, `text-${c}-500`, `text-${c}-600`,
      `bg-${c}-50`, `bg-${c}-100`, `bg-${c}-400/20`,
      `shadow-${c}-400/40`, `shadow-${c}-500/60`,
      `from-${c}-300`, `from-${c}-400`, `to-${c}-400`, `to-${c}-500`, `to-${c}-600`,
    ]),
  ],
  theme: {
    extend: {
      // ============================================
      // 主题化颜色 (映射到 CSS 变量)
      // ============================================
      colors: {
        skin: {
          // 背景系
          'bg-primary': 'rgb(var(--color-bg-primary) / <alpha-value>)',
          'bg-secondary': 'rgb(var(--color-bg-secondary) / <alpha-value>)',
          'bg-panel': 'rgb(var(--color-bg-panel) / <alpha-value>)',
          'bg-elevated': 'rgb(var(--color-bg-elevated) / <alpha-value>)',
          
          // 文本系
          'text-primary': 'rgb(var(--color-text-primary) / <alpha-value>)',
          'text-secondary': 'rgb(var(--color-text-secondary) / <alpha-value>)',
          'text-tertiary': 'rgb(var(--color-text-tertiary) / <alpha-value>)',
          'text-muted': 'rgb(var(--color-text-muted) / <alpha-value>)',
          
          // 边框
          'border': 'rgb(var(--color-border-subtle) / <alpha-value>)',
          'border-medium': 'rgb(var(--color-border-medium) / <alpha-value>)',
          
          // 强调色
          'accent-cyan': 'rgb(var(--color-accent-cyan) / <alpha-value>)',
          'accent-amber': 'rgb(var(--color-accent-amber) / <alpha-value>)',
          'accent-emerald': 'rgb(var(--color-accent-emerald) / <alpha-value>)',
          'accent-purple': 'rgb(var(--color-accent-purple) / <alpha-value>)',
          'accent-red': 'rgb(var(--color-accent-red) / <alpha-value>)',
        },
      },
      
      // ============================================
      // Typography 暗色主题覆盖
      // ============================================
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-body': 'rgb(209 213 219)',
            '--tw-prose-headings': 'rgb(255 255 255)',
            '--tw-prose-links': 'rgb(34 211 238)',
            '--tw-prose-bold': 'rgb(255 255 255)',
            '--tw-prose-code': 'rgb(52 211 153)',
            '--tw-prose-pre-bg': 'rgb(17 24 39 / 0.6)',
            '--tw-prose-quotes': 'rgb(156 163 175)',
            '--tw-prose-quote-borders': 'rgb(34 211 238 / 0.4)',
            '--tw-prose-counters': 'rgb(156 163 175)',
            '--tw-prose-bullets': 'rgb(34 211 238)',
            '--tw-prose-th-borders': 'rgb(55 65 81)',
            '--tw-prose-td-borders': 'rgb(55 65 81)',
          }
        }
      },

      // ============================================
      // 动画
      // ============================================
      animation: {
        'breathe': 'breathe 3s ease-in-out infinite',
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'float': 'float 6s ease-in-out infinite',
      },
      keyframes: {
        breathe: {
          '0%, 100%': { opacity: '0.4', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
