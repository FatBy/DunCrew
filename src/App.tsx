import { useEffect } from 'react'
import { AnimatePresence } from 'framer-motion'
import { WorldView } from '@/components/WorldView'
import { Dock } from '@/components/Dock'
import { HouseContainer } from '@/components/HouseContainer'
import { ConnectionPanel } from '@/components/ConnectionPanel'
import { ToastContainer } from '@/components/Toast'
import { AIChatPanel } from '@/components/ai/AIChatPanel'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { BuildProposalModal } from '@/components/world/BuildProposalModal'
import { ApprovalModal } from '@/components/ApprovalModal'
import { NexusDetailPanel } from '@/components/world/NexusDetailPanel'
import { InterruptedTasksWarning } from '@/components/InterruptedTasksWarning'
import { CrashRecoveryBanner } from '@/components/CrashRecoveryBanner'
import { useStore } from '@/store'
import { getHouseById } from '@/houses/registry'
import { openClawService } from '@/services/OpenClawService'
import { localClawService } from '@/services/LocalClawService'
import { skillStatsService } from '@/services/skillStatsService'
import { memoryStore } from '@/services/memoryStore'
import { getLocalSoulData, getLocalSkills, getLocalMemories } from '@/utils/localDataProvider'
import { simpleVisualDNA } from '@/store/slices/worldSlice'
import { createInitialScoring } from '@/types'
import { restoreLLMConfigFromServer } from '@/services/llmService'
import { persistTaskHistory } from '@/store/slices/sessionsSlice'
import { getCachedMBTIResult, getCachedAxes } from '@/services/mbtiAnalyzer'

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

  // Initialize services on mount
  useEffect(() => {
    const storeActions = {
      // Connection
      setConnectionStatus: useStore.getState().setConnectionStatus,
      setConnectionMode: useStore.getState().setConnectionMode,
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
      
      // Gateway sessions → DunCrew 对话回填
      syncGatewaySessionsToConversations: useStore.getState().syncGatewaySessionsToConversations,
      
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
      
      // P4: Nexus 数据注入
      setNexusesFromServer: useStore.getState().setNexusesFromServer,
      setActiveNexus: useStore.getState().setActiveNexus,
      updateNexusScoring: useStore.getState().updateNexusScoring,
      bindSkillToNexus: useStore.getState().bindSkillToNexus,
      getNexuses: () => useStore.getState().nexuses,
      syncAgentsAsNexuses: useStore.getState().syncAgentsAsNexuses,
      getConnectionMode: () => useStore.getState().connectionMode,
      get activeNexusId() { return useStore.getState().activeNexusId },
      get nexuses() { return useStore.getState().nexuses },
    }

    // 注入到 OpenClaw 服务 (兼容模式)
    openClawService.injectStore(storeActions)
    
    // 注入到 LocalClaw 服务 (Native 模式)
    localClawService.injectStore(storeActions as any)

    // 注入 SkillStats → Store 响应式桥接
    skillStatsService.injectStoreRefresh(() => {
      useStore.getState().refreshSkillSnapshot()
    })

    // 注册 memoryStore 写回调 → store 缓存增量更新
    memoryStore.onWrite((entries) => {
      useStore.getState().appendMemoryCacheEntries(entries)
    })

    // 自动重连: 恢复上次的连接状态
    const savedMode = localStorage.getItem('duncrew_connection_mode')
    
    // LLM 配置自动恢复：先尝试从后端恢复，再检查localStorage
    const tryRestoreLLMConfig = async () => {
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

    // 种子 Nexus: 仅在后端未加载 Nexus 时作为 fallback
    // Phase 4: 实际 Nexus 数据将从 /nexuses API 加载
    // 延迟 3 秒检查，给后端加载留出时间
    setTimeout(() => {
      const state = useStore.getState()
      // 如果后端已经加载了 nexuses (通过 loadAllDataToStore)，则跳过
      if (state.nexuses.size === 0) {
        const seedNexusId = 'skill-scout'
        useStore.getState().addNexus({
          id: seedNexusId,
          position: { gridX: 3, gridY: -2 },
          scoring: createInitialScoring(),
          visualDNA: simpleVisualDNA(seedNexusId),
          label: 'Skill Scout',
          constructionProgress: 1,
          createdAt: Date.now(),
          boundSkillIds: ['skill-scout', 'skill-generator'],
          flavorText: '持续扫描全球 SKILL 社区，发现并安装新能力',
        })
        console.log('[App] Fallback: Seeded Nexus (backend not available)')
      }
    }, 3000)

    if (savedMode) {
      useStore.getState().setConnectionMode(savedMode as 'native' | 'openclaw')

      if (savedMode === 'native') {
        // 迁移旧 localStorage key (ddos_ → duncrew_)
        migrateLocalStorageKeys()

        // 立即从 localStorage 恢复缓存数据 (无需等待服务器)
        restoreLocalCacheToStore(storeActions)

        // Native 模式: 静默尝试连接本地服务器
        console.log('[App] Auto-reconnecting to Native server...')
        localClawService.connect().then(async success => {
          if (success) {
            console.log('[App] Auto-reconnect successful')
            
            // 从后端加载持久化数据 (会话、Nexus 状态)
            try {
              await useStore.getState().loadConversationsFromServer()
              await useStore.getState().loadNexusesFromServer()
              await useStore.getState().loadBehaviorRecords()
              await useStore.getState().loadSkillEnvValues()
              console.log('[App] Loaded persisted data from server')
            } catch (e) {
              console.warn('[App] Failed to load persisted data:', e)
            }
          } else {
            console.log('[App] Auto-reconnect failed, server may not be running')
            // 静默失败 - 不显示错误状态，保持断开
            useStore.getState().setConnectionStatus('disconnected')
            useStore.getState().setSessionsLoading(false)
            useStore.getState().setChannelsLoading(false)
            useStore.getState().setDevicesLoading(false)
          }
        })
      } else if (savedMode === 'openclaw') {
        // OpenClaw 模式: 使用保存的凭据重连
        const savedToken = localStorage.getItem('openclaw_auth_token')
        const savedGateway = localStorage.getItem('openclaw_gateway_url')
        if (savedToken && savedGateway) {
          console.log('[App] Auto-reconnecting to OpenClaw...')
          openClawService.setGatewayUrl(savedGateway)
          openClawService.setAuthToken(savedToken)
          openClawService.connect()
          // 恢复本地持久化的对话数据（与 Native 模式一致）
          useStore.getState().loadConversationsFromServer().catch((e) => {
            console.warn('[App] Failed to load conversations for OpenClaw mode:', e)
          })
          // 恢复 Nexus 持久化数据
          useStore.getState().loadNexusesFromServer().catch((e) => {
            console.warn('[App] Failed to load nexuses for OpenClaw mode:', e)
          })
        }
      }
    } else {
      // 首次使用: 所有 loading 设为 false 以显示默认内容
      useStore.getState().setSessionsLoading(false)
      useStore.getState().setChannelsLoading(false)
      useStore.getState().setDevicesLoading(false)
    }

    // Cleanup on unmount
    return () => {
      openClawService.disconnect()
      localClawService.disconnect()
    }
  }, [])

  // 刷新前持久化任务状态，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = () => {
      const { activeExecutions, nexuses } = useStore.getState()
      if (activeExecutions.length > 0) {
        persistTaskHistory(activeExecutions)
      }
      // 安全网：确保 Nexus 数据写入 localStorage
      if (nexuses.size > 0) {
        try {
          const arr = Array.from(nexuses.values())
          localStorage.setItem('duncrew_nexuses', JSON.stringify(arr))
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

      {/* Observer: Nexus build proposal modal */}
      <BuildProposalModal />
      <ApprovalModal />

      {/* Nexus detail panel */}
      <NexusDetailPanel />

      {/* Interrupted tasks warning */}
      <InterruptedTasksWarning />

      {/* Crash recovery banner */}
      <CrashRecoveryBanner />

      {/* Toast notifications */}
      <ToastContainer />
    </div>
  )
}

export default App
