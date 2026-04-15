import { Fingerprint, Sparkles } from 'lucide-react'
import type { SoulIdentity } from '@/types'

interface IdentityCardProps {
  identity: SoulIdentity | null
  onRegenerate?: () => void
}

export function IdentityCard({ identity, onRegenerate }: IdentityCardProps) {
  return (
    <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-teal-600/80 text-xs font-semibold tracking-widest uppercase">
          <Fingerprint className="w-4 h-4" />
          身份标识
        </div>
        {onRegenerate && (
          <button
            onClick={onRegenerate}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-teal-600 transition-colors"
            title="重新生成灵魂"
          >
            <Sparkles className="w-3 h-3" />
            重塑
          </button>
        )}
      </div>
      <h2 className="text-xl font-bold text-gray-800 mb-1">
        {identity?.name || 'DunCrew 智能体'}
      </h2>
      <p className="text-sm text-teal-500/70 font-mono mb-4">
        {identity?.essence || '数字灵魂核心'}
      </p>
      <div className="text-xs text-gray-500 bg-gray-50/80 rounded-lg p-2 border border-gray-100">
        {identity?.vibe || '—'}
      </div>
    </div>
  )
}
