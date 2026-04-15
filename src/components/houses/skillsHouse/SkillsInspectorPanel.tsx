/**
 * SkillsInspectorPanel - 右侧全局督查抽屉 (V2)
 *
 * DD-OS 视觉:
 * - 从右侧划入, w-[400px], rounded-[32px]
 * - 96px 状态头像圈
 * - 休眠态: 灰色提示框 + "配置并激活" 按钮
 * - 正常态: 彩色健康度条 + Tag 云
 */

import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, Key, Terminal, Tag,
  Activity, TrendingUp, Shield, Settings,
  KeyRound, Eye, EyeOff,
  Home, Globe, User, Package,
  Trash2, Loader2, Power, Pencil, Sparkles,
  CheckCircle2, XCircle, ArrowRight,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useStore } from '@/store'
import { ABILITY_DOMAIN_CONFIGS } from '@/services/skillStatsService'
import { simpleChat } from '@/services/llmService'
import { getServerUrl as _getServerUrl } from '@/utils/env'
import type { UISkillModel } from '@/utils/skillsHouseMapper'

interface SkillsInspectorPanelProps {
  skill: UISkillModel
  envValues: Record<string, string>
  onEnvChange: (key: string, value: string) => void
  onClose: () => void
}

// DD-OS 缓动
const ddosEase = [0.23, 1, 0.32, 1]

// 状态头像圈样式 (96px 版)
function getLargeRingClass(skill: UISkillModel): string {
  if (skill.isDormant) {
    return 'border-stone-300 border-[3px] border-dashed bg-stone-50'
  }
  if (skill.type === 'instruction') {
    return 'border-[#7EC8E3] border-[3px] bg-white'
  }
  return 'border-[#AEE1CC] border-[3px] bg-white'
}

// 健康度颜色
function getHealthColor(score: number, isDormant: boolean): string {
  if (isDormant) return 'bg-stone-300'
  if (score >= 80) return 'bg-emerald-400'
  if (score >= 50) return 'bg-amber-400'
  return 'bg-stone-400'
}

function getHealthLabel(score: number, isDormant: boolean): string {
  if (isDormant) return '休眠'
  if (score >= 80) return '健康'
  if (score >= 50) return '需关注'
  return '低'
}

// 休眠原因详细描述
function getDormantReasons(skill: UISkillModel): string[] {
  const reasons: string[] = []
  if (skill.status === 'inactive') reasons.push('技能未启用')
  if (skill.status === 'error') reasons.push('技能状态异常')
  if (skill.requiresAPI) {
    const missingApi = skill.missingReqs.filter((r) => r.startsWith('env:'))
    if (missingApi.length > 0) {
      reasons.push(`需配置 ${skill.apiName ?? 'API Key'}`)
    }
  }
  const missingBins = skill.missingReqs.filter((r) => !r.startsWith('env:'))
  if (missingBins.length > 0) {
    reasons.push(`缺少依赖: ${missingBins.map((r) => r.replace('env:', '')).join(', ')}`)
  }
  return reasons
}

export function SkillsInspectorPanel({ skill, envValues, onEnvChange, onClose }: SkillsInspectorPanelProps) {
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({})
  const [uninstalling, setUninstalling] = useState(false)
  const [uninstallConfirm, setUninstallConfirm] = useState(false)
  const [toggling, setToggling] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editInstruction, setEditInstruction] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const [editResult, setEditResult] = useState<{
    success: boolean; message: string;
    scoreBefore?: number; scoreAfter?: number;
    fixedItems?: string[];
  } | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizePhase, setOptimizePhase] = useState<'analyze' | 'llm' | 'save' | null>(null)
  const [optimizeResult, setOptimizeResult] = useState<{
    success: boolean; message: string;
    scoreBefore?: number; scoreAfter?: number;
    fixedItems?: string[];
    alreadyOptimal?: boolean;
  } | null>(null)
  const [editPhase, setEditPhase] = useState<'read' | 'llm' | 'save' | null>(null)

  const refreshSkills = useStore((s) => s.refreshSkills)
  const toggleSkillEnabled = useStore((s) => s.toggleSkillEnabled)
  const canUninstall = skill.source === 'community' || skill.source === 'user'
  const isDisabled = skill.status === 'inactive'

  const handleToggle = async () => {
    setToggling(true)
    try {
      await toggleSkillEnabled(skill.name, isDisabled)
    } finally {
      setToggling(false)
    }
  }

  const handleEdit = async () => {
    if (!editInstruction.trim()) return
    setEditLoading(true)
    setEditResult(null)
    setEditPhase('read')
    try {
      const serverUrl = localStorage.getItem('duncrew_server_url') || _getServerUrl()

      // Step 1: 从后端获取当前 SKILL.md 内容 + 诊断
      const validateRes = await fetch(`${serverUrl}/skills/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill._raw.name }),
      })
      const validateData = await validateRes.json()
      if (!validateRes.ok) {
        setEditResult({ success: false, message: validateData.error || '读取技能内容失败' })
        return
      }

      const currentContent = validateData.content || ''

      // Step 2: 调用 LLM 进行编辑
      setEditPhase('llm')
      const editPrompt = (
        '你是一个技能文件（SKILL.md）编辑专家。请根据用户指令修改以下 SKILL.md 内容。\n\n' +
        `## 用户编辑指令:\n${editInstruction}\n\n` +
        '## 修改规则:\n' +
        '1. 严格按照用户指令修改，不要做额外的无关更改\n' +
        '2. 保持 YAML frontmatter 格式正确\n' +
        '3. 保持技能的核心功能不变（除非用户明确要求改变）\n' +
        '4. 直接返回完整的修改后的 SKILL.md 内容，不要包含任何解释或 markdown 代码块\n\n' +
        `## 当前 SKILL.md 内容:\n\`\`\`\n${currentContent}\n\`\`\`\n\n` +
        '请直接返回修复后的完整 SKILL.md 内容（不要用 markdown 代码块包裹）:'
      )

      const llmResult = await simpleChat([{ role: 'user', content: editPrompt }])
      if (!llmResult) {
        setEditResult({ success: false, message: 'LLM 调用失败，请检查 LLM 配置' })
        return
      }

      // 清理可能的 markdown 包裹
      let newContent = llmResult.trim()
      if (newContent.startsWith('```')) {
        newContent = newContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      }

      // Step 3: 保存到后端
      setEditPhase('save')
      const saveRes = await fetch(`${serverUrl}/skills/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill._raw.name, content: newContent }),
      })
      const saveData = await saveRes.json()
      if (saveRes.ok) {
        setEditResult({
          success: true,
          message: '编辑完成',
          scoreBefore: saveData.scoreBefore,
          scoreAfter: saveData.scoreAfter,
          fixedItems: [`按指令修改: "${editInstruction}"`],
        })
        setEditInstruction('')
        await refreshSkills()
      } else {
        setEditResult({ success: false, message: saveData.error || '保存失败' })
      }
    } catch (error) {
      setEditResult({ success: false, message: error instanceof Error ? error.message : '编辑过程出错' })
    } finally {
      setEditLoading(false)
      setEditPhase(null)
    }
  }

  const handleOptimize = async () => {
    setOptimizing(true)
    setOptimizeResult(null)
    setOptimizePhase('analyze')
    try {
      const serverUrl = localStorage.getItem('duncrew_server_url') || _getServerUrl()

      // Step 1: 获取诊断 + 优化提示词
      const analyzeRes = await fetch(`${serverUrl}/skills/optimize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill._raw.name }),
      })
      const analyzeData = await analyzeRes.json()
      if (!analyzeRes.ok) {
        setOptimizeResult({ success: false, message: analyzeData.error || '分析失败' })
        return
      }

      if (analyzeData.alreadyOptimal) {
        setOptimizeResult({ success: true, message: '技能质量已达标，无需优化', alreadyOptimal: true })
        return
      }

      // 提取失败项描述列表
      const failedLabels: string[] = (analyzeData.diagnostics || [])
        .filter((d: { pass: boolean }) => !d.pass)
        .map((d: { field: string; suggestion: string }) => d.suggestion || d.field)

      // Step 2: 调用 LLM 进行自动优化
      setOptimizePhase('llm')
      const llmResult = await simpleChat([{ role: 'user', content: analyzeData.optimizePrompt }])
      if (!llmResult) {
        setOptimizeResult({ success: false, message: 'LLM 调用失败，请检查 LLM 配置' })
        return
      }

      let newContent = llmResult.trim()
      if (newContent.startsWith('```')) {
        newContent = newContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '')
      }

      // Step 3: 保存优化后的内容
      setOptimizePhase('save')
      const saveRes = await fetch(`${serverUrl}/skills/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill._raw.name, content: newContent }),
      })
      const saveData = await saveRes.json()
      if (saveRes.ok) {
        setOptimizeResult({
          success: true,
          message: `优化完成，修复了 ${analyzeData.failedCount} 项问题`,
          scoreBefore: saveData.scoreBefore,
          scoreAfter: saveData.scoreAfter,
          fixedItems: failedLabels,
        })
        await refreshSkills()
      } else {
        setOptimizeResult({ success: false, message: saveData.error || '保存优化结果失败' })
      }
    } catch (error) {
      setOptimizeResult({ success: false, message: error instanceof Error ? error.message : '优化过程出错' })
    } finally {
      setOptimizing(false)
      setOptimizePhase(null)
    }
  }

  const handleUninstall = async () => {
    if (!uninstallConfirm) {
      setUninstallConfirm(true)
      return
    }
    setUninstalling(true)
    try {
      const serverUrl = localStorage.getItem('duncrew_server_url') || _getServerUrl()
      const response = await fetch(`${serverUrl}/skills/uninstall`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: skill._raw.name }),
      })
      if (response.ok) {
        await refreshSkills()
        onClose()
      }
    } catch (error) {
      console.error('[Inspector] Uninstall failed:', error)
    } finally {
      setUninstalling(false)
      setUninstallConfirm(false)
    }
  }

  const domainConfig = useMemo(
    () => ABILITY_DOMAIN_CONFIGS.find((d) => d.id === skill.domain),
    [skill.domain],
  )

  const typeLabel = skill.type === 'instruction' ? '🧠 指令型' : '⚡ 执行型'
  const dangerLabel = skill.danger === 'safe'
    ? '🟢 安全'
    : skill.danger === 'high'
    ? '🟡 高风险'
    : '🔴 极高危'

  const sourceConfig = {
    builtin:   { icon: Home,  label: '系统内置', color: 'text-blue-500' },
    community: { icon: Globe, label: '社区下载', color: 'text-violet-500' },
    user:      { icon: User,  label: '用户自建', color: 'text-amber-500' },
  } as const
  const sourceCfg = sourceConfig[skill.source]
  const SourceIcon = sourceCfg.icon

  const dormantReasons = skill.isDormant ? getDormantReasons(skill) : []
  const requiredEnvs = skill._raw.requires?.env || []

  return (
    <motion.div
      initial={{ x: '100%', opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: '100%', opacity: 0 }}
      transition={{ duration: 0.4, ease: ddosEase }}
      className="absolute top-4 right-4 bottom-4 w-[400px] z-50 flex flex-col bg-white rounded-[32px] shadow-[0_20px_60px_rgba(0,0,0,0.08)] border border-stone-100 overflow-hidden"
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-6 pt-5 pb-2 shrink-0">
        <p className="text-[10px] font-black text-stone-400 uppercase tracking-[0.15em]">
          Inspector
        </p>
        <button
          onClick={onClose}
          className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 滚动内容 */}
      <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-5">
        {/* 96px 头像 + 名称 */}
        <div className={cn('flex flex-col items-center pt-2', skill.isDormant && 'grayscale-[0.4]')}>
          <div
            className={cn(
              'w-24 h-24 rounded-full flex items-center justify-center',
              getLargeRingClass(skill),
            )}
          >
            <span className="text-4xl">{skill.emoji}</span>
          </div>
          <h3 className={cn('mt-3 text-base font-bold', skill.isDormant ? 'text-stone-500' : 'text-stone-800')}>
            {skill.name}
          </h3>
          <p className="text-xs text-stone-400 mt-1 text-center max-w-[280px] leading-relaxed">
            {skill.desc || '暂无描述'}
          </p>

          {/* 域标签 */}
          {domainConfig && (
            <span
              className={cn(
                'mt-2 px-3 py-1 rounded-full text-[10px] font-bold text-white',
                skill.isDormant && 'opacity-60',
              )}
              style={{ backgroundColor: domainConfig.color }}
            >
              {domainConfig.name}
            </span>
          )}
          {/* 子组归属标签 */}
          {skill.subGroupLabel && (
            <span className="mt-1 px-2 py-0.5 rounded-md text-[9px] font-mono text-stone-400 bg-stone-50 border border-stone-200/60">
              {skill.subGroupLabel}
            </span>
          )}
        </div>

        {/* 操作栏: 启用/停用 + 编辑 + 优化 */}
        <div className="flex items-center gap-2">
          {/* 启用/停用开关 */}
          <button
            onClick={handleToggle}
            disabled={toggling}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-bold transition-all border',
              toggling && 'opacity-60 cursor-wait',
              isDisabled
                ? 'bg-stone-50 border-stone-200 text-stone-400 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-600'
                : 'bg-emerald-50 border-emerald-200 text-emerald-600 hover:bg-red-50 hover:border-red-300 hover:text-red-500',
            )}
          >
            {toggling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
            {isDisabled ? '启用' : '停用'}
          </button>

          {/* 编辑按钮 */}
          <button
            onClick={() => { setEditMode(!editMode); setEditResult(null) }}
            className={cn(
              'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all border',
              editMode
                ? 'bg-sky-50 border-sky-300 text-sky-600'
                : 'bg-white border-stone-200 text-stone-500 hover:border-sky-300 hover:text-sky-600',
            )}
          >
            <Pencil className="w-3.5 h-3.5" />
            编辑
          </button>

          {/* 一键优化按钮 */}
          <button
            onClick={handleOptimize}
            disabled={optimizing || skill.rankScore >= 90}
            className={cn(
              'flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-bold transition-all border',
              optimizing && 'opacity-60 cursor-wait',
              skill.rankScore >= 90
                ? 'bg-stone-50 border-stone-200 text-stone-300 cursor-not-allowed'
                : 'bg-white border-stone-200 text-amber-500 hover:border-amber-300 hover:bg-amber-50',
            )}
            title={skill.rankScore >= 90 ? '质量已达标，无需优化' : '基于质量诊断自动优化 SKILL.md'}
          >
            {optimizing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            优化
          </button>
        </div>

        {/* 编辑面板 (展开) */}
        {editMode && (
          <div className="p-4 rounded-2xl bg-sky-50/50 border border-sky-200 space-y-3">
            <div className="flex items-center gap-2 text-sky-600 mb-1">
              <Pencil className="w-3.5 h-3.5" />
              <span className="text-xs font-bold">AI 辅助编辑</span>
            </div>

            {/* 编辑中: 分步骤进度面板 */}
            {editLoading && editPhase ? (
              <div className="space-y-2.5 py-1">
                {([
                  { key: 'read', label: '读取技能内容' },
                  { key: 'llm', label: 'AI 正在编辑' },
                  { key: 'save', label: '保存并验证' },
                ] as const).map((step, idx) => {
                  const isActive = editPhase === step.key
                  const isDone = (['read', 'llm', 'save'] as const).indexOf(editPhase) > idx
                  return (
                    <div key={step.key} className="flex items-center gap-2.5">
                      <div className={cn(
                        'w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all duration-300',
                        isDone ? 'bg-sky-500' :
                        isActive ? 'bg-sky-100 border-2 border-sky-400' :
                        'bg-stone-100 border border-stone-200',
                      )}>
                        {isDone ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        ) : isActive ? (
                          <Loader2 className="w-3 h-3 text-sky-500 animate-spin" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-stone-300" />
                        )}
                      </div>
                      <span className={cn(
                        'text-xs transition-colors duration-200',
                        isDone ? 'text-sky-600 font-semibold' :
                        isActive ? 'text-sky-700 font-bold' :
                        'text-stone-400',
                      )}>
                        {step.label}{isActive ? '...' : ''}
                      </span>
                    </div>
                  )
                })}
                {/* 脉冲条 */}
                <div className="h-1 rounded-full bg-sky-100 overflow-hidden mt-1">
                  <motion.div
                    className="h-full bg-sky-400 rounded-full"
                    initial={{ width: '0%' }}
                    animate={{ width: editPhase === 'read' ? '30%' : editPhase === 'llm' ? '70%' : '95%' }}
                    transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                  />
                </div>
              </div>
            ) : (
              <>
                <textarea
                  value={editInstruction}
                  onChange={(e) => setEditInstruction(e.target.value)}
                  placeholder="描述要修改的内容，如: 补充 API 依赖说明、优化描述、添加使用示例..."
                  className="w-full h-20 text-xs rounded-xl px-3 py-2.5 bg-white border border-sky-200 text-stone-700 placeholder:text-stone-300 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 outline-none resize-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleEdit}
                    disabled={!editInstruction.trim()}
                    className={cn(
                      'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all border',
                      !editInstruction.trim() ? 'bg-stone-50 border-stone-200 text-stone-300 cursor-not-allowed' :
                      'bg-sky-500 border-sky-500 text-white hover:bg-sky-600',
                    )}
                  >
                    <Pencil className="w-3 h-3" />
                    执行编辑
                  </button>
                  <button
                    onClick={() => { setEditMode(false); setEditResult(null) }}
                    className="px-3 py-2 rounded-xl text-xs text-stone-400 hover:text-stone-600 border border-stone-200 hover:border-stone-300 transition-colors"
                  >
                    取消
                  </button>
                </div>
              </>
            )}

            {/* 编辑结果 */}
            <AnimatePresence>
              {editResult && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.3 }}
                  className={cn(
                    'p-3.5 rounded-xl text-xs border space-y-2',
                    editResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {editResult.success
                      ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      : <XCircle className="w-4 h-4 text-red-500 shrink-0" />}
                    <span className={cn('font-bold', editResult.success ? 'text-emerald-700' : 'text-red-600')}>
                      {editResult.message}
                    </span>
                  </div>
                  {editResult.fixedItems && editResult.fixedItems.length > 0 && (
                    <div className="ml-6 space-y-1">
                      {editResult.fixedItems.map((item, i) => (
                        <div key={i} className="flex items-start gap-1.5 text-emerald-600">
                          <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {editResult.scoreBefore != null && editResult.scoreAfter != null && (
                    <div className="flex items-center gap-2 ml-6 pt-1">
                      <span className="font-mono text-stone-500">{editResult.scoreBefore}</span>
                      <ArrowRight className="w-3 h-3 text-stone-400" />
                      <span className={cn('font-mono font-bold', editResult.scoreAfter > editResult.scoreBefore ? 'text-emerald-600' : 'text-stone-600')}>
                        {editResult.scoreAfter}
                      </span>
                      {editResult.scoreAfter > editResult.scoreBefore && (
                        <span className="text-emerald-500 font-bold">+{editResult.scoreAfter - editResult.scoreBefore}</span>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/* 优化进度面板 */}
        <AnimatePresence>
          {optimizing && optimizePhase && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
              className="overflow-hidden"
            >
              <div className="p-4 rounded-2xl bg-amber-50/60 border border-amber-200 space-y-2.5">
                <div className="flex items-center gap-2 text-amber-600 mb-1">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span className="text-xs font-bold">正在优化技能</span>
                </div>
                {([
                  { key: 'analyze', label: '分析质量问题' },
                  { key: 'llm', label: 'AI 自动修复' },
                  { key: 'save', label: '保存并更新评分' },
                ] as const).map((step, idx) => {
                  const isActive = optimizePhase === step.key
                  const isDone = (['analyze', 'llm', 'save'] as const).indexOf(optimizePhase) > idx
                  return (
                    <div key={step.key} className="flex items-center gap-2.5">
                      <div className={cn(
                        'w-5 h-5 rounded-full flex items-center justify-center shrink-0 transition-all duration-300',
                        isDone ? 'bg-amber-500' :
                        isActive ? 'bg-amber-100 border-2 border-amber-400' :
                        'bg-stone-100 border border-stone-200',
                      )}>
                        {isDone ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-white" />
                        ) : isActive ? (
                          <Loader2 className="w-3 h-3 text-amber-500 animate-spin" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-stone-300" />
                        )}
                      </div>
                      <span className={cn(
                        'text-xs transition-colors duration-200',
                        isDone ? 'text-amber-600 font-semibold' :
                        isActive ? 'text-amber-700 font-bold' :
                        'text-stone-400',
                      )}>
                        {step.label}{isActive ? '...' : ''}
                      </span>
                    </div>
                  )
                })}
                <div className="h-1 rounded-full bg-amber-100 overflow-hidden mt-1">
                  <motion.div
                    className="h-full bg-amber-400 rounded-full"
                    initial={{ width: '0%' }}
                    animate={{ width: optimizePhase === 'analyze' ? '30%' : optimizePhase === 'llm' ? '70%' : '95%' }}
                    transition={{ duration: 0.6, ease: [0.23, 1, 0.32, 1] }}
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 优化结果 */}
        <AnimatePresence>
          {optimizeResult && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.35 }}
              className={cn(
                'p-4 rounded-2xl text-xs border space-y-2.5',
                optimizeResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200',
              )}
            >
              <div className="flex items-center gap-2">
                {optimizeResult.success
                  ? <CheckCircle2 className="w-4.5 h-4.5 text-emerald-500 shrink-0" />
                  : <XCircle className="w-4.5 h-4.5 text-red-500 shrink-0" />}
                <span className={cn('font-bold text-[13px]', optimizeResult.success ? 'text-emerald-700' : 'text-red-600')}>
                  {optimizeResult.message}
                </span>
              </div>

              {/* 逐条列出修复项 */}
              {optimizeResult.fixedItems && optimizeResult.fixedItems.length > 0 && (
                <div className="ml-6 space-y-1.5 pt-0.5">
                  {optimizeResult.fixedItems.map((item, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.1, duration: 0.25 }}
                      className="flex items-start gap-1.5 text-emerald-600"
                    >
                      <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" />
                      <span>{item}</span>
                    </motion.div>
                  ))}
                </div>
              )}

              {/* 分数变化动画 */}
              {optimizeResult.scoreBefore != null && optimizeResult.scoreAfter != null && (
                <div className="ml-6 pt-2 border-t border-emerald-200/60">
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-stone-500 uppercase tracking-wider font-bold">质量分</span>
                    <span className="font-mono text-sm text-stone-400">{optimizeResult.scoreBefore}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-emerald-400" />
                    <motion.span
                      className={cn('font-mono text-sm font-black', optimizeResult.scoreAfter > optimizeResult.scoreBefore ? 'text-emerald-600' : 'text-stone-600')}
                      initial={{ scale: 1 }}
                      animate={{ scale: [1, 1.3, 1] }}
                      transition={{ duration: 0.4, delay: 0.3 }}
                    >
                      {optimizeResult.scoreAfter}
                    </motion.span>
                    {optimizeResult.scoreAfter > optimizeResult.scoreBefore && (
                      <motion.span
                        className="text-xs font-bold text-emerald-500 bg-emerald-100 px-1.5 py-0.5 rounded-md"
                        initial={{ opacity: 0, scale: 0.5 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ delay: 0.5, duration: 0.3, type: 'spring' }}
                      >
                        +{optimizeResult.scoreAfter - optimizeResult.scoreBefore}
                      </motion.span>
                    )}
                  </div>
                  {/* 前后对比条 */}
                  <div className="mt-2 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-stone-400 w-6">前</span>
                      <div className="flex-1 h-1.5 rounded-full bg-stone-100 overflow-hidden">
                        <div className="h-full rounded-full bg-stone-300" style={{ width: `${optimizeResult.scoreBefore}%` }} />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] text-emerald-500 font-bold w-6">后</span>
                      <div className="flex-1 h-1.5 rounded-full bg-emerald-100 overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-emerald-400"
                          initial={{ width: `${optimizeResult.scoreBefore}%` }}
                          animate={{ width: `${optimizeResult.scoreAfter}%` }}
                          transition={{ duration: 0.6, delay: 0.2, ease: [0.23, 1, 0.32, 1] }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {optimizeResult.success && !optimizeResult.alreadyOptimal && (
                <p className="text-[10px] text-emerald-500/70 ml-6 pt-1">技能文件已自动更新并重新加载</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* 休眠态: 激活需求提示 (灰色, 非粉色) */}
        {skill.isDormant && dormantReasons.length > 0 && (
          <div className="p-4 rounded-2xl bg-stone-50 border border-stone-200">
            <div className="flex items-center gap-2 text-stone-500 mb-2">
              <Settings className="w-4 h-4" />
              <span className="text-xs font-bold">激活需求 (Activation Requirements)</span>
            </div>
            {dormantReasons.map((reason, i) => (
              <p key={i} className="text-[11px] text-stone-400 font-mono ml-6 mt-1">
                {reason}
              </p>
            ))}
          </div>
        )}

        {/* 正常态 API 提示 (非休眠时才用彩色) */}
        {!skill.isDormant && skill.requiresAPI && (
          <div className="p-3 rounded-2xl bg-amber-50 border border-amber-200">
            <div className="flex items-center gap-2 text-amber-600">
              <Key className="w-4 h-4" />
              <span className="text-xs font-bold">需要 API 授权</span>
            </div>
            <p className="text-[11px] text-amber-500 mt-1 ml-6 font-mono">
              {skill.apiName}
            </p>
          </div>
        )}

        {/* 属性行 */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Terminal className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">机制</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{typeLabel}</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Shield className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">安全</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{dangerLabel}</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Package className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">来源</span>
            </div>
            <p className={cn('text-xs font-bold flex items-center gap-1', sourceCfg.color)}>
              <SourceIcon className="w-3 h-3" />
              {sourceCfg.label}
            </p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <Activity className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">调用</span>
            </div>
            <p className="text-xs font-bold text-stone-700">{skill.usageCount} 次</p>
          </div>
          <div className="p-3 rounded-2xl bg-stone-50">
            <div className="flex items-center gap-1.5 text-stone-400 mb-1">
              <TrendingUp className="w-3 h-3" />
              <span className="text-[9px] font-black uppercase tracking-wider">版本</span>
            </div>
            <p className="text-xs font-bold text-stone-700 font-mono">
              {skill._raw.version || 'n/a'}
            </p>
          </div>
        </div>

        {/* 健康度进度条 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
              健康度
            </span>
            <span className={cn(
              'text-[10px] font-bold',
              skill.isDormant ? 'text-stone-400' :
              skill.healthScore >= 80 ? 'text-emerald-500' :
              skill.healthScore >= 50 ? 'text-amber-500' : 'text-stone-400',
            )}>
              {skill.healthScore}/100 · {getHealthLabel(skill.healthScore, skill.isDormant)}
            </span>
          </div>
          <div className="h-2 rounded-full bg-stone-100 overflow-hidden">
            <motion.div
              className={cn('h-full rounded-full', getHealthColor(skill.healthScore, skill.isDormant))}
              initial={{ width: 0 }}
              animate={{ width: `${skill.healthScore}%` }}
              transition={{ duration: 0.6, ease: ddosEase }}
            />
          </div>
        </div>

        {/* 能力评分 */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
              Ranking Score
            </span>
            <span className={cn(
              'text-sm font-black font-mono',
              skill.isDormant ? 'text-stone-400' :
              skill.rankScore >= 70 ? 'text-emerald-500' :
              skill.rankScore >= 45 ? 'text-amber-500' : 'text-stone-400',
            )}>
              {skill.rankScore}
            </span>
          </div>
          <div className="space-y-2.5">
            {/* 使用可靠度 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-stone-500">使用可靠度</span>
                <span className="text-[10px] font-mono font-bold text-sky-500">
                  {Math.round(skill.scoreBreakdown.usageScore * 100)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-sky-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${skill.scoreBreakdown.usageScore * 100}%` }}
                  transition={{ duration: 0.5, ease: ddosEase }}
                />
              </div>
            </div>
            {/* 新鲜度 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-stone-500">新鲜度</span>
                <span className="text-[10px] font-mono font-bold text-emerald-500">
                  {Math.round(skill.scoreBreakdown.freshnessScore * 100)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-emerald-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${skill.scoreBreakdown.freshnessScore * 100}%` }}
                  transition={{ duration: 0.5, delay: 0.05, ease: ddosEase }}
                />
              </div>
            </div>
            {/* 质量完整度 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-stone-500">质量完整度</span>
                <span className="text-[10px] font-mono font-bold text-violet-500">
                  {Math.round(skill.scoreBreakdown.qualityScore * 100)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-stone-100 overflow-hidden">
                <motion.div
                  className="h-full rounded-full bg-violet-400"
                  initial={{ width: 0 }}
                  animate={{ width: `${skill.scoreBreakdown.qualityScore * 100}%` }}
                  transition={{ duration: 0.5, delay: 0.1, ease: ddosEase }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ToolNames 云 */}
        {skill.toolNames.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Terminal className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Registered Tools
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skill.toolNames.map((t) => (
                <span
                  key={t}
                  className={cn(
                    'px-2 py-1 rounded-lg text-[10px] font-mono border',
                    skill.isDormant
                      ? 'bg-stone-50 text-stone-400 border-stone-200'
                      : 'bg-sky-50 text-sky-600 border-sky-200',
                  )}
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Semantic Tags 云 */}
        {skill.tags.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Tag className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Tags
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {skill.tags.map((t) => (
                <span
                  key={t}
                  className="px-2 py-1 rounded-lg text-[10px] font-mono bg-stone-50 text-stone-500 border border-stone-200"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 环境变量配置 (API Key 输入) */}
        {requiredEnvs.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-3">
              <Key className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                API 配置
              </span>
            </div>
            <div className="space-y-3">
              {requiredEnvs.map(envKey => {
                const hasValue = !!envValues[envKey]
                const visible = showKeys[envKey]
                return (
                  <div key={envKey} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[11px] text-stone-700 font-mono font-medium">
                        <KeyRound size={12} className={hasValue ? 'text-emerald-500' : 'text-amber-500'} />
                        {envKey}
                      </div>
                      <span className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded border uppercase tracking-widest font-bold',
                        hasValue
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-500'
                          : 'bg-amber-50 border-amber-200 text-amber-500',
                      )}>
                        {hasValue ? '已配置' : '待配置'}
                      </span>
                    </div>
                    <div className="relative">
                      <input
                        type={visible ? 'text' : 'password'}
                        value={envValues[envKey] || ''}
                        onChange={e => onEnvChange(envKey, e.target.value)}
                        placeholder={`输入 ${envKey}...`}
                        className={cn(
                          'w-full text-xs rounded-xl pl-3 pr-9 py-2.5 outline-none transition-all font-mono placeholder:text-stone-300 placeholder:font-sans',
                          hasValue
                            ? 'bg-emerald-50/50 border border-emerald-200 text-emerald-700 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100'
                            : 'bg-stone-50 border border-stone-200 text-stone-700 focus:border-amber-400 focus:ring-2 focus:ring-amber-100/50',
                        )}
                      />
                      <button
                        onClick={() => setShowKeys(prev => ({ ...prev, [envKey]: !prev[envKey] }))}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
                      >
                        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 运行环境 */}
        {skill._raw.primaryEnv && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <Terminal className="w-3 h-3 text-stone-400" />
              <span className="text-[9px] font-black text-stone-400 uppercase tracking-wider">
                Runtime
              </span>
            </div>
            <span className={cn(
              'px-2.5 py-1 rounded-lg text-[11px] font-mono border',
              skill.isDormant
                ? 'bg-stone-50 text-stone-400 border-stone-200'
                : 'bg-emerald-50 text-emerald-600 border-emerald-200',
            )}>
              {skill._raw.primaryEnv}
            </span>
          </div>
        )}

        {/* 卸载按钮 (仅 community/user 来源) */}
        {canUninstall && (
          <div className="pt-2 border-t border-stone-100">
            <button
              onClick={handleUninstall}
              disabled={uninstalling}
              className={cn(
                'flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl text-xs font-bold transition-all',
                uninstallConfirm
                  ? 'bg-red-50 border border-red-300 text-red-600 hover:bg-red-100'
                  : 'bg-stone-50 border border-stone-200 text-stone-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50',
                uninstalling && 'opacity-60 cursor-wait',
              )}
            >
              {uninstalling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              {uninstalling ? '卸载中...' : uninstallConfirm ? '确认卸载？再次点击' : '卸载技能'}
            </button>
          </div>
        )}
      </div>
    </motion.div>
  )
}
