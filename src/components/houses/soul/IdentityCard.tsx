import { Fingerprint } from 'lucide-react'
import type { SoulIdentity } from '@/types'

interface IdentityCardProps {
  identity: SoulIdentity | null
}

export function IdentityCard({ identity }: IdentityCardProps) {
  return (
    <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4">
      <div className="flex items-center gap-2 text-teal-600/80 text-xs font-semibold mb-3 tracking-widest uppercase">
        <Fingerprint className="w-4 h-4" />
        身份标识
      </div>
      <h2 className="text-xl font-bold text-gray-800 mb-1">
        {identity?.name || 'DunCrew Agent'}
      </h2>
      <p className="text-sm text-teal-500/70 font-mono mb-4">
        {identity?.essence || 'Digital Soul Core'}
      </p>
      <div className="text-xs text-gray-500 bg-gray-50/80 rounded-lg p-2 border border-gray-100">
        {identity?.vibe || '—'}
      </div>
    </div>
  )
}
