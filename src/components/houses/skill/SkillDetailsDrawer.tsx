import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Eye, EyeOff, KeyRound, Terminal, Cpu, Activity,
  CheckCircle2, Settings2, Code2, ToggleLeft, Hash, Palette, Type,
} from 'lucide-react'
import type { OpenClawSkill } from '@/types'

interface SkillDetailsDrawerProps {
  skill: OpenClawSkill | null
  isOpen: boolean
  envValues: Record<string, string>
  onEnvChange: (key: string, value: string) => void
  onClose: () => void
}

// 根据参数类型返回对应图标和颜色
function getTypeVisuals(key: string, type: string, defaultValue: unknown) {
  if (key.includes('color')) return {
    icon: <Palette size={14} />, color: 'text-pink-500', bg: 'bg-pink-50',
    preview: <div className="w-4 h-4 rounded shadow-sm" style={{ backgroundColor: (defaultValue as string) || '#ccc' }} />,
  }
  if (type === 'number') return {
    icon: <Hash size={14} />, color: 'text-blue-500', bg: 'bg-blue-50',
    preview: <span className="font-mono bg-blue-100 text-blue-700 px-1.5 rounded text-xs">{String(defaultValue ?? 'N/A')}</span>,
  }
  if (type === 'boolean') return {
    icon: <ToggleLeft size={14} />, color: 'text-emerald-500', bg: 'bg-emerald-50',
    preview: <ToggleLeft size={18} className={defaultValue ? 'text-emerald-500' : 'text-slate-300'} />,
  }
  return {
    icon: <Type size={14} />, color: 'text-indigo-500', bg: 'bg-indigo-50',
    preview: <span className="font-mono text-slate-400 text-xs">"..."</span>,
  }
}

export function SkillDetailsDrawer({
  skill, isOpen, envValues, onEnvChange, onClose,
}: SkillDetailsDrawerProps) {
  const [showRawJson, setShowRawJson] = useState(false)
  const [showEnvKey, setShowEnvKey] = useState<Record<string, boolean>>({})

  const inputProps = (skill?.inputs as Record<string, unknown>)?.properties as Record<string, { type: string; description?: string; default?: unknown }> | undefined
  const requiredInputs = ((skill?.inputs as Record<string, unknown>)?.required as string[]) || []

  return (
    <AnimatePresence>
      {isOpen && skill && (
        <>
          {/* 遮罩 */}
          <motion.div
            key="drawer-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-[200]"
            onClick={onClose}
          />

          {/* 抽屉主体 */}
          <motion.div
            key="drawer-body"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="fixed inset-y-2 right-2 w-[560px] bg-[#F4F4F5] shadow-2xl z-[201] rounded-3xl flex flex-col overflow-hidden"
          >
            {/* 头部 */}
            <div className="shrink-0 p-6 pb-4">
              <div className="flex justify-between items-start mb-4">
                <div className="w-16 h-16 rounded-2xl bg-white shadow-sm border border-slate-200 flex items-center justify-center text-4xl">
                  {skill.emoji || '🔧'}
                </div>
                <button
                  onClick={onClose}
                  className="p-2 bg-white/50 hover:bg-white text-slate-500 rounded-full transition-colors shadow-sm"
                >
                  <X size={18} />
                </button>
              </div>
              <h2 className="text-2xl font-bold text-slate-800 tracking-tight">{skill.name}</h2>
              {skill.description && (
                <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{skill.description}</p>
              )}
            </div>

            {/* Bento Box Grid */}
            <div className="flex-1 overflow-y-auto p-6 pt-2 space-y-4">
              <div className="grid grid-cols-2 gap-4">

                {/* Widget 1: 运行时 */}
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 flex flex-col">
                  <div className="flex items-center gap-2 mb-3 text-slate-400">
                    <Activity size={14} />
                    <span className="text-xs font-semibold uppercase tracking-wider">运行时</span>
                  </div>
                  <div className="flex-1 flex flex-col justify-center">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-slate-50 flex items-center justify-center border border-slate-100">
                        <Terminal size={18} className="text-slate-600" />
                      </div>
                      <div>
                        <div className="text-sm font-bold text-slate-700">
                          {skill.executable ? '本地可执行脚本' : '指令型 Prompt'}
                        </div>
                        {skill.toolName && (
                          <div className="text-xs text-slate-400 font-mono mt-0.5">{skill.toolName}</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Widget 2: 环境就绪检查 */}
                <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
                  <div className="flex items-center gap-2 mb-3 text-slate-400">
                    <Cpu size={14} />
                    <span className="text-xs font-semibold uppercase tracking-wider">环境就绪检查</span>
                  </div>
                  <div className="space-y-4">
                    {/* Bins */}
                    {skill.requires?.bins && skill.requires.bins.length > 0 && (
                      <div className="space-y-2.5">
                        {skill.requires.bins.map(bin => (
                          <div key={bin} className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm text-slate-600 font-mono">
                              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.8)]" />
                              {bin}
                            </div>
                            <CheckCircle2 size={14} className="text-emerald-500" />
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Env 输入 */}
                    {skill.requires?.env && skill.requires.env.length > 0 && (
                      <div className={`space-y-3 ${skill.requires.bins?.length ? 'pt-3 border-t border-slate-100' : ''}`}>
                        {skill.requires.env.map(envKey => {
                          const hasValue = !!envValues[envKey]
                          return (
                            <div key={envKey} className="flex flex-col gap-1.5">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-1.5 text-xs text-slate-700 font-mono font-medium">
                                  <KeyRound size={12} className={hasValue ? 'text-indigo-500' : 'text-amber-500'} />
                                  {envKey}
                                </div>
                                <span className="text-[9px] bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded text-slate-400 uppercase tracking-widest">
                                  Required
                                </span>
                              </div>
                              <div className="relative">
                                <input
                                  type={showEnvKey[envKey] ? 'text' : 'password'}
                                  value={envValues[envKey] || ''}
                                  onChange={e => onEnvChange(envKey, e.target.value)}
                                  placeholder={`Enter ${envKey}...`}
                                  className={`w-full text-xs rounded-lg pl-3 pr-8 py-2.5 outline-none transition-all font-mono placeholder:text-slate-300 placeholder:font-sans
                                    ${hasValue
                                      ? 'bg-indigo-50/50 border border-indigo-200 text-indigo-700 focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100'
                                      : 'bg-slate-50 border border-slate-200 text-slate-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-100/50'
                                    }`}
                                />
                                <button
                                  onClick={() => setShowEnvKey(prev => ({ ...prev, [envKey]: !prev[envKey] }))}
                                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors"
                                >
                                  {showEnvKey[envKey] ? <EyeOff size={14} /> : <Eye size={14} />}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {/* 无依赖时 */}
                    {!skill.requires?.bins?.length && !skill.requires?.env?.length && (
                      <p className="text-xs text-slate-400 italic">无额外依赖</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Widget 3: 技能参数配置 (全宽) */}
              {inputProps && Object.keys(inputProps).length > 0 && (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-50 flex items-center justify-between bg-slate-50/50">
                    <div className="flex items-center gap-2 text-slate-600">
                      <Settings2 size={16} className="text-indigo-500" />
                      <span className="text-sm font-bold">技能参数配置 (Schema)</span>
                    </div>
                    <button
                      onClick={() => setShowRawJson(!showRawJson)}
                      className="text-[10px] flex items-center gap-1 bg-white border border-slate-200 px-2 py-1 rounded-md text-slate-500 hover:text-slate-800 transition-colors shadow-sm"
                    >
                      <Code2 size={12} /> {showRawJson ? '查看可视化 UI' : '查看底层 JSON'}
                    </button>
                  </div>

                  <div className="p-2">
                    {showRawJson ? (
                      <div className="bg-[#0F172A] rounded-xl p-4 m-2 overflow-x-auto shadow-inner">
                        <pre className="text-xs font-mono text-cyan-300 whitespace-pre-wrap leading-relaxed">
                          {JSON.stringify(skill.inputs, null, 2)}
                        </pre>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {Object.entries(inputProps).map(([key, prop]) => {
                          const isRequired = requiredInputs.includes(key)
                          const visuals = getTypeVisuals(key, prop.type, prop.default)
                          return (
                            <div key={key} className="flex items-start gap-4 p-3 hover:bg-slate-50 rounded-xl transition-colors">
                              <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center ${visuals.bg} ${visuals.color}`}>
                                {visuals.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-mono font-semibold text-slate-700">{key}</span>
                                  {isRequired && (
                                    <span className="text-[9px] bg-amber-50 border border-amber-200 text-amber-600 px-1 py-0.5 rounded uppercase tracking-wider font-bold">
                                      Required
                                    </span>
                                  )}
                                  <span className="text-[10px] text-slate-400 font-mono ml-auto">{prop.type}</span>
                                </div>
                                {prop.description && (
                                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{prop.description}</p>
                                )}
                                {prop.default !== undefined && (
                                  <div className="flex items-center gap-1.5 mt-1.5">
                                    <span className="text-[10px] text-slate-400">默认值:</span>
                                    {visuals.preview}
                                  </div>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
