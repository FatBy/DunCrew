import type { StateCreator } from 'zustand'
import type { NexusEntity, CameraState, GridPosition, RenderSettings, VisualDNA, NexusScoring } from '@/types'
import { createInitialScoring } from '@/types'
import type { WorldTheme } from '@/rendering/types'
import { localServerService } from '@/services/localServerService'

/** 建造动画总时长 (ms) */
const CONSTRUCTION_DURATION_MS = 3000

/**
 * 基于 createdAt 时间戳计算建造进度 (0~1)
 * 无论 tick 循环是否运行、页面是否刷新，进度始终正确
 */
export function getConstructionProgress(nexus: NexusEntity): number {
  // constructionProgress === 1 说明已标记完成，直接返回
  if (nexus.constructionProgress >= 1) return 1
  // 如果 constructionProgress 已经是 1 (旧数据)
  const elapsed = Date.now() - nexus.createdAt
  if (elapsed >= CONSTRUCTION_DURATION_MS) return 1
  return Math.min(1, elapsed / CONSTRUCTION_DURATION_MS)
}

// 后端数据键名
const DATA_KEY_NEXUSES = 'nexuses_state'

// localStorage key for Nexus persistence (备份/缓存)
const NEXUS_STORAGE_KEY = 'duncrew_nexuses'

// 区分"首次加载"和"运行时新增"：首次加载时新 Nexus 直接显示，运行时新增播放建造动画
let _initialLoadDone = false

// ---- 持久化函数 (后端 + localStorage 双写) ----

function saveNexusesToStorage(nexuses: Map<string, NexusEntity>): void {
  try {
    const arr = Array.from(nexuses.values())
    // 同步写入 localStorage (快速缓存)
    localStorage.setItem(NEXUS_STORAGE_KEY, JSON.stringify(arr))
    // 异步写入后端 (持久化)
    localServerService.setData(DATA_KEY_NEXUSES, arr).catch(() => {
      console.warn('[WorldSlice] Failed to save nexuses to server')
    })
  } catch (e) {
    console.warn('[WorldSlice] Failed to save nexuses to localStorage:', e)
  }
}

function loadNexusesFromStorage(): Map<string, NexusEntity> {
  try {
    const saved = localStorage.getItem(NEXUS_STORAGE_KEY)
    if (saved) {
      const arr: NexusEntity[] = JSON.parse(saved)
      const map = new Map<string, NexusEntity>()
      for (const nexus of arr) {
        map.set(nexus.id, nexus)
      }
      return map
    }
  } catch (e) {
    console.warn('[WorldSlice] Failed to load nexuses from localStorage:', e)
  }
  return new Map<string, NexusEntity>()
}

// ISO 投影常量
const TILE_WIDTH = 128
const TILE_HEIGHT = 64

// 简易同步哈希 -> VisualDNA (不依赖 crypto.subtle)
export function simpleVisualDNA(id: string): VisualDNA {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0
  }
  const h = Math.abs(hash)
  
  const primaryHue = h % 360
  const geometryVariant = h % 4
  
  return {
    primaryHue,
    primarySaturation: 50 + (h >> 8) % 40,
    primaryLightness: 35 + (h >> 16) % 30,
    accentHue: (primaryHue + 60) % 360,
    textureMode: 'solid',
    glowIntensity: 0.5 + ((h >> 4) % 50) / 100,
    geometryVariant,
  }
}

// 初始状态: 从 localStorage 加载或空世界
function createDemoNexuses(): Map<string, NexusEntity> {
  return loadNexusesFromStorage()
}

// 执行结果类型
export interface NexusExecutionResult {
  nexusId: string
  nexusName: string
  status: 'success' | 'error'
  output?: string
  error?: string
  timestamp: number
}

export interface WorldSlice {
  // State
  nexuses: Map<string, NexusEntity>
  camera: CameraState
  selectedNexusId: string | null
  activeNexusId: string | null
  renderSettings: RenderSettings
  worldTheme: WorldTheme
  // 执行状态追踪
  executingNexusId: string | null
  executionStartTime: number | null
  lastExecutionResult: NexusExecutionResult | null

  // Nexus Actions
  addNexus: (nexus: NexusEntity) => void
  removeNexus: (id: string) => void
  updateNexusScoring: (id: string, scoring: NexusScoring) => void
  updateNexusPosition: (id: string, position: GridPosition) => void
  selectNexus: (id: string | null) => void
  setActiveNexus: (id: string | null) => void
  setNexusesFromServer: (nexuses: Array<Partial<NexusEntity> & { id: string; name?: string; description?: string; sopContent?: string }>) => void
  tickConstructionAnimations: (deltaMs: number) => void

  // Camera Actions
  setCameraPosition: (x: number, y: number) => void
  panCamera: (dx: number, dy: number) => void
  setZoom: (zoom: number) => void
  focusOnNexus: (id: string) => void

  // Settings
  setRenderSettings: (settings: Partial<RenderSettings>) => void
  setWorldTheme: (theme: WorldTheme) => void

  // Execution Actions
  startNexusExecution: (nexusId: string) => void
  completeNexusExecution: (nexusId: string, result: Omit<NexusExecutionResult, 'nexusId' | 'nexusName' | 'timestamp'>) => void

  // Skill Binding (Agent 通过 Extension 绑定技能)
  bindSkillToNexus: (nexusId: string, skillName: string) => void

  // 从后端加载数据 (应用启动后调用)
  loadNexusesFromServer: () => Promise<void>
  
  // OpenClaw agents → DunCrew Nexuses 同步
  syncAgentsAsNexuses: (agents: Array<{ id: string; name?: string; identity?: { name?: string; emoji?: string } }>, skills: Array<{ name: string; description?: string; status?: string }>) => void
}

export const createWorldSlice: StateCreator<WorldSlice> = (set, get) => ({
  // 初始状态
  nexuses: createDemoNexuses(),
  camera: { x: 0, y: 0, zoom: 1 },
  selectedNexusId: null,
  activeNexusId: null,
  renderSettings: {
    showGrid: true,
    showParticles: true,
    showLabels: true,
    enableGlow: true,
  },
  worldTheme: 'dashboard' as WorldTheme,
  // 执行状态初始值
  executingNexusId: null,
  executionStartTime: null,
  lastExecutionResult: null,

  // ---- Nexus Actions ----

  addNexus: (nexus) => set((state) => {
    const next = new Map(state.nexuses)
    next.set(nexus.id, { ...nexus, updatedAt: Date.now() })
    saveNexusesToStorage(next)
    return { nexuses: next }
  }),

  removeNexus: (id) => set((state) => {
    const next = new Map(state.nexuses)
    next.delete(id)
    saveNexusesToStorage(next)
    return {
      nexuses: next,
      selectedNexusId: state.selectedNexusId === id ? null : state.selectedNexusId,
      activeNexusId: state.activeNexusId === id ? null : state.activeNexusId,
    }
  }),

  updateNexusScoring: (id, scoring) => set((state) => {
    const nexus = state.nexuses.get(id)
    if (!nexus) return state
    const next = new Map(state.nexuses)
    next.set(id, { ...nexus, scoring, updatedAt: Date.now() })
    saveNexusesToStorage(next)
    return { nexuses: next }
  }),

  bindSkillToNexus: (nexusId, skillName) => set((state) => {
    const nexus = state.nexuses.get(nexusId)
    if (!nexus) return state
    const existing = nexus.boundSkillIds || []
    if (existing.includes(skillName)) return state
    const next = new Map(state.nexuses)
    next.set(nexusId, { ...nexus, boundSkillIds: [...existing, skillName], updatedAt: Date.now() })
    saveNexusesToStorage(next)
    return { nexuses: next }
  }),

  updateNexusPosition: (id, position) => set((state) => {
    const nexus = state.nexuses.get(id)
    if (!nexus) return state
    
    // 简单网格吸附
    const snappedPosition = { gridX: Math.round(position.gridX), gridY: Math.round(position.gridY) }
    
    const next = new Map(state.nexuses)
    next.set(id, { ...nexus, position: snappedPosition, updatedAt: Date.now() })
    saveNexusesToStorage(next)
    return { nexuses: next }
  }),

  selectNexus: (id) => set({ selectedNexusId: id }),

  setActiveNexus: (id) => set({ activeNexusId: id }),

  setNexusesFromServer: (nexuses) => set((state) => {
    const next = new Map(state.nexuses)
    
    // 使用已占用位置集合来避免重叠
    const usedPositions = new Set<string>()
    for (const [, n] of next) {
      usedPositions.add(`${n.position.gridX},${n.position.gridY}`)
    }
    
    let autoIdx = 0
    
    for (const serverNexus of nexuses) {
      const existing = next.get(serverNexus.id)

      // V2: 合并 scoring (本地已有分数优先，防止服务器空数据覆盖)
      const serverScoring = serverNexus.scoring
      const hasRealServerScoring = serverScoring && typeof serverScoring === 'object' && (serverScoring.score > 0 || serverScoring.totalRuns > 0)
      const scoring = hasRealServerScoring ? serverScoring : (existing?.scoring || createInitialScoring())

      // 构建 VisualDNA：优先使用服务器提供的 visual_dna，否则从 ID 生成
      let visualDNA: VisualDNA
      const serverVDNA = serverNexus.visualDNA
      if (serverVDNA && typeof serverVDNA === 'object' && 'primaryHue' in serverVDNA) {
        visualDNA = {
          primaryHue: serverVDNA.primaryHue ?? 180,
          primarySaturation: serverVDNA.primarySaturation ?? 70,
          primaryLightness: serverVDNA.primaryLightness ?? 50,
          accentHue: serverVDNA.accentHue ?? 240,
          textureMode: serverVDNA.textureMode ?? 'solid',
          glowIntensity: serverVDNA.glowIntensity ?? 0.7,
          geometryVariant: serverVDNA.geometryVariant ?? 0,
        }
      } else {
        visualDNA = existing?.visualDNA || simpleVisualDNA(serverNexus.id)
      }

      // 位置分配：优先保留已有位置，否则按网格递增分配
      let position = existing?.position
      if (!position || (position.gridX === 0 && position.gridY === 0 && usedPositions.has('0,0'))) {
        // 简单行布局：每行5个，间距2
        let gx = 0, gy = 0
        do {
          autoIdx++
          gx = (autoIdx % 5) * 2 - 4
          gy = Math.floor(autoIdx / 5) * 2 - 2
        } while (usedPositions.has(`${gx},${gy}`))
        position = { gridX: gx, gridY: gy }
      }
      usedPositions.add(`${position.gridX},${position.gridY}`)

      next.set(serverNexus.id, {
        // 保留前端已有的状态 (constructionProgress 等)
        ...existing,
        // 从服务器合并的数据
        id: serverNexus.id,
        position,
        scoring,
        visualDNA,
        label: serverNexus.label || serverNexus.name || serverNexus.id,
        constructionProgress: existing?.constructionProgress ?? (_initialLoadDone ? 0 : 1),
        createdAt: existing?.createdAt || Date.now(),
        // 统一使用 boundSkillIds (后端字段名为 skillDependencies)
        boundSkillIds: (serverNexus as any).skillDependencies || serverNexus.boundSkillIds || [],
        flavorText: serverNexus.flavorText || (serverNexus as any).description || '',
        // Phase 4: File-based Nexus fields
        sopContent: serverNexus.sopContent,
        triggers: serverNexus.triggers,
        version: serverNexus.version,
        location: serverNexus.location,
        path: serverNexus.path,
        projectPath: (serverNexus as any).projectPath || existing?.projectPath,
        // Phase 5: 目标函数驱动 (Objective-Driven Execution)
        objective: serverNexus.objective,
        metrics: serverNexus.metrics,
        strategy: serverNexus.strategy,
        skillsConfirmed: (serverNexus as any).skillsConfirmed || existing?.skillsConfirmed || false,
      })
    }
    saveNexusesToStorage(next)
    return { nexuses: next }
  }),

  tickConstructionAnimations: (_deltaMs) => set((state) => {
    // V2: 基于 createdAt 时间戳判定建造完成，不再依赖逐帧递增
    // 此函数只负责将已超时的 Nexus 标记为 constructionProgress=1 并持久化
    const now = Date.now()
    let anyCompleted = false
    let hasBuilding = false
    const next = new Map(state.nexuses)

    for (const [id, nexus] of next) {
      if (nexus.constructionProgress < 1) {
        const elapsed = now - nexus.createdAt
        if (elapsed >= CONSTRUCTION_DURATION_MS) {
          // 时间已到，标记为完成
          next.set(id, { ...nexus, constructionProgress: 1 })
          anyCompleted = true
        } else {
          hasBuilding = true
        }
      }
    }

    if (anyCompleted) {
      saveNexusesToStorage(next)
      return { nexuses: next }
    }
    // 仍有建造中但未完成的 → 需要触发重渲染让 UI 显示实时进度
    // 返回新 Map 引用来触发 Zustand 通知
    if (hasBuilding) {
      return { nexuses: new Map(state.nexuses) }
    }
    return state
  }),

  // ---- Camera Actions ----

  setCameraPosition: (x, y) => set({ camera: { ...get().camera, x, y } }),

  panCamera: (dx, dy) => set((state) => ({
    camera: {
      ...state.camera,
      x: state.camera.x + dx,
      y: state.camera.y + dy,
    },
  })),

  setZoom: (zoom) => set((state) => ({
    camera: {
      ...state.camera,
      zoom: Math.max(0.5, Math.min(2.0, zoom)),
    },
  })),

  focusOnNexus: (id) => {
    const nexus = get().nexuses.get(id)
    if (!nexus) return
    const { gridX, gridY } = nexus.position
    // ISO 投影：将 grid 坐标转为世界中心偏移
    const worldX = (gridX - gridY) * TILE_WIDTH / 2
    const worldY = (gridX + gridY) * TILE_HEIGHT / 2
    set({
      camera: { ...get().camera, x: -worldX, y: -worldY },
      selectedNexusId: id,
    })
  },

  // ---- Settings ----

  setRenderSettings: (settings) => set((state) => ({
    renderSettings: { ...state.renderSettings, ...settings },
  })),

  setWorldTheme: (theme) => set({ worldTheme: theme }),

  // ---- Execution Actions ----

  startNexusExecution: (nexusId) => set((state) => {
    // 更新 lastUsedAt 时间戳
    const nexus = state.nexuses.get(nexusId)
    if (nexus) {
      const next = new Map(state.nexuses)
      next.set(nexusId, { ...nexus, lastUsedAt: Date.now(), updatedAt: Date.now() })
      saveNexusesToStorage(next)
      return {
        nexuses: next,
        executingNexusId: nexusId,
        executionStartTime: Date.now(),
      }
    }
    return {
      executingNexusId: nexusId,
      executionStartTime: Date.now(),
    }
  }),

  completeNexusExecution: (nexusId, result) => set((state) => {
    // 仅当完成的是当前正在执行的 Nexus 时才更新
    if (state.executingNexusId !== nexusId) return state
    const nexus = state.nexuses.get(nexusId)

    // 更新 nexus 实体的 updatedAt 并持久化
    let nextNexuses = state.nexuses
    if (nexus) {
      nextNexuses = new Map(state.nexuses)
      nextNexuses.set(nexusId, { ...nexus, updatedAt: Date.now() })
      saveNexusesToStorage(nextNexuses)
    }

    return {
      nexuses: nextNexuses,
      executingNexusId: null,
      executionStartTime: null,
      lastExecutionResult: {
        nexusId,
        nexusName: nexus?.label || nexusId,
        status: result.status,
        output: result.output,
        error: result.error,
        timestamp: Date.now(),
      },
    }
  }),

  // 从后端加载数据 (应用启动后调用)
  // 合并三个数据源: 当前 store(初始化时从 localStorage 加载) + 后端 + localStorage
  loadNexusesFromServer: async () => {
    try {
      // 1. 当前 store 数据 (初始化时已从 localStorage 加载)
      const storeNexuses = get().nexuses
      
      // 2. 读取后端数据
      const serverNexuses = await localServerService.getData<NexusEntity[]>(DATA_KEY_NEXUSES)
      
      // 3. 读取 localStorage 数据 (可能有其他 tab 写入的新数据)
      const localNexuses = loadNexusesFromStorage()
      
      // 4. 合并三方数据 (以 updatedAt/createdAt 最新者为准)
      const mergedMap = new Map<string, NexusEntity>()
      
      // 先添加当前 store 数据
      for (const [id, nexus] of storeNexuses) {
        mergedMap.set(id, nexus)
      }
      
      // 再合并 localStorage 数据 (如果更新)
      for (const [id, localNexus] of localNexuses) {
        const existing = mergedMap.get(id)
        const localTime = localNexus.updatedAt || localNexus.createdAt || 0
        const existingTime = existing?.updatedAt || existing?.createdAt || 0
        if (!existing || localTime > existingTime) {
          mergedMap.set(id, localNexus)
        }
      }
      
      // 最后合并后端数据 (如果更新)
      if (serverNexuses && serverNexuses.length > 0) {
        for (const serverNexus of serverNexuses) {
          const existing = mergedMap.get(serverNexus.id)
          
          // 保护本地已有的 scoring：服务器数据通常不含 scoring
          const sScoring = serverNexus.scoring
          const hasRealScoring = sScoring && typeof sScoring === 'object' && (sScoring.score > 0 || sScoring.totalRuns > 0)
          
          if (!existing) {
            // 新 Nexus：直接添加
            mergedMap.set(serverNexus.id, serverNexus)
          } else {
            // 已存在：合并服务器的元数据字段，但始终保留本地 scoring
            const preservedScoring = hasRealScoring ? sScoring : (existing.scoring || createInitialScoring())
            mergedMap.set(serverNexus.id, {
              ...existing,
              // 从服务器更新的元数据字段
              label: serverNexus.label || (serverNexus as any).name || existing.label,
              flavorText: serverNexus.flavorText || (serverNexus as any).description || existing.flavorText,
              boundSkillIds: (serverNexus as any).skillDependencies || serverNexus.boundSkillIds || existing.boundSkillIds,
              sopContent: serverNexus.sopContent || existing.sopContent,
              triggers: serverNexus.triggers || existing.triggers,
              version: serverNexus.version || existing.version,
              path: serverNexus.path || existing.path,
              projectPath: (serverNexus as any).projectPath || existing.projectPath,
              location: serverNexus.location || existing.location,
              objective: serverNexus.objective || existing.objective,
              metrics: serverNexus.metrics || existing.metrics,
              strategy: serverNexus.strategy || existing.strategy,
              skillsConfirmed: (serverNexus as any).skillsConfirmed || existing.skillsConfirmed || false,
              // 始终保留本地 scoring 和位置
              scoring: preservedScoring!,
              position: existing.position,
              visualDNA: existing.visualDNA,
              createdAt: existing.createdAt,
              updatedAt: existing.updatedAt,
              constructionProgress: existing.constructionProgress,
            })
          }
        }
      }
      
      if (mergedMap.size > 0) {
        set({ nexuses: mergedMap })
        
        // 5. 双写同步 (确保浏览器数据也推送到后端)
        const mergedArray = [...mergedMap.values()]
        localStorage.setItem(NEXUS_STORAGE_KEY, JSON.stringify(mergedArray))
        localServerService.setData(DATA_KEY_NEXUSES, mergedArray).catch(() => {})
        
        console.log('[World] Merged nexuses from 3 sources:',
          'store=' + storeNexuses.size,
          'localStorage=' + localNexuses.size,
          'server=' + (serverNexuses?.length || 0),
          '→ total=' + mergedMap.size)
      }
    } catch (error) {
      console.warn('[World] Failed to load from server, keeping current store data:', error)
      // 失败时确保当前 store 数据推送到后端
      const current = get().nexuses
      if (current.size > 0) {
        const arr = [...current.values()]
        localServerService.setData(DATA_KEY_NEXUSES, arr).catch(() => {})
      }
    }
    // 标记首次加载完成，后续 setNexusesFromServer 中新 Nexus 将触发建造动画
    _initialLoadDone = true
  },
  
  syncAgentsAsNexuses: (agents, _skills) => set((state) => {
    const next = new Map(state.nexuses)
    let changed = false
    
    // 收集已占用位置
    const usedPositions = new Set<string>()
    for (const [, nexus] of next) {
      usedPositions.add(`${nexus.position.gridX},${nexus.position.gridY}`)
    }
    
    let autoIdx = 0
    
    for (const agent of agents) {
      const agentId = `oc-agent-${agent.id}`
      const existing = next.get(agentId)
      
      // 如果已存在且不是 OpenClaw 源的 Nexus，跳过（不覆盖用户创建的）
      if (existing && !existing.source?.startsWith('openclaw')) continue
      
      const displayName = agent.name || agent.identity?.name || agent.id
      const visualDNA = existing?.visualDNA || simpleVisualDNA(agentId)
      
      // 位置分配：保留已有位置或分配新位置
      let position = existing?.position
      if (!position || (position.gridX === 0 && position.gridY === 0 && usedPositions.has('0,0'))) {
        let gx = 0, gy = 0
        do {
          autoIdx++
          gx = (autoIdx % 5) * 2 - 4
          gy = Math.floor(autoIdx / 5) * 2 - 2
        } while (usedPositions.has(`${gx},${gy}`))
        position = { gridX: gx, gridY: gy }
      }
      usedPositions.add(`${position.gridX},${position.gridY}`)
      
      next.set(agentId, {
        ...existing,
        id: agentId,
        label: displayName,
        flavorText: `OpenClaw Agent: ${agent.id}`,
        position,
        scoring: existing?.scoring || createInitialScoring(),
        visualDNA,
        constructionProgress: 1,
        createdAt: existing?.createdAt || Date.now(),
        boundSkillIds: existing?.boundSkillIds || [],
        source: `openclaw:${agent.id}`,
        // 保留 identity 信息
        agentIdentity: agent.identity ? {
          name: agent.identity.name,
          emoji: agent.identity.emoji,
        } : undefined,
      } as NexusEntity)
      changed = true
    }
    
    if (changed) {
      console.log('[World] Synced OpenClaw agents as Nexuses:', agents.map(a => a.id))
      saveNexusesToStorage(next)
    }
    return changed ? { nexuses: next } : {}
  }),
})
