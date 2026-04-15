/**
 * SkillHouse - Blueprint 重构版
 *
 * 设计宪法:
 * - Tab 1: 赛博青色神经元网络 (SkillTreeView)
 * - Tab 2: 技工学院 (SkillsHouseView) — DD-OS 风格的技能看板
 * - 右上角: 安装/创建操作按钮
 */

import { useMemo, useState } from 'react'
import { Loader2, Wrench } from 'lucide-react'
import { useStore } from '@/store'
import { SkillTreeView } from '@/components/blueprint/SkillTreeView'
import { SkillsHouseView } from './skillsHouse/SkillsHouseView'

// ── SkillHouse 主组件 ──────────────────────

export function SkillHouse() {
  const storeSkills = useStore((s) => s.skills)
  const loading = useStore((s) => s.channelsLoading)
  const connectionStatus = useStore((s) => s.connectionStatus)

  const isConnected = connectionStatus === 'connected'
  const [activeTab, setActiveTab] = useState<'neuron' | 'academy'>('neuron')

  const activeSkills = useMemo(
    () => storeSkills.filter((s) => s.unlocked || s.status === 'active'),
    [storeSkills],
  )

  if (loading && isConnected) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#fefaf6]">
      {/* ── Layer 0: 主内容层 ── */}
      {activeTab === 'neuron' ? (
        <div className="absolute inset-0 overflow-y-auto">
          <SkillTreeView />
        </div>
      ) : (
        <div className="absolute inset-0">
          <SkillsHouseView />
        </div>
      )}

      {/* ── Layer 1: 浮动 Tab (左上) ── */}
      <div className="absolute top-4 left-4 z-20 pointer-events-auto">
        <div className="flex gap-1 p-1 bg-white/90 backdrop-blur-xl border border-stone-200 rounded-lg shadow-sm">
          <button
            onClick={() => setActiveTab('neuron')}
            className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${
              activeTab === 'neuron'
                ? 'bg-cyan-50 text-cyan-600 border border-cyan-200'
                : 'text-stone-400 hover:text-stone-600 border border-transparent'
            }`}
          >
            神经元
          </button>
          <button
            onClick={() => setActiveTab('academy')}
            className={`flex items-center gap-1 px-3 py-1 text-xs font-bold rounded-md transition-colors ${
              activeTab === 'academy'
                ? 'bg-cyan-50 text-cyan-600 border border-cyan-200'
                : 'text-stone-400 hover:text-stone-600 border border-transparent'
            }`}
          >
            <Wrench className="w-3 h-3" />
            技工学院
          </button>
        </div>
      </div>

      {/* ── Layer 1: Stats HUD (右上, 仅神经元 Tab) ── */}
      {activeTab === 'neuron' && (
        <div className="absolute top-4 right-4 z-20 pointer-events-auto">
          <div className="bg-white/90 backdrop-blur-xl border border-stone-200 rounded-xl px-4 py-3 shadow-sm">
            <div className="space-y-2 min-w-[80px]">
              <div>
                <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Skills</p>
                <p className="text-lg font-bold text-cyan-600">{storeSkills.length}</p>
              </div>
              <div>
                <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest">Active</p>
                <p className="text-lg font-bold text-emerald-600">{activeSkills.length}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
