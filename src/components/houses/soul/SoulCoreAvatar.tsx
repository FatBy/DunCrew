import { useState, useCallback, useEffect } from 'react'
import { Loader2, Brain } from 'lucide-react'
import type { MBTIResult, SoulIdentity } from '@/types'
import { getAvatarPath } from '@/services/mbtiAnalyzer'

interface SoulCoreAvatarProps {
  mbtiResult: MBTIResult | null
  identity: SoulIdentity | null
  loading: boolean
}

export function SoulCoreAvatar({ mbtiResult, identity, loading }: SoulCoreAvatarProps) {
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)

  const avatarSrc = mbtiResult ? getAvatarPath(mbtiResult) : ''

  // Reset states when src changes
  useEffect(() => {
    setImgLoaded(false)
    setImgError(false)
  }, [avatarSrc])

  // Handle cached images that load before React attaches onLoad
  const handleImgRef = useCallback((img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth > 0) {
      setImgLoaded(true)
    }
  }, [])

    return (
    <div className="lg:col-span-6 flex flex-col items-center p-8 relative h-fit sticky top-1/4">
      {/* Decorative Background Rings */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="w-64 h-64 border-[0.5px] border-teal-200/30 rounded-full absolute animate-[spin_60s_linear_infinite]" />
        <div className="w-80 h-80 border-[0.5px] border-indigo-200/20 rounded-full absolute animate-[spin_90s_linear_infinite_reverse]" />
      </div>

      {/* Avatar Container */}
      <div className="relative z-10 w-40 h-40 rounded-full bg-gradient-to-tr from-teal-100 to-indigo-50 p-1.5 shadow-[0_0_40px_rgba(20,184,166,0.15)]">
        <div className="w-full h-full rounded-full bg-white overflow-hidden border-4 border-white shadow-inner flex items-center justify-center relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-stone-50">
              <Loader2 className="w-10 h-10 text-teal-400/40 animate-spin" />
            </div>
          ) : mbtiResult && !imgError ? (
            <>
              <img
                ref={handleImgRef}
                src={avatarSrc}
                alt={`${mbtiResult.animalZh} - ${mbtiResult.type.toUpperCase()}`}
                className={`w-full h-full object-cover object-center bg-[#FCFAF8] scale-110 transition-opacity duration-500 ${
                  imgLoaded ? 'opacity-100' : 'opacity-0'
                }`}
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgError(true)}
              />
              {!imgLoaded && (
                <div className="absolute inset-0 flex items-center justify-center bg-stone-50">
                  <Loader2 className="w-8 h-8 text-teal-400 animate-spin" />
                </div>
              )}
            </>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-teal-50 to-indigo-50">
              <Brain className="w-12 h-12 text-teal-400" />
              {mbtiResult && (
                <span className="text-xs text-teal-600 font-bold mt-1">{mbtiResult.type.toUpperCase()}</span>
              )}
            </div>
          )}
        </div>
        {/* Status Dot */}
        <div className="absolute bottom-2 right-2 w-4 h-4 bg-teal-400 border-2 border-white rounded-full shadow-[0_0_10px_rgba(45,212,191,0.5)]" />
      </div>

      {/* Label area */}
      <div className="mt-6 text-center z-10">
        <div className="text-xl font-black text-transparent bg-clip-text bg-gradient-to-r from-teal-600 to-indigo-600 tracking-wider">
          {mbtiResult
            ? `${mbtiResult.type.toUpperCase()} ${mbtiResult.animalZh}`
            : identity?.symbol || '---'}
        </div>
        <div className="text-xs text-gray-400 font-mono mt-1">
          {mbtiResult
            ? `${mbtiResult.group} / ${identity?.name || '智能体'}`
            : identity?.essence || '数字灵魂核心'}
        </div>
        {mbtiResult && (
          <div className="mt-4 flex gap-2 justify-center flex-wrap">
            {mbtiResult.trait.split('\uff0c').slice(0, 2).map((t, i) => (
              <span
                key={i}
                className="px-3 py-1 bg-white/60 border border-gray-100 rounded-full text-xs text-gray-600 shadow-sm"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
