import { useState, useMemo, useEffect, useRef } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { 
  X, Play, Trash2, Star, Clock, Globe2, 
  ChevronDown, ChevronRight, Puzzle, Cpu,
  BookOpen, Zap, CheckCircle2, XCircle, Timer, Target, TrendingUp, AlertCircle,
  Loader2, Pause, SkipForward, Activity, Edit2,
  GripVertical, Download, MessageSquare, Upload, Plus, Search
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { useT } from '@/i18n'
import { searchOnlineSkills } from '@/services/onlineSearchService'
import { installSkill, triggerHotReload } from '@/services/installService'
import { nexusRuleEngine, RULE_LABELS, type NexusRule } from '@/services/nexusRuleEngine'
import { nexusScoringService } from '@/services/nexusScoringService'
import { agentEventBus } from '@/services/agentEventBus'
import type { NexusEntity, NexusExperience, NexusScoring } from '@/types'
import { getScoreTier, SCORE_TIER_COLORS } from '@/types'
import { formatTime } from '@/utils/formatTime'
import {
  getGrowthStage,
  getDefaultSpecies,
  getNexusEmoji,
  STAGE_LABELS,
  getEmotionState,
  EMOTION_LABELS,
  type GrowthStage,
} from '@/components/dashboard/nexusGrowth'
import { AchievementBadges } from '@/components/dashboard/AchievementBadges'

// Tab 类型
type DetailTab = 'ability' | 'sop' | 'skills' | 'records'

const TAB_CONFIG: { id: DetailTab; label: string; icon: string }[] = [
  { id: 'ability', label: '能力', icon: '\u26A1' },
  { id: 'sop', label: 'SOP', icon: '\uD83D\uDCCB' },
  { id: 'skills', label: '技能', icon: '\uD83E\uDDE9' },
  { id: 'records', label: '记录', icon: '\uD83D\uDCCA' },
]

// 建造总时长（与 worldSlice tickConstructionAnimations 中的 3000ms 一致）
const CONSTRUCTION_DURATION_MS = 3000

/**
 * 基于 visualDNA 动态生成颜色配置
 */
function getDynamicConfig(nexus: NexusEntity | undefined) {
  if (!nexus) {
    return {
      label: 'Nexus',
      typeLabel: 'Nexus',
      typeLabelCity: 'Building',
      bgClass: 'bg-stone-100',
      borderClass: 'border-stone-200',
      textClass: 'text-stone-400',
      hue: 180,
    }
  }
  
  const hue = nexus.visualDNA?.primaryHue ?? 180
  
  // 动态生成 CSS 类名（使用 HSL 内联样式）
  return {
    label: nexus.flavorText?.slice(0, 20) || 'Nexus',
    typeLabel: nexus.label || 'Nexus',
    typeLabelCity: nexus.label || 'Building',
    // 使用 Tailwind 兼容的动态样式
    bgClass: '', // 将改用内联样式
    borderClass: '', // 将改用内联样式
    textClass: '', // 将改用内联样式
    hue,
  }
}

// Tier 中文标签
const TIER_LABELS: Record<string, string> = {
  Expert: '专家',
  Capable: '胜任',
  Learning: '学习中',
  Weak: '薄弱',
}

/** 格式化毫秒为人类可读的时长 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

export function NexusDetailPanel() {
  const t = useT()
  const nexusPanelOpen = useStore((s) => s.nexusPanelOpen)
  const selectedNexusForPanel = useStore((s) => s.selectedNexusForPanel)
  const closeNexusPanel = useStore((s) => s.closeNexusPanel)
  const nexuses = useStore((s) => s.nexuses)
  const removeNexus = useStore((s) => s.removeNexus)
  const addNexus = useStore((s) => s.addNexus)
  const skills = useStore((s) => s.skills)
  const openClawSkills = useStore((s) => s.openClawSkills)
  const llmConfig = useStore((s) => s.llmConfig)
  const setActiveNexus = useStore((s) => s.setActiveNexus)
  const activeNexusId = useStore((s) => s.activeNexusId)
  const tasks = useStore((s) => s.tasks)
  const activeExecutions = useStore((s) => s.activeExecutions)

  const addToast = useStore((s) => s.addToast)

  // 搜索技能功能
  const pendingNexusChatInput = useStore((s) => s.pendingNexusChatInput)
  const clearPendingInput = useStore((s) => s.clearPendingInput)
  
  // 多会话系统 - 用于点击 Execute 时创建新的 Nexus 会话
  const createNewNexusConversation = useStore((s) => s.createNewNexusConversation)
  const getOrCreateNexusConversation = useStore((s) => s.getOrCreateNexusConversation)
  const switchConversation = useStore((s) => s.switchConversation)
  const setChatOpen = useStore((s) => s.setChatOpen)
  const conversations = useStore((s) => s.conversations)
  
  const [showModelConfig, setShowModelConfig] = useState(false)
  const [showSOP, setShowSOP] = useState(true)  // 默认展开 SOP
  const [showTaskDetail, setShowTaskDetail] = useState(false)  // 任务流程默认折叠
  const [customBaseUrl, setCustomBaseUrl] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [customApiKey, setCustomApiKey] = useState('')
  const [experiences, setExperiences] = useState<NexusExperience[]>([])
  const [activeRules, setActiveRules] = useState<NexusRule[]>([])
  
  // V2: 评分系统状态
  const [scoring, setScoring] = useState<NexusScoring | null>(null)
  const [showToolDimensions, setShowToolDimensions] = useState(false)
  const [showRecentRuns, setShowRecentRuns] = useState(false)
  
  // Tab 状态
  const [activeTab, setActiveTab] = useState<DetailTab>('ability')
  
  // 名称编辑状态
  const [isEditingName, setIsEditingName] = useState(false)
  const [editNameValue, setEditNameValue] = useState('')
  
  // 技能安装状态
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  // 技能浏览器状态
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [skillSearchQuery, setSkillSearchQuery] = useState('')
  // 导入文件 ref
  const importFileRef = useRef<HTMLInputElement>(null)

  const constraintsRef = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()
  
  const nexus = selectedNexusForPanel ? nexuses.get(selectedNexusForPanel) : null
  
  // Resolve all bound skills (标记未加载为 unavailable, 尊重实际状态)
  const boundSkills = useMemo(() => {
    if (!nexus) return []
    const ids = nexus.boundSkillIds || []
    return ids.map(id => {
      const normalized = id.toLowerCase().trim()
      const fromStore = skills.find(s => 
        s.id?.toLowerCase() === normalized || 
        s.name?.toLowerCase() === normalized ||
        (s.skillName && s.skillName.toLowerCase() === normalized)
      )
      const fromOC = openClawSkills.find(s => 
        s.name?.toLowerCase() === normalized
      )
      if (fromStore) return fromStore
      if (fromOC) {
        // 使用 OpenClaw 返回的真实状态而非硬编码 active
        const realStatus = fromOC.status === 'active' ? 'active' as const
          : fromOC.status === 'inactive' ? 'inactive' as const
          : 'error' as const
        return {
          id: fromOC.name,
          name: fromOC.name,
          description: fromOC.description,
          status: realStatus,
          unlocked: realStatus === 'active',
        }
      }
      return { id, name: id, description: '', status: 'unavailable' as const, unlocked: false }
    }) as Array<{ id: string; name: string; description?: string; status: string; unlocked?: boolean }>
  }, [nexus, skills, openClawSkills])

  // File-based Nexus can execute even without bound skills (it has SOP)
  const canExecute = boundSkills.length > 0 || !!nexus?.sopContent

  // 可用技能列表（排除已绑定的，按搜索词过滤）
  const availableSkillsForPicker = useMemo(() => {
    const boundIds = new Set((nexus?.boundSkillIds || []).map(s => s.toLowerCase().trim()))
    // 合并 skills (本地) 和 openClawSkills (OpenClaw) 去重
    const allSkills: Array<{ id: string; name: string; description?: string; status?: string }> = []
    const seen = new Set<string>()
    for (const s of skills) {
      const key = (s.name || s.id || '').toLowerCase().trim()
      if (key && !seen.has(key) && !boundIds.has(key)) {
        seen.add(key)
        allSkills.push({ id: s.id || s.name || '', name: s.name || s.id || '', description: s.description, status: s.status as string })
      }
    }
    for (const s of openClawSkills) {
      const key = (s.name || '').toLowerCase().trim()
      if (key && !seen.has(key) && !boundIds.has(key)) {
        seen.add(key)
        allSkills.push({ id: s.name || '', name: s.name || '', description: s.description, status: s.status })
      }
    }
    if (!skillSearchQuery) return allSkills
    const q = skillSearchQuery.toLowerCase()
    return allSkills.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.description?.toLowerCase().includes(q))
    )
  }, [nexus, skills, openClawSkills, skillSearchQuery])

  // 绑定技能到当前 Nexus
  const handleBindSkill = (skillName: string) => {
    if (!nexus) return
    const existing = nexus.boundSkillIds || []
    if (existing.includes(skillName)) return
    removeNexus(nexus.id)
    addNexus({ ...nexus, boundSkillIds: [...existing, skillName] })
    addToast({ type: 'success', title: `已绑定技能: ${skillName}` })
  }

  // 导出 Nexus 为 JSON
  const handleExportNexus = () => {
    if (!nexus) return
    const exportData = {
      exportVersion: 1,
      id: nexus.id,
      label: nexus.label,
      scoring: nexus.scoring,
      visualDNA: nexus.visualDNA,
      position: nexus.position,
      boundSkillIds: nexus.boundSkillIds,
      flavorText: nexus.flavorText,
      sopContent: nexus.sopContent,
      triggers: nexus.triggers,
      version: nexus.version,
      objective: nexus.objective,
      metrics: nexus.metrics,
      strategy: nexus.strategy,
      customModel: nexus.customModel,
      createdAt: nexus.createdAt,
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(nexus.label || nexus.id).replace(/[^a-zA-Z0-9\u4e00-\u9fff-_]/g, '_')}.nexus.json`
    a.click()
    URL.revokeObjectURL(url)
    addToast({ type: 'success', title: 'Nexus 配置已导出' })
  }

  // 导入 Nexus JSON
  const handleImportNexus = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        if (!data.label && !data.id) {
          addToast({ type: 'error', title: '无效的 Nexus 配置文件' })
          return
        }
        const newId = `imported-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const gridX = Math.floor(Math.random() * 6) - 3
        const gridY = Math.floor(Math.random() * 6) - 3
        addNexus({
          ...data,
          id: newId,
          position: { gridX, gridY },
          constructionProgress: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: `imported:${file.name}`,
        })
        addToast({ type: 'success', title: `已导入 Nexus: ${data.label || data.id}` })
      } catch {
        addToast({ type: 'error', title: '文件解析失败，请检查 JSON 格式' })
      }
    }
    reader.readAsText(file)
    // 重置 input 以允许重复选择同一文件
    e.target.value = ''
  }

  // 当前 Nexus 的历史对话列表
  const nexusConversations = useMemo(() => {
    if (!nexus) return []
    return [...conversations.values()]
      .filter(c => c.type === 'nexus' && c.nexusId === nexus.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations, nexus])

  const handleOpenConversation = (convId: string) => {
    switchConversation(convId)
    setChatOpen(true)
  }

  // 搜索并安装技能
  const handleSearchAndInstallSkill = async (skillName: string) => {
    setInstallingSkillId(skillName)
    try {
      // 1. 搜索在线技能
      const results = await searchOnlineSkills(skillName)
      if (results.length === 0) {
        addToast({ type: 'warning', title: `未找到 "${skillName}" 的在线技能` })
        return
      }
      
      // 2. 安装第一个匹配结果
      const matched = results[0]
      const installResult = await installSkill(matched)
      
      if (installResult.success) {
        // 3. 触发后端热重载 + 刷新前端技能列表（带重试）
        await triggerHotReload().catch(() => {})
        
        // 等待后端扫描完成再拉取技能列表
        let freshSkills: typeof openClawSkills = []
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(r => setTimeout(r, 300))
          try {
            const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
            const res = await fetch(`${serverUrl}/skills`)
            if (res.ok) {
              freshSkills = await res.json()
              // 检查新技能是否已出现在列表中
              const found = freshSkills.some(s => 
                s.name?.toLowerCase() === matched.name.toLowerCase()
              )
              if (found) break
            }
          } catch { /* 重试 */ }
        }
        if (freshSkills.length > 0) {
          useStore.getState().setOpenClawSkills(freshSkills)
        }

        // 4. 自动绑定到当前 Nexus：用安装后的真实名称替换原 unavailable 条目
        if (nexus) {
          const oldIds = nexus.boundSkillIds || []
          const newIds = oldIds.map(id => id === skillName ? matched.name : id)
          // 如果安装的技能名与原名不同，确保不重复
          const deduped = [...new Set(newIds)]
          removeNexus(nexus.id)
          addNexus({ ...nexus, boundSkillIds: deduped })
        }

        addToast({ type: 'success', title: `技能 "${matched.name}" 安装并绑定成功` })
      } else {
        addToast({ type: 'error', title: `安装失败: ${installResult.message}` })
      }
    } catch (error) {
      addToast({ type: 'error', title: '搜索安装失败' })
    } finally {
      setInstallingSkillId(null)
    }
  }

  // 查找与当前 Nexus 关联的活跃任务
  const activeTask = useMemo(() => {
    if (!nexus) return null
    const allTasks = [...activeExecutions, ...tasks]
    // 找到正在执行且关联到此 Nexus 的任务
    return allTasks.find(t => 
      t.status === 'executing' && 
      t.taskPlan?.nexusId === nexus.id
    ) || null
  }, [nexus, activeExecutions, tasks])

  // Load experiences from server when panel opens
  useEffect(() => {
    if (!nexus?.id || !nexusPanelOpen) return
    const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
    fetch(`${serverUrl}/nexuses/${nexus.id}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.recentExperiences) {
          setExperiences(data.recentExperiences)
        }
      })
      .catch(() => {})
  }, [nexus?.id, nexusPanelOpen])

  // Load active rules from rule engine when panel opens
  useEffect(() => {
    if (!nexus?.id || !nexusPanelOpen) {
      setActiveRules([])
      return
    }
    const rules = nexusRuleEngine.getActiveRulesForNexus(nexus.id)
    setActiveRules(rules)
  }, [nexus?.id, nexusPanelOpen])

  // V2: Load scoring data when panel opens
  useEffect(() => {
    if (!nexus?.id || !nexusPanelOpen) {
      setScoring(null)
      return
    }
    // 先从缓存加载
    const cached = nexusScoringService.getScoring(nexus.id)
    if (cached) {
      setScoring(cached)
    } else {
      // 尝试从服务端加载，失败则用 getOrCreate 创建初始值
      const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
      nexusScoringService.loadFromServer(nexus.id, serverUrl).then(loaded => {
        setScoring(loaded || nexusScoringService.getOrCreate(nexus.id))
      })
    }
  }, [nexus?.id, nexusPanelOpen])

  // V2: 订阅 run_end 事件，自动刷新 scoring
  useEffect(() => {
    if (!nexus?.id) return
    const unsub = agentEventBus.subscribe((event) => {
      if (event.type === 'run_end') {
        const updated = nexusScoringService.getScoring(nexus.id)
        if (updated) {
          setScoring({ ...updated })
        }
      }
    })
    return unsub
  }, [nexus?.id])

  // 面板打开/关闭时处理状态
  useEffect(() => {
    if (!nexusPanelOpen) {
      setIsEditingName(false)
      setEditNameValue('')
    } else if (selectedNexusForPanel) {
      // 如果有预填输入，自动切换到主聊天面板的 Nexus 会话
      if (pendingNexusChatInput) {
        getOrCreateNexusConversation(selectedNexusForPanel)
        setChatOpen(true)
        clearPendingInput()
      }
    }
  }, [nexusPanelOpen, selectedNexusForPanel, pendingNexusChatInput])
  
  if (!nexus) return null
  
  const archConfig = getDynamicConfig(nexus)
  const hue = archConfig.hue
  // 动态颜色样式
  const dynamicColor = `hsl(${hue}, 80%, 70%)`
  const dynamicBg = { backgroundColor: `hsla(${hue}, 70%, 50%, 0.2)` }
  const dynamicBorder = { borderColor: `hsla(${hue}, 70%, 50%, 0.3)` }
  const dynamicText = { color: dynamicColor }

  // V2: 评分制数据
  const scoreTier = scoring ? getScoreTier(scoring.score) : 'Learning'
  const tierColor = SCORE_TIER_COLORS[scoreTier]
  const toolDims = scoring ? Object.values(scoring.dimensions) : []
  const recentRuns = scoring?.recentRuns || []
  
  // 保存名称修改
  const handleSaveName = async () => {
    setIsEditingName(false)
    const trimmedName = editNameValue.trim()
    if (!trimmedName || trimmedName === nexus.label) return
    
    try {
      const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
      const res = await fetch(`${serverUrl}/nexuses/${nexus.id}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName })
      })
      
      if (res.ok) {
        // 更新本地状态
        removeNexus(nexus.id)
        addNexus({ ...nexus, label: trimmedName })
      }
    } catch (e) {
      console.error('Failed to update nexus name', e)
    }
  }
  
  // Which model is being used
  const activeModel = nexus.customModel 
    ? { label: nexus.customModel.model, isCustom: true }
    : { label: llmConfig.model || 'Not configured', isCustom: false }
  
  const handleExecute = () => {
    // 点击 Execute 按钮：始终创建新的 Nexus 会话，然后打开主聊天面板
    if (!nexus) return
    createNewNexusConversation(nexus.id)
    setChatOpen(true)
  }

  const handleDeactivate = () => {
    setActiveNexus(null)
  }
  
  const handleSaveModel = () => {
    if (!nexus) return
    const updated = { ...nexus }
    if (customBaseUrl && customModel) {
      updated.customModel = {
        baseUrl: customBaseUrl,
        model: customModel,
        apiKey: customApiKey || undefined,
      }
    } else {
      updated.customModel = undefined
    }
    // Update via remove + add
    removeNexus(nexus.id)
    addNexus(updated)
    setShowModelConfig(false)
  }
  
  const handleClearModel = () => {
    if (!nexus) return
    const updated = { ...nexus, customModel: undefined }
    removeNexus(nexus.id)
    addNexus(updated)
    setCustomBaseUrl('')
    setCustomModel('')
    setCustomApiKey('')
    setShowModelConfig(false)
  }
  
  const handleDelete = () => {
    const confirmMsg = '确定要删除此节点吗？此操作不可撤销。'
    if (confirm(confirmMsg)) {
      removeNexus(nexus.id)
      closeNexusPanel()
    }
  }

  // Initialize model config fields when opening
  const handleToggleModelConfig = () => {
    if (!showModelConfig && nexus.customModel) {
      setCustomBaseUrl(nexus.customModel.baseUrl)
      setCustomModel(nexus.customModel.model)
      setCustomApiKey(nexus.customModel.apiKey || '')
    }
    setShowModelConfig(!showModelConfig)
  }
  
  return (
    <>
    <AnimatePresence>
      {nexusPanelOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeNexusPanel}
            className="fixed inset-0 bg-stone-900/10 z-40"
          />
          
          {/* 拖动约束区域 */}
          <div ref={constraintsRef} className="fixed inset-0 z-[49] pointer-events-none" />
          
          <motion.div
            initial={{ opacity: 0, x: 480 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 480 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            drag
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={constraintsRef}
            dragElastic={0.05}
            dragMomentum={false}
            className="fixed right-4 top-4 bottom-4 w-[480px] z-50
                       bg-white/95 backdrop-blur-xl border border-stone-200
                       rounded-2xl
                       flex flex-col overflow-hidden
                       shadow-[-20px_0_60px_rgba(0,0,0,0.6)]
                       pointer-events-auto"
          >
            {/* Header - 可拖动区域 */}
            <div 
              className="flex items-center justify-between px-6 py-4 border-b border-stone-200 bg-stone-50 cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="flex items-center gap-3">
                <GripVertical className="w-4 h-4 text-stone-300" />
                <Globe2 className="w-5 h-5" style={dynamicText} />
                <div>
                  {/* 名称编辑 */}
                  <div className="flex items-center gap-2 group">
                    {isEditingName ? (
                      <input 
                        autoFocus
                        className="bg-stone-900/10 text-stone-800 px-2 py-1 rounded border border-stone-200 outline-none font-mono text-base font-semibold w-48 uppercase tracking-wide"
                        value={editNameValue}
                        onChange={e => setEditNameValue(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleSaveName()}
                        onBlur={handleSaveName}
                      />
                    ) : (
                      <>
                        <h2 className="font-mono text-base font-semibold text-stone-800 tracking-wide uppercase">
                          {nexus.label || `Node-${nexus.id.slice(-6)}`}
                        </h2>
                        <button 
                          onClick={() => { setIsEditingName(true); setEditNameValue(nexus.label || nexus.id) }}
                          className="opacity-0 group-hover:opacity-100 p-1 text-stone-400 hover:text-stone-700 transition-opacity rounded hover:bg-stone-100"
                          title="编辑名称"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                  <p className="text-sm font-mono text-stone-400 mt-0.5">
                    <span className="px-1.5 py-0.5 rounded text-xs font-semibold" style={{ color: tierColor, backgroundColor: `${tierColor}20` }}>
                      {TIER_LABELS[scoreTier] || scoreTier}
                    </span>
                    {' '}{nexus.label || 'Nexus'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={closeNexusPanel} className="p-1.5 text-stone-300 hover:text-stone-500 transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            
            {/* Content: 详情视图 */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              
              {/* === 建造中状态 === */}
              {nexus.constructionProgress < 1 && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex flex-col items-center justify-center py-16 space-y-6"
                >
                  {/* 建造动画 */}
                  <div className="relative w-32 h-32">
                    {/* 外层旋转光环 */}
                    <motion.div 
                      className="absolute inset-0 rounded-full border-2 border-dashed"
                      style={dynamicBorder}
                      animate={{ rotate: 360 }}
                      transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                    />
                    {/* 中层脉冲 */}
                    <motion.div 
                      className="absolute inset-4 rounded-full"
                      style={dynamicBg}
                      animate={{ scale: [1, 1.1, 1], opacity: [0.3, 0.6, 0.3] }}
                      transition={{ duration: 2, repeat: Infinity }}
                    />
                    {/* 核心 */}
                    <div className="absolute inset-8 rounded-full flex items-center justify-center" style={dynamicBg}>
                      <span className="text-2xl">🔨</span>
                    </div>
                  </div>
                  
                  {/* 进度文字 */}
                  <div className="text-center space-y-2">
                    <p className="text-lg font-mono font-semibold" style={dynamicText}>
                      {t('nexus.constructing')}
                    </p>
                    <p className="text-sm font-mono text-stone-400">
                      {t('nexus.constructing_matter')}
                    </p>
                  </div>
                  
                  {/* 进度条 */}
                  <div className="w-48">
                    <div className="flex justify-between text-xs font-mono text-stone-400 mb-1">
                      <span>{t('nexus.constructing_progress')}</span>
                      <span>{Math.round(nexus.constructionProgress * 100)}%</span>
                    </div>
                    <div className="h-2 bg-stone-100/80 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${nexus.constructionProgress * 100}%` }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        className="h-full rounded-full"
                        style={dynamicBg}
                      />
                    </div>
                    {/* 预估剩余时间 */}
                    <div className="flex items-center justify-center gap-1.5 mt-2">
                      <Timer className="w-3 h-3 text-stone-300" />
                      <span className="text-xs font-mono text-stone-400">
                        {t('nexus.constructing_eta')}{' '}
                        <span style={dynamicText}>
                          {Math.max(0, Math.ceil((1 - nexus.constructionProgress) * CONSTRUCTION_DURATION_MS / 1000))}
                        </span>
                        {t('nexus.constructing_eta_seconds')}
                      </span>
                    </div>
                  </div>
                  
                  <p className="text-xs font-mono text-stone-300 text-center max-w-xs">
                    {t('nexus.constructing_hint')}
                    <br />{t('nexus.constructing_done_hint')}
                  </p>
                </motion.div>
              )}

              {/* === 正常内容（仅在建造完成后显示） === */}
              {nexus.constructionProgress >= 1 && (
                <>
              {/* Growth Stage Visual + Score (V2) */}
              {(() => {
                const species = (nexus as any).species || getDefaultSpecies(nexus.id)
                const stage: GrowthStage = scoring ? getGrowthStage(scoring.score, scoring.totalRuns) : 'egg'
                const emoji = getNexusEmoji(species, scoring ?? undefined)
                const emotion = scoring ? getEmotionState(scoring.streak) : 'neutral'
                return (
                  <div className="flex items-center gap-4">
                    <div className="relative w-24 h-24 flex items-center justify-center">
                      <div
                        className="absolute inset-0 rounded-2xl opacity-20 blur-lg"
                        style={{ backgroundColor: tierColor }}
                      />
                      <div
                        className="relative w-20 h-20 rounded-2xl flex items-center justify-center border"
                        style={{
                          background: `linear-gradient(135deg, ${tierColor}10, ${tierColor}05)`,
                          borderColor: `${tierColor}25`,
                        }}
                      >
                        <span className="text-4xl">{emoji}</span>
                      </div>
                      <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[9px] font-mono whitespace-nowrap bg-skin-bg-panel/80 border border-stone-200/60 text-skin-text-muted">
                        {STAGE_LABELS[stage]} | {EMOTION_LABELS[emotion]}
                      </div>
                    </div>
                    <div className="flex-1 space-y-2">
                      {/* 分数 + Tier */}
                      <div className="flex items-center gap-2">
                        <TrendingUp className="w-4 h-4" style={{ color: tierColor }} />
                        <span className="text-xs font-mono text-stone-400 uppercase">Score</span>
                        <span className="text-3xl font-bold font-mono" style={{ color: tierColor }}>
                          {scoring?.score ?? 0}
                        </span>
                        <span
                          className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full border"
                          style={{ color: tierColor, borderColor: `${tierColor}40`, backgroundColor: `${tierColor}15` }}
                        >
                          {TIER_LABELS[scoreTier] || scoreTier}
                        </span>
                      </div>
                      {/* 分数进度条 */}
                      <div>
                        <div className="flex justify-between text-xs font-mono text-stone-400 mb-1">
                          <span>
                            {scoring && scoring.streak !== 0 && (
                              <span style={{ color: scoring.streak > 0 ? '#22c55e' : '#ef4444' }}>
                                {scoring.streak > 0 ? `+${scoring.streak}` : scoring.streak} streak
                              </span>
                            )}
                          </span>
                          <span>
                            {scoring ? `${(scoring.successRate * 100).toFixed(0)}% (${scoring.successCount}/${scoring.totalRuns})` : '\u2014'}
                          </span>
                        </div>
                        <div className="h-2 bg-stone-100/80 rounded-full overflow-hidden">
                          <motion.div
                            initial={{ width: 0 }}
                            animate={{ width: `${scoring?.score ?? 0}%` }}
                            transition={{ duration: 0.8, ease: 'easeOut' }}
                            className="h-full rounded-full"
                            style={{ backgroundColor: tierColor }}
                          />
                        </div>
                      </div>
                      <div className="text-xs font-mono text-stone-300">
                        {nexus.flavorText?.slice(0, 30) || 'Nexus'}
                      </div>
                    </div>
                  </div>
                )
              })()}

              {/* ==================== Tab Bar ==================== */}
              <div className="flex border-b border-stone-200 -mx-6 px-6">
                {TAB_CONFIG.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-2 text-xs font-mono transition-all border-b-2 -mb-px',
                      activeTab === tab.id
                        ? 'border-current text-skin-accent-cyan'
                        : 'border-transparent text-stone-400 hover:text-stone-500'
                    )}
                  >
                    <span>{tab.icon}</span>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* ==================== TAB: ABILITY ==================== */}
              {activeTab === 'ability' && (<>
              {/* ==================== Execute Button ==================== */}
              <button
                onClick={handleExecute}
                disabled={!canExecute}
                className={cn(
                  'w-full py-4 px-5 rounded-xl flex items-center justify-center gap-3',
                  'text-base font-mono font-semibold tracking-wider uppercase transition-all',
                  'group relative overflow-hidden',
                  canExecute
                    ? 'border hover:brightness-125 active:scale-[0.98]'
                    : 'bg-stone-100/80 border border-stone-200 text-stone-300 cursor-not-allowed'
                )}
                style={canExecute ? { ...dynamicBg, ...dynamicBorder, ...dynamicText } : undefined}
              >
                {/* Glow effect on hover */}
                {canExecute && (
                  <div 
                    className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity blur-xl"
                    style={dynamicBg}
                  />
                )}
                <Play className="w-5 h-5 relative z-10" />
                <span className="relative z-10">
                  {canExecute ? 'Execute' : 'No Skills Bound'}
                </span>
              </button>

              {/* 一句话介绍 */}
              {nexus.flavorText && (
                <p className="text-sm font-mono text-stone-400 text-center leading-relaxed -mt-2">
                  {nexus.flavorText}
                </p>
              )}
              
              {/* ==================== TAB: ABILITY - end / TAB: SKILLS - start ==================== */}
              </>)}
              {activeTab === 'skills' && (<>
              {/* ==================== Bound Skills ==================== */}
              <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <div className="flex items-center gap-2 mb-3">
                  <Puzzle className="w-4 h-4" style={dynamicText} />
                  <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                    Bound Skills
                  </span>
                  <span className="ml-auto text-xs font-mono text-stone-300">
                    {boundSkills.length}
                  </span>
                  <button
                    onClick={() => { setShowSkillPicker(!showSkillPicker); setSkillSearchQuery('') }}
                    className={cn(
                      "w-6 h-6 rounded flex items-center justify-center transition-colors",
                      showSkillPicker
                        ? "bg-stone-100 text-stone-500"
                        : "bg-stone-100/80 text-stone-300 hover:bg-stone-100 hover:text-stone-400"
                    )}
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                
                {/* 技能选择器面板 */}
                <AnimatePresence>
                  {showSkillPicker && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden mb-3"
                    >
                      <div className="p-3 rounded-lg bg-stone-50 border border-white/[0.08]">
                        <div className="relative mb-2">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-300" />
                          <input
                            type="text"
                            value={skillSearchQuery}
                            onChange={(e) => setSkillSearchQuery(e.target.value)}
                            placeholder="搜索可用技能..."
                            className="w-full pl-8 pr-3 py-1.5 bg-stone-100/80 border border-stone-200 rounded text-xs font-mono text-stone-600 placeholder-stone-300 focus:border-stone-200 focus:outline-none"
                            autoFocus
                          />
                        </div>
                        <div className="max-h-[200px] overflow-y-auto space-y-1">
                          {availableSkillsForPicker.length > 0 ? (
                            availableSkillsForPicker.slice(0, 20).map(skill => (
                              <button
                                key={skill.id}
                                onClick={() => handleBindSkill(skill.name)}
                                className="w-full text-left p-2 rounded hover:bg-white/[0.05] transition-colors group/skill"
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-mono text-stone-600 group-hover/skill:text-stone-800">{skill.name}</span>
                                  {skill.status === 'active' && (
                                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400/70 border border-emerald-500/15">
                                      ACTIVE
                                    </span>
                                  )}
                                </div>
                                {skill.description && (
                                  <p className="text-[13px] font-mono text-stone-300 mt-0.5 line-clamp-1">{skill.description}</p>
                                )}
                              </button>
                            ))
                          ) : (
                            <p className="text-[11px] font-mono text-stone-300 py-2 text-center">
                              {skillSearchQuery ? '无匹配技能' : '所有技能已绑定'}
                            </p>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                
                {boundSkills.length > 0 ? (
                  <div className="space-y-2.5">
                    {boundSkills.map(skill => (
                      <div 
                        key={skill.id}
                        className="p-3 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.05] transition-colors"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-mono text-stone-700 font-medium">{skill.name}</span>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              'text-[13px] font-mono px-2 py-0.5 rounded-full',
                              skill.status === 'active' 
                                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'
                                : skill.status === 'error'
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/20'
                                : 'bg-red-500/20 text-red-400 border border-red-500/20'
                            )}>
                              {skill.status === 'active' ? 'ONLINE' : skill.status === 'error' ? 'MISSING DEPS' : 'UNAVAILABLE'}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                e.preventDefault()
                                if (!nexus) return
                                const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
                                fetch(`${serverUrl}/nexuses/${nexus.id}/skills`, {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ action: 'remove', skillId: skill.name })
                                })
                                  .then(res => {
                                    if (res.ok) return res.json()
                                    // 后端无此 Nexus (Observer 创建) → 前端直接移除
                                    const newSkills = (nexus.boundSkillIds || []).filter(s => s !== skill.name)
                                    removeNexus(nexus.id)
                                    addNexus({ ...nexus, boundSkillIds: newSkills })
                                    addToast({ type: 'success', title: `已移除技能: ${skill.name}` })
                                    return null
                                  })
                                  .then(data => {
                                    if (!data) return // 已在上方前端处理
                                    const updated = { ...nexus, boundSkillIds: data.skillDependencies || [] }
                                    removeNexus(nexus.id)
                                    addNexus(updated)
                                    addToast({ type: 'success', title: `已移除技能: ${skill.name}` })
                                  })
                                  .catch(err => {
                                    console.error('Failed to remove skill:', err)
                                    addToast({ type: 'error', title: `移除失败: ${skill.name}` })
                                  })
                              }}
                              className="text-[11px] font-mono px-2 py-0.5 rounded bg-red-500/10 text-red-400/60 border border-red-500/15 hover:bg-red-500/20 hover:text-red-400 transition-colors cursor-pointer"
                            >
                              移除
                            </button>
                          </div>
                        </div>
                        {skill.status === 'active' && skill.description && (
                          <p className="text-xs font-mono text-stone-300 leading-relaxed line-clamp-2">
                            {skill.description}
                          </p>
                        )}
                        {skill.status !== 'active' && (
                          <div className="flex items-center gap-2 mt-1.5">
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleSearchAndInstallSkill(skill.name)
                              }}
                              disabled={installingSkillId === skill.name}
                              className={cn(
                                "text-[11px] font-mono px-2 py-1 rounded border transition-colors flex items-center gap-1",
                                installingSkillId === skill.name
                                  ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30 cursor-wait"
                                  : "bg-amber-500/10 text-amber-400/70 border-amber-500/15 hover:bg-amber-500/20 hover:text-amber-400"
                              )}
                            >
                              {installingSkillId === skill.name ? (
                                <>
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  安装中...
                                </>
                              ) : (
                                <>
                                  <Download className="w-3 h-3" />
                                  搜索并安装
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm font-mono text-stone-300 italic">No skills bound to this Nexus</p>
                )}
              </div>

              {/* ==================== TAB: SKILLS - end / TAB: SOP - start ==================== */}
              </>)}
              {activeTab === 'sop' && (<>
              {/* ==================== Objective Function (目标函数) ==================== */}
              {(nexus.objective || nexus.metrics || nexus.strategy) && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="flex items-center gap-2 mb-3">
                    <Target className="w-4 h-4" style={dynamicText} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      Objective Function
                    </span>
                  </div>
                  
                  {nexus.objective && (
                    <div className="mb-4">
                      <p className="text-sm text-stone-700 leading-relaxed">{nexus.objective}</p>
                    </div>
                  )}
                  
                  {nexus.strategy && (
                    <div className="mb-3 p-3 rounded-lg bg-stone-50 border border-white/[0.04]">
                      <div className="flex items-center gap-1.5 mb-2">
                        <TrendingUp className="w-3 h-3 text-stone-400" />
                        <span className="text-xs font-mono text-stone-400 uppercase">Strategy</span>
                      </div>
                      <p className="text-xs text-stone-500 leading-relaxed whitespace-pre-wrap">{nexus.strategy}</p>
                    </div>
                  )}
                  
                  {nexus.metrics && nexus.metrics.length > 0 && (
                    <div className="p-3 rounded-lg bg-stone-50 border border-white/[0.04]">
                      <div className="flex items-center gap-1.5 mb-2">
                        <AlertCircle className="w-3 h-3 text-stone-400" />
                        <span className="text-xs font-mono text-stone-400 uppercase">Success Metrics</span>
                      </div>
                      <ul className="space-y-1">
                        {nexus.metrics.map((metric, i) => (
                          <li key={i} className="text-xs text-stone-400 flex items-start gap-2">
                            <span className="text-stone-300">•</span>
                            <span>{metric}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* === SOP tab pause: always-visible operational status === */}
              </>)}

              {/* ==================== Active Nexus Indicator ==================== */}
              {activeNexusId === nexus.id && (
                <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-mono text-emerald-400 uppercase tracking-wider">
                      Active Nexus
                    </span>
                  </div>
                  <button
                    onClick={handleDeactivate}
                    className="text-[13px] font-mono px-3 py-1 rounded bg-stone-100/80 text-stone-400 hover:text-stone-500 border border-stone-200 transition-colors"
                  >
                    Deactivate
                  </button>
                </div>
              )}

              {/* ==================== Task Execution Progress ==================== */}
              {activeTask?.taskPlan && activeTask.taskPlan.subTasks && (
                <div className="p-5 rounded-xl bg-cyan-500/5 border border-cyan-500/20">
                  <button
                    onClick={() => setShowTaskDetail(!showTaskDetail)}
                    className="w-full flex items-center gap-2"
                  >
                    <Activity className="w-4 h-4 text-cyan-400 animate-pulse" />
                    <span className="text-xs font-mono text-cyan-400 uppercase tracking-wider">
                      Task Execution
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {(activeTask.taskPlan.subTasks || []).filter(t => t.status === 'done').length}/{(activeTask.taskPlan.subTasks || []).length}
                    </span>
                    {showTaskDetail 
                      ? <ChevronDown className="w-3 h-3 text-stone-300" />
                      : <ChevronRight className="w-3 h-3 text-stone-300" />
                    }
                  </button>
                  
                  {/* 进度条（始终显示） */}
                  <div className="mt-3">
                    <div className="h-2 bg-stone-100 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ 
                          width: `${Math.round(
                            (activeTask.taskPlan.subTasks.filter(t => t.status === 'done' || t.status === 'skipped').length / 
                             activeTask.taskPlan.subTasks.length) * 100
                          )}%` 
                        }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-500"
                      />
                    </div>
                  </div>
                  
                  {/* 详情（折叠） */}
                  <AnimatePresence initial={false}>
                    {showTaskDetail && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 pt-3 border-t border-cyan-500/10">
                  {/* 子任务状态统计 */}
                  <div className="flex flex-wrap gap-2 mb-3 text-[13px] font-mono">
                    {activeTask.taskPlan.subTasks.filter(t => t.status === 'executing').length > 0 && (
                      <span className="flex items-center gap-1 text-cyan-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {activeTask.taskPlan.subTasks.filter(t => t.status === 'executing').length} 执行中
                      </span>
                    )}
                    {activeTask.taskPlan.subTasks.filter(t => t.status === 'blocked').length > 0 && (
                      <span className="flex items-center gap-1 text-amber-400">
                        <Pause className="w-3.5 h-3.5" />
                        {activeTask.taskPlan.subTasks.filter(t => t.status === 'blocked').length} 阻塞
                      </span>
                    )}
                    {activeTask.taskPlan.subTasks.filter(t => t.status === 'failed').length > 0 && (
                      <span className="flex items-center gap-1 text-red-400">
                        <XCircle className="w-3.5 h-3.5" />
                        {activeTask.taskPlan.subTasks.filter(t => t.status === 'failed').length} 失败
                      </span>
                    )}
                    {activeTask.taskPlan.subTasks.filter(t => t.status === 'paused_for_approval').length > 0 && (
                      <span className="flex items-center gap-1 text-yellow-400">
                        <AlertCircle className="w-3.5 h-3.5" />
                        {activeTask.taskPlan.subTasks.filter(t => t.status === 'paused_for_approval').length} 待确认
                      </span>
                    )}
                  </div>
                  
                  {/* 子任务列表 */}
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {activeTask.taskPlan.subTasks.map(subTask => {
                      const statusConfig: Record<string, { icon: typeof CheckCircle2; color: string }> = {
                        pending: { icon: Clock, color: 'slate' },
                        ready: { icon: Play, color: 'green' },
                        executing: { icon: Loader2, color: 'cyan' },
                        done: { icon: CheckCircle2, color: 'emerald' },
                        failed: { icon: XCircle, color: 'red' },
                        blocked: { icon: Pause, color: 'amber' },
                        skipped: { icon: SkipForward, color: 'slate' },
                        paused_for_approval: { icon: AlertCircle, color: 'yellow' },
                      }
                      const config = statusConfig[subTask.status] || statusConfig.pending
                      const StatusIcon = config.icon
                      const isExecuting = subTask.status === 'executing'
                      
                      return (
                        <div 
                          key={subTask.id}
                          className={cn(
                            'p-2 rounded-lg border flex items-start gap-2 transition-all',
                            subTask.status === 'done' && 'bg-emerald-500/5 border-emerald-500/15',
                            subTask.status === 'failed' && 'bg-red-500/5 border-red-500/15',
                            subTask.status === 'executing' && 'bg-cyan-500/5 border-cyan-500/20',
                            subTask.status === 'blocked' && 'bg-amber-500/5 border-amber-500/15',
                            subTask.status === 'paused_for_approval' && 'bg-yellow-500/5 border-yellow-500/20',
                            (subTask.status === 'pending' || subTask.status === 'ready' || subTask.status === 'skipped') && 'bg-stone-50 border-white/[0.05]'
                          )}
                        >
                          <div className={cn('w-5 h-5 flex items-center justify-center flex-shrink-0', `text-${config.color}-400`)}>
                            <StatusIcon className={cn('w-3.5 h-3.5', isExecuting && 'animate-spin')} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13px] text-stone-500 line-clamp-1">{subTask.description}</p>
                            {subTask.error && (
                              <p className="text-xs text-red-400/70 mt-0.5 line-clamp-1">✗ {subTask.error}</p>
                            )}
                            {subTask.status === 'blocked' && subTask.blockReason && (
                              <p className="text-xs text-amber-400/70 mt-0.5 line-clamp-2">⚠ {subTask.blockReason}</p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
              
              {/* ==================== TAB: SOP - resume ==================== */}
              {activeTab === 'sop' && (<>
              {/* ==================== SOP Section ==================== */}
              {nexus.sopContent && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <button
                    onClick={() => setShowSOP(!showSOP)}
                    className="w-full flex items-center gap-2"
                  >
                    <BookOpen className="w-4 h-4" style={dynamicText} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      Mission & SOP
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {nexus.version || '1.0.0'}
                    </span>
                    {showSOP 
                      ? <ChevronDown className="w-3 h-3 text-stone-300" />
                      : <ChevronRight className="w-3 h-3 text-stone-300" />
                    }
                  </button>
                  
                  <AnimatePresence initial={false}>
                    {showSOP && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 pt-3 border-t border-stone-100">
                          <pre className="text-sm font-mono text-stone-500 leading-relaxed whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                            {nexus.sopContent}
                          </pre>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* ==================== TAB: SOP - end ==================== */}
              </>)}

              {/* ==================== TAB: SKILLS - resume for Experience ==================== */}
              {activeTab === 'skills' && (<>
              {/* ==================== Experience Section ==================== */}
              {experiences.length > 0 && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="flex items-center gap-2 mb-3">
                    <Star className="w-4 h-4" style={dynamicText} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      Experience Log
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {experiences.length}
                    </span>
                  </div>
                  <div className="space-y-1.5 max-h-[240px] overflow-y-auto">
                    {experiences.map((exp, i) => (
                      <div 
                        key={i}
                        className="p-2.5 rounded-lg bg-stone-50 border border-white/[0.04] flex items-center gap-2"
                      >
                        {exp.outcome === 'success' 
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                          : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        }
                        <p className="text-xs font-mono text-stone-400 truncate">
                          {exp.title}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ==================== TAB: SKILLS(Experience) - end / TAB: ABILITY resume ==================== */}
              </>)}
              {activeTab === 'ability' && (<>
              {/* ==================== Tool Dimensions (V2) ==================== */}
              {toolDims.length > 0 && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <button
                    onClick={() => setShowToolDimensions(!showToolDimensions)}
                    className="w-full flex items-center gap-2"
                  >
                    <Puzzle className="w-4 h-4" style={{ color: tierColor }} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      Tool Dimensions
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {toolDims.length}
                    </span>
                    {showToolDimensions
                      ? <ChevronDown className="w-3 h-3 text-stone-300" />
                      : <ChevronRight className="w-3 h-3 text-stone-300" />
                    }
                  </button>

                  {/* 概览统计（始终显示） */}
                  <div className="mt-2 flex gap-3 text-[13px] font-mono text-stone-300">
                    <span>
                      Avg Score: <span style={{ color: tierColor }}>{toolDims.length > 0 ? Math.round(toolDims.reduce((a, d) => a + d.score, 0) / toolDims.length) : '—'}</span>
                    </span>
                    <span>
                      Total Calls: <span className="text-stone-400">{toolDims.reduce((a, d) => a + d.calls, 0)}</span>
                    </span>
                  </div>

                  <AnimatePresence initial={false}>
                    {showToolDimensions && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 pt-3 border-t border-stone-100 space-y-2 max-h-[280px] overflow-y-auto">
                          {toolDims
                            .sort((a, b) => b.calls - a.calls)
                            .map(dim => {
                              const dimTierColor = dim.score >= 80 ? '#22c55e'
                                : dim.score >= 60 ? '#3b82f6'
                                : dim.score >= 40 ? '#f59e0b'
                                : '#ef4444'
                              const successPct = dim.calls > 0 ? Math.round((dim.successes / dim.calls) * 100) : 0
                              return (
                                <div
                                  key={dim.toolName}
                                  className="p-2.5 rounded-lg bg-stone-50 border border-white/[0.04]"
                                >
                                  <div className="flex items-center justify-between mb-1.5">
                                    <span className="text-xs font-mono text-stone-600 font-medium truncate max-w-[180px]">
                                      {dim.toolName}
                                    </span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-mono font-semibold" style={{ color: dimTierColor }}>
                                        {dim.score}
                                      </span>
                                    </div>
                                  </div>
                                  {/* 分数条 */}
                                  <div className="h-1.5 bg-stone-100/80 rounded-full overflow-hidden mb-1.5">
                                    <div
                                      className="h-full rounded-full transition-all duration-500"
                                      style={{ width: `${dim.score}%`, backgroundColor: dimTierColor }}
                                    />
                                  </div>
                                  {/* 指标 */}
                                  <div className="flex gap-3 text-xs font-mono text-stone-300">
                                    <span>{dim.calls} calls</span>
                                    <span className="text-emerald-400/60">{dim.successes}ok</span>
                                    <span className="text-red-400/60">{dim.failures}err</span>
                                    <span>{successPct}%</span>
                                    <span className="ml-auto">{formatDuration(dim.avgDurationMs)} avg</span>
                                  </div>
                                </div>
                              )
                            })}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* Achievement Badges (ability tab 最后) */}
              <AchievementBadges nexusId={nexus.id} />

              {/* ==================== TAB: ABILITY - end / TAB: RECORDS - start ==================== */}
              </>)}
              {activeTab === 'records' && (<>
              {/* ==================== Recent Runs (V2) ==================== */}
              {recentRuns.length > 0 && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <button
                    onClick={() => setShowRecentRuns(!showRecentRuns)}
                    className="w-full flex items-center gap-2"
                  >
                    <Activity className="w-4 h-4" style={{ color: tierColor }} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      Recent Runs
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {recentRuns.length}
                    </span>
                    {showRecentRuns
                      ? <ChevronDown className="w-3 h-3 text-stone-300" />
                      : <ChevronRight className="w-3 h-3 text-stone-300" />
                    }
                  </button>

                  <AnimatePresence initial={false}>
                    {showRecentRuns && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="mt-3 pt-3 border-t border-stone-100 space-y-1.5 max-h-[300px] overflow-y-auto">
                          {[...recentRuns].reverse().map((run, i) => (
                            <div
                              key={`${run.runId}-${i}`}
                              className={cn(
                                'p-2.5 rounded-lg border flex items-start gap-2',
                                run.success
                                  ? 'bg-emerald-500/5 border-emerald-500/10'
                                  : 'bg-red-500/5 border-red-500/10'
                              )}
                            >
                              {run.success
                                ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                                : <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                              }
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-mono text-stone-500 truncate">
                                  {run.task}
                                </p>
                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs font-mono text-stone-300">
                                  <span style={{ color: run.scoreChange >= 0 ? '#22c55e' : '#ef4444' }}>
                                    {run.scoreChange > 0 ? '+' : ''}{run.scoreChange}
                                  </span>
                                  <span>{run.turns} turns</span>
                                  <span>{formatDuration(run.durationMs)}</span>
                                  {run.toolsCalled.length > 0 && (
                                    <span className="truncate max-w-[120px]">
                                      {run.toolsCalled.join(', ')}
                                    </span>
                                  )}
                                  {run.genesHarvested && run.genesHarvested > 0 && (
                                    <span className="text-amber-400/50">
                                      +{run.genesHarvested} genes
                                    </span>
                                  )}
                                </div>
                              </div>
                              <span className="text-xs font-mono text-stone-300 shrink-0">
                                {formatTime(run.timestamp)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}

              {/* ==================== Conversation History ==================== */}
              {nexusConversations.length > 0 && (
                <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                  <div className="flex items-center gap-2 mb-3">
                    <MessageSquare className="w-4 h-4" style={dynamicText} />
                    <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                      对话记录
                    </span>
                    <span className="ml-auto text-xs font-mono text-stone-300">
                      {nexusConversations.length}
                    </span>
                  </div>
                  <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                    {nexusConversations.map(conv => (
                      <button 
                        key={conv.id} 
                        onClick={() => handleOpenConversation(conv.id)}
                        className="w-full p-2.5 rounded-lg bg-stone-50 border border-white/[0.04] 
                                   hover:bg-white/[0.05] transition-colors text-left flex items-center gap-2"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-mono text-stone-500 truncate">{conv.title}</p>
                          <p className="text-xs font-mono text-stone-300">
                            {conv.messages.length}条消息 · {formatTime(conv.updatedAt)}
                          </p>
                        </div>
                        <ChevronRight className="w-3 h-3 text-stone-300 flex-shrink-0" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* ==================== TAB: RECORDS pause / TAB: SKILLS resume for Rules ==================== */}
              </>)}
              {activeTab === 'skills' && (<>
              {/* ==================== Active Rules Section ==================== */}
              {activeRules.length > 0 && (
                <div className="p-5 rounded-xl bg-amber-500/5 border border-amber-500/15">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="w-4 h-4 text-amber-400" />
                    <span className="text-xs font-mono text-amber-400/70 uppercase tracking-wider">
                      Active Rules
                    </span>
                    <span className="ml-auto text-xs font-mono text-amber-400/40">
                      {activeRules.length}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {activeRules.map(rule => {
                      const daysLeft = Math.max(0, Math.ceil((rule.expiresAt - Date.now()) / (1000 * 60 * 60 * 24)))
                      return (
                        <div 
                          key={rule.id}
                          className="p-3 rounded-lg bg-white/[0.03] border border-amber-500/10"
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-mono text-amber-400/80 font-medium">
                              {RULE_LABELS[rule.type] || rule.type}
                            </span>
                            <span className="text-xs font-mono text-stone-300">
                              {daysLeft}d left
                            </span>
                          </div>
                          <p className="text-[13px] font-mono text-stone-400 leading-relaxed">
                            {rule.injectedPrompt}
                          </p>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              
              {/* ==================== TAB: SKILLS(Rules) - end / TAB: RECORDS resume ==================== */}
              </>)}
              {activeTab === 'records' && (<>
              {/* ==================== Model Config ==================== */}
              <div className="p-5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
                <button
                  onClick={handleToggleModelConfig}
                  className="w-full flex items-center gap-2"
                >
                  <Cpu className="w-4 h-4 text-stone-400" />
                  <span className="text-xs font-mono text-stone-400 uppercase tracking-wider">
                    Model
                  </span>
                  <span className={cn(
                    'ml-auto text-xs font-mono px-2 py-0.5 rounded',
                    activeModel.isCustom 
                      ? 'bg-amber-500/15 text-amber-400 border border-amber-500/20'
                      : 'text-stone-300'
                  )}>
                    {activeModel.isCustom ? 'Custom' : 'Global'}
                  </span>
                  {showModelConfig 
                    ? <ChevronDown className="w-3 h-3 text-stone-300" />
                    : <ChevronRight className="w-3 h-3 text-stone-300" />
                  }
                </button>
                
                <p className="text-xs font-mono text-stone-300 mt-1.5 truncate">
                  {activeModel.label}
                </p>
                
                <AnimatePresence initial={false}>
                  {showModelConfig && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 pt-3 border-t border-stone-100 space-y-3">
                        <div>
                          <label className="text-[13px] font-mono text-stone-300 uppercase mb-1 block">Base URL</label>
                          <input
                            type="text"
                            value={customBaseUrl}
                            onChange={e => setCustomBaseUrl(e.target.value)}
                            placeholder={llmConfig.baseUrl || 'https://api.openai.com/v1'}
                            className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded text-sm font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none focus:border-cyan-500/30"
                          />
                        </div>
                        <div>
                          <label className="text-[13px] font-mono text-stone-300 uppercase mb-1 block">Model</label>
                          <input
                            type="text"
                            value={customModel}
                            onChange={e => setCustomModel(e.target.value)}
                            placeholder={llmConfig.model || 'gpt-4o'}
                            className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded text-sm font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none focus:border-cyan-500/30"
                          />
                        </div>
                        <div>
                          <label className="text-[13px] font-mono text-stone-300 uppercase mb-1 block">API Key (optional, uses global if empty)</label>
                          <input
                            type="password"
                            value={customApiKey}
                            onChange={e => setCustomApiKey(e.target.value)}
                            placeholder="Leave empty for global key"
                            className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded text-sm font-mono text-stone-600 placeholder:text-stone-300 focus:outline-none focus:border-cyan-500/30"
                          />
                        </div>
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={handleSaveModel}
                            className="flex-1 py-2 px-4 rounded text-xs font-mono bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/30 transition-colors"
                          >
                            Save
                          </button>
                          {nexus.customModel && (
                            <button
                              onClick={handleClearModel}
                              className="py-2 px-4 rounded text-xs font-mono bg-stone-100/80 border border-stone-200 text-stone-400 hover:text-stone-500 transition-colors"
                            >
                              Reset to Global
                            </button>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              
              {/* Time info */}
              <div className="flex items-center gap-2 text-xs font-mono text-stone-300">
                <Clock className="w-4 h-4" />
                <span>Created {new Date(nexus.createdAt).toLocaleDateString()}</span>
                {nexus.lastUsedAt && (
                  <>
                    <span className="text-stone-200">|</span>
                    <span>Last used {new Date(nexus.lastUsedAt).toLocaleDateString()}</span>
                  </>
                )}
              </div>
              {/* ==================== TAB: RECORDS - end ==================== */}
              </>)}
              </>
              )}            </div>
            
            {/* Footer */}
            <div className="p-5 border-t border-stone-200 bg-stone-100/60 space-y-2">
              {/* Export / Import */}
              <div className="flex gap-2">
                <button
                  onClick={handleExportNexus}
                  className="flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2
                           text-xs font-mono text-stone-400 hover:text-stone-600
                           border border-stone-200 hover:bg-stone-100/80 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  导出配置
                </button>
                <button
                  onClick={() => importFileRef.current?.click()}
                  className="flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2
                           text-xs font-mono text-stone-400 hover:text-stone-600
                           border border-stone-200 hover:bg-stone-100/80 transition-colors"
                >
                  <Upload className="w-3.5 h-3.5" />
                  导入配置
                </button>
                <input
                  ref={importFileRef}
                  type="file"
                  accept=".json"
                  onChange={handleImportNexus}
                  className="hidden"
                />
              </div>
              {/* Delete */}
              <button
                onClick={handleDelete}
                className="w-full py-2.5 px-4 rounded-lg flex items-center justify-center gap-2
                         text-sm font-mono text-red-400/50 hover:text-red-400
                         border border-red-500/10 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Decommission Node
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
    </>
  )
}
