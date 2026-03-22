/**
 * SkillsHouseView - 技工学院主容器
 *
 * 组合:
 * - 左侧 Glassmorphism 导航 (SkillsSidebar)
 * - 中间内容区 (SkillsGridView / SkillsMindMapView)
 * - 右侧督查抽屉 (SkillsInspectorPanel)
 *
 * 背景: #FBFBFC + 浅灰色点阵底噪
 */

import { useState, useMemo, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useStore } from '@/store'
import {
  mapAllSkills,
  groupByDomain,
  filterBySpecial,
  type UISkillModel,
} from '@/utils/skillsHouseMapper'
import { SkillsSidebar, type SidebarSelection } from './SkillsSidebar'
import { SkillsGridView } from './SkillsGridView'
import { SkillsMindMapView } from './SkillsMindMapView'
import { SkillsInspectorPanel } from './SkillsInspectorPanel'

export function SkillsHouseView() {
  const openClawSkills = useStore((s) => s.openClawSkills)
  const skillEnvValues = useStore((s) => s.skillEnvValues)
  const setSkillEnvValue = useStore((s) => s.setSkillEnvValue)
  const statsVersion = useStore((s) => s.skillStatsVersion)

  // 侧边栏状态
  const [selection, setSelection] = useState<SidebarSelection>({
    kind: 'special',
    filter: 'all',
  })
  const [viewMode, setViewMode] = useState<'grid' | 'mindmap'>('grid')

  // 督查抽屉
  const [inspecting, setInspecting] = useState<UISkillModel | null>(null)

  // 映射 OpenClawSkill → UISkillModel
  // statsVersion 作为依赖保证 usageCount 刷新
  const allModels = useMemo(
    () => mapAllSkills(openClawSkills, skillEnvValues),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openClawSkills, skillEnvValues, statsVersion],
  )

  // 域分组
  const domains = useMemo(() => groupByDomain(allModels), [allModels])

  // 根据侧边栏选择过滤
  const filteredSkills = useMemo(() => {
    if (selection.kind === 'special') {
      return filterBySpecial(allModels, selection.filter)
    }
    const group = domains.find((d) => d.id === selection.domainId)
    return group?.skills ?? []
  }, [selection, allModels, domains])

  // 统计数字
  const brokenCount = useMemo(
    () => allModels.filter((m) => m.status === 'error' || m.missingReqs.length > 0).length,
    [allModels],
  )
  const apiCount = useMemo(
    () => allModels.filter((m) => m.requiresAPI).length,
    [allModels],
  )
  const builtinCount = useMemo(
    () => allModels.filter((m) => m.source === 'builtin').length,
    [allModels],
  )
  const communityCount = useMemo(
    () => allModels.filter((m) => m.source === 'community').length,
    [allModels],
  )
  const userCount = useMemo(
    () => allModels.filter((m) => m.source === 'user').length,
    [allModels],
  )

  // 是否使用思维导图
  const showMindMap =
    selection.kind === 'special' && selection.filter === 'all' && viewMode === 'mindmap'

  const handleSelectSkill = useCallback((skill: UISkillModel) => {
    setInspecting(skill)
  }, [])

  const handleCloseInspector = useCallback(() => {
    setInspecting(null)
  }, [])

  const handleEnvChange = useCallback((key: string, value: string) => {
    if (inspecting) {
      setSkillEnvValue(inspecting._raw.name, key, value)
    }
  }, [inspecting, setSkillEnvValue])

  // 当前选中技能的 envValues
  const inspectingEnvValues = inspecting
    ? skillEnvValues[inspecting._raw.name] || {}
    : {}

  return (
    <div
      className="relative flex w-full h-full overflow-hidden"
      style={{
        backgroundColor: '#FBFBFC',
        backgroundImage: 'radial-gradient(circle, #e5e5e5 1px, transparent 1px)',
        backgroundSize: '24px 24px',
      }}
    >
      {/* 左侧导航 */}
      <SkillsSidebar
        domains={domains}
        totalCount={allModels.length}
        brokenCount={brokenCount}
        apiCount={apiCount}
        builtinCount={builtinCount}
        communityCount={communityCount}
        userCount={userCount}
        selection={selection}
        onSelect={setSelection}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
      />

      {/* 中间内容区 */}
      <div className="flex-1 min-w-0 h-full relative">
        {showMindMap ? (
          <SkillsMindMapView
            domains={domains}
            allSkills={allModels}
            onSelectSkill={handleSelectSkill}
          />
        ) : (
          <SkillsGridView
            skills={filteredSkills}
            allSkills={allModels}
            onSelectSkill={handleSelectSkill}
          />
        )}
      </div>

      {/* 右侧督查抽屉 */}
      <AnimatePresence>
        {inspecting && (
          <SkillsInspectorPanel
            key={inspecting.id}
            skill={inspecting}
            envValues={inspectingEnvValues}
            onEnvChange={handleEnvChange}
            onClose={handleCloseInspector}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
