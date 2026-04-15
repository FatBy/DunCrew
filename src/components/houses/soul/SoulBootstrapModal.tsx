import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles, Loader2, Check, RefreshCw, ChevronRight } from 'lucide-react'
import type { SoulGenerationPreferences } from '@/services/soulGenerator'
import { generateSoulContent, saveSoulContent, saveSoulPrefs } from '@/services/soulGenerator'

interface SoulBootstrapModalProps {
  onComplete: (soulContent: string) => void
  onSkip: () => void
}

const STYLE_OPTIONS = [
  { value: '简洁专业', label: '简洁专业', desc: '直接、高效、不废话' },
  { value: '温暖亲切', label: '温暖亲切', desc: '像朋友一样交流' },
  { value: '幽默轻松', label: '幽默轻松', desc: '有点小幽默，不死板' },
  { value: '严谨学术', label: '严谨学术', desc: '精确、有深度、有条理' },
] as const

type Step = 'name' | 'style' | 'expectations' | 'generating' | 'preview'

export function SoulBootstrapModal({ onComplete, onSkip }: SoulBootstrapModalProps) {
  const [step, setStep] = useState<Step>('name')
  const [prefs, setPrefs] = useState<SoulGenerationPreferences>({
    name: '',
    style: '简洁专业',
    expectations: '',
  })
  const [generatedContent, setGeneratedContent] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleGenerate() {
    setStep('generating')
    setError('')

    try {
      const content = await generateSoulContent(prefs)
      setGeneratedContent(content)
      setStep('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请重试')
      setStep('expectations')
    }
  }

  async function handleConfirm() {
    setSaving(true)
    try {
      await saveSoulContent(generatedContent)
      saveSoulPrefs(prefs)
    } catch {}
    setSaving(false)
    onComplete(generatedContent)
  }

  const stepIndex = ['name', 'style', 'expectations'].indexOf(step)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden"
      >
        {/* Header */}
        <div className="bg-gradient-to-r from-teal-500 to-indigo-500 p-6 text-white">
          <div className="flex items-center gap-2 mb-1">
            <Sparkles className="w-5 h-5" />
            <span className="text-sm font-semibold tracking-wide opacity-80">灵魂铸造</span>
          </div>
          <h2 className="text-xl font-black">为你的 AI 注入灵魂</h2>
          <p className="text-sm opacity-70 mt-1">回答几个问题，LLM 将为你生成专属的 AI 个性</p>
        </div>

        {/* Steps indicator */}
        {stepIndex >= 0 && (
          <div className="flex gap-1 px-6 pt-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={`h-1 flex-1 rounded-full transition-colors ${
                  stepIndex >= i ? 'bg-teal-400' : 'bg-gray-100'
                }`}
              />
            ))}
          </div>
        )}

        <div className="p-6">
          <AnimatePresence mode="wait">
            {/* Step 1: Name */}
            {step === 'name' && (
              <motion.div
                key="name"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  你想给 AI 起什么名字？
                </label>
                <input
                  type="text"
                  placeholder="留空则由 LLM 自动起名"
                  value={prefs.name}
                  onChange={(e) => setPrefs((prev) => ({ ...prev, name: e.target.value }))}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 bg-gray-50"
                  autoFocus
                  onKeyDown={(e) => e.key === 'Enter' && setStep('style')}
                />
                <p className="text-xs text-gray-400 mt-2">比如：小克、星辰、Nova、Aria...</p>
              </motion.div>
            )}

            {/* Step 2: Style */}
            {step === 'style' && (
              <motion.div
                key="style"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <label className="block text-sm font-semibold text-gray-700 mb-3">
                  你希望 AI 用什么语言风格和你交流？
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {STYLE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setPrefs((prev) => ({ ...prev, style: option.value }))}
                      className={`p-3 rounded-xl border-2 text-left transition-all ${
                        prefs.style === option.value
                          ? 'border-teal-400 bg-teal-50'
                          : 'border-gray-100 bg-gray-50 hover:border-gray-200'
                      }`}
                    >
                      <div className="text-sm font-semibold text-gray-800">{option.label}</div>
                      <div className="text-xs text-gray-400 mt-0.5">{option.desc}</div>
                    </button>
                  ))}
                </div>
              </motion.div>
            )}

            {/* Step 3: Expectations */}
            {step === 'expectations' && (
              <motion.div
                key="expectations"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
              >
                <label className="block text-sm font-semibold text-gray-700 mb-2">
                  对 AI 有什么特别的期望或规矩？
                  <span className="text-gray-400 font-normal ml-1">（可选）</span>
                </label>
                <textarea
                  placeholder="比如：回答要带例子、不要用太多专业术语、遇到不确定的事情要说明..."
                  value={prefs.expectations}
                  onChange={(e) => setPrefs((prev) => ({ ...prev, expectations: e.target.value }))}
                  rows={3}
                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400 bg-gray-50 resize-none"
                  autoFocus
                />
                {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
              </motion.div>
            )}

            {/* Generating */}
            {step === 'generating' && (
              <motion.div
                key="generating"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-8"
              >
                <Loader2 className="w-8 h-8 text-teal-400 animate-spin mx-auto mb-3" />
                <p className="text-sm font-semibold text-gray-700">正在铸造灵魂...</p>
                <p className="text-xs text-gray-400 mt-1">LLM 正在为你生成专属个性，请稍候</p>
              </motion.div>
            )}

            {/* Preview */}
            {step === 'preview' && (
              <motion.div
                key="preview"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
              >
                <div className="flex items-center justify-between mb-3">
                  <label className="text-sm font-semibold text-gray-700">灵魂预览</label>
                  <button
                    onClick={handleGenerate}
                    className="flex items-center gap-1 text-xs text-teal-600 hover:text-teal-700"
                  >
                    <RefreshCw className="w-3 h-3" />
                    重新生成
                  </button>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 max-h-52 overflow-y-auto border border-gray-100">
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap font-mono leading-relaxed">
                    {generatedContent}
                  </pre>
                </div>
                <p className="text-xs text-gray-400 mt-2">
                  确认后，这份灵魂将注入到 AI 的系统提示词中，影响它的行为方式。
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-between">
          <button
            onClick={onSkip}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            跳过
          </button>

          <div className="flex gap-2">
            {step === 'style' && (
              <button
                onClick={() => setStep('name')}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                上一步
              </button>
            )}
            {step === 'expectations' && (
              <button
                onClick={() => setStep('style')}
                className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                上一步
              </button>
            )}

            {step === 'name' && (
              <button
                onClick={() => setStep('style')}
                className="flex items-center gap-1 px-5 py-2 bg-teal-500 text-white text-sm font-semibold rounded-xl hover:bg-teal-600 transition-colors"
              >
                下一步 <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 'style' && (
              <button
                onClick={() => setStep('expectations')}
                className="flex items-center gap-1 px-5 py-2 bg-teal-500 text-white text-sm font-semibold rounded-xl hover:bg-teal-600 transition-colors"
              >
                下一步 <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 'expectations' && (
              <button
                onClick={handleGenerate}
                className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-teal-500 to-indigo-500 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity"
              >
                <Sparkles className="w-4 h-4" />
                开始铸造
              </button>
            )}
            {step === 'preview' && (
              <button
                onClick={handleConfirm}
                disabled={saving}
                className="flex items-center gap-2 px-5 py-2 bg-gradient-to-r from-teal-500 to-indigo-500 text-white text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Check className="w-4 h-4" />
                )}
                确认注入
              </button>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  )
}
