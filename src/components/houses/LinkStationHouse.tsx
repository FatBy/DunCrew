/**
 * LinkStationHouse - 联络站
 *
 * 两个 Sheet：
 * 1. 模型通道 - Provider 预设选择 + 已配置管理 + 通道绑定
 * 2. MCP 服务 - 蛛网可视化
 */

import { useState, useMemo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Radio, Globe, Plus, Search, Trash2, Check, X,
  RefreshCw, ChevronRight, ExternalLink, Eye, EyeOff,
  LayoutList, Zap, Unplug, Wrench, Save,
  MessageSquare, Database, Image, Video,
} from 'lucide-react'
import { useStore } from '@/store'
import { testConnection } from '@/services/llmService'
import { PROVIDER_GUIDES } from '@/store/slices/linkStationSlice'
import { parseCurlCommand } from '@/utils/parseCurl'
import { GlassCard } from '@/components/GlassCard'
import type {
  ModelProvider, ModelBinding, ChannelBindings,
  MCPServerEntry, MCPServerStatus, MCPToolEntry,
  MCPTransportType,
} from '@/types'

// ============================================
// 主组件
// ============================================

export function LinkStationHouse() {
  const activeSheet = useStore(s => s.linkStation.activeSheet)
  const setActiveSheet = useStore(s => s.setActiveSheet)

  return (
    <div className="flex flex-col h-full">
      {/* Tab 栏 */}
      <div className="flex items-center gap-1 px-6 pt-4 pb-2">
        <div className="flex items-center gap-1 bg-stone-100/60 p-1 rounded-2xl">
          <TabButton
            active={activeSheet === 'model-channel'}
            onClick={() => setActiveSheet('model-channel')}
            icon={<Radio className="w-3.5 h-3.5" />}
            label="模型通道"
          />
          <TabButton
            active={activeSheet === 'mcp-service'}
            onClick={() => setActiveSheet('mcp-service')}
            icon={<Globe className="w-3.5 h-3.5" />}
            label="MCP 服务"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeSheet === 'model-channel' ? <ModelChannelSheet /> : <MCPServiceSheet />}
      </div>
    </div>
  )
}

function TabButton({ active, onClick, icon, label }: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-xl transition-all duration-300 ${
        active
          ? 'bg-white text-teal-600 shadow-sm'
          : 'text-stone-400 hover:text-stone-600'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

// ============================================
// Sheet 1: 模型通道
// ============================================

function ModelChannelSheet() {
  const providers = useStore(s => s.linkStation.providers)
  const channelBindings = useStore(s => s.linkStation.channelBindings)
  const addProvider = useStore(s => s.addProvider)
  const removeProvider = useStore(s => s.removeProvider)
  const updateProvider = useStore(s => s.updateProvider)
  const setChannelBinding = useStore(s => s.setChannelBinding)

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  const [guideKey, setGuideKey] = useState<string | null>(null)
  const [guidesExpanded, setGuidesExpanded] = useState(false)

  // 搜索 PROVIDER_GUIDES 预设列表
  const allGuides = useMemo(() => Object.entries(PROVIDER_GUIDES), [])
  const filteredGuides = useMemo(() => {
    if (!searchQuery) return allGuides
    const query = searchQuery.toLowerCase()
    return allGuides.filter(([, guide]) =>
      guide.label.toLowerCase().includes(query) ||
      guide.tagline.toLowerCase().includes(query)
    )
  }, [allGuides, searchQuery])

  const selectedProvider = useMemo(
    () => providers.find(p => p.id === selectedProviderId) || null,
    [providers, selectedProviderId]
  )

  const handleGuideComplete = useCallback((provider: ModelProvider, chatBinding?: ModelBinding) => {
    addProvider(provider)
    if (chatBinding) setChannelBinding('chat', chatBinding)
    setShowGuide(false)
    setGuideKey(null)
    setSelectedProviderId(provider.id)
  }, [addProvider, setChannelBinding])

  if (showGuide && guideKey) {
    return (
      <ProviderSetupWizard
        guideKey={guideKey}
        onComplete={handleGuideComplete}
        onCancel={() => { setShowGuide(false); setGuideKey(null) }}
      />
    )
  }

  return (
    <div className="flex h-full">
      {/* 左侧：Provider 预设搜索 + 已配置列表 */}
      <div className="w-72 flex-shrink-0 border-r border-stone-100 flex flex-col bg-stone-50/30">
        {/* 搜索框 - 搜索 Provider 预设 */}
        <div className="p-4 pb-2">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              type="text"
              placeholder="搜索模型服务商..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-stone-200 text-sm rounded-xl pl-9 pr-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all placeholder-stone-400 text-stone-700"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-4">
          {/* Provider 预设列表（可折叠） */}
          <div>
            <button
              onClick={() => setGuidesExpanded(!guidesExpanded)}
              className="w-full flex items-center justify-between px-1 mb-1.5 group"
            >
              <h4 className="text-[10px] font-semibold text-stone-400 tracking-wider uppercase">
                选择 Provider
              </h4>
              <ChevronRight className={`w-3 h-3 text-stone-300 group-hover:text-teal-500 transition-transform duration-200 ${guidesExpanded ? 'rotate-90' : ''}`} />
            </button>
            <AnimatePresence>
              {guidesExpanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="space-y-0.5">
                    {filteredGuides.map(([key, guide]) => (
                      <button
                        key={key}
                        onClick={() => { setGuideKey(key); setShowGuide(true) }}
                        className="group w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg border border-transparent hover:bg-white hover:border-stone-200 hover:shadow-sm transition-all text-left"
                      >
                        <span className="text-base flex-shrink-0">{guide.icon}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-stone-700 truncate">{guide.label}</div>
                          <div className="text-[10px] text-stone-400 truncate">{guide.tagline}</div>
                        </div>
                        <ChevronRight className="w-3 h-3 text-stone-300 group-hover:text-teal-500 flex-shrink-0 transition-colors" />
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 已配置的 Provider */}
          {providers.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold text-stone-400 mb-2 px-1 tracking-wider uppercase">
                已配置 ({providers.length})
              </h4>
              <div className="space-y-1">
                {providers.map(provider => (
                  <button
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                    className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-left ${
                      selectedProviderId === provider.id
                        ? 'bg-teal-50/60 border-teal-200 shadow-sm'
                        : 'border-transparent hover:bg-white hover:border-stone-200'
                    }`}
                  >
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                      selectedProviderId === provider.id
                        ? 'bg-teal-100 text-teal-600'
                        : 'bg-stone-100 text-stone-400'
                    }`}>
                      <Zap className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium truncate ${
                        selectedProviderId === provider.id ? 'text-teal-800' : 'text-stone-700'
                      }`}>
                        {provider.label}
                      </div>
                      <div className="text-[11px] text-stone-400 truncate">
                        {provider.models.length > 0
                          ? `${provider.models.length} 个模型就绪`
                          : '未配置模型'}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右侧内容区 */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 overflow-y-auto p-6">
          {selectedProvider ? (
            <ProviderDetailEditor
              provider={selectedProvider}
              onUpdate={(patch) => updateProvider(selectedProvider.id, patch)}
              onDelete={() => { removeProvider(selectedProvider.id); setSelectedProviderId(null) }}
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 mx-auto bg-stone-100 rounded-2xl flex items-center justify-center">
                  <Radio className="w-7 h-7 text-stone-300" />
                </div>
                <p className="text-sm text-stone-500">选择左侧的 Provider 开始配置</p>
                <p className="text-xs text-stone-400">或搜索预设快速添加新通道</p>
              </div>
            </div>
          )}
        </div>

        <ChannelBindingPanel
          providers={providers}
          channelBindings={channelBindings}
          onSetBinding={setChannelBinding}
        />
      </div>
    </div>
  )
}

// ============================================
// Provider 设置向导（3 步）
// ============================================

function ProviderSetupWizard({ guideKey, onComplete, onCancel }: {
  guideKey: string
  onComplete: (provider: ModelProvider, chatBinding?: ModelBinding) => void
  onCancel: () => void
}) {
  const guide = PROVIDER_GUIDES[guideKey]
  const [step, setStep] = useState(1)
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(guide?.baseUrl || '')
  const [showKey, setShowKey] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [selectedModel, setSelectedModel] = useState(guide?.recommendedModel || '')
  const [showCurlImport, setShowCurlImport] = useState(false)
  const [curlInput, setCurlInput] = useState('')
  const [curlError, setCurlError] = useState('')

  const handleCurlImport = () => {
    const result = parseCurlCommand(curlInput)
    if (!result) {
      setCurlError('无法解析，请粘贴完整的 cURL 命令')
      return
    }
    if (result.apiKey) setApiKey(result.apiKey)
    if (result.baseUrl) setBaseUrl(result.baseUrl)
    if (result.model) setSelectedModel(result.model)
    setCurlError('')
    setShowCurlImport(false)
    setCurlInput('')
  }

  if (!guide) return null

  const handleTestConnection = async () => {
    setTestStatus('testing')
    try {
      const ok = await testConnection({ apiKey, baseUrl, model: selectedModel || 'test' })
      setTestStatus(ok ? 'success' : 'error')
    } catch {
      setTestStatus('error')
    }
  }

  const handleComplete = () => {
    const now = Date.now()
    const providerId = `${guideKey}-${now}`
    const provider: ModelProvider = {
      id: providerId,
      label: guide.label,
      baseUrl,
      apiKey,
      apiProtocol: guide.apiProtocol,
      source: 'manual',
      models: selectedModel ? [{ id: selectedModel, name: selectedModel }] : [],
      createdAt: now,
      updatedAt: now,
      imageGenProfile: guide.imageGenProfile,
    }
    const chatBinding: ModelBinding | undefined = selectedModel
      ? { providerId, modelId: selectedModel }
      : undefined
    onComplete(provider, chatBinding)
  }

  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="w-full max-w-lg">
        <GlassCard className="p-8 space-y-6">
          {/* 标题 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-2xl">{guide.icon}</span>
              <div>
                <h3 className="text-base font-bold text-stone-800">配置 {guide.label}</h3>
                <p className="text-xs text-stone-400">{guide.tagline}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400">步骤 {step}/3</span>
              <button onClick={onCancel} className="text-stone-400 hover:text-stone-600 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 步骤指示器 */}
          <div className="flex gap-1.5">
            {[1, 2, 3].map(s => (
              <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${s <= step ? 'bg-teal-400' : 'bg-stone-200'}`} />
            ))}
          </div>

          {/* Step 1: 获取 API Key */}
          {step === 1 && (
            <div className="space-y-5">
              <p className="text-sm font-medium text-stone-600">第 1 步：获取 API Key</p>
              <ol className="space-y-2.5">
                {guide.steps.map((stepText, index) => (
                  <li key={index} className="flex gap-2.5 text-sm text-stone-500">
                    <span className="text-teal-500 font-bold flex-shrink-0">{index + 1}.</span>
                    {stepText}
                  </li>
                ))}
              </ol>

              {guide.signupUrl && (
                <a href={guide.signupUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-teal-600 hover:text-teal-500 font-medium">
                  <ExternalLink className="w-3.5 h-3.5" /> 打开 {guide.label} 平台
                </a>
              )}

              <div className="space-y-3">
                {/* cURL 导入 */}
                <button
                  onClick={() => setShowCurlImport(!showCurlImport)}
                  className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-500 font-medium transition-colors"
                >
                  <LayoutList className="w-3.5 h-3.5" />
                  {showCurlImport ? '收起 cURL 导入' : '从 cURL 命令导入配置'}
                </button>

                <AnimatePresence>
                  {showCurlImport && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="space-y-2 p-3 bg-stone-50 rounded-xl border border-stone-200">
                        <p className="text-[11px] text-stone-400">粘贴 API 文档中的 cURL 命令，自动提取 Base URL、API Key 和模型名</p>
                        <textarea
                          value={curlInput}
                          onChange={e => { setCurlInput(e.target.value); setCurlError('') }}
                          placeholder={'curl --request POST \\\n  --url https://api.example.com/v1/... \\\n  --header \'Authorization: Bearer sk-xxx\' \\\n  --data \'{"model": "..."}\''}
                          rows={5}
                          className="w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-xs text-stone-700 placeholder-stone-300 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono resize-none"
                        />
                        {curlError && <p className="text-[11px] text-red-500">{curlError}</p>}
                        <div className="flex justify-end">
                          <button onClick={handleCurlImport} disabled={!curlInput.trim()}
                            className="px-3 py-1.5 text-xs font-medium bg-teal-500 text-white rounded-lg hover:bg-teal-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                            解析并填入
                          </button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div>
                  <label className="text-xs font-medium text-stone-500 mb-1.5 block">API Key</label>
                  <div className="flex items-center gap-2">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder="sk-xxxxxxxxxxxxxxxx"
                      className="flex-1 px-3.5 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 placeholder-stone-400 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono"
                    />
                    <button onClick={() => setShowKey(!showKey)} className="p-2 text-stone-400 hover:text-stone-600 transition-colors">
                      {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-stone-500 mb-1.5 block">Base URL</label>
                  <input type="text" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                    className={`w-full px-3.5 py-2.5 bg-stone-50 border rounded-xl text-sm text-stone-700 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono ${
                      baseUrl && /\/(chat\/completions|image_generation|embeddings|audio|video)/.test(baseUrl)
                        ? 'border-amber-300 bg-amber-50/50'
                        : 'border-stone-200'
                    }`}
                  />
                  {baseUrl && /\/(chat\/completions|image_generation|embeddings|audio|video)/.test(baseUrl) && (
                    <p className="text-[11px] text-amber-600 mt-1.5 flex items-start gap-1">
                      ⚠️ Base URL 只需填到 /v1 即可，不要包含具体接口路径（如 /chat/completions、/image_generation 等），系统会自动拼接
                    </p>
                  )}
                </div>
              </div>

              {guide.tip && (
                <p className="text-xs text-stone-500 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                  💡 {guide.tip}
                </p>
              )}

              <div className="flex justify-end">
                <button onClick={() => setStep(2)} disabled={!apiKey && guideKey !== 'ollama'}
                  className="px-5 py-2 text-sm font-medium bg-teal-500 text-white rounded-xl hover:bg-teal-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm">
                  下一步 →
                </button>
              </div>
            </div>
          )}

          {/* Step 2: 选择模型 */}
          {step === 2 && (
            <div className="space-y-5">
              <p className="text-sm font-medium text-stone-600">第 2 步：选择模型</p>
              <div>
                <label className="text-xs font-medium text-stone-500 mb-1.5 block">模型名称</label>
                <input type="text" value={selectedModel} onChange={e => setSelectedModel(e.target.value)}
                  placeholder="输入模型 ID"
                  className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 placeholder-stone-400 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono"
                />
                {guide.recommendedModel && (
                  <p className="text-xs text-stone-400 mt-2">
                    💡 推荐使用 <span className="text-teal-600 font-medium">{guide.recommendedModel}</span>
                  </p>
                )}
              </div>

              <div>
                <button onClick={handleTestConnection}
                  className={`flex items-center gap-2 px-4 py-2 text-sm rounded-xl transition-all ${
                    testStatus === 'testing' ? 'bg-stone-100 text-stone-400' :
                    testStatus === 'success' ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' :
                    testStatus === 'error' ? 'bg-red-50 text-red-500 border border-red-200' :
                    'bg-stone-100 text-stone-500 hover:bg-stone-200'
                  }`}>
                  <RefreshCw className={`w-4 h-4 ${testStatus === 'testing' ? 'animate-spin' : ''}`} />
                  {testStatus === 'testing' ? '测试中...' :
                   testStatus === 'success' ? '连接成功 ✓' :
                   testStatus === 'error' ? '连接失败 ✗' : '测试连接'}
                </button>
                {testStatus === 'error' && (
                  <p className="text-[11px] text-stone-400 mt-1.5">
                    💡 请检查 API Key 和 Base URL 是否正确。图片/视频/Embed 等非对话模型测试失败可直接跳过
                  </p>
                )}
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(1)} className="px-4 py-2 text-sm text-stone-400 hover:text-stone-600">← 上一步</button>
                <button onClick={() => setStep(3)}
                  className="px-5 py-2 text-sm font-medium bg-teal-500 text-white rounded-xl hover:bg-teal-600 transition-colors shadow-sm">
                  下一步 →
                </button>
              </div>
            </div>
          )}

          {/* Step 3: 绑定通道 */}
          {step === 3 && (
            <div className="space-y-5">
              <p className="text-sm font-medium text-stone-600">第 3 步：绑定通道</p>
              <p className="text-xs text-stone-400">将 {guide.label} 的模型绑定到主对话通道</p>

              <div className="bg-stone-50 rounded-xl p-4 space-y-3 border border-stone-100">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-stone-500 flex items-center gap-2">
                    <MessageSquare className="w-4 h-4 text-pink-400" /> 主对话
                  </span>
                  <span className="text-teal-600 font-mono font-medium">{selectedModel || '未配置'}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-stone-400 flex items-center gap-2">
                    <Zap className="w-4 h-4 text-violet-300" /> 副对话
                  </span>
                  <span className="text-stone-400">可稍后配置</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-stone-400 flex items-center gap-2">
                    <Database className="w-4 h-4 text-amber-300" /> Embed
                  </span>
                  <span className="text-stone-400">可稍后配置</span>
                </div>
              </div>

              <div className="flex justify-between">
                <button onClick={() => setStep(2)} className="px-4 py-2 text-sm text-stone-400 hover:text-stone-600">← 上一步</button>
                <button onClick={handleComplete}
                  className="px-5 py-2 text-sm font-medium bg-teal-500 text-white rounded-xl hover:bg-teal-600 transition-colors shadow-sm">
                  完成 ✓
                </button>
              </div>
            </div>
          )}
        </GlassCard>
      </div>
    </div>
  )
}

// ============================================
// Provider 详情编辑器
// ============================================

function ProviderDetailEditor({ provider, onUpdate, onDelete }: {
  provider: ModelProvider
  onUpdate: (patch: Partial<ModelProvider>) => void
  onDelete: () => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const [saved, setSaved] = useState(false)
  const [showCurlImport, setShowCurlImport] = useState(false)
  const [curlInput, setCurlInput] = useState('')
  const [curlError, setCurlError] = useState('')

  const handleCurlImport = () => {
    const result = parseCurlCommand(curlInput)
    if (!result) {
      setCurlError('无法解析，请粘贴完整的 cURL 命令')
      return
    }
    const patch: Partial<ModelProvider> = {}
    if (result.apiKey) patch.apiKey = result.apiKey
    if (result.baseUrl) patch.baseUrl = result.baseUrl
    if (result.model) {
      const existingIds = provider.models.map(m => m.id)
      if (!existingIds.includes(result.model)) {
        patch.models = [...provider.models, { id: result.model, name: result.model }]
      }
    }
    onUpdate(patch)
    setCurlError('')
    setShowCurlImport(false)
    setCurlInput('')
  }

  const handleTestConnection = async () => {
    setTestStatus('testing')
    try {
      const model = provider.models[0]?.id || 'test'
      const ok = await testConnection({ apiKey: provider.apiKey, baseUrl: provider.baseUrl, model })
      setTestStatus(ok ? 'success' : 'error')
    } catch {
      setTestStatus('error')
    }
  }

  const handleSave = () => {
    onUpdate({ updatedAt: Date.now() })
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-stone-800 flex items-center gap-3">
            {provider.label}
            {provider.models.length > 0 && (
              <span className="px-2.5 py-0.5 bg-emerald-50 text-emerald-600 text-xs rounded-lg font-medium border border-emerald-100">
                {provider.models.length} 个模型
              </span>
            )}
          </h2>
          <p className="text-stone-400 text-sm mt-1">配置 API 连接和模型参数</p>
        </div>
        <button
          onClick={() => setShowCurlImport(!showCurlImport)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-600 bg-teal-50 border border-teal-100 rounded-lg hover:bg-teal-100 transition-colors"
        >
          <LayoutList className="w-3.5 h-3.5" />
          cURL 导入
        </button>
      </div>

      <AnimatePresence>
        {showCurlImport && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 p-4 bg-stone-50 rounded-xl border border-stone-200">
              <p className="text-[11px] text-stone-400">粘贴 API 文档中的 cURL 命令，自动提取 Base URL、API Key 和模型名</p>
              <textarea
                value={curlInput}
                onChange={e => { setCurlInput(e.target.value); setCurlError('') }}
                placeholder={'curl --request POST \\\n  --url https://api.example.com/v1/... \\\n  --header \'Authorization: Bearer sk-xxx\' \\\n  --data \'{"model": "..."}\''}
                rows={5}
                className="w-full px-3 py-2 bg-white border border-stone-200 rounded-lg text-xs text-stone-700 placeholder-stone-300 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono resize-none"
              />
              {curlError && <p className="text-[11px] text-red-500">{curlError}</p>}
              <div className="flex justify-end">
                <button onClick={handleCurlImport} disabled={!curlInput.trim()}
                  className="px-3 py-1.5 text-xs font-medium bg-teal-500 text-white rounded-lg hover:bg-teal-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  解析并填入
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="bg-white border border-stone-100 rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 space-y-4">
          <FieldInput label="名称" value={provider.label} onChange={v => onUpdate({ label: v })} />
          <div>
            <FieldInput label="Base URL" value={provider.baseUrl} onChange={v => onUpdate({ baseUrl: v })} mono />
            {provider.baseUrl && /\/(chat\/completions|image_generation|embeddings|audio|video)/.test(provider.baseUrl) && (
              <p className="text-[11px] text-amber-600 mt-1 px-1 flex items-start gap-1">
                ⚠️ Base URL 只需填到 /v1 即可，不要包含具体接口路径
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-medium text-stone-500 mb-1.5 block">API Key</label>
            <div className="flex items-center gap-2">
              <input type={showKey ? 'text' : 'password'} value={provider.apiKey}
                onChange={e => onUpdate({ apiKey: e.target.value })}
                className="flex-1 px-3.5 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all font-mono"
              />
              <button onClick={() => setShowKey(!showKey)} className="p-2 text-stone-400 hover:text-stone-600 transition-colors">
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-stone-500 mb-1.5 block">API 协议</label>
            <select value={provider.apiProtocol}
              onChange={e => onUpdate({ apiProtocol: e.target.value as ModelProvider['apiProtocol'] })}
              className="w-full px-3.5 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all cursor-pointer">
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
              <option value="auto">自动检测</option>
            </select>
          </div>

          <div>
            <label className="text-xs font-medium text-stone-500 mb-1.5 block">模型列表</label>
            <div className="space-y-1.5">
              {provider.models.map(model => (
                <div key={model.id} className="flex items-center justify-between px-3 py-2 bg-stone-50 rounded-lg text-sm border border-stone-100">
                  <span className="text-stone-600 font-mono">{model.id}</span>
                </div>
              ))}
              {provider.models.length === 0 && (
                <p className="text-xs text-stone-400 px-1">暂无模型，请手动添加或拉取</p>
              )}
            </div>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-stone-50 bg-stone-50/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-500">确认删除？</span>
                <button onClick={onDelete} className="p-1.5 text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => setConfirmDelete(false)} className="p-1.5 text-stone-400 hover:bg-stone-100 rounded-lg transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="p-1.5 text-stone-300 hover:text-red-400 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button onClick={handleTestConnection}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-xl transition-all ${
                testStatus === 'testing' ? 'bg-stone-100 text-stone-400' :
                testStatus === 'success' ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' :
                testStatus === 'error' ? 'bg-red-50 text-red-500 border border-red-200' :
                'bg-stone-100 text-stone-500 hover:bg-stone-200'
              }`}>
              <RefreshCw className={`w-3.5 h-3.5 ${testStatus === 'testing' ? 'animate-spin' : ''}`} />
              {testStatus === 'testing' ? '测试中...' :
               testStatus === 'success' ? '连接成功 ✓' :
               testStatus === 'error' ? '连接失败 ✗' : '测试连接'}
            </button>
            {testStatus === 'error' && (
              <span className="text-[10px] text-stone-400">检查 Key 和 URL</span>
            )}
            <button onClick={handleSave}
              className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-xl transition-all ${
                saved
                  ? 'bg-emerald-50 text-emerald-600 border border-emerald-200'
                  : 'bg-teal-500 text-white hover:bg-teal-600 shadow-sm'
              }`}>
              {saved ? (
                <><Check className="w-3.5 h-3.5" /> 已保存</>
              ) : (
                '保存'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function FieldInput({ label, value, onChange, mono }: {
  label: string; value: string; onChange: (v: string) => void; mono?: boolean
}) {
  return (
    <div>
      <label className="text-xs font-medium text-stone-500 mb-1.5 block">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
        className={`w-full px-3.5 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 transition-all ${mono ? 'font-mono' : ''}`}
      />
    </div>
  )
}

// ============================================
// 通道绑定面板
// ============================================

const CHANNEL_CONFIG: Array<{
  channel: keyof ChannelBindings; label: string; tag: string; iconBg: string; icon: React.ReactNode
}> = [
  { channel: 'chat', label: '主对话', tag: '核心逻辑', iconBg: 'bg-pink-50 text-pink-500', icon: <MessageSquare className="w-3.5 h-3.5" /> },
  { channel: 'chatSecondary', label: '副对话', tag: '轻量任务', iconBg: 'bg-violet-50 text-violet-500', icon: <Zap className="w-3.5 h-3.5" /> },
  { channel: 'embed', label: 'Embed 向量', tag: '记忆检索', iconBg: 'bg-amber-50 text-amber-500', icon: <Database className="w-3.5 h-3.5" /> },
  { channel: 'imageGen', label: '文生图', tag: '图像生成', iconBg: 'bg-blue-50 text-blue-500', icon: <Image className="w-3.5 h-3.5" /> },
  { channel: 'videoGen', label: '文生视频', tag: '视频生成', iconBg: 'bg-cyan-50 text-cyan-500', icon: <Video className="w-3.5 h-3.5" /> },
  { channel: 'search', label: '搜索增强', tag: '联网搜索', iconBg: 'bg-emerald-50 text-emerald-500', icon: <Globe className="w-3.5 h-3.5" /> },
]

function ChannelBindingPanel({ providers, channelBindings, onSetBinding }: {
  providers: ModelProvider[]
  channelBindings: ChannelBindings
  onSetBinding: (channel: keyof ChannelBindings, binding: ModelBinding | null) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const forceSaveAll = useStore(s => s.forceSaveAll)
  const addToast = useStore(s => s.addToast)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')

  const handleForceWrite = useCallback(async () => {
    setSaveStatus('saving')
    const result = await forceSaveAll()
    if (result.success) {
      setSaveStatus('success')
      addToast({ type: 'success', title: '配置已写入', message: '通道配置已全量保存并同步' })
    } else {
      setSaveStatus('error')
      addToast({ type: 'error', title: '写入失败', message: result.error || '请检查后端连接' })
    }
    setTimeout(() => setSaveStatus('idle'), 2000)
  }, [forceSaveAll, addToast])

  const modelOptions = useMemo(() => {
    return providers.flatMap(p =>
      p.models.map(m => ({ providerId: p.id, providerLabel: p.label, modelId: m.id }))
    )
  }, [providers])

  const activeNexusId = useStore(s => (s as any).activeNexusId)
  const duns = useStore(s => (s as any).duns) as Map<string, any> | undefined
  const activeNexus = activeNexusId && duns ? duns.get(activeNexusId) : null
  const hasCustomModel = activeNexus?.customModel?.model

  // 统计已绑定数量
  const boundCount = CHANNEL_CONFIG.filter(c => !!channelBindings[c.channel]).length

  return (
    <div className="border-t border-stone-100">
      <div className="mx-6 my-2">
        {/* 手风琴标题栏 - 始终可见 */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-1 py-2 group"
        >
          <Unplug className="w-3.5 h-3.5 text-teal-500" />
          <span className="text-xs font-semibold text-stone-700">通道绑定</span>
          <span className="text-[10px] text-stone-400 bg-stone-100 px-1.5 py-0.5 rounded">
            {boundCount}/{CHANNEL_CONFIG.length}
          </span>
          <ChevronRight className={`w-3 h-3 text-stone-300 ml-auto group-hover:text-teal-500 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`} />
        </button>

        {/* 手风琴内容 */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              {hasCustomModel && (
                <div className="mb-2.5 flex items-center gap-1.5 px-3 py-2 bg-amber-50 border border-amber-100 rounded-xl text-[11px] text-amber-600">
                  ⚠️ 当前空间使用独立模型配置
                </div>
              )}

              <div className="grid grid-cols-2 gap-2.5 pb-1">
                {CHANNEL_CONFIG.map(({ channel, label, tag, iconBg, icon }) => {
                  const binding = channelBindings[channel]
                  const currentValue = binding ? `${binding.providerId}::${binding.modelId}` : ''
                  const hasBinding = !!binding

                  return (
                    <div key={channel} className="bg-stone-50/50 border border-stone-100 rounded-xl p-3 hover:bg-white hover:border-stone-200 transition-all">
                      <div className="flex items-center gap-2 mb-2">
                        <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
                          {icon}
                        </div>
                        <span className="text-xs font-medium text-stone-700">{label}</span>
                        <span className="text-[10px] text-stone-400 ml-auto bg-stone-100 px-1.5 py-0.5 rounded">{tag}</span>
                      </div>
                      <select value={currentValue}
                        onChange={e => {
                          if (!e.target.value) onSetBinding(channel, null)
                          else {
                            const [providerId, modelId] = e.target.value.split('::')
                            onSetBinding(channel, { providerId, modelId })
                          }
                        }}
                        className={`w-full appearance-none bg-white border border-stone-150 text-xs rounded-lg pl-2.5 pr-6 py-2 outline-none focus:ring-2 focus:ring-teal-500/20 focus:border-teal-300 cursor-pointer transition-all ${
                          hasBinding ? 'text-stone-700' : 'text-stone-400'
                        }`}>
                        <option value="">未配置</option>
                        {modelOptions.map(opt => (
                          <option key={`${opt.providerId}::${opt.modelId}`} value={`${opt.providerId}::${opt.modelId}`}>
                            {opt.providerLabel} / {opt.modelId}
                          </option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>

              {/* 确认写入按钮 */}
              <div className="flex justify-end mt-2.5 pb-1">
                <button
                  onClick={handleForceWrite}
                  disabled={saveStatus === 'saving'}
                  className={`flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-lg border transition-all ${
                    saveStatus === 'success'
                      ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                      : saveStatus === 'error'
                      ? 'bg-red-50 text-red-600 border-red-200'
                      : saveStatus === 'saving'
                      ? 'bg-stone-50 text-stone-400 border-stone-150 cursor-wait'
                      : 'bg-stone-50 text-stone-500 border-stone-150 hover:bg-teal-50 hover:text-teal-600 hover:border-teal-200'
                  }`}
                >
                  {saveStatus === 'saving' && <RefreshCw className="w-3 h-3 animate-spin" />}
                  {saveStatus === 'success' && <Check className="w-3 h-3" />}
                  {saveStatus === 'idle' && <Save className="w-3 h-3" />}
                  {saveStatus === 'error' && <X className="w-3 h-3" />}
                  {saveStatus === 'saving' ? '写入中...' :
                   saveStatus === 'success' ? '已写入' :
                   saveStatus === 'error' ? '写入失败' :
                   '确认写入'}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

// ============================================
// Sheet 2: MCP 服务
// ============================================

function MCPServiceSheet() {
  const mcpServers = useStore(s => s.linkStation.mcpServers)
  const mcpStatus = useStore(s => s.linkStation.mcpStatus)
  const mcpTools = useStore(s => s.linkStation.mcpTools)
  const toggleMCPServer = useStore(s => s.toggleMCPServer)
  const removeMCPServer = useStore(s => s.removeMCPServer)
  const addMCPServer = useStore(s => s.addMCPServer)

  const [viewMode, setViewMode] = useState<'web' | 'list'>('web')
  const [selectedServer, setSelectedServer] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  const connectedCount = mcpServers.filter(s => mcpStatus[s.name] === 'connected').length
  const totalToolCount = mcpTools.length

  if (viewMode === 'list') {
    return (
      <MCPListView
        servers={mcpServers} status={mcpStatus} tools={mcpTools}
        onToggle={toggleMCPServer} onRemove={removeMCPServer}
        onSwitchView={() => setViewMode('web')}
        onAdd={() => setShowAddForm(true)}
        showAddForm={showAddForm} onAddServer={addMCPServer}
        onCancelAdd={() => setShowAddForm(false)}
      />
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* 悬浮工具栏 */}
      <div className="absolute top-3 left-4 z-30 flex items-center gap-2 mcp-nav">
        <button onClick={() => setShowAddForm(true)}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-stone-500 hover:text-teal-600 bg-white/80 backdrop-blur-md hover:bg-teal-50/80 rounded-full transition-all shadow-sm border border-stone-200/60">
          <Plus className="w-3.5 h-3.5" /> 添加节点
        </button>
        <button onClick={() => setViewMode('list')}
          className="flex items-center gap-1.5 px-4 py-1.5 text-xs text-stone-400 hover:text-stone-600 bg-white/80 backdrop-blur-md hover:bg-stone-100/80 rounded-full transition-all shadow-sm border border-stone-200/60">
          <LayoutList className="w-3.5 h-3.5" /> 列表
        </button>
      </div>

      {/* 全幅无限画布 */}
      <MCPWebView servers={mcpServers} status={mcpStatus} tools={mcpTools}
        selectedServer={selectedServer} onSelectServer={setSelectedServer}
        connectedCount={connectedCount} totalToolCount={totalToolCount} />

      {/* 悬浮属性面板 */}
      <AnimatePresence>
        {selectedServer && (
          <MCPServerDetailPanel
            server={mcpServers.find(s => s.name === selectedServer)!}
            status={mcpStatus[selectedServer] || 'disconnected'}
            tools={mcpTools.filter(t => t.serverName === selectedServer)}
            onClose={() => setSelectedServer(null)}
            onToggle={(enabled) => toggleMCPServer(selectedServer, enabled)}
            onRemove={() => { removeMCPServer(selectedServer); setSelectedServer(null) }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddForm && (
          <MCPAddForm
            onAdd={(server) => { addMCPServer(server); setShowAddForm(false) }}
            onCancel={() => setShowAddForm(false)}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// MCP 星轨画布视图 (Premium Orbital Park)
// ============================================

function MCPWebView({ servers, status, tools, selectedServer, onSelectServer, connectedCount, totalToolCount }: {
  servers: MCPServerEntry[]
  status: Record<string, MCPServerStatus>
  tools: MCPToolEntry[]
  selectedServer: string | null
  onSelectServer: (name: string | null) => void
  connectedCount: number
  totalToolCount: number
}) {
  // === 画布拖拽与缩放引擎 ===
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [scale, setScale] = useState(0.85)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0 })

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.mcp-node') || (e.target as HTMLElement).closest('.mcp-nav')) return
    setIsDragging(true)
    dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y }
  }
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return
    setPan({ x: e.clientX - dragStartRef.current.x, y: e.clientY - dragStartRef.current.y })
  }
  const handleMouseUp = () => setIsDragging(false)
  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY > 0 ? -0.05 : 0.05
    setScale(s => Math.max(0.3, Math.min(1.5, s + delta)))
  }

  // === 双圈同心圆布局算法 ===
  const ORBIT_1_RADIUS = 320
  const ORBIT_2_RADIUS = 560

  const nodePositions = useMemo(() => {
    if (servers.length === 0) return []
    // <=6 全放内圈, >6 按 45% 分内圈
    const orbit1Count = servers.length <= 6 ? servers.length : Math.ceil(servers.length * 0.45)
    const orbit2Count = servers.length - orbit1Count

    return servers.map((server, index) => {
      const isOrbit1 = index < orbit1Count
      const orbitIndex = isOrbit1 ? index : index - orbit1Count
      const orbitTotal = isOrbit1 ? orbit1Count : Math.max(orbit2Count, 1)
      const radius = isOrbit1 ? ORBIT_1_RADIUS : ORBIT_2_RADIUS
      // 外圈 phaseOffset 错开内圈节点
      const phaseOffset = isOrbit1 ? 0 : (Math.PI / Math.max(orbitTotal, 1))
      const angle = (orbitIndex / orbitTotal) * 2 * Math.PI - Math.PI / 2 + phaseOffset

      const x = radius * Math.cos(angle)
      const y = radius * Math.sin(angle)
      const isConnected = (status[server.name] || 'disconnected') === 'connected'
      const isError = (status[server.name] || 'disconnected') === 'error'
      const isSelected = selectedServer === server.name
      const toolCount = tools.filter(t => t.serverName === server.name).length

      return { server, x, y, isConnected, isError, isSelected, toolCount, orbit: isOrbit1 ? 1 : 2, index }
    })
  }, [servers, status, tools, selectedServer])

  // === 空状态 ===
  if (servers.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="w-20 h-20 mx-auto relative flex items-center justify-center">
            <div className="absolute inset-0 rounded-full border-[3px] border-dashed border-slate-200/60 animate-[spin_20s_linear_infinite]" />
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-slate-50 to-slate-100 flex items-center justify-center">
              <Globe className="w-7 h-7 text-slate-300" />
            </div>
          </div>
          <p className="text-sm text-slate-500 font-medium">暂无 MCP 连接节点</p>
          <p className="text-xs text-slate-400">点击"添加节点"开始构建连接网络</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`absolute inset-0 overflow-hidden ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
    >
      {/* 点阵背景 */}
      <div
        className="absolute inset-0 opacity-[0.22]"
        style={{
          backgroundImage: 'radial-gradient(#64748B 1px, transparent 1px)',
          backgroundSize: `${32 * scale}px ${32 * scale}px`,
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      />

      {/* 画布核心变换层 */}
      <div
        className="absolute top-1/2 left-1/2"
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transition: isDragging ? 'none' : 'transform 0.08s ease-out',
        }}
      >
        {/* === SVG 蛛网连线层 === */}
        <svg className="absolute overflow-visible pointer-events-none" style={{ width: 0, height: 0, left: 0, top: 0 }}>
          <defs>
            <linearGradient id="mcpActiveLine" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#14B8A6" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.15" />
            </linearGradient>
            <filter id="mcpGlow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>
          {nodePositions.map(node => (
            <g key={`conn-${node.server.name}`}>
              {/* 常规态：极细浅灰虚线 */}
              {!node.isSelected && (
                <line
                  x1={0} y1={0} x2={node.x} y2={node.y}
                  stroke={node.isConnected || node.isError ? '#CBD5E1' : '#E2E8F0'}
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                  opacity={0.7}
                />
              )}
              {/* 选中态：青色渐变高亮实线 + 发光 */}
              {node.isSelected && (
                <line
                  x1={0} y1={0} x2={node.x} y2={node.y}
                  stroke="url(#mcpActiveLine)"
                  strokeWidth={2.5}
                  filter="url(#mcpGlow)"
                  opacity={0.9}
                />
              )}
              {/* 数据流光点：沿连线向中心流动 */}
              {(node.isConnected || node.isSelected) && (
                <circle r="3" fill="#14B8A6" opacity="0.8">
                  <animateMotion
                    path={`M ${node.x} ${node.y} L 0 0`}
                    dur={`${2 + node.index * 0.3}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          ))}
        </svg>

        {/* === 中心主脑 DunCrew Core === */}
        <div className="absolute mcp-node" style={{ left: 0, top: 0, transform: 'translate(-50%, -50%)', zIndex: 10 }}>
          <div className="relative group cursor-default">
            {/* 深蓝/紫色外发光 */}
            <div className="absolute -inset-16 bg-indigo-500/10 rounded-full blur-2xl" />
            <div className="w-[170px] h-[170px] relative flex items-center justify-center">
              {/* 缓慢自转虚线外圈 */}
              <div className="absolute inset-0 rounded-full border-[2px] border-dashed border-indigo-400/40 animate-[spin_20s_linear_infinite]" />
              {/* 深色渐变静止玻璃球 */}
              <div className="absolute inset-3 rounded-full bg-gradient-to-b from-[#1E293B] to-[#0F172A] flex flex-col items-center justify-center shadow-xl text-white">
                <span className="text-[18px] font-black tracking-widest leading-tight">DunCrew</span>
                <span className="text-[14px] font-bold tracking-widest leading-tight opacity-80">CORE</span>
                <div className="mt-2 px-3 py-1 bg-white/10 rounded-full border border-white/20">
                  <span className="text-[10px] opacity-80 uppercase tracking-widest">Main Agent</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* === 周边节点 === */}
        {nodePositions.map((node, idx) => {
          const spinDuration = 25 + idx * 5
          const isReverse = idx % 2 === 1

          return (
            <div
              key={node.server.name}
              className="absolute mcp-node"
              style={{ left: node.x, top: node.y, transform: 'translate(-50%, -50%)', zIndex: 10 }}
            >
              <div
                className={`relative group cursor-pointer transition-all duration-500 ${
                  node.isSelected ? 'scale-105' : 'hover:-translate-y-1'
                }`}
                onClick={() => onSelectServer(node.isSelected ? null : node.server.name)}
              >
                {/* 悬浮发光 */}
                <div className={`absolute -inset-8 rounded-full blur-2xl transition-all duration-500 ${
                  node.isSelected
                    ? 'bg-teal-400/20'
                    : node.isConnected
                      ? 'bg-emerald-400/10 group-hover:bg-emerald-400/20'
                      : 'bg-slate-300/0 group-hover:bg-slate-300/10'
                }`} />

                {/* 气泡容器（正圆形） */}
                <div className="w-[110px] h-[110px] relative flex items-center justify-center">
                  {/* 旋转虚线外圈 */}
                  <div
                    className={`absolute inset-0 rounded-full border-[2px] border-dashed transition-colors duration-300 ${
                      node.isSelected
                        ? 'border-teal-400'
                        : node.isConnected
                          ? 'border-emerald-400/70 group-hover:border-emerald-500'
                          : node.isError
                            ? 'border-red-300/70 group-hover:border-red-400'
                            : 'border-slate-300/70 group-hover:border-slate-400'
                    }`}
                    style={{ animation: `spin ${spinDuration}s linear infinite ${isReverse ? 'reverse' : ''}` }}
                  />
                  {/* 静止纯白内圈 */}
                  <div className={`absolute inset-[5px] rounded-full bg-white flex flex-col items-center justify-center text-center shadow-sm border ${
                    node.isSelected
                      ? 'border-teal-200 ring-2 ring-teal-400/30 ring-offset-1'
                      : node.isConnected
                        ? 'border-emerald-100'
                        : 'border-stone-100/80'
                  }`}>
                    <Globe className={`w-5 h-5 mb-1 ${
                      node.isConnected ? 'text-emerald-500' : node.isError ? 'text-red-400' : 'text-slate-400'
                    }`} />
                    <span className="text-[13px] font-bold text-slate-700 leading-tight truncate max-w-[80px] px-1.5">
                      {node.server.name}
                    </span>
                  </div>
                </div>

                {/* 选中态：底部悬浮绿色 Ready 胶囊 + 工具数 */}
                {node.isSelected && (
                  <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2 whitespace-nowrap">
                    {node.isConnected && (
                      <div className="flex items-center bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full shadow-sm">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 animate-pulse shadow-[0_0_4px_rgba(16,185,129,0.6)]" />
                        <span className="text-[10px] font-bold text-emerald-600 uppercase tracking-wider">Ready</span>
                      </div>
                    )}
                    {node.isError && (
                      <div className="flex items-center bg-red-50 border border-red-200 px-2.5 py-1 rounded-full shadow-sm">
                        <span className="w-2 h-2 rounded-full bg-red-400 mr-1.5" />
                        <span className="text-[10px] font-bold text-red-500 uppercase tracking-wider">Error</span>
                      </div>
                    )}
                    {!node.isConnected && !node.isError && (
                      <div className="flex items-center bg-slate-50 border border-slate-200 px-2.5 py-1 rounded-full shadow-sm">
                        <span className="w-2 h-2 rounded-full bg-slate-300 mr-1.5" />
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Offline</span>
                      </div>
                    )}
                    {node.toolCount > 0 && (
                      <div className="bg-slate-100 px-2.5 py-1 rounded-full">
                        <span className="text-[10px] font-bold text-slate-500">{node.toolCount} Tools</span>
                      </div>
                    )}
                  </div>
                )}

                {/* 未选中时的状态小圆点 */}
                {!node.isSelected && (
                  <div className="absolute -bottom-5 left-1/2 -translate-x-1/2">
                    {node.isConnected ? (
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 block shadow-[0_0_6px_rgba(16,185,129,0.6)]" />
                    ) : node.isError ? (
                      <span className="w-2.5 h-2.5 rounded-full bg-red-400 block" />
                    ) : (
                      <span className="w-2.5 h-2.5 rounded-full bg-slate-300 block" />
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 底部悬浮状态栏 */}
      <div className="absolute bottom-4 left-4 z-20">
        <div className="flex bg-white/90 backdrop-blur-md rounded-full shadow-lg border border-stone-100 px-5 py-2.5 items-center gap-3">
          <span className={`text-sm font-bold ${connectedCount > 0 ? 'text-emerald-500' : 'text-stone-400'}`}>
            {connectedCount > 0 && <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-1.5 animate-pulse" />}
            已连接 {connectedCount}/{servers.length}
          </span>
          <span className="w-px h-4 bg-stone-200" />
          <span className="text-sm font-medium text-stone-400">工具 {totalToolCount}</span>
        </div>
      </div>
    </div>
  )
}

// ============================================
// MCP 服务器详情面板 (Premium Inspector)
// ============================================

function MCPServerDetailPanel({ server, status, tools, onClose, onToggle, onRemove }: {
  server: MCPServerEntry; status: MCPServerStatus; tools: MCPToolEntry[]
  onClose: () => void; onToggle: (enabled: boolean) => void; onRemove: () => void
}) {
  const updateMCPServer = useStore(s => s.updateMCPServer)
  const isConnected = status === 'connected'
  const isError = status === 'error'

  const [drawerTab, setDrawerTab] = useState<'tools' | 'config'>('tools')

  // 配置编辑状态
  const currentTransport = server.transportType || 'stdio'
  const [editTransport, setEditTransport] = useState<MCPTransportType>(currentTransport)
  const [editCommand, setEditCommand] = useState(server.command || '')
  const [editArgs, setEditArgs] = useState<string[]>(server.args || [])
  const [editArgInput, setEditArgInput] = useState('')
  const [editUrl, setEditUrl] = useState(server.url || '')
  const [editEnvPairs, setEditEnvPairs] = useState<Array<{ key: string; value: string }>>(
    server.env ? Object.entries(server.env).map(([key, value]) => ({ key, value })) : []
  )
  const [configDirty, setConfigDirty] = useState(false)

  // 标记脏状态
  const markDirty = () => { if (!configDirty) setConfigDirty(true) }

  // 保存配置
  const handleSaveConfig = () => {
    const envRecord: Record<string, string> = {}
    for (const pair of editEnvPairs) {
      if (pair.key.trim()) envRecord[pair.key.trim()] = pair.value
    }
    updateMCPServer(server.name, {
      transportType: editTransport,
      command: editTransport === 'stdio' ? editCommand.trim() : server.command,
      args: editTransport === 'stdio' ? editArgs : server.args,
      url: editTransport === 'sse' ? editUrl.trim() : server.url,
      env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
    })
    setConfigDirty(false)
  }

  // Args Tag 操作
  const handleAddArg = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && editArgInput.trim()) {
      setEditArgs(prev => [...prev, editArgInput.trim()])
      setEditArgInput('')
      markDirty()
    }
  }
  const handleRemoveArg = (index: number) => {
    setEditArgs(prev => prev.filter((_, i) => i !== index))
    markDirty()
  }

  // Env 操作
  const handleAddEnv = () => {
    setEditEnvPairs(prev => [...prev, { key: '', value: '' }])
    markDirty()
  }
  const handleRemoveEnv = (index: number) => {
    setEditEnvPairs(prev => prev.filter((_, i) => i !== index))
    markDirty()
  }
  const handleUpdateEnv = (index: number, field: 'key' | 'value', val: string) => {
    setEditEnvPairs(prev => prev.map((pair, i) => i === index ? { ...pair, [field]: val } : pair))
    markDirty()
  }

  // 构建包名显示
  const packageIdentifier = currentTransport === 'sse'
    ? server.url || 'SSE Server'
    : `${server.command} ${server.args.join(' ')}`

  return (
    <motion.div
      initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }}
      transition={{ type: 'spring', damping: 28, stiffness: 280 }}
      className="absolute right-6 top-6 bottom-6 w-[400px] z-30 mcp-panel"
    >
      <div className="h-full bg-white/95 backdrop-blur-3xl border border-white/60 rounded-[24px] shadow-[0_10px_50px_rgba(0,0,0,0.06)] flex flex-col overflow-hidden">

        {/* 头部 - 图标与标题水平排列 */}
        <div className="px-6 pt-5 pb-4 bg-gradient-to-b from-teal-50/30 to-transparent">
          <div className="flex items-start gap-3.5">
            {/* 圆形渐变图标 */}
            <div className="w-11 h-11 rounded-full bg-gradient-to-br from-teal-400 to-cyan-500 text-white flex items-center justify-center shadow-md shadow-teal-500/20 border border-white flex-shrink-0 mt-0.5">
              <Globe className="w-5 h-5" />
            </div>
            {/* 标题 + 状态 + 描述 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-black text-stone-800 tracking-tight truncate">{server.name}</h2>
                {/* 状态胶囊 */}
                {isConnected ? (
                  <div className="flex items-center px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-100 flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 shadow-[0_0_6px_rgba(16,185,129,0.7)] animate-pulse" />
                    <span className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider">Connected</span>
                  </div>
                ) : isError ? (
                  <div className="flex items-center px-2 py-0.5 rounded-full bg-red-50 border border-red-100 flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 mr-1" />
                    <span className="text-[9px] font-bold text-red-500 uppercase tracking-wider">Error</span>
                  </div>
                ) : (
                  <div className="flex items-center px-2 py-0.5 rounded-full bg-stone-50 border border-stone-200 flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-stone-300 mr-1" />
                    <span className="text-[9px] font-bold text-stone-400 uppercase tracking-wider">Offline</span>
                  </div>
                )}
              </div>
              <p className="text-[11px] text-stone-400 tracking-tight truncate mt-1">
                {packageIdentifier}
              </p>
            </div>
            {/* iOS 风格开关 + 关闭 */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => onToggle(!server.enabled)}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-300 focus:outline-none ${
                  server.enabled ? 'bg-teal-400' : 'bg-stone-200'
                }`}
              >
                <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition duration-300 ${
                  server.enabled ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
              <button onClick={onClose} className="p-1.5 text-stone-300 hover:text-stone-500 transition-colors rounded-full hover:bg-stone-100">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* 气泡 Tab 切换栏 */}
        <div className="px-6 pb-3">
          <div className="flex bg-stone-50 rounded-xl p-1.5 border border-stone-100/50">
            <button
              onClick={() => setDrawerTab('tools')}
              className={`flex-1 flex items-center justify-center py-2 text-xs font-bold rounded-lg transition-all duration-300 ${
                drawerTab === 'tools'
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-stone-400 hover:text-stone-600'
              }`}
            >
              <Zap className="w-3.5 h-3.5 mr-1.5" />
              可用工具
              {tools.length > 0 && (
                <span className={`ml-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold ${
                  drawerTab === 'tools' ? 'bg-teal-50 text-teal-600' : 'bg-stone-200/80 text-stone-400'
                }`}>{tools.length}</span>
              )}
            </button>
            <button
              onClick={() => setDrawerTab('config')}
              className={`flex-1 flex items-center justify-center py-2 text-xs font-bold rounded-lg transition-all duration-300 ${
                drawerTab === 'config'
                  ? 'bg-white text-teal-700 shadow-sm'
                  : 'text-stone-400 hover:text-stone-600'
              }`}
            >
              <Unplug className="w-3.5 h-3.5 mr-1.5" />
              连接配置
              {configDirty && <span className="ml-1 w-1.5 h-1.5 rounded-full bg-amber-400" />}
            </button>
          </div>
        </div>

        {/* ── 可用工具 Tab ── */}
        {drawerTab === 'tools' && (
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {tools.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center py-12">
                <div className="w-14 h-14 relative flex items-center justify-center mb-3">
                  <div className="absolute inset-0 rounded-full border-[2px] border-dashed border-stone-200/60 animate-[spin_20s_linear_infinite]" />
                  <div className="absolute inset-1.5 rounded-full bg-stone-50 flex items-center justify-center">
                    <Zap className="w-5 h-5 text-stone-300" />
                  </div>
                </div>
                <p className="text-sm text-stone-400 font-medium">
                  {isConnected ? '该服务器未提供工具' : '连接后可查看可用工具'}
                </p>
              </div>
            ) : (
              <div className="space-y-3 pb-4">
                {tools.map(tool => (
                  <div key={tool.name} className="bg-white rounded-xl p-4 shadow-sm border border-stone-100 hover:border-teal-200 hover:shadow-md transition-all group cursor-default">
                    <div className="flex items-center mb-2">
                      {/* 工具名称：胶囊气泡 */}
                      <div className="bg-teal-50 text-teal-600 px-3 py-1.5 rounded-full text-xs font-extrabold flex items-center">
                        <Wrench className="w-3.5 h-3.5 mr-1.5" />
                        {tool.name}
                      </div>
                    </div>
                    {tool.description && (
                      <p className="text-[12px] text-stone-400 leading-relaxed pl-1 mt-1 line-clamp-3">
                        {tool.description}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── 连接配置 Tab ── */}
        {drawerTab === 'config' && (
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {/* 传输协议卡片 */}
            <div className="bg-white rounded-xl p-5 shadow-sm border border-stone-100">
              <div className="flex items-center justify-between mb-4">
                <label className="text-sm font-bold text-stone-700">传输协议</label>
                <div className="flex bg-stone-50 p-1 rounded-lg border border-stone-100">
                  <button
                    onClick={() => { setEditTransport('stdio'); markDirty() }}
                    className={`px-4 py-1 text-xs font-bold rounded-lg transition-all ${
                      editTransport === 'stdio' ? 'bg-white text-stone-800 shadow-sm' : 'text-stone-400 hover:text-stone-600'
                    }`}
                  >Stdio</button>
                  <button
                    onClick={() => { setEditTransport('sse'); markDirty() }}
                    className={`px-4 py-1 text-xs font-bold rounded-lg transition-all ${
                      editTransport === 'sse' ? 'bg-white text-stone-800 shadow-sm' : 'text-stone-400 hover:text-stone-600'
                    }`}
                  >SSE</button>
                </div>
              </div>

              <div className="space-y-4">
                {editTransport === 'stdio' ? (
                  <>
                    <div>
                      <label className="block text-xs font-bold text-stone-400 mb-1.5 ml-1">启动命令</label>
                      <input
                        type="text" value={editCommand}
                        onChange={e => { setEditCommand(e.target.value); markDirty() }}
                        placeholder="npx"
                        className="w-full bg-stone-50 focus:bg-white focus:border-teal-300 focus:ring-4 focus:ring-teal-500/10 border border-transparent text-sm rounded-xl px-4 py-2.5 text-stone-700 transition-all outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-stone-400 mb-1.5 ml-1">参数列表</label>
                      <div className="w-full bg-stone-50 border border-transparent focus-within:bg-white focus-within:border-teal-300 focus-within:ring-4 focus-within:ring-teal-500/10 rounded-xl p-2.5 transition-all">
                        {editArgs.length > 0 && (
                          <div className="flex flex-wrap gap-2 mb-2">
                            {editArgs.map((arg, index) => (
                              <span key={index} className="bg-white border border-stone-200 text-stone-600 text-xs px-3 py-1.5 rounded-full flex items-center shadow-sm">
                                {arg}
                                <button onClick={() => handleRemoveArg(index)} className="ml-1.5 text-stone-300 hover:text-stone-500">
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                        <input
                          type="text" value={editArgInput}
                          onChange={e => setEditArgInput(e.target.value)}
                          onKeyDown={handleAddArg}
                          placeholder="输入参数后回车添加..."
                          className="w-full bg-transparent text-xs px-2 py-1 text-stone-500 placeholder-stone-300 outline-none"
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div>
                    <label className="block text-xs font-bold text-stone-400 mb-1.5 ml-1">连接地址 (URL)</label>
                    <input
                      type="text" value={editUrl}
                      onChange={e => { setEditUrl(e.target.value); markDirty() }}
                      placeholder="http://localhost:3000/sse"
                      className="w-full bg-stone-50 focus:bg-white focus:border-teal-300 focus:ring-4 focus:ring-teal-500/10 border border-transparent text-sm rounded-xl px-4 py-2.5 text-stone-700 transition-all outline-none"
                    />
                    <div className="mt-3 bg-sky-50/50 rounded-xl p-4 flex items-start border border-sky-100">
                      <RefreshCw className="w-3.5 h-3.5 text-sky-500 mr-2 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-sky-700 leading-relaxed font-medium">
                        若标准 SSE 连接失败，系统将自动降级至 <span className="font-bold">Streamable HTTP</span> 模式。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* 环境变量卡片 */}
            <div className="bg-white rounded-xl p-5 shadow-sm border border-stone-100">
              <label className="text-sm font-bold text-stone-700 block mb-4">环境变量</label>
              <div className="space-y-3">
                {editEnvPairs.map((env, index) => (
                  <div key={index} className="flex items-center gap-2 group">
                    <input
                      type="text" value={env.key}
                      onChange={e => handleUpdateEnv(index, 'key', e.target.value)}
                      placeholder="KEY"
                      className="w-5/12 bg-stone-50 border border-transparent focus:bg-white focus:border-teal-300 text-xs rounded-xl px-4 py-2.5 text-stone-600 outline-none transition-colors"
                    />
                    <span className="text-stone-300 text-sm font-bold">=</span>
                    <input
                      type="password" value={env.value}
                      onChange={e => handleUpdateEnv(index, 'value', e.target.value)}
                      placeholder="VALUE"
                      className="flex-1 bg-stone-50 border border-transparent focus:bg-white focus:border-teal-300 text-xs rounded-xl px-4 py-2.5 text-stone-600 outline-none transition-colors"
                    />
                    <button
                      onClick={() => handleRemoveEnv(index)}
                      className="p-2 text-stone-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                <button
                  onClick={handleAddEnv}
                  className="w-full py-3 border border-dashed border-stone-200 hover:border-teal-300 hover:bg-teal-50 text-stone-400 hover:text-teal-600 text-xs font-bold rounded-xl flex items-center justify-center transition-all mt-2"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> 添加变量
                </button>
              </div>
            </div>

            {/* 保存 & 删除 */}
            <div className="flex gap-2 pt-1">
              {configDirty && (
                <button
                  onClick={handleSaveConfig}
                  className="flex-1 px-4 py-2.5 text-xs font-bold bg-teal-500 text-white rounded-xl hover:bg-teal-600 transition-colors shadow-sm"
                >
                  保存配置
                </button>
              )}
              <button
                onClick={onRemove}
                className="px-4 py-2.5 text-xs text-stone-400 hover:text-red-500 rounded-xl hover:bg-red-50 transition-colors border border-stone-200/60"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}

// ============================================
// MCP 列表视图
// ============================================

function MCPListView({ servers, status, tools, onToggle, onRemove, onSwitchView, onAdd, showAddForm, onAddServer, onCancelAdd }: {
  servers: MCPServerEntry[]; status: Record<string, MCPServerStatus>; tools: MCPToolEntry[]
  onToggle: (name: string, enabled: boolean) => void; onRemove: (name: string) => void
  onSwitchView: () => void; onAdd: () => void; showAddForm: boolean
  onAddServer: (server: MCPServerEntry) => void; onCancelAdd: () => void
}) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 border-b border-stone-100">
        <span className="text-sm text-stone-500">MCP 服务器列表</span>
        <div className="flex items-center gap-2">
          <button onClick={onAdd} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-500 hover:text-teal-600 hover:bg-teal-50 rounded-lg transition-colors">
            <Plus className="w-3.5 h-3.5" /> 添加
          </button>
          <button onClick={onSwitchView} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-stone-400 hover:text-stone-600 hover:bg-stone-100 rounded-lg transition-colors">
            <Globe className="w-3.5 h-3.5" /> 蛛网
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {servers.map(server => {
          const isConnected = (status[server.name] || 'disconnected') === 'connected'
          const serverTools = tools.filter(t => t.serverName === server.name)
          return (
            <div key={server.name} className="px-4 py-3 bg-white rounded-xl border border-stone-100 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-stone-700">{server.name}</span>
                <span className={`text-xs ${isConnected ? 'text-emerald-500' : 'text-stone-400'}`}>
                  {isConnected ? '🟢 已连接' : '⚪ 未连接'}
                </span>
              </div>
              <p className="text-xs text-stone-400 font-mono truncate">{server.command} {server.args.join(' ')}</p>
              {isConnected && serverTools.length > 0 && (
                <p className="text-xs text-stone-400">工具 ({serverTools.length}): {serverTools.map(t => t.name).join(', ')}</p>
              )}
              <div className="flex gap-2 pt-1">
                <button onClick={() => onToggle(server.name, !server.enabled)}
                  className="px-2.5 py-1 text-xs text-stone-400 hover:text-teal-600 rounded-lg hover:bg-teal-50 transition-colors">
                  {server.enabled ? '禁用' : '启用'}
                </button>
                <button onClick={() => onRemove(server.name)}
                  className="px-2.5 py-1 text-xs text-stone-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors">
                  删除
                </button>
              </div>
            </div>
          )
        })}
        {servers.length === 0 && <div className="text-center text-stone-400 text-sm py-12">暂无 MCP 服务器</div>}
      </div>

      <AnimatePresence>
        {showAddForm && <MCPAddForm onAdd={onAddServer} onCancel={onCancelAdd} />}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// MCP 添加表单
// ============================================

function MCPAddForm({ onAdd, onCancel }: {
  onAdd: (server: MCPServerEntry) => void; onCancel: () => void
}) {
  // ── 输入模式切换 ──
  const [inputMode, setInputMode] = useState<'form' | 'json'>('form')

  // ── 表单字段 ──
  const [transportType, setTransportType] = useState<MCPTransportType>('stdio')
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [sseUrl, setSseUrl] = useState('')
  const [timeout, setTimeout] = useState('60')
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([])

  // ── JSON 导入 ──
  const [jsonInput, setJsonInput] = useState('')
  const [jsonError, setJsonError] = useState('')

  // ── 环境变量操作 ──
  const addEnvPair = () => setEnvPairs(prev => [...prev, { key: '', value: '' }])
  const removeEnvPair = (index: number) => setEnvPairs(prev => prev.filter((_, i) => i !== index))
  const updateEnvPair = (index: number, field: 'key' | 'value', val: string) => {
    setEnvPairs(prev => prev.map((pair, i) => i === index ? { ...pair, [field]: val } : pair))
  }

  // ── 表单校验 ──
  const isFormValid = (() => {
    if (!name.trim()) return false
    if (transportType === 'stdio' && !command.trim()) return false
    if (transportType === 'sse' && !sseUrl.trim()) return false
    return true
  })()

  // ── 表单提交 ──
  const handleFormSubmit = () => {
    if (!isFormValid) return
    const envRecord: Record<string, string> = {}
    for (const pair of envPairs) {
      if (pair.key.trim()) envRecord[pair.key.trim()] = pair.value
    }
    const timeoutNum = parseInt(timeout) || 60

    const server: MCPServerEntry = {
      name: name.trim(),
      command: transportType === 'stdio' ? command.trim() : '',
      args: transportType === 'stdio' && args.trim() ? args.split(/\s+/).filter(Boolean) : [],
      env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
      enabled: true,
      transportType,
      url: transportType === 'sse' ? sseUrl.trim() : undefined,
      timeout: timeoutNum !== 60 ? timeoutNum : undefined,
    }
    onAdd(server)
  }

  // ── JSON 导入提交 ──
  const handleJsonImport = () => {
    try {
      const parsed = JSON.parse(jsonInput)
      // 支持两种格式：
      // 1. { "mcpServers": { "name": { command, args, env } } }
      // 2. { "servers": { "name": { command, args, env } } }
      // 3. 直接 { "name": { command, args, env } }
      const serversMap = parsed.mcpServers || parsed.servers || parsed
      const entries = Object.entries(serversMap)

      if (entries.length === 0) {
        setJsonError('未找到有效的服务器配置')
        return
      }

      let importedCount = 0
      for (const [serverName, config] of entries) {
        const serverConfig = config as Record<string, unknown>
        if (!serverConfig || typeof serverConfig !== 'object') continue

        const serverCommand = (serverConfig.command as string) || ''
        const serverArgs = (serverConfig.args as string[]) || []
        const serverEnv = (serverConfig.env as Record<string, string>) || undefined
        const serverUrl = (serverConfig.url as string) || undefined
        const serverTimeout = (serverConfig.timeout as number) || undefined
        const isSSE = !serverCommand && !!serverUrl

        const server: MCPServerEntry = {
          name: serverName,
          command: serverCommand,
          args: serverArgs,
          env: serverEnv && Object.keys(serverEnv).length > 0 ? serverEnv : undefined,
          enabled: serverConfig.enabled !== false,
          transportType: isSSE ? 'sse' : 'stdio',
          url: serverUrl,
          timeout: serverTimeout,
        }
        onAdd(server)
        importedCount++
      }

      if (importedCount === 0) {
        setJsonError('未找到有效的服务器配置')
      }
    } catch {
      setJsonError('JSON 格式错误，请检查输入')
    }
  }

  // ── 输入框样式 ──
  const inputClassName = "w-full px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-sm text-stone-700 font-mono placeholder:text-stone-300 focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400/20 transition-all"
  const labelClassName = "block text-xs font-medium text-stone-500 mb-1.5"

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
      className="absolute inset-0 bg-white/80 backdrop-blur-sm flex items-center justify-center z-20"
    >
      <GlassCard className="w-[480px] max-h-[85vh] flex flex-col p-0 overflow-hidden">
        {/* ── 标题栏 ── */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h4 className="text-sm font-bold text-stone-800">添加 MCP 服务器</h4>
          <button onClick={onCancel} className="text-stone-400 hover:text-stone-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── 输入模式切换 ── */}
        <div className="flex items-center gap-1 mx-6 mb-4 bg-stone-100/60 p-1 rounded-xl">
          <button
            onClick={() => { setInputMode('form'); setJsonError('') }}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              inputMode === 'form' ? 'bg-white text-teal-600 shadow-sm' : 'text-stone-400 hover:text-stone-600'
            }`}
          >
            表单配置
          </button>
          <button
            onClick={() => { setInputMode('json'); setJsonError('') }}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
              inputMode === 'json' ? 'bg-white text-teal-600 shadow-sm' : 'text-stone-400 hover:text-stone-600'
            }`}
          >
            JSON 导入
          </button>
        </div>

        {/* ── 滚动内容区 ── */}
        <div className="flex-1 overflow-y-auto px-6 pb-2 space-y-4">
          {inputMode === 'form' ? (
            <>
              {/* 传输类型选择 */}
              <div>
                <label className={labelClassName}>
                  传输类型 <span className="text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  {(['stdio', 'sse'] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => setTransportType(type)}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-medium transition-all ${
                        transportType === type
                          ? 'bg-teal-50 border-teal-300 text-teal-700 shadow-sm'
                          : 'bg-white border-stone-200 text-stone-400 hover:border-stone-300 hover:text-stone-600'
                      }`}
                    >
                      {type === 'stdio' ? (
                        <><Database className="w-3.5 h-3.5" /> STDIO</>
                      ) : (
                        <><Globe className="w-3.5 h-3.5" /> SSE</>
                      )}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-stone-400 mt-1.5">
                  {transportType === 'stdio'
                    ? 'STDIO: 通过标准输入/输出与本地进程通信，适用于 npx、uvx 等命令行工具'
                    : 'SSE: 通过 HTTP Server-Sent Events 连接远程服务器'}
                </p>
              </div>

              {/* 服务器名称 */}
              <div>
                <label className={labelClassName}>
                  服务器名称 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="如: filesystem、github、my-custom-server"
                  className={inputClassName.replace('font-mono', '')}
                />
              </div>

              {/* STDIO 模式字段 */}
              {transportType === 'stdio' && (
                <>
                  <div>
                    <label className={labelClassName}>
                      命令 <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={command}
                      onChange={e => setCommand(e.target.value)}
                      placeholder="如: npx、uvx、node、python"
                      className={inputClassName}
                    />
                  </div>
                  <div>
                    <label className={labelClassName}>参数</label>
                    <input
                      type="text"
                      value={args}
                      onChange={e => setArgs(e.target.value)}
                      placeholder="如: -y @anthropic/mcp-server-filesystem --allowed-directories ."
                      className={inputClassName}
                    />
                    <p className="text-[11px] text-stone-400 mt-1">多个参数用空格分隔</p>
                  </div>
                </>
              )}

              {/* SSE 模式字段 */}
              {transportType === 'sse' && (
                <div>
                  <label className={labelClassName}>
                    服务器 URL <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={sseUrl}
                    onChange={e => setSseUrl(e.target.value)}
                    placeholder="如: http://localhost:3000/sse"
                    className={inputClassName}
                  />
                </div>
              )}

              {/* 环境变量 */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-stone-500">环境变量</label>
                  <button
                    onClick={addEnvPair}
                    className="flex items-center gap-1 text-[11px] text-teal-500 hover:text-teal-600 transition-colors"
                  >
                    <Plus className="w-3 h-3" /> 添加
                  </button>
                </div>
                {envPairs.length === 0 ? (
                  <p className="text-[11px] text-stone-300 py-2">
                    可选。点击「添加」配置环境变量，如 API_KEY、TOKEN 等
                  </p>
                ) : (
                  <div className="space-y-2">
                    {envPairs.map((pair, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={pair.key}
                          onChange={e => updateEnvPair(index, 'key', e.target.value)}
                          placeholder="KEY"
                          className="flex-1 px-2.5 py-1.5 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-teal-400 transition-all"
                        />
                        <span className="text-stone-300 text-xs">=</span>
                        <input
                          type="text"
                          value={pair.value}
                          onChange={e => updateEnvPair(index, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-[2] px-2.5 py-1.5 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-teal-400 transition-all"
                        />
                        <button
                          onClick={() => removeEnvPair(index)}
                          className="p-1 text-stone-300 hover:text-red-400 transition-colors flex-shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 超时时间 */}
              <div>
                <label className={labelClassName}>超时时间（秒）</label>
                <input
                  type="number"
                  value={timeout}
                  onChange={e => setTimeout(e.target.value)}
                  placeholder="60"
                  min={5}
                  max={600}
                  className="w-32 px-3 py-2 bg-stone-50 border border-stone-200 rounded-lg text-sm text-stone-700 font-mono placeholder:text-stone-300 focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400/20 transition-all"
                />
                <p className="text-[11px] text-stone-400 mt-1">工具调用的最大等待时间，默认 60 秒</p>
              </div>
            </>
          ) : (
            /* ── JSON 导入模式 ── */
            <div className="space-y-3">
              <p className="text-xs text-stone-500">
                粘贴 MCP 服务器的 JSON 配置，支持以下格式：
              </p>
              <div className="text-[11px] text-stone-400 bg-stone-50 rounded-lg p-3 font-mono leading-relaxed border border-stone-100">
                {'{'}<br />
                {'  '}<span className="text-teal-600">"mcpServers"</span>: {'{'}<br />
                {'    '}<span className="text-teal-600">"server-name"</span>: {'{'}<br />
                {'      '}<span className="text-stone-500">"command"</span>: "npx",<br />
                {'      '}<span className="text-stone-500">"args"</span>: ["-y", "@xxx/server"],<br />
                {'      '}<span className="text-stone-500">"env"</span>: {'{'} "KEY": "value" {'}'}<br />
                {'    }'}<br />
                {'  }'}<br />
                {'}'}
              </div>
              <textarea
                value={jsonInput}
                onChange={e => { setJsonInput(e.target.value); setJsonError('') }}
                placeholder='粘贴 JSON 配置...'
                rows={8}
                className="w-full px-3 py-2.5 bg-stone-50 border border-stone-200 rounded-lg text-xs font-mono text-stone-700 placeholder:text-stone-300 focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400/20 transition-all resize-none"
              />
              {jsonError && (
                <p className="text-xs text-red-500 flex items-center gap-1">
                  <X className="w-3 h-3" /> {jsonError}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── 底部按钮 ── */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-stone-100">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-stone-400 hover:text-stone-600 transition-colors"
          >
            取消
          </button>
          {inputMode === 'form' ? (
            <button
              onClick={handleFormSubmit}
              disabled={!isFormValid}
              className="px-5 py-2 text-sm font-medium bg-teal-500 text-white rounded-xl hover:bg-teal-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              添加服务器
            </button>
          ) : (
            <button
              onClick={handleJsonImport}
              disabled={!jsonInput.trim()}
              className="px-5 py-2 text-sm font-medium bg-teal-500 text-white rounded-xl hover:bg-teal-600 disabled:opacity-30 disabled:cursor-not-allowed transition-colors shadow-sm"
            >
              导入
            </button>
          )}
        </div>
      </GlassCard>
    </motion.div>
  )
}
