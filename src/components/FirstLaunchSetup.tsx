import { useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles, Eye, EyeOff, ChevronRight, ChevronLeft,
  Check, Loader2, Zap, Monitor, ArrowRight, Rocket,
  ExternalLink, Wand2,
} from 'lucide-react'
import { useStore } from '@/store'
import { testConnection } from '@/services/llmService'
import { simpleChat } from '@/services/llmService'
import { saveSoulMd } from '@/utils/localDataProvider'
import { cn } from '@/utils/cn'
import { PROVIDER_GUIDES } from '@/store/slices/linkStationSlice'
import { simpleVisualDNA } from '@/store/slices/worldSlice'
import { createInitialScoring } from '@/types'
import type { ModelProvider, ModelEntry, ApiProtocol } from '@/types'

// ============================================
// 常量
// ============================================

const QUICK_TAGS = [
  { label: '私人律师', prompt: '我需要一个私人法律顾问，帮我分析法律问题、审查合同、提供法律建议' },
  { label: '周易命理', prompt: '我需要一个周易命理师，精通八字排盘、六爻占卜、梅花易数，帮我分析运势' },
  { label: '论文杀手', prompt: '我需要一个论文写作助手，帮我查找文献、梳理论点、撰写和润色学术论文' },
  { label: '小红书写手', prompt: '我需要一个小红书文案写手，帮我写出有爆款潜力的笔记内容' },
  { label: '竞品分析师', prompt: '我需要一个竞品分析师，帮我调研竞争对手、分析市场趋势、撰写分析报告' },
  { label: '小说编剧', prompt: '我需要一个小说编剧，帮我构思故事情节、塑造角色、撰写小说章节' },
]

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

// Provider 按区域分组
type RegionGroup = { title: string; keys: string[] }

function getProviderGroups(): RegionGroup[] {
  const domestic: string[] = []
  const local: string[] = []
  const overseas: string[] = []

  for (const [key, guide] of Object.entries(PROVIDER_GUIDES)) {
    if (guide.region === 'domestic') domestic.push(key)
    else if (guide.region === 'local') local.push(key)
    else overseas.push(key)
  }

  const groups: RegionGroup[] = []
  if (domestic.length > 0) groups.push({ title: '国内推荐', keys: domestic })
  if (local.length > 0) groups.push({ title: '本地部署', keys: local })
  if (overseas.length > 0) groups.push({ title: '海外服务', keys: overseas })
  return groups
}

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
// Step 1: 选择 AI 服务商
// ============================================

function StepProviderSelect({
  selectedKey,
  onSelect,
}: {
  selectedKey: string
  onSelect: (key: string) => void
}) {
  const groups = useMemo(() => getProviderGroups(), [])

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          选择 AI 服务商
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          DunCrew 需要一个大模型 API 来驱动 Agent，选择你已有或想注册的服务
        </p>
      </div>

      {groups.map((group) => (
        <div key={group.title}>
          <h3 className="text-xs font-mono text-stone-400 mb-2 uppercase tracking-wider">
            {group.title}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {group.keys.map((key) => {
              const guide = PROVIDER_GUIDES[key]
              return (
                <button
                  key={key}
                  onClick={() => onSelect(key)}
                  className={cn(
                    'relative p-3 rounded-xl border text-left transition-all',
                    selectedKey === key
                      ? 'bg-cyan-500/10 border-cyan-500/40 ring-1 ring-cyan-500/20'
                      : 'bg-stone-50 border-stone-200 hover:border-stone-300'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{guide.icon}</span>
                    <div>
                      <span className={cn(
                        'text-sm font-mono font-medium block leading-tight',
                        selectedKey === key ? 'text-cyan-600' : 'text-stone-600'
                      )}>
                        {guide.label}
                      </span>
                      <span className="text-[11px] text-stone-400 font-mono">
                        {guide.tagline}
                      </span>
                    </div>
                  </div>
                  {selectedKey === key && (
                    <div className="absolute top-2 right-2">
                      <Check className="w-3.5 h-3.5 text-cyan-500" />
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================================
// Step 2: 配置 API Key + 测试连接
// ============================================

function StepApiConfig({
  guideKey,
  apiKey,
  setApiKey,
  model,
  setModel,
  testStatus,
  onTest,
  onAutoConnect,
}: {
  guideKey: string
  apiKey: string
  setApiKey: (k: string) => void
  model: string
  setModel: (m: string) => void
  testStatus: 'idle' | 'testing' | 'success' | 'error'
  onTest: () => void
  onAutoConnect: () => void
}) {
  const [showKey, setShowKey] = useState(false)
  const guide = PROVIDER_GUIDES[guideKey]

  if (!guide) return null

  const isLocalProvider = guide.region === 'local'

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          配置 {guide.label}
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          按照以下步骤获取 API Key 并连接
        </p>
      </div>

      {/* 分步教程 */}
      <div className="bg-stone-50 rounded-xl p-4 border border-stone-200 space-y-2">
        {guide.steps.map((stepText, i) => (
          <div key={i} className="flex gap-2.5 text-xs font-mono">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/15 text-cyan-600 flex items-center justify-center text-[10px] font-bold mt-0.5">
              {i + 1}
            </span>
            <span className="text-stone-600 leading-relaxed">{stepText}</span>
          </div>
        ))}
        {guide.tip && (
          <p className="text-[11px] text-amber-600 font-mono mt-2 pl-7">
            {guide.tip}
          </p>
        )}
        {guide.signupUrl && (
          <div className="flex gap-2 pl-7 mt-2">
            <a
              href={guide.signupUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-mono text-cyan-600 hover:text-cyan-500 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              注册/登录
            </a>
            {guide.apiKeyPageUrl && (
              <a
                href={guide.apiKeyPageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-mono text-cyan-600 hover:text-cyan-500 transition-colors"
              >
                <ExternalLink className="w-3 h-3" />
                获取 API Key
              </a>
            )}
          </div>
        )}
      </div>

      {/* API Key 输入 */}
      <div className="space-y-3">
        <div>
          <label className="text-xs font-mono text-stone-400 mb-1 block">
            API Key
          </label>
          <div className="relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={isLocalProvider ? '本地部署无需填写，留空即可' : 'sk-...'}
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
        </div>

        {/* 模型选择 */}
        <div>
          <label className="text-xs font-mono text-stone-400 mb-1 block">
            模型
          </label>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={guide.recommendedModel || 'model-name'}
            className="w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
          />
          {guide.recommendedModel && model !== guide.recommendedModel && (
            <button
              onClick={() => setModel(guide.recommendedModel!)}
              className="text-[11px] font-mono text-cyan-500 hover:text-cyan-600 mt-1 transition-colors"
            >
              使用推荐模型: {guide.recommendedModel}
            </button>
          )}
        </div>
      </div>

      {/* 测试连接按钮 */}
      <div className="space-y-3">
        <button
          onClick={onTest}
          disabled={testStatus === 'testing' || !model}
          className={cn(
            'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-mono transition-all',
            testStatus === 'testing'
              ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-500 animate-pulse'
              : testStatus === 'success'
              ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-500'
              : testStatus === 'error'
              ? 'bg-red-500/15 border border-red-500/30 text-red-400'
              : !model
              ? 'bg-stone-100 border border-stone-200 text-stone-300 cursor-not-allowed'
              : 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20'
          )}
        >
          {testStatus === 'testing' && <Loader2 className="w-4 h-4 animate-spin" />}
          {testStatus === 'success' && <Check className="w-4 h-4" />}
          {testStatus === 'idle' && <Zap className="w-4 h-4" />}
          {testStatus === 'error' && <Zap className="w-4 h-4" />}
          {testStatus === 'testing' ? '测试中...'
            : testStatus === 'success' ? 'AI 连接成功'
            : testStatus === 'error' ? '连接失败，请检查配置'
            : '测试 AI 连接'}
        </button>

        {testStatus === 'success' && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center"
          >
            <p className="text-sm text-emerald-500 font-mono mb-3">
              AI 引擎已验证，连接本地服务器开始使用
            </p>
            <button
              onClick={onAutoConnect}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20 transition-all"
            >
              <Monitor className="w-4 h-4" />
              连接本地服务器
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
              请检查 API Key 和模型名是否正确。如果使用海外服务，请确认网络连接正常。
            </p>
          </motion.div>
        )}
      </div>
    </div>
  )
}

// ============================================
// Step 3: 创建你的第一个 Dun
// ============================================

interface GeneratedDun {
  name: string
  description: string
  sop: string
  triggers: string[]
}

function StepCreateDun({
  userInput,
  setUserInput,
  generatedDun,
  generating,
  onGenerate,
}: {
  userInput: string
  setUserInput: (v: string) => void
  generatedDun: GeneratedDun | null
  generating: boolean
  onGenerate: () => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-stone-800 mb-1">
          创建你的第一个 Dun
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          告诉我你想让 AI 帮你做什么，我会为你创建一个专属 Agent
        </p>
      </div>

      {/* 快捷标签 */}
      <div className="flex flex-wrap gap-1.5">
        {QUICK_TAGS.map((tag) => (
          <button
            key={tag.label}
            onClick={() => setUserInput(tag.prompt)}
            className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-mono border transition-colors',
              userInput === tag.prompt
                ? 'bg-cyan-500/15 border-cyan-500/30 text-cyan-600'
                : 'bg-stone-50 border-stone-200 text-stone-400 hover:border-stone-300 hover:text-stone-500'
            )}
          >
            {tag.label}
          </button>
        ))}
      </div>

      {/* 输入框 */}
      <div>
        <textarea
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          placeholder="例如：帮我写小红书爆款文案 / 帮我分析竞品产品 / 帮我做周易八字排盘..."
          rows={3}
          className="w-full px-3 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm font-mono text-stone-600 placeholder-stone-300 focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/20 resize-none"
        />
      </div>

      {/* 生成按钮 */}
      <button
        onClick={onGenerate}
        disabled={generating || !userInput.trim()}
        className={cn(
          'w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-mono transition-all',
          generating
            ? 'bg-purple-500/15 border border-purple-500/30 text-purple-500 animate-pulse'
            : !userInput.trim()
            ? 'bg-stone-100 border border-stone-200 text-stone-300 cursor-not-allowed'
            : 'bg-purple-500/15 border border-purple-500/30 text-purple-600 hover:bg-purple-500/20'
        )}
      >
        {generating ? (
          <><Loader2 className="w-4 h-4 animate-spin" />正在生成 Dun...</>
        ) : (
          <><Wand2 className="w-4 h-4" />生成专属 Dun</>
        )}
      </button>

      {/* 生成结果预览 */}
      {generatedDun && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 bg-emerald-500/5 rounded-xl border border-emerald-500/20 space-y-2"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-500" />
            <span className="text-sm font-mono font-semibold text-emerald-700">
              {generatedDun.name}
            </span>
          </div>
          <p className="text-xs text-stone-500 font-mono leading-relaxed">
            {generatedDun.description}
          </p>
          {generatedDun.triggers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {generatedDun.triggers.map((t, i) => (
                <span key={i} className="px-2 py-0.5 bg-emerald-500/10 rounded-md text-[10px] font-mono text-emerald-600">
                  {t}
                </span>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}

// ============================================
// Step 4: 一切就绪
// ============================================

function StepReady({ dunName }: { dunName?: string }) {
  return (
    <div className="space-y-5">
      <div className="text-center py-6">
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', bounce: 0.5, duration: 0.6 }}
          className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center"
        >
          <Sparkles className="w-8 h-8 text-emerald-500" />
        </motion.div>
        <h2 className="text-xl font-semibold text-stone-800 mb-2">
          一切就绪
        </h2>
        <p className="text-sm text-stone-400 font-mono">
          AI 引擎已连接{dunName ? `，「${dunName}」已为你待命` : ''}，开始探索 DunCrew
        </p>
      </div>

      <div className="space-y-3">
        {[
          { icon: '💬', title: '右侧聊天面板', desc: '与 Agent 交互，它能读写文件、执行命令、搜索网络' },
          { icon: '🏗️', title: 'Dun 建筑群', desc: '你的 Dun 以建筑形态展示在主界面，点击管理和使用' },
          { icon: '⚙️', title: '联络站', desc: '随时在联络站切换模型、管理 API 和 MCP 服务' },
        ].map((tip, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.1 }}
            className="flex items-start gap-3 p-3 rounded-xl bg-stone-50 border border-stone-200"
          >
            <span className="text-lg">{tip.icon}</span>
            <div>
              <h4 className="text-sm font-mono font-medium text-stone-700">
                {tip.title}
              </h4>
              <p className="text-xs text-stone-400 font-mono mt-0.5">
                {tip.desc}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

// ============================================
// 主组件: FirstLaunchSetup
// ============================================

export function FirstLaunchSetup({ onComplete }: { onComplete: () => void }) {
  // Step 状态
  const [step, setStep] = useState(0)
  const TOTAL_STEPS = 4

  // Step 1: Provider 选择
  const [selectedProviderKey, setSelectedProviderKey] = useState('qwen')

  // Step 2: API 配置
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(PROVIDER_GUIDES['qwen']?.recommendedModel || '')
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')

  // Step 3: Dun 创建
  const [dunInput, setDunInput] = useState('')
  const [generatedDun, setGeneratedDun] = useState<GeneratedDun | null>(null)
  const [generating, setGenerating] = useState(false)

  // Store actions
  const addProvider = useStore((s) => s.addProvider)
  const setChannelBinding = useStore((s) => s.setChannelBinding)
  const addDun = useStore((s) => s.addDun)

  // 切换 Provider 时重置相关状态
  const handleSelectProvider = useCallback((key: string) => {
    setSelectedProviderKey(key)
    const guide = PROVIDER_GUIDES[key]
    if (guide?.recommendedModel) {
      setModel(guide.recommendedModel)
    } else {
      setModel('')
    }
    setApiKey('')
    setTestStatus('idle')
  }, [])

  // 获取当前 guide
  const currentGuide = PROVIDER_GUIDES[selectedProviderKey]

  // 构造并保存 Provider 到 LinkStation
  const saveProviderToStore = useCallback(() => {
    if (!currentGuide) return null

    const providerId = `setup-${selectedProviderKey}-${Date.now()}`
    const modelEntry: ModelEntry = {
      id: model,
      name: model,
    }
    const provider: ModelProvider = {
      id: providerId,
      label: currentGuide.label,
      baseUrl: currentGuide.baseUrl,
      apiKey: apiKey,
      apiProtocol: currentGuide.apiProtocol as ApiProtocol,
      source: 'manual',
      models: [modelEntry],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    addProvider(provider)
    // 绑定到 chat 通道
    setChannelBinding('chat', { providerId, modelId: model })
    return providerId
  }, [currentGuide, selectedProviderKey, apiKey, model, addProvider, setChannelBinding])

  // 测试连接 (先临时保存配置)
  const handleTestLLM = useCallback(async () => {
    setTestStatus('testing')
    try {
      // 先保存到 store 以便 testConnection 能读到配置
      saveProviderToStore()
      const ok = await testConnection({
        apiKey,
        baseUrl: currentGuide?.baseUrl || '',
        model,
      })
      setTestStatus(ok ? 'success' : 'error')
    } catch {
      setTestStatus('error')
    }
  }, [apiKey, model, currentGuide, saveProviderToStore])

  // 自动连接 Native 服务器
  const handleAutoConnect = useCallback(async () => {
    const { localClawService } = await import('@/services/LocalClawService')
    useStore.getState().setConnectionStatus('connecting')
    const success = await localClawService.connect()
    if (!success) {
      useStore.getState().setConnectionStatus('disconnected')
    }
    setStep(2) // 跳到 Dun 创建步骤
  }, [])

  // 生成 Dun (LLM)
  const handleGenerateDun = useCallback(async () => {
    if (!dunInput.trim()) return
    setGenerating(true)
    try {
      const result = await simpleChat([
        {
          role: 'system',
          content: `你是一个 AI Agent 定义生成器。用户会描述他想要一个什么样的 AI 助手，你需要生成一个 Agent 定义。
请严格按照以下 JSON 格式返回（不要包含 markdown 标记）：
{
  "name": "简短的中文名称(2-6个字)",
  "description": "一句话描述这个 Agent 的核心能力(20-40字)",
  "sop": "## Mission\\n描述核心任务\\n\\n## SOP\\n1. 第一步\\n2. 第二步\\n3. 第三步\\n\\n## Rules\\n- 规则1\\n- 规则2",
  "triggers": ["触发关键词1", "触发关键词2", "触发关键词3"]
}`,
        },
        {
          role: 'user',
          content: dunInput,
        },
      ])

      if (result) {
        // 尝试解析 JSON（兼容 LLM 可能返回的 markdown 包裹）
        const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
        const parsed = JSON.parse(cleaned) as GeneratedDun
        setGeneratedDun({
          name: parsed.name || '未命名 Dun',
          description: parsed.description || dunInput,
          sop: parsed.sop || `## Mission\n${dunInput}`,
          triggers: Array.isArray(parsed.triggers) ? parsed.triggers.slice(0, 5) : [],
        })
      } else {
        // LLM 调用失败，使用 fallback
        setGeneratedDun({
          name: '智能助手',
          description: dunInput.slice(0, 40),
          sop: `## Mission\n${dunInput}\n\n## SOP\n1. 理解用户需求\n2. 搜索相关信息\n3. 完成任务并交付结果\n\n## Rules\n- 确保输出质量\n- 主动确认不确定的需求`,
          triggers: [],
        })
      }
    } catch {
      // JSON 解析失败，fallback
      setGeneratedDun({
        name: '智能助手',
        description: dunInput.slice(0, 40),
        sop: `## Mission\n${dunInput}\n\n## SOP\n1. 理解用户需求\n2. 搜索相关信息\n3. 完成任务并交付结果\n\n## Rules\n- 确保输出质量\n- 主动确认不确定的需求`,
        triggers: [],
      })
    } finally {
      setGenerating(false)
    }
  }, [dunInput])

  // 完成设置
  const handleFinish = useCallback(async () => {
    // 确保 Provider 已保存 (如果测试时未保存)
    const existingProviders = useStore.getState().linkStation.providers
    if (existingProviders.length === 0) {
      saveProviderToStore()
    }

    // 保存 Dun (如果生成了)
    if (generatedDun) {
      const dunId = `dun-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      addDun({
        id: dunId,
        position: { gridX: 2, gridY: 2 },
        scoring: createInitialScoring(),
        visualDNA: simpleVisualDNA(dunId),
        label: generatedDun.name,
        flavorText: generatedDun.description,
        sopContent: generatedDun.sop,
        triggers: generatedDun.triggers,
        constructionProgress: 1,
        createdAt: Date.now(),
        location: 'local',
      })
    }

    // 写入默认 SOUL.md
    const existingSoul = localStorage.getItem('duncrew_soul_md')
    if (!existingSoul) {
      saveSoulMd(DEFAULT_SOUL_MD)
    }

    // 标记完成
    localStorage.setItem('duncrew_setup_done', '1')
    onComplete()
  }, [generatedDun, addDun, saveProviderToStore, onComplete])

  // 是否可以前进
  const canProceed = step === 0
    ? !!selectedProviderKey
    : step === 1
    ? testStatus === 'success'
    : step === 2
    ? true // Dun 创建是可选的
    : true

  // 跳过设置
  const handleSkip = useCallback(() => {
    // 写入默认 SOUL.md
    const existingSoul = localStorage.getItem('duncrew_soul_md')
    if (!existingSoul) {
      saveSoulMd(DEFAULT_SOUL_MD)
    }

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
        className="w-full max-w-lg mx-4 bg-white/95 backdrop-blur-3xl rounded-[2rem] border border-white/80 shadow-[0_30px_80px_rgba(0,0,0,0.12)] overflow-hidden max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-stone-100 flex-shrink-0">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-cyan-500" />
              <span className="font-mono text-sm font-semibold text-stone-700">
                DunCrew 初始设置
              </span>
            </div>
            <button
              onClick={handleSkip}
              className="text-[11px] font-mono text-stone-400 hover:text-stone-600 transition-colors"
            >
              跳过设置
            </button>
          </div>
          <StepIndicator current={step} total={TOTAL_STEPS} />
        </div>

        {/* Step Content */}
        <div className="px-6 py-5 min-h-[360px] overflow-y-auto flex-1">
          <AnimatePresence mode="wait">
            {step === 0 && (
              <motion.div
                key="step-0"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <StepProviderSelect
                  selectedKey={selectedProviderKey}
                  onSelect={handleSelectProvider}
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
                <StepApiConfig
                  guideKey={selectedProviderKey}
                  apiKey={apiKey}
                  setApiKey={setApiKey}
                  model={model}
                  setModel={setModel}
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
                <StepCreateDun
                  userInput={dunInput}
                  setUserInput={setDunInput}
                  generatedDun={generatedDun}
                  generating={generating}
                  onGenerate={handleGenerateDun}
                />
              </motion.div>
            )}
            {step === 3 && (
              <motion.div
                key="step-3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
              >
                <StepReady dunName={generatedDun?.name} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer Navigation */}
        <div className="px-6 py-4 border-t border-stone-100 flex items-center justify-between flex-shrink-0">
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
            上一步
          </button>

          {step < TOTAL_STEPS - 1 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={!canProceed}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-mono transition-all',
                canProceed
                  ? 'bg-cyan-500/15 border border-cyan-500/30 text-cyan-600 hover:bg-cyan-500/20'
                  : 'bg-stone-100 border border-stone-200 text-stone-300 cursor-not-allowed'
              )}
            >
              {step === 2 && !generatedDun ? '跳过，稍后创建' : '下一步'}
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={handleFinish}
              className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-mono bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/20 transition-all"
            >
              <ArrowRight className="w-4 h-4" />
              开始使用
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
