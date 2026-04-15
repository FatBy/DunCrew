import { useEffect } from 'react'
import { Loader2, Sparkles, Activity, RefreshCw, AlertCircle } from 'lucide-react'
import { useStore } from '@/store'
import { IdentityCard } from './IdentityCard'
import { CoreTruthsAccordion } from './CoreTruthsAccordion'
import { SoulCoreAvatar } from './SoulCoreAvatar'
import { MBTIDriftSlider } from './MBTIDriftSlider'
import { AmendmentTimeline } from './AmendmentTimeline'
import { SoulBootstrapModal } from './SoulBootstrapModal'
import { isDefaultEnglishSoul } from '@/services/soulGenerator'

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

  // — Soul 生成 —
  const soulRawContent = useStore((s) => s.soulRawContent)
  const soulBootstrapNeeded = useStore((s) => s.soulBootstrapNeeded)
  const setSoulBootstrapNeeded = useStore((s) => s.setSoulBootstrapNeeded)
  const applySoulFromGenerated = useStore((s) => s.applySoulFromGenerated)
  const soulResynthesisNeeded = useStore((s) => s.soulResynthesisNeeded)
  const soulResynthesizing = useStore((s) => s.soulResynthesizing)
  const triggerSoulResynthesis = useStore((s) => s.triggerSoulResynthesis)

  // — soulAmendmentSlice —
  const amendments = useStore((s) => s.amendments)
  const draftAmendments = useStore((s) => s.draftAmendments)
  const approveDraft = useStore((s) => s.approveDraft)
  const rejectDraft = useStore((s) => s.rejectDraft)
  const archiveAmendment = useStore((s) => s.archiveAmendment)
  const unarchiveAmendment = useStore((s) => s.unarchiveAmendment)

  // 首次加载时触发核心协议总结生成（有缓存则直接读取）
  useEffect(() => {
    if (soulCoreTruths.length > 0 && !soulTruthsSummary) {
      generateSoulSummary()
    }
  }, [soulCoreTruths.length, soulTruthsSummary, generateSoulSummary])

  // 检测是否需要引导生成（英文默认 Soul，且用户未曾生成过）
  useEffect(() => {
    // 如果用户已经生成过或跳过过，不再弹出
    const generated = localStorage.getItem('duncrew_soul_generated_at')
    const skipped = localStorage.getItem('duncrew_soul_bootstrap_skipped')
    if (generated || skipped) return

    if (soulRawContent && isDefaultEnglishSoul(soulRawContent)) {
      setSoulBootstrapNeeded(true)
    }
  }, [soulRawContent, setSoulBootstrapNeeded])

  // — 构造 base / expressed 轴分数 —
  // 优先使用实际计算的轴强度，fallback 到类型字母推算
  const baseAxes = computeBaseAxesFromType(soulMBTIBase, soulMBTIAxes)
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
      {/* Soul Bootstrap Modal */}
      {soulBootstrapNeeded && (
        <SoulBootstrapModal
          onComplete={(content) => {
            applySoulFromGenerated(content)
          }}
          onSkip={() => {
            localStorage.setItem('duncrew_soul_bootstrap_skipped', '1')
            setSoulBootstrapNeeded(false)
          }}
        />
      )}

      {/* 重合成提示横幅 */}
      {soulResynthesisNeeded && !soulResynthesizing && (
        <div className="bg-indigo-50/60 border border-indigo-100/50 rounded-xl p-3 flex items-center gap-3 text-sm text-indigo-800/80 mb-4">
          <AlertCircle className="w-4 h-4 text-indigo-500 flex-shrink-0" />
          <span className="flex-1">已积累 5 条行为修正，建议重合成灵魂以融入这些变化。</span>
          <button
            onClick={triggerSoulResynthesis}
            className="flex items-center gap-1 px-3 py-1 bg-indigo-500 text-white text-xs font-semibold rounded-lg hover:bg-indigo-600 transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            立即重合成
          </button>
        </div>
      )}
      {soulResynthesizing && (
        <div className="bg-indigo-50/60 border border-indigo-100/50 rounded-xl p-3 flex items-center gap-3 text-sm text-indigo-800/80 mb-4">
          <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
          <span>正在重合成灵魂，融入已批准的行为修正...</span>
        </div>
      )}

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
          <IdentityCard
            identity={soulIdentity}
            onRegenerate={() => setSoulBootstrapNeeded(true)}
          />
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
          onUnarchive={unarchiveAmendment}
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
 * 优先使用实际计算的轴强度（currentAxes），仅在无值时 fallback 到从类型字母推算。
 */
function computeBaseAxesFromType(
  base: MBTIResult | null,
  currentAxes: MBTIAxisScores | null,
): MBTIAxisScores {
  // 优先使用实际计算的轴强度
  if (currentAxes && (currentAxes.ei !== 0 || currentAxes.sn !== 0 || currentAxes.tf !== 0 || currentAxes.jp !== 0)) {
    return currentAxes
  }
  // Fallback: 从类型字母推算
  if (!base) return currentAxes || { ei: 0, sn: 0, tf: 0, jp: 0 }
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
