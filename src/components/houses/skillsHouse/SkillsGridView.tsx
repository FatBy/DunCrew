/**
 * SkillsGridView - 网格商店模式
 *
 * V2: 去掉域折叠视图，默认按 rankScore 平铺所有技能
 * - 顶部搜索栏 + 安装/创建按钮
 * - "所有技能"默认展示: 最近使用横条 + 按评分排序的卡片网格
 * - 搜索/点击侧边栏分类时展示过滤后的卡片网格
 */

import { useState, useCallback, useMemo, useRef } from 'react'
import { Search, Upload, Sparkles, Loader2, Check, AlertCircle } from 'lucide-react'
import { SkillGridCard } from './SkillGridCard'
import { SkillCreateDialog } from '../skill/SkillCreateDialog'
import { useStore } from '@/store'
import { getServerUrl as _getServerUrl } from '@/utils/env'
import type { UISkillModel } from '@/utils/skillsHouseMapper'

interface SkillsGridViewProps {
  skills: UISkillModel[]
  allSkills: UISkillModel[]
  /** @deprecated 不再使用域折叠视图，保留接口兼容 */
  domains?: unknown[]
  isShowingAll: boolean
  onSelectSkill: (skill: UISkillModel) => void
}

/** 前端多字段模糊匹配 */
function fuzzyMatch(skill: UISkillModel, query: string): boolean {
  const lowerQuery = query.toLowerCase()
  const tokens = lowerQuery.split(/\s+/).filter(Boolean)
  const searchable = `${skill.name} ${skill.desc} ${skill.tags.join(' ')} ${skill._raw.keywords?.join(' ') ?? ''}`.toLowerCase()
  return tokens.every((token) => searchable.includes(token))
}

export function SkillsGridView({ skills, allSkills, isShowingAll, onSelectSkill }: SkillsGridViewProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [installStatus, setInstallStatus] = useState<{ type: 'idle' | 'uploading' | 'success' | 'error'; message?: string }>({ type: 'idle' })
  const fileInputRef = useRef<HTMLInputElement>(null)
  const refreshSkills = useStore((s) => s.refreshSkills)
  const toggleSkillEnabled = useStore((s) => s.toggleSkillEnabled)

  const handleToggleEnabled = useCallback(async (skillName: string, enabled: boolean) => {
    await toggleSkillEnabled(skillName, enabled)
  }, [toggleSkillEnabled])

  // 搜索过滤
  const isSearching = searchQuery.trim().length > 0
  const searchFilteredSkills = useMemo(() => {
    if (!isSearching) return skills
    return allSkills.filter((skill) => fuzzyMatch(skill, searchQuery))
  }, [isSearching, searchQuery, skills, allSkills])

  // 最近使用的技能 (按 usageCount 降序, 取前 8 个有使用记录的)
  const recentlyUsedSkills = useMemo(() => {
    return [...allSkills]
      .filter((s) => s.usageCount > 0)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, 8)
  }, [allSkills])

  // 文件上传安装
  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    event.target.value = ''

    const validExtensions = ['.skill', '.zip']
    if (!validExtensions.some((ext) => file.name.toLowerCase().endsWith(ext))) {
      setInstallStatus({ type: 'error', message: '仅支持 .skill/.zip' })
      setTimeout(() => setInstallStatus({ type: 'idle' }), 3000)
      return
    }
    if (file.size > 50 * 1024 * 1024) {
      setInstallStatus({ type: 'error', message: '文件过大 (最大50MB)' })
      setTimeout(() => setInstallStatus({ type: 'idle' }), 3000)
      return
    }

    setInstallStatus({ type: 'uploading', message: '安装中...' })
    try {
      const arrayBuffer = await file.arrayBuffer()
      const base64Data = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''))
      const serverUrl = localStorage.getItem('duncrew_server_url') || _getServerUrl()
      const response = await fetch(`${serverUrl}/skills/install-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data: base64Data }),
      })
      const result = await response.json()
      if (!response.ok) {
        setInstallStatus({ type: 'error', message: result.error || '安装失败' })
        setTimeout(() => setInstallStatus({ type: 'idle' }), 4000)
        return
      }
      setInstallStatus({ type: 'success', message: `已安装: ${result.name}` })
      await refreshSkills()
      setTimeout(() => setInstallStatus({ type: 'idle' }), 3000)
    } catch (error) {
      setInstallStatus({ type: 'error', message: error instanceof Error ? error.message : '网络错误' })
      setTimeout(() => setInstallStatus({ type: 'idle' }), 4000)
    }
  }

  const handleCreateSuccess = async () => {
    setShowCreateDialog(false)
    await refreshSkills()
  }

  // 决定展示模式
  const showAllRanked = isShowingAll && !isSearching
  const displaySkills = isSearching ? searchFilteredSkills : skills

  return (
    <div className="relative h-full overflow-y-auto">
      {/* ── 顶部操作栏 ── */}
      <div className="sticky top-0 z-30 bg-[#FBFBFC]/90 backdrop-blur-lg border-b border-stone-200/60 px-5 py-3">
        <div className="flex items-center gap-3">
          {/* 搜索框 */}
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-300" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索技能 (名称、描述、标签)..."
              className="w-full pl-9 pr-4 py-2 bg-white border border-stone-200 rounded-xl text-sm text-stone-700 placeholder-stone-300 focus:border-stone-400 focus:outline-none transition-colors"
            />
            {isSearching && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-stone-400 font-mono">
                {searchFilteredSkills.length} 结果
              </span>
            )}
          </div>

          {/* 安装按钮 */}
          <input ref={fileInputRef} type="file" accept=".skill,.zip" onChange={handleFileSelect} className="hidden" />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={installStatus.type === 'uploading'}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border transition-colors shrink-0 ${
              installStatus.type === 'uploading'
                ? 'text-stone-400 bg-stone-50 border-stone-200 cursor-wait'
                : installStatus.type === 'success'
                ? 'text-emerald-600 bg-emerald-50 border-emerald-300'
                : installStatus.type === 'error'
                ? 'text-red-500 bg-red-50 border-red-200'
                : 'text-stone-500 bg-white border-stone-200 hover:border-stone-300 hover:text-stone-700'
            }`}
          >
            {installStatus.type === 'uploading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : installStatus.type === 'success' ? <Check className="w-3.5 h-3.5" />
              : installStatus.type === 'error' ? <AlertCircle className="w-3.5 h-3.5" />
              : <Upload className="w-3.5 h-3.5" />}
            {installStatus.message || '安装'}
          </button>

          {/* 创建按钮 */}
          <button
            onClick={() => setShowCreateDialog(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl border text-stone-500 bg-white border-stone-200 hover:border-amber-300 hover:text-amber-600 transition-colors shrink-0"
          >
            <Sparkles className="w-3.5 h-3.5" />
            创建
          </button>
        </div>
      </div>

      {/* ── 内容区 ── */}
      <div className="p-5">
        {/* 搜索无结果 */}
        {isSearching && searchFilteredSkills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-stone-400">
            <span className="text-4xl mb-3">🔍</span>
            <p className="text-sm">未找到匹配「{searchQuery}」的技能</p>
          </div>
        )}

        {/* "所有技能"默认态: 最近使用 + 按 rankScore 平铺 */}
        {showAllRanked && (
          <div className="space-y-4">
            {/* 最近使用横条 */}
            {recentlyUsedSkills.length > 0 && (
              <div>
                <p className="text-[10px] font-black text-stone-400 uppercase tracking-widest mb-2">
                  🔥 最近使用
                </p>
                <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-stone-200">
                  {recentlyUsedSkills.map((skill) => (
                    <button
                      key={skill.id}
                      onClick={() => onSelectSkill(skill)}
                      className="flex items-center gap-2 px-3 py-2 bg-white border border-stone-200 rounded-xl hover:border-stone-300 hover:shadow-sm transition-all shrink-0 group"
                    >
                      <span className="text-base">{skill.emoji}</span>
                      <div className="text-left">
                        <p className="text-xs font-semibold text-stone-700 group-hover:text-stone-900 truncate max-w-[120px]">
                          {skill.name}
                        </p>
                        <p className="text-[10px] text-stone-400 font-mono">
                          x{skill.usageCount}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 按 rankScore 平铺所有技能 */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {[...allSkills].sort((a, b) => b.rankScore - a.rankScore).map((skill) => (
                <SkillGridCard
                  key={skill.id}
                  skill={skill}
                  onClick={() => onSelectSkill(skill)}
                  onToggleEnabled={handleToggleEnabled}
                />
              ))}
            </div>
          </div>
        )}

        {/* 普通网格 (搜索结果 / 侧边栏分类选中) */}
        {!showAllRanked && displaySkills.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {displaySkills.map((skill) => (
              <SkillGridCard
                key={skill.id}
                skill={skill}
                onClick={() => onSelectSkill(skill)}
                onToggleEnabled={handleToggleEnabled}
              />
            ))}
          </div>
        )}

        {/* 空状态 (非搜索) */}
        {!isSearching && !showAllRanked && displaySkills.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-stone-400">
            <span className="text-4xl mb-3">📭</span>
            <p className="text-sm">该分类下暂无技能</p>
          </div>
        )}
      </div>

      {/* 创建技能弹窗 */}
      <SkillCreateDialog
        isOpen={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreated={handleCreateSuccess}
      />
    </div>
  )
}
