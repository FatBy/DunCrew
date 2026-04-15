import { motion } from 'framer-motion'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import type { Locale } from '@/i18n'

const options: { value: Locale; label: string }[] = [
  { value: 'zh', label: '中' },
  { value: 'en', label: 'EN' },
]

export function LocaleToggle() {
  const locale = useStore((s) => s.locale)
  const setLocale = useStore((s) => s.setLocale)

  return (
    <div
      className="flex items-center rounded-full bg-stone-100/80 border border-stone-200/60 p-[3px] backdrop-blur-xl"
      title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
    >
      {options.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setLocale(value)}
          className={cn(
            'relative px-2.5 py-1 rounded-full text-[11px] font-mono font-semibold transition-colors',
            locale === value ? 'text-white' : 'text-stone-400 hover:text-stone-500',
          )}
        >
          {locale === value && (
            <motion.div
              layoutId="locale-pill"
              className="absolute inset-0 rounded-full bg-stone-700"
              transition={{ type: 'spring', stiffness: 500, damping: 32 }}
            />
          )}
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  )
}
