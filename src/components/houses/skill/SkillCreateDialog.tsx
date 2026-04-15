/**
 * SkillCreateDialog - 轻量级技能创建弹窗
 *
 * 功能:
 * - 输入技能名称 + 描述
 * - 实时预览标准化后的名称 (kebab-case)
 * - 高级选项折叠: 类型选择 (指令型/执行型)
 * - 调用 POST /skills/create 创建骨架
 */

import { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Sparkles, Loader2, ChevronDown, ChevronRight, AlertCircle, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import { getServerUrl as _getServerUrl } from '@/utils/env'

interface SkillCreateDialogProps {
  isOpen: boolean
  onClose: () => void
  onCreated: (skillName: string) => void
}

/** 前端名称标准化预览 (与后端 re.sub 逻辑一致) */
function toKebabCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_\-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function getServerUrl(): string {
  return localStorage.getItem('duncrew_server_url') || _getServerUrl()
}

export function SkillCreateDialog({ isOpen, onClose, onCreated }: SkillCreateDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [skillType, setSkillType] = useState<'instruction' | 'executable'>('instruction')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const normalizedName = useMemo(() => toKebabCase(name), [name])
  const isNameValid = normalizedName.length > 0
  const isNameDifferent = name.trim() !== '' && name.trim() !== normalizedName && normalizedName.length > 0

  const handleCreate = async () => {
    if (!isNameValid || creating) return
    setCreating(true)
    setError(null)

    try {
      const serverUrl = getServerUrl()
      const response = await fetch(`${serverUrl}/skills/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: normalizedName,
          description: description.trim(),
          type: skillType,
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        setError(data.error || `创建失败: HTTP ${response.status}`)
        return
      }

      setSuccess(true)
      setTimeout(() => {
        onCreated(data.name || normalizedName)
        resetAndClose()
      }, 800)
    } catch (networkError) {
      setError(networkError instanceof Error ? networkError.message : '网络错误')
    } finally {
      setCreating(false)
    }
  }

  const resetAndClose = () => {
    setName('')
    setDescription('')
    setSkillType('instruction')
    setShowAdvanced(false)
    setCreating(false)
    setError(null)
    setSuccess(false)
    onClose()
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[200] flex items-center justify-center p-4"
        onClick={resetAndClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-md bg-white/95 backdrop-blur-xl border border-stone-200 rounded-2xl shadow-[0_20px_60px_rgba(0,0,0,0.12)] overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                <Sparkles className="w-4 h-4 text-amber-500" />
              </div>
              <h2 className="text-sm font-semibold text-stone-800">创建新技能</h2>
            </div>
            <button onClick={resetAndClose} className="p-1 text-stone-400 hover:text-stone-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Content */}
          <div className="px-6 py-5 space-y-4">
            {/* 名称输入 */}
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1.5">技能名称</label>
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                placeholder="如：deep-research、代码审查"
                className="w-full px-4 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 placeholder-stone-300 focus:border-amber-400 focus:ring-2 focus:ring-amber-100 focus:outline-none transition-all"
              />
              {/* 名称预览 */}
              {isNameDifferent && (
                <p className="mt-1.5 text-[11px] text-stone-400">
                  标准化名称: <span className="font-mono text-amber-600">{normalizedName}</span>
                </p>
              )}
              {name.trim() !== '' && !isNameValid && (
                <p className="mt-1.5 text-[11px] text-red-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  名称需包含至少一个字母或数字
                </p>
              )}
            </div>

            {/* 描述输入 */}
            <div>
              <label className="block text-xs font-medium text-stone-500 mb-1.5">描述 (可选)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="简要描述技能的功能..."
                rows={2}
                className="w-full px-4 py-2.5 bg-stone-50 border border-stone-200 rounded-xl text-sm text-stone-700 placeholder-stone-300 focus:border-amber-400 focus:ring-2 focus:ring-amber-100 focus:outline-none transition-all resize-none"
              />
            </div>

            {/* 高级选项 (折叠) */}
            <div>
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-stone-400 hover:text-stone-600 transition-colors"
              >
                {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                高级选项
              </button>
              {showAdvanced && (
                <div className="mt-2 p-3 rounded-xl bg-stone-50 border border-stone-200">
                  <label className="block text-[11px] font-medium text-stone-500 mb-2">技能类型</label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSkillType('instruction')}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all',
                        skillType === 'instruction'
                          ? 'bg-blue-50 border-blue-200 text-blue-600'
                          : 'bg-white border-stone-200 text-stone-500 hover:border-stone-300',
                      )}
                    >
                      🧠 指令型
                      <p className="text-[10px] mt-0.5 opacity-70">纯文本工作流</p>
                    </button>
                    <button
                      onClick={() => setSkillType('executable')}
                      className={cn(
                        'flex-1 px-3 py-2 rounded-lg text-xs font-medium border transition-all',
                        skillType === 'executable'
                          ? 'bg-emerald-50 border-emerald-200 text-emerald-600'
                          : 'bg-white border-stone-200 text-stone-500 hover:border-stone-300',
                      )}
                    >
                      ⚡ 执行型
                      <p className="text-[10px] mt-0.5 opacity-70">含 Python 脚本</p>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-600">{error}</p>
              </div>
            )}

            {/* 成功提示 */}
            {success && (
              <div className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center gap-2">
                <Check className="w-4 h-4 text-emerald-500" />
                <p className="text-xs text-emerald-600">技能 <span className="font-mono">{normalizedName}</span> 创建成功！</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-stone-100 bg-stone-50/50">
            <button
              onClick={resetAndClose}
              className="px-4 py-2 text-xs font-medium text-stone-500 hover:text-stone-700 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!isNameValid || creating || success}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold transition-all',
                isNameValid && !creating && !success
                  ? 'bg-amber-500 text-white hover:bg-amber-600 shadow-sm'
                  : 'bg-stone-200 text-stone-400 cursor-not-allowed',
              )}
            >
              {creating ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : success ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              {creating ? '创建中...' : success ? '已创建' : '创建'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
