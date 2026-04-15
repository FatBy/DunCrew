import { useState, useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { WorldView } from '@/components/WorldView'
import { Dock } from '@/components/Dock'
import { HouseContainer } from '@/components/HouseContainer'
import { ConnectionPanel } from '@/components/ConnectionPanel'
import { ToastContainer } from '@/components/Toast'
import { NotificationCenter } from '@/components/NotificationCenter'
import { LocaleToggle } from '@/components/LocaleToggle'
import { AIChatPanel } from '@/components/ai/AIChatPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { BuildProposalModal } from '@/components/world/BuildProposalModal'
import { SkillProposalCard } from '@/components/world/SkillProposalCard'
import { ApprovalModal } from '@/components/ApprovalModal'
import { DunDetailPanel } from '@/components/world/DunDetailPanel'
import { InterruptedTasksWarning } from '@/components/InterruptedTasksWarning'
import { CrashRecoveryBanner } from '@/components/CrashRecoveryBanner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { FirstLaunchSetup } from '@/components/FirstLaunchSetup'
import { useStore } from '@/store'
import { getHouseById } from '@/houses/registry'
import { localClawService } from '@/services/LocalClawService'
import { skillStatsService } from '@/services/skillStatsService'
import { memoryStore } from '@/services/memoryStore'
import { getLocalSoulData, getLocalSkills, getLocalMemories } from '@/utils/localDataProvider'
import { simpleVisualDNA } from '@/store/slices/worldSlice'
import { createInitialScoring } from '@/types'
import { restoreLLMConfigFromServer, injectStoreConfigReader } from '@/services/llmService'
import { persistTaskHistory } from '@/store/slices/sessionsSlice'
import { MEMORY_CACHE_STORAGE_KEY } from '@/store/slices/agentSlice'
import { getCachedMBTIResult, getCachedAxes } from '@/services/mbtiAnalyzer'
import { soulEvolutionService } from '@/services/soulEvolutionService'
import { agentEventBus } from '@/services/agentEventBus'
import type { ExecTrace } from '@/types'

/**
 * 一次性迁移: 将 localStorage 中旧 ddos_ 前缀的数据移动到 duncrew_ 前缀
 * 迁移后删除旧 key 释放空间
 */
function migrateLocalStorageKeys() {
  const migrated = localStorage.getItem('duncrew_migration_done')
  if (migrated) return

  try {
    // 收集所有需要迁移的 key
    const oldKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && (key.startsWith('ddos_') || key.startsWith('ddos-'))) {
        oldKeys.push(key)
      }
    }

    // 先删旧 key 腾空间，再写新 key
    const entries: Array<[string, string]> = []
    for (const oldKey of oldKeys) {
      const value = localStorage.getItem(oldKey)
      if (value) {
        const newKey = oldKey.startsWith('ddos_')
          ? oldKey.replace('ddos_', 'duncrew_')
          : oldKey.replace('ddos-', 'duncrew-')
        entries.push([newKey, value])
      }
      localStorage.removeItem(oldKey)
    }

    // 写入新 key
    for (const [newKey, value] of entries) {
      if (!localStorage.getItem(newKey)) {
        localStorage.setItem(newKey, value)
      }
    }

    if (oldKeys.length > 0) {
      console.log(`[Migration] Migrated ${oldKeys.length} localStorage keys from ddos → duncrew`)
    }
  } catch (err) {
    console.warn('[Migration] localStorage migration failed:', err)
  }

  localStorage.setItem('duncrew_migration_done', '1')
}

/**
 * 从 localStorage 缓存立即恢复数据到 store
 * 在服务器连接之前先显示上次的数据，避免空白等待
 */
function restoreLocalCacheToStore(storeActions: any) {
  let restored = false

  // MBTI (先恢复缓存结果，立即显示 avatar，不等检测)
  const cachedMBTI = getCachedMBTIResult()
  if (cachedMBTI) {
    const cachedAxes = getCachedAxes()
    useStore.setState({
      soulMBTI: cachedMBTI,
      soulMBTIBase: cachedMBTI,
      soulMBTIExpressed: cachedMBTI,
      ...(cachedAxes ? { soulMBTIAxes: cachedAxes } : {}),
    })
    restored = true
  }

  // Soul
  const soulData = getLocalSoulData()
  if (soulData) {
    storeActions.setSoulFromParsed({
      title: '',
      subtitle: soulData.identity.essence,
      coreTruths: soulData.coreTruths,
      boundaries: soulData.boundaries,
      vibeStatement: soulData.vibeStatement,
      continuityNote: soulData.continuityNote,
      rawContent: soulData.rawContent,
    }, null)
    restored = true
  }

  // Skills
  const skills = getLocalSkills()
  if (skills.length > 0) {
    storeActions.setOpenClawSkills(skills)
    restored = true
  }

  // Memories
  const memories = getLocalMemories()
  if (memories.length > 0) {
    storeActions.setMemories(memories)
    restored = true
  }

  if (restored) {
    console.log('[App] Restored cached data from localStorage (Soul/Skills/Memories)')
  }
}

function App() {
  const currentView = useStore((s) => s.currentView)
  const currentHouse = getHouseById(currentView)

  // 首次启动引导页
  const [showSetup, setShowSetup] = useState(() => {
    return !localStorage.getItem('duncrew_setup_done')
  })

  // Initialize services on mount
  useEffect(() => {
    let cancelRetry: (() => void) | null = null

    const storeActions = {
      // Connection
      setConnectionStatus: useStore.getState().setConnectionStatus,
      setConnectionError: useStore.getState().setConnectionError,
      setReconnectAttempt: useStore.getState().setReconnectAttempt,
      setReconnectCountdown: useStore.getState().setReconnectCountdown,
      addToast: useStore.getState().addToast,
      
      // Sessions → Tasks
      setSessions: useStore.getState().setSessions,
      addSession: useStore.getState().addSession,
      updateSession: useStore.getState().updateSession,
      removeSession: useStore.getState().removeSession,
      setSessionsLoading: useStore.getState().setSessionsLoading,
      
      // Channels → Skills (兼容)
      setChannelsSnapshot: useStore.getState().setChannelsSnapshot,
      setChannelConnected: useStore.getState().setChannelConnected,
      setChannelsLoading: useStore.getState().setChannelsLoading,
      
      // OpenClaw Skills → Skills (新)
      setOpenClawSkills: useStore.getState().setOpenClawSkills,
      
      // Agent → Memories
      setAgentIdentity: useStore.getState().setAgentIdentity,
      setAgentStatus: useStore.getState().setAgentStatus,
      addRunEvent: useStore.getState().addRunEvent,
      addLog: useStore.getState().addLog,
      setAgentLoading: useStore.getState().setAgentLoading,
      setMemoriesFromSessions: useStore.getState().setMemoriesFromSessions,
      
      // Devices → Soul
      setPresenceSnapshot: useStore.getState().setPresenceSnapshot,
      updateDevice: useStore.getState().updateDevice,
      removeDevice: useStore.getState().removeDevice,
      setHealth: useStore.getState().setHealth,
      setDevicesLoading: useStore.getState().setDevicesLoading,
      updateSoulFromState: useStore.getState().updateSoulFromState,
      
      // Soul from SOUL.md
      setSoulFromParsed: useStore.getState().setSoulFromParsed,
      
      // Memories 直接设置
      setMemories: useStore.getState().setMemories,
      
      // AI 执行状态
      updateExecutionStatus: useStore.getState().updateExecutionStatus,
      
      // Native 模式: Agent 任务上下文
      setCurrentTask: useStore.getState().setCurrentTask,
      
      // Native 模式: 实时执行任务管理
      addActiveExecution: useStore.getState().addActiveExecution,
      updateActiveExecution: useStore.getState().updateActiveExecution,
      removeActiveExecution: useStore.getState().removeActiveExecution,
      appendExecutionStep: useStore.getState().appendExecutionStep,
      updateExecutionStep: useStore.getState().updateExecutionStep,
      
      // P3: 危险操作审批
      requestApproval: useStore.getState().requestApproval,
      
      // P4: Dun 数据注入
      setDunsFromServer: useStore.getState().setDunsFromServer,
      setActiveDun: useStore.getState().setActiveDun,
      updateDunScoring: useStore.getState().updateDunScoring,
      updateDun: useStore.getState().updateDun,
      bindSkillToDun: useStore.getState().bindSkillToDun,
      getDuns: () => useStore.getState().duns,
      syncAgentsAsDuns: useStore.getState().syncAgentsAsDuns,
      get activeDunId() { return useStore.getState().activeDunId },
      get duns() { return useStore.getState().duns },
    }

    // 注入 LinkStation Store 配置读取器到 llmService（避免循环依赖）
    injectStoreConfigReader(
      () => useStore.getState().getActiveChatConfig(),
      () => useStore.getState().getActiveEmbedConfig(),
      (channel: string) => useStore.getState().getChannelConfig(channel),
    )

    // 加载联络站持久化数据（含旧配置迁移）
    useStore.getState().loadLinkStation()

    // 注入到 LocalClaw 服务 (Native 模式)
    localClawService.injectStore(storeActions as any)

    // 注册连接生命周期回调 — App 层负责加载业务数据
    const unsubConnected = localClawService.onConnected(async (isReconnect) => {
      if (!isReconnect) {
        // 首次连接: 加载所有持久化数据
        try {
          await useStore.getState().loadConversationsFromServer()
          await useStore.getState().loadDunsFromServer()
          await useStore.getState().loadBehaviorRecords()
          await useStore.getState().loadSkillEnvValues()
          console.log('[App] Loaded persisted data from server')
        } catch (e) {
          console.warn('[App] Failed to load persisted data:', e)
        }
        // 重新加载启动时可能失败的数据
        useStore.getState().loadLinkStation()
        soulEvolutionService.init().catch(() => {})
      }
      // 重连时不重新加载全部数据，避免覆盖用户本地操作
    })

    // 注入 SkillStats → Store 响应式桥接
    skillStatsService.injectStoreRefresh(() => {
      useStore.getState().refreshSkillSnapshot()
    })

    // 注册 memoryStore 写回调 → store 缓存增量更新
    memoryStore.onWrite((entries) => {
      useStore.getState().appendMemoryCacheEntries(entries)
    })

    
    // LLM 配置自动恢复：先尝试从后端恢复，再检查localStorage
    const tryRestoreLLMConfig = async () => {
      // 如果 LinkStation 已有有效配置，跳过后端恢复
      try {
        const storeState = useStore.getState()
        const linkStationConfig = storeState.getActiveChatConfig?.()
        if (linkStationConfig?.apiKey && linkStationConfig?.baseUrl && linkStationConfig?.model) {
          storeState.setLlmConnected(true)
          console.log('[App] LLM config already available from LinkStation, skipping server restore')
          return
        }
      } catch {}

      // 先尝试从后端文件系统恢复（解决跨端口问题）
      const serverConfig = await restoreLLMConfigFromServer()
      
      // 再次检查配置（可能已从后端恢复到localStorage）
      const llmConfig = useStore.getState().llmConfig
      const finalConfig = serverConfig || llmConfig
      
      if (finalConfig.apiKey && finalConfig.baseUrl && finalConfig.model) {
        // 更新store状态
        if (serverConfig) {
          useStore.getState().setLlmConfig(serverConfig)
        }
        useStore.getState().setLlmConnected(true)
        console.log('[App] LLM config restored')
      }
    }
    tryRestoreLLMConfig()

    // 种子 Dun: 仅在后端未加载 Dun 时作为 fallback
    // Phase 4: 实际 Dun 数据将从 /duns API 加载
    // 延迟 3 秒检查，给后端加载留出时间
    setTimeout(() => {
      const state = useStore.getState()
      // 如果后端已经加载了 duns (通过 loadAllDataToStore)，则跳过
      if (state.duns.size === 0) {
        const seedDunId = 'skill-scout'
        useStore.getState().addDun({
          id: seedDunId,
          position: { gridX: 3, gridY: -2 },
          scoring: createInitialScoring(),
          visualDNA: simpleVisualDNA(seedDunId),
          label: 'Skill Scout',
          constructionProgress: 1,
          createdAt: Date.now(),
          boundSkillIds: ['skill-scout', 'skill-generator'],
          flavorText: '持续扫描全球 SKILL 社区，发现并安装新能力',
        })
        console.log('[App] Fallback: Seeded Dun (backend not available)')
      }
    }, 3000)

    // 迁移旧 localStorage key (ddos_ → duncrew_)
    migrateLocalStorageKeys()

    // 清理 OpenClaw 遗留 localStorage 数据
    localStorage.removeItem('openclaw_auth_token')
    localStorage.removeItem('openclaw_gateway_url')
    localStorage.removeItem('duncrew_connection_mode')

    // 立即从 localStorage 恢复缓存数据 (无需等待服务器)
    restoreLocalCacheToStore(storeActions)

    // 自动连接到本地服务器 (指数退避, 首次启动宽容重试)
    cancelRetry = localClawService.autoConnect(true)

    // Issue #8: 初始化 soulEvolutionService（加载修正案、启动衰减定时器）
    soulEvolutionService.init().catch((err) => {
      console.warn('[App] soulEvolutionService.init failed:', err)
    })

    // Issue #8: 订阅 run_end 事件 → 驱动灵魂演化
    const unsubSoulEvolution = agentEventBus.subscribe((event) => {
      if (event.type === 'run_end') {
        const dunId = event.dunId || (event.data?.dunId as string | undefined) || ''
        // 从事件数据中重建轻量 ExecTrace（soulEvolutionService 只需 id/task/success）
        const trace: ExecTrace = {
          id: event.runId,
          task: (event.data?.task as string | undefined) || event.runId,
          tools: [],
          success: (event.data?.success as boolean | undefined) ?? true,
          duration: (event.data?.durationMs as number | undefined) ?? 0,
          timestamp: event.ts,
          tags: [],
        }
        soulEvolutionService.onTraceCompleted(trace, dunId)
      }
    })

    // Cleanup on unmount
    return () => {
      if (cancelRetry) cancelRetry()
      unsubConnected()
      localClawService.disconnect()
      unsubSoulEvolution()
      soulEvolutionService.destroy()
    }
  }, [])

  // 刷新前持久化任务状态，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = () => {
      const { activeExecutions, duns, memoryCacheRaw } = useStore.getState()
      if (activeExecutions.length > 0) {
        persistTaskHistory(activeExecutions)
      }
      // 安全网：确保 Dun 数据写入 localStorage
      if (duns.size > 0) {
        try {
          const arr = Array.from(duns.values())
          localStorage.setItem('duncrew_duns', JSON.stringify(arr))
        } catch (_) { /* ignore */ }
      }
      // 安全网：确保记忆缓存写入 localStorage（防抖可能未触发）
      if (memoryCacheRaw.length > 0) {
        try {
          const toCache = memoryCacheRaw
            .filter(r => r.source === 'memory' || r.source === 'l1_memory')
            .slice(0, 300)
          localStorage.setItem(MEMORY_CACHE_STORAGE_KEY, JSON.stringify(toCache))
        } catch (_) { /* ignore */ }
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  const initTheme = useStore((s) => s.initTheme)

  // 初始化主题
  useEffect(() => {
    initTheme()
  }, [initTheme])

  return (
    <div className="flex w-screen h-screen overflow-hidden bg-skin-bg-primary text-skin-text-primary">
      {/* 左侧导航栏 */}
      <Dock />

      {/* 主内容区域 */}
      <div className="relative flex-1 min-w-0 h-full overflow-hidden">
        {/* Background layer: always present */}
        <ErrorBoundary>
          <WorldView />
        </ErrorBoundary>

        {/* Content layer: active house */}
        <AnimatePresence mode="wait">
          {currentView !== 'world' && currentHouse && (
            <ErrorBoundary key={currentView}>
              <HouseContainer house={currentHouse}>
                <currentHouse.component />
              </HouseContainer>
            </ErrorBoundary>
          )}
        </AnimatePresence>

        {/* Connection control panel */}
        <ConnectionPanel />
      </div>

      {/* AI Chat panel - Blueprint AssistantModal */}
      <AIChatPanel />

      {/* Observer: Dun build proposal modal */}
      <BuildProposalModal />
      {/* Observer: Skill discovery proposal card */}
      <SkillProposalCard />
      <ApprovalModal />

      {/* Dun detail panel */}
      <DunDetailPanel />

      {/* Interrupted tasks warning */}
      <InterruptedTasksWarning />

      {/* Crash recovery banner */}
      <CrashRecoveryBanner />

      {/* Auto-update banner */}
      <UpdateBanner />

      {/* Toast notifications */}
      <ToastContainer />

      {/* Notification Center & Locale Toggle - fixed top-right */}
      <div className="fixed top-3 right-4 z-[9998] flex items-center gap-2">
        <LocaleToggle />
        <NotificationCenter />
      </div>

      {/* 首次启动引导 */}
      <AnimatePresence>
        {showSetup && (
          <FirstLaunchSetup onComplete={() => setShowSetup(false)} />
        )}
      </AnimatePresence>
    </div>
  )
}

export default App
