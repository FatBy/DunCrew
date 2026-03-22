import { useState } from 'react'
import { ShieldAlert, ChevronDown } from 'lucide-react'
import type { SoulTruth } from '@/types'

interface CoreTruthsAccordionProps {
  truths: SoulTruth[]
}

export function CoreTruthsAccordion({ truths }: CoreTruthsAccordionProps) {
  const [expandedId, setExpandedId] = useState<string | null>(truths[0]?.id ?? null)

  return (
    <div className="bg-white/60 backdrop-blur-md border border-white/80 shadow-[0_4px_24px_-8px_rgba(0,0,0,0.05)] rounded-2xl p-4 flex flex-col max-h-[60vh]">
      <div className="flex items-center gap-2 text-indigo-400/80 text-xs font-semibold mb-4 tracking-widest uppercase">
        <ShieldAlert className="w-4 h-4" />
        核心协议 (L1)
      </div>

      <div className="space-y-1 overflow-y-auto flex-1 pr-2">
        {truths.map((truth) => {
          const isExpanded = expandedId === truth.id
          return (
            <div
              key={truth.id}
              className={`group border rounded-xl transition-all duration-200 overflow-hidden cursor-pointer ${
                isExpanded
                  ? 'bg-indigo-50/50 border-indigo-100'
                  : 'bg-transparent border-transparent hover:bg-gray-50/50'
              }`}
              onClick={() => setExpandedId(isExpanded ? null : truth.id)}
            >
              {/* Header row */}
              <div className="flex gap-3 p-2.5 items-center">
                <div
                  className={`text-xs font-mono transition-colors ${
                    isExpanded ? 'text-indigo-500 font-bold' : 'text-indigo-300'
                  }`}
                >
                  {truth.id}
                </div>
                <div className="flex-1">
                  <div
                    className={`text-sm font-medium transition-colors ${
                      isExpanded
                        ? 'text-indigo-700'
                        : 'text-gray-700 group-hover:text-indigo-600'
                    }`}
                  >
                    {truth.title}
                  </div>
                </div>
                <ChevronDown
                  className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
                    isExpanded ? 'rotate-180 text-indigo-400' : ''
                  }`}
                />
              </div>

              {/* Expandable content — CSS Grid height animation */}
              <div
                className={`grid transition-all duration-300 ease-in-out ${
                  isExpanded
                    ? 'grid-rows-[1fr] opacity-100'
                    : 'grid-rows-[0fr] opacity-0'
                }`}
              >
                <div className="overflow-hidden">
                  <div className="px-2 pb-3 pl-10 pr-4">
                    <div className="text-[10px] text-indigo-400/80 font-semibold mb-1 tracking-wider uppercase">
                      Principle: {truth.principle}
                    </div>
                    <div className="text-[11px] text-gray-500 leading-relaxed">
                      {truth.description}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
