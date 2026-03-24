import { useEffect } from 'react'
import { Loader2, Sparkles, Activity } from 'lucide-react'
import { useStore } from '@/store'
import { IdentityCard } from './IdentityCard'
import { CoreTruthsAccordion } from './CoreTruthsAccordion'
import { SoulCoreAvatar } from './SoulCoreAvatar'
import { MBTIDriftSlider } from './MBTIDriftSlider'
import { AmendmentTimeline } from './AmendmentTimeline'

export function SoulTowerPage() {
  // — devicesSlice —
  const soulIdentity = useStore((s) => s.soulIdentity)
  const soulCoreTruths = useStore((s) => s.soulCoreTruths)
  const soulVibeStatement = useStore((s) => s.soulVibeStatement)
  const soulMBTI = useStore((s) => s.soulMBTI)
  const soulMBTILoading = useStore((s) => s.soulMBTILoading)
  const soulMBTIBase = useStore((s) => s.soulMBTIBase)
  const soulMBTIExpressed = useStore((s) => s.soulMBTIExpressed)
  const soulMBTIAxes = useStore((s) => s.soulMBTIAxes)
  const soulTruthsSummary = useStore((s) => s.soulTruthsSummary)
  const generateSoulSummary = useStore((s) => s.generateSoulSummary)
  const loading = useStore((s) => s.devicesLoading)

  // — soulAmendmentSlice —
  const amendments = useStore((s) => s.amendments)
  const draftAmendments = useStore((s) => s.draftAmendments)
  const approveDraft = useStore((s) => s.approveDraft)
  const rejectDraft = useStore((s) => s.rejectDraft)
  const archiveAmendment = useStore((s) => s.archiveAmendment)

  // 首次加载时触发核心协议总结生成（有缓存则直接读取）
  useEffect(() => {
    if (soulCoreTruths.length > 0 && !soulTruthsSummary) {
      generateSoulSummary()
    }
  }, [soulCoreTruths.length, soulTruthsSummary, generateSoulSummary])

  // — 构造 base / expressed 轴分数 —
  // 如果 base 和 expressed 类型不同，通过类型字母推算基础轴
  // 否则直接使用 soulMBTIAxes 作为两者
  const baseAxes = soulMBTIAxes
    ? computeBaseAxesFromType(soulMBTIBase, soulMBTIAxes)
    : null
  const expressedAxes = soulMBTIAxes

  // Loading state
  if (loading && !soulIdentity) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-teal-400/50 font-mono text-sm gap-2">
        <Loader2 className="w-6 h-6 animate-spin" />
        初始化灵魂核心...
      </div>
    )
  }

  // Build insight text — 使用表达型作为当前类型
  const insightText = buildInsightText(soulMBTIExpressed || soulMBTI, soulMBTIBase, soulMBTIExpressed, soulVibeStatement)

  return (
    <div
      className="h-full bg-[#FCFAF8] flex flex-col p-4 sm:p-6 font-sans overflow-y-auto"
      style={{
        backgroundImage: 'radial-gradient(#e5e7eb 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {/* AI Insight Banner */}
      {insightText && (
        <div className="bg-yellow-50/60 border border-yellow-100/50 rounded-xl p-3 flex items-start gap-3 text-sm text-yellow-800/80 mb-6">
          <Sparkles className="w-4 h-4 mt-0.5 text-yellow-500 flex-shrink-0" />
          <div>
            <strong className="font-semibold">AI 洞察：</strong>
            {insightText}
          </div>
          <Activity className="w-4 h-4 ml-auto text-yellow-400/50 animate-pulse" />
        </div>
      )}

      {/* Three Column Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 flex-1">
        {/* Left Column: Layer 1 Nature (Immutable) */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          <IdentityCard identity={soulIdentity} />
          {soulCoreTruths.length > 0 && (
            <CoreTruthsAccordion truths={soulCoreTruths} summary={soulTruthsSummary} />
          )}
        </div>

        {/* Center Column: The Core Avatar — 优先显示表达型(漂移后)MBTI */}
        <SoulCoreAvatar
          mbtiResult={soulMBTIExpressed || soulMBTI}
          identity={soulIdentity}
          loading={soulMBTILoading}
        />

        {/* Right Column: Layer 2 Nurture (Dynamic) */}
        <div className="lg:col-span-3 flex flex-col gap-4">
          <MBTIDriftSlider
            baseAxes={baseAxes}
            expressedAxes={expressedAxes}
          />
        </div>
      </div>

      {/* Bottom: Full-width Amendment Timeline */}
      <div className="mt-6">
        <AmendmentTimeline
          amendments={amendments}
          draftAmendments={draftAmendments}
          onApprove={approveDraft}
          onReject={rejectDraft}
          onArchive={archiveAmendment}
        />
      </div>
    </div>
  )
}

// ============================================
// Helpers
// ============================================

import type { MBTIResult, MBTIAxisScores } from '@/types'

/**
 * 从 base MBTIResult 类型字母推算基础轴分数。
 * 如果 base 和当前 axes 指向同一类型，直接使用 axes；
 * 否则根据 base 的 4 字母构造固定轴分（±0.5）。
 */
function computeBaseAxesFromType(
  base: MBTIResult | null,
  currentAxes: MBTIAxisScores,
): MBTIAxisScores {
  if (!base) return currentAxes

  const type = base.type
  return {
    ei: type[0] === 'e' ? 0.5 : -0.5,
    sn: type[1] === 's' ? 0.5 : -0.5,
    tf: type[2] === 't' ? 0.5 : -0.5,
    jp: type[3] === 'j' ? 0.5 : -0.5,
  }
}

/** 根据当前 MBTI 状态生成 AI 洞察文本 */
function buildInsightText(
  current: MBTIResult | null,
  base: MBTIResult | null,
  expressed: MBTIResult | null,
  vibe: string,
): string {
  if (!current) return ''

  const parts: string[] = []

  // 类型描述
  parts.push(`**${current.trait}**`)

  // 漂移提示
  if (base && expressed && base.type !== expressed.type) {
    parts.push(
      `从 ${base.type.toUpperCase()} 漂移至 ${expressed.type.toUpperCase()}，`
      + '近期观测到行为特征的微弱变化。'
    )
  }

  // Vibe 摘要
  if (vibe) {
    const short = vibe.length > 60 ? vibe.slice(0, 60) + '...' : vibe
    parts.push(short)
  }

  return parts.join(' ')
}
