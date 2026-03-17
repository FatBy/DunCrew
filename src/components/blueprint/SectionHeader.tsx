import type { ReactNode } from 'react'

interface SectionHeaderProps {
  title: string
  subtitle?: string
  action?: ReactNode
}

export const SectionHeader = ({ title, subtitle, action }: SectionHeaderProps) => (
  <div className="flex items-end justify-between border-b border-stone-200/60 pb-4 mb-6">
    <div>
      <h2 className="text-2xl font-black text-stone-800 tracking-tight">{title}</h2>
      {subtitle && <p className="text-sm font-medium text-stone-500 mt-1">{subtitle}</p>}
    </div>
    {action && <div>{action}</div>}
  </div>
)
