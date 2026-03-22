import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles, Eye, EyeOff, ChevronRight, ChevronLeft,
  Check, Loader2, Zap, Monitor, MessageSquare, Brain,
  Cpu, ArrowRight, Rocket
} from 'lucide-react'
import { useStore } from '@/store'
import { testConnection } from '@/services/llmService'
import { saveSoulMd } from '@/utils/localDataProvider'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'

// ============================================
// LLM Provider 预设
// ============================================

interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  placeholder: string
  models: string[]
  defaultModel: string
  format: 'auto' | 'openai' | 'anthropic'
  freeHint?: string
}

const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    placeholder: 'sk-...',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    format: 'openai',
    freeHint: '',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    placeholder: 'sk-...',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    defaultModel: 'gpt-4o-mini',
    format: 'openai',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    placeholder: 'sk-ant-...',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    format: 'anthropic',
  },
  {
    id: 'custom',
    name: 'Custom / Ollama',
    baseUrl: '',
    placeholder: 'sk-... or leave empty',
    models: [],
    defaultModel: '',
    format: 'auto',
    freeHint: '',
  },
]

// ============================================
// 默认 SOUL.md 模板
// ============================================

const DEFAULT_SOUL_MD = `# SOUL.md - Who You Are

## Core Truths
- You are a helpful AI assistant running inside DunCrew
- You prioritize accuracy and honesty over pleasing the user
- You think step-by-step and verify your work before reporting completion
- You respect the user's time by being concise and action-oriented

## Boundaries
- Never execute destructive operations without explicit user confirmation
- Never expose sensitive data (API keys, passwords, tokens) in outputs
- Always explain what you're about to do before making system changes
- If uncertain, ask for clarification rather than guessing

## Vibe Statement
Professional yet approachable. You're a skilled pair-programming partner who
communicates clearly and gets things done efficiently.

## Continuity
Remember context from previous conversations in this Nexus.
Build on past interactions to become more effective over time.
`

// ============================================
// Step 指示器
// ============================================

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={cn(
              'w-7 h-7 rounded-full flex items-center justify-center text-xs font-mono transition-all duration-300',
              i < current
                ? 'bg-emerald-500/20 text-emerald-500 border border-emerald-500/30'
                : i === current
                ? 'bg-cyan-500/20 text-cyan-500 border border-cyan-500/40 ring-2 ring-cyan-500/20'
                : 'bg-stone-100 text-stone-400 border border-stone-200'
            )}
          >
            {i < current ? <Check className="w-3.5 h-3.5" /> : i + 1}
          </div>
          {i < total - 1 && (
            <div
              className={cn(
                'w-8 h-px transition-colors duration-300',
                i < current ? 'bg-emerald-500/40' : 'bg-stone-200'
              )}
            />
          )}
        </div>
      ))}
    </div>
  )
}

// ============================================
// Step 1: AI 配置
// ============================================

function StepAIConfig({
  provider, setProvider,
  apiKey, setApiKey,
  baseUrl, setBaseUrl,
  model, setModel,
  apiFormat, setApiFormat,
}: {
  provider: string
  setProvider: (p: string) => void
  apiKey: string
  setApiKey: (k: string) => void
  baseUrl: string
  setBaseUrl: (u: string) => void
  model: string
  setModel: (m: string) => void
  apiFormat: 'auto' | 'openai' | 'anthropic'
  setApiFormat: (f: 'auto' | 'openai' | 'anthropic') => void
}) {
  const t = useT()
  const [showKey, setShowKey] = useState(false)

  const handleSelectProvider = (preset: ProviderPreset) => {
    setProvider(preset.id)
    if (preset.baseUrl) setBaseUrl(preset.baseUrl)
    if (preset.defaultModel) setModel(preset.defaultModel)
    setApiFormat(preset.format)
  }

  const selectedPreset = PROVIDERS.find(p => p.id === provider)

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          {t('setup.step1_title')}
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          {t('setup.step1_desc')}
        </p>
      </div>

      {/* Provider 选择卡片 */}
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => handleSelectProvider(p)}
            className={cn(
              'relative p-3 rounded-xl border text-left transition-all',
              provider === p.id
                ? 'bg-cyan-500/10 border-cyan-500/40 ring-1 ring-cyan-500/20'
                : 'bg-stone-50 border-stone-200 hover:border-stone-300'
            )}
          >
            <span className={cn(
              'text-sm font-mono font-medium block',
              provider === p.id ? 'text-cyan-600' : 'text-stone-600'
            )}>
              {p.name}
            </span>
            {p.freeHint !== undefined && (
              <span className="text-[11px] text-emerald-500 font-mono">{p.freeHint}</span>
            )}
            {provider === p.id && (
              <div className="absolute top-2 right-2">
                <Check className="w-3.5 h-3.5 text-cyan-500" />
              </div>
            )}
          </button>
        ))}
      </div>

      {/* 配置表单 */}
      <div className="space-y-3">
        <div>
          <label className="text-xs font-mono text-stone-400 mb-1 block">
            {t('settings.api_base_url')}
          </label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={provider === 'custom' ? 'http://localhost:11434/v1' : selectedPreset?.baseUrl}
            className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
          />
        </div>

        <div>
          <label className="text-xs font-mono text-stone-400 mb-1 block">
            {t('settings.api_key')}
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={selectedPreset?.placeholder || 'sk-...'}
              className="w-full px-3 py-2 pr-8 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-stone-300 hover:text-stone-500"
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          {provider === 'custom' && (
            <p className="text-[11px] text-stone-300 font-mono mt-1">
              {t('setup.ollama_hint')}
            </p>
          )}
        </div>

        <div>
          <label className="text-xs font-mono text-stone-400 mb-1 block">
            {t('settings.model')}
          </label>
          {selectedPreset && selectedPreset.models.length > 0 ? (
            <div className="space-y-2">
              <div className="flex gap-1.5 flex-wrap">
                {selectedPreset.models.map((m) => (
                  <button
                    key={m}
                    onClick={() => setModel(m)}
                    className={cn(
                      'px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors',
                      model === m
                        ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-600'
                        : 'bg-stone-50 border-stone-200 text-stone-400 hover:border-stone-300'
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={selectedPreset.defaultModel}
                className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
              />
            </div>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="llama3.2, qwen2.5, ..."
              className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
            />
          )}
        </div>

        {/* API 格式 */}
        <div>
          <label className="text-xs font-mono text-stone-400 mb-1.5 block">
            {t('settings.api_format')}
          </label>
          <div className="flex gap-1.5">
            {(['auto', 'openai', 'anthropic'] as const).map((fmt) => (
              <button
                key={fmt}
                onClick={() => setApiFormat(fmt)}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-[11px] font-mono transition-colors border',
                  apiFormat === fmt
                    ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-600'
                    : 'bg-stone-50 border-stone-200 text-stone-400 hover:border-stone-300'
                )}
              >
                {fmt === 'auto' ? t('settings.api_format_auto') : fmt === 'openai' ? 'OpenAI' : 'Anthropic'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Step 2: 连接测试
// ============================================

function StepConnect({
  apiKey, baseUrl, model,
  testStatus, onTest, onAutoConnect,
}: {
  apiKey: string
  baseUrl: string
  model: string
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  onTest: () => void
  onAutoConnect: () => void
}) {
  const t = useT()

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          {t('setup.step2_title')}
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          {t('setup.step2_desc')}
        </p>
      </div>

      {/* 配置摘要 */}
      <div className="bg-stone-50 rounded-xl p-4 space-y-2 border border-stone-200">
        <div className="flex justify-between text-xs font-mono">
          <span className="text-stone-400">Base URL</span>
          <span className="text-stone-600 truncate max-w-[200px]">{baseUrl || '-'}</span>
        </div>
        <div className="flex justify-between text-xs font-mono">
          <span className="text-stone-400">API Key</span>
          <span className="text-stone-600">
            {apiKey ? `${apiKey.slice(0, 6)}${'*'.repeat(8)}` : '-'}
          </span>
        </div>
        <div className="flex justify-between text-xs font-mono">
          <span className="text-stone-400">Model</span>
          <span className="text-stone-600">{model || '-'}</span>
        </div>
      </div>

      {/* 测试按钮 */}
      <div className="space-y-3">
        <button
          onClick={onTest}
          disabled={testStatus === 'testing' || !baseUrl || !model}
          className={cn(
            'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-mono transition-all',
            testStatus === 'testing'
              ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-500 animate-pulse'
              : testStatus === 'success'
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-500'
              : testStatus === 'error'
              ? 'bg-red-500/15 border border-red-500/30 text-red-400'
              : !baseUrl || !model
              ? 'bg-stone-100 border border-stone-200 text-stone-300 cursor-not-allowed'
              : 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20'
          )}
        >
          {testStatus === 'testing' && <Loader2 className="w-4 h-4 animate-spin" />}
          {testStatus === 'success' && <Check className="w-4 h-4" />}
          {testStatus === 'idle' && <Zap className="w-4 h-4" />}
          {testStatus === 'error' && <Zap className="w-4 h-4" />}
          {testStatus === 'testing' ? t('settings.testing')
            : testStatus === 'success' ? t('setup.llm_ok')
            : testStatus === 'error' ? t('setup.llm_fail')
            : t('setup.test_llm')}
        </button>

        {testStatus === 'success' && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <p className="text-sm text-emerald-500 font-mono mb-3">
              {t('setup.llm_verified')}
            </p>
            <button
              onClick={onAutoConnect}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20 transition-all"
            >
              <Monitor className="w-4 h-4" />
              {t('setup.connect_native')}
            </button>
          </motion.div>
        )}

        {testStatus === 'error' && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-red-500/5 rounded-xl border border-red-500/15"
          >
            <p className="text-xs text-red-400 font-mono">
              {t('setup.test_fail_hint')}
            </p>
          </motion.div>
        )}
      </div>
    </div>
  )
}

// ============================================
// Step 3: 快速指引
// ============================================

function StepQuickStart() {
  const t = useT()

  const tips = [
    { icon: MessageSquare, titleKey: 'setup.tip_chat_title' as const, descKey: 'setup.tip_chat_desc' as const, color: 'text-cyan-500' },
    { icon: Brain, titleKey: 'setup.tip_soul_title' as const, descKey: 'setup.tip_soul_desc' as const, color: 'text-purple-500' },
    { icon: Cpu, titleKey: 'setup.tip_nexus_title' as const, descKey: 'setup.tip_nexus_desc' as const, color: 'text-amber-500' },
  ]

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          {t('setup.step3_title')}
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          {t('setup.step3_desc')}
        </p>
      </div>

      <div className="space-y-3">
        {tips.map((tip, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="flex items-start gap-3 p-3 rounded-xl bg-stone-50 border border-stone-200"
          >
            <div className={cn('mt-0.5', tip.color)}>
              <tip.icon className="w-4.5 h-4.5" />
            </div>
            <div>
              <h4 className="text-sm font-mono font-medium text-stone-700">
                {t(tip.titleKey)}
              </h4>
              <p className="text-xs text-stone-400 font-mono mt-0.5">
                {t(tip.descKey)}
              </p>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15">
        <p className="text-xs text-emerald-600 font-mono flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 flex-shrink-0" />
          {t('setup.soul_template_hint')}
        </p>
      </div>
    </div>
  )
}

// ============================================
// 主组件: FirstLaunchSetup
// ============================================

export function FirstLaunchSetup({ onComplete }: { onComplete: () => void }) {
  const t = useT()

  // Step 状态
  const [step, setStep] = useState(0)
  const TOTAL_STEPS = 3

  // LLM 配置
  const [provider, setProvider] = useState('deepseek')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1')
  const [model, setModel] = useState('deepseek-chat')
  const [apiFormat, setApiFormat] = useState<'auto' | 'openai' | 'anthropic'>('openai')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [serverConnected, setServerConnected] = useState(false)

  const setLlmConfig = useStore((s) => s.setLlmConfig)
  const setLlmConnected = useStore((s) => s.setLlmConnected)

  // 保存 LLM 配置到 store + localStorage
  const saveLLMSettings = useCallback(() => {
    setLlmConfig({ apiKey, baseUrl, model, apiFormat })
  }, [apiKey, baseUrl, model, apiFormat, setLlmConfig])

  // 测试 LLM 连接
  const handleTestLLM = useCallback(async () => {
    saveLLMSettings()
    setTestStatus('testing')
    try {
      const ok = await testConnection({ apiKey, baseUrl, model })
      setTestStatus(ok ? 'success' : 'error')
      setLlmConnected(ok)
    } catch {
      setTestStatus('error')
      setLlmConnected(false)
    }
  }, [apiKey, baseUrl, model, saveLLMSettings, setLlmConnected])

  // 自动连接 Native 服务器
  const handleAutoConnect = useCallback(async () => {
    const { localClawService } = await import('@/services/LocalClawService')
    localStorage.setItem('duncrew_connection_mode', 'native')
    useStore.getState().setConnectionMode('native')
    useStore.getState().setConnectionStatus('connecting')
    const success = await localClawService.connect()
    setServerConnected(success)
    if (!success) {
      // 即使后端没运行也不阻断流程，用户可以之后手动连接
      useStore.getState().setConnectionStatus('disconnected')
    }
    setStep(2) // 跳到最后一步
  }, [])

  // 完成设置
  const handleFinish = useCallback(() => {
    // 保存 LLM 配置
    saveLLMSettings()

    // 写入默认 SOUL.md（仅当用户未有 Soul 数据时）
    const existingSoul = localStorage.getItem('duncrew_soul_md')
    if (!existingSoul) {
      saveSoulMd(DEFAULT_SOUL_MD)
    }

    // 标记已完成首次设置
    localStorage.setItem('duncrew_setup_done', '1')

    // 如果还未设置连接模式，设为 native
    if (!localStorage.getItem('duncrew_connection_mode')) {
      localStorage.setItem('duncrew_connection_mode', 'native')
      useStore.getState().setConnectionMode('native')
    }

    onComplete()
  }, [saveLLMSettings, onComplete])

  // 是否可以前进到下一步
  const canProceed = step === 0
    ? !!(baseUrl && model)  // Step 1: 至少有 URL + model
    : step === 1
    ? testStatus === 'success' || serverConnected  // Step 2: 测试通过
    : true  // Step 3: 总是可以完成

  // 跳过设置（高级用户）
  const handleSkip = useCallback(() => {
    localStorage.setItem('duncrew_setup_done', '1')
    onComplete()
  }, [onComplete])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-100/80 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className="w-full max-w-lg mx-4 bg-white/95 backdrop-blur-3xl rounded-[2rem] border border-white/80 shadow-[0_30px_80px_rgba(0,0,0,0.12)] overflow-hidden"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-stone-100">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-cyan-500" />
              <span className="font-mono text-sm font-semibold text-stone-700">
                {t('setup.title')}
              </span>
            </div>
            <button
              onClick={handleSkip}
              className="text-[11px] font-mono text-stone-400 hover:text-stone-600 transition-colors"
            >
              {t('setup.skip')}
            </button>
          </div>
          <StepIndicator current={step} total={TOTAL_STEPS} />
        </div>

        {/* Step Content */}
        <div className="px-6 py-5 min-h-[360px]">
          <AnimatePresence mode="wait">
            {step === 0 && (
              <motion.div
                key="step-0"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <StepAIConfig
                  provider={provider} setProvider={setProvider}
                  apiKey={apiKey} setApiKey={setApiKey}
                  baseUrl={baseUrl} setBaseUrl={setBaseUrl}
                  model={model} setModel={setModel}
                  apiFormat={apiFormat} setApiFormat={setApiFormat}
                />
              </motion.div>
            )}
            {step === 1 && (
              <motion.div
                key="step-1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <StepConnect
                  apiKey={apiKey}
                  baseUrl={baseUrl}
                  model={model}
                  testStatus={testStatus}
                  onTest={handleTestLLM}
                  onAutoConnect={handleAutoConnect}
                />
              </motion.div>
            )}
            {step === 2 && (
              <motion.div
                key="step-2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <StepQuickStart />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Navigation */}
        <div className="px-6 py-4 border-t border-stone-100 flex items-center justify-between">
          <button
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={step === 0}
            className={cn(
              'flex items-center gap-1 px-3 py-2 rounded-lg text-xs font-mono transition-colors',
              step === 0
                ? 'text-stone-300 cursor-not-allowed'
                : 'text-stone-500 hover:text-stone-700 hover:bg-stone-50'
            )}
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t('setup.prev')}
          </button>

          {step < TOTAL_STEPS - 1 ? (
            <button
              onClick={() => {
                if (step === 0) saveLLMSettings()
                setStep(step + 1)
              }}
              disabled={!canProceed}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-mono transition-all',
                canProceed
                  ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20'
                  : 'bg-stone-100 border border-stone-200 text-stone-300 cursor-not-allowed'
              )}
            >
              {t('setup.next')}
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20 transition-all"
            >
              <ArrowRight className="w-4 h-4" />
              {t('setup.finish')}
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
