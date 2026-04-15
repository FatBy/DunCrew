import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { X, Plus, Loader2, Wand2, GripHorizontal, Sparkles } from 'lucide-react'
import { useStore } from '@/store'
import { simpleVisualDNA } from '@/store/slices/worldSlice'
import { createInitialScoring } from '@/types'
import { chat, getLLMConfig } from '@/services/llmService'
import { getServerUrl } from '@/utils/env'
import { assignUniqueSpecies } from '@/components/dashboard/dunGrowth'
import type { AnimalSpecies } from '@/components/dashboard/dunGrowth'
import { useT } from '@/i18n'

export interface DunInitialData {
  name?: string
  description?: string
  sopContent?: string
  isFromChat?: boolean
  suggestedSkills?: string[]
  tags?: string[]
  triggers?: string[]
  objective?: string
  metrics?: string[]
  strategy?: string
}

interface CreateDunModalProps {
  isOpen: boolean
  onClose: () => void
  initialData?: DunInitialData
  isAnalyzing?: boolean
}

const INTENT_TO_DUN_PROMPT = [
  '你是 DunCrew 的 Dun 生成器。用户会用一句话描述想让 Dun 做什么，你需要生成完整的 Dun 定义。',
  '',
  '返回 JSON（不要其他内容）：',
  '{',
  '  "name": "2-6个中文字的简短名称",',
  '  "description": "一句话描述功能和适用场景",',
  '  "sopContent": "Markdown 格式的 SOP，包含目标、执行步骤、注意事项",',
  '  "suggestedSkills": ["可能需要的工具名"],',
  '  "tags": ["分类标签"]',
  '}',
].join('\n')

export function CreateDunModal({ isOpen, onClose, initialData }: CreateDunModalProps) {
  const addDun = useStore((s) => s.addDun)
  const duns = useStore((s) => s.duns)
  const t = useT()
  const dragControls = useDragControls()
  const constraintsRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [intent, setIntent] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState('')
  const autoCreatedRef = useRef(false)

  useEffect(() => {
    if (isOpen && !initialData?.isFromChat) {
      setTimeout(() => inputRef.current?.focus(), 100)
    }
  }, [isOpen, initialData?.isFromChat])

  useEffect(() => {
    if (isOpen && initialData?.isFromChat && initialData.name && !autoCreatedRef.current) {
      autoCreatedRef.current = true
      createDunFromData(initialData)
    }
  }, [isOpen, initialData]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) {
      setIntent('')
      setError('')
      setIsCreating(false)
      autoCreatedRef.current = false
    }
  }, [isOpen])

  const createAndSync = useCallback(async (data: {
    name: string
    description?: string
    sopContent?: string
    suggestedSkills?: string[]
  }) => {
    const dunId = `dun-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const visualDNA = simpleVisualDNA(dunId)
    const gridX = Math.floor(Math.random() * 6) - 3
    const gridY = Math.floor(Math.random() * 6) - 3

    // 收集已使用的 species，分配唯一种族
    const usedSpecies = new Set<AnimalSpecies>()
    for (const [, d] of duns) {
      if (d.species) usedSpecies.add(d.species as AnimalSpecies)
    }
    const species = assignUniqueSpecies(dunId, usedSpecies)

    addDun({
      id: dunId,
      position: { gridX, gridY },
      scoring: createInitialScoring(),
      visualDNA,
      species,
      label: data.name,
      constructionProgress: 0,
      createdAt: Date.now(),
      boundSkillIds: data.suggestedSkills || [],
      sopContent: data.sopContent || undefined,
      flavorText: data.description || `创建于 ${new Date().toLocaleDateString()}`,
    })

    const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
    try {
      await fetch(`${serverUrl}/duns/${encodeURIComponent(dunId)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: data.name }),
      })
      if (data.sopContent) {
        const skillDeps = data.suggestedSkills?.length
          ? '\nskill_dependencies:\n' + data.suggestedSkills.map(s => `  - ${s}`).join('\n')
          : '\nskill_dependencies: []'
        const fullContent = [
          '---',
          `name: ${data.name}`,
          `description: ${data.description || ''}`,
          'version: 1.0.0',
          skillDeps,
          '---',
          '',
          data.sopContent,
        ].join('\n')
        await fetch(`${serverUrl}/duns/${encodeURIComponent(dunId)}/sop-content`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: fullContent }),
        })
      }
    } catch (e) {
      console.warn('[CreateDun] Backend sync failed (non-critical):', e)
    }
  }, [addDun, duns])

  const createDunFromData = useCallback(async (data: DunInitialData) => {
    setIsCreating(true)
    await createAndSync({
      name: data.name || t('dun.unnamed'),
      description: data.description,
      sopContent: data.sopContent,
      suggestedSkills: data.suggestedSkills,
    })
    setIsCreating(false)
    onClose()
  }, [createAndSync, onClose])

  const handleCreate = useCallback(async () => {
    const trimmed = intent.trim()
    if (!trimmed) return

    setIsCreating(true)
    setError('')

    try {
      const config = getLLMConfig()
      if (!config.apiKey) {
        await createAndSync({ name: trimmed })
        onClose()
        return
      }

      const response = await chat(
        [
          { role: 'system', content: INTENT_TO_DUN_PROMPT },
          { role: 'user', content: trimmed },
        ],
        { temperature: 0.3 } as any,
      )

      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        await createAndSync({ name: trimmed })
        onClose()
        return
      }

      const result = JSON.parse(jsonMatch[0])
      await createAndSync({
        name: result.name || trimmed,
        description: result.description,
        sopContent: result.sopContent,
        suggestedSkills: result.suggestedSkills,
      })
      onClose()
    } catch (e) {
      console.error('[CreateDun] Generation failed:', e)
      try {
        await createAndSync({ name: trimmed })
        onClose()
      } catch {
        setError(t('dun.create_failed'))
        setIsCreating(false)
      }
    }
  }, [intent, createAndSync, onClose])

  const handleClose = () => {
    if (isCreating) return
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && intent.trim() && !isCreating) {
      e.preventDefault()
      handleCreate()
    }
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[100]"
          />
          <div ref={constraintsRef} className="fixed inset-0 z-[101] pointer-events-none" />
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            drag
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={constraintsRef}
            dragElastic={0.05}
            dragMomentum={false}
            className="fixed inset-0 z-[101] m-auto
                       w-[90%] max-w-md h-fit
                       bg-white border-2 border-cyan-500/30
                       rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.15)]
                       overflow-hidden pointer-events-auto"
          >
            <div
              className="flex items-center justify-between px-4 py-3 border-b border-stone-100 cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="flex items-center gap-2">
                <GripHorizontal className="w-3.5 h-3.5 text-stone-300" />
                {initialData?.isFromChat ? (
                  <Wand2 className="w-4 h-4 text-amber-400" />
                ) : (
                  <Plus className="w-4 h-4 text-cyan-400" />
                )}
                <span className="font-mono text-sm text-cyan-500">
                  {t('dun.create_title')}
                </span>
              </div>
              <button
                onClick={handleClose}
                className="p-1 hover:bg-stone-100 rounded transition-colors"
                disabled={isCreating}
              >
                <X className="w-4 h-4 text-stone-400" />
              </button>
            </div>

            <div className="p-5">
              {initialData?.isFromChat && isCreating && (
                <div className="flex flex-col items-center gap-3 py-6">
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1.5, ease: 'linear' }}
                  >
                    <Sparkles className="w-8 h-8 text-cyan-400" />
                  </motion.div>
                  <p className="text-sm text-stone-500">{t('dun.creating_from_chat')}</p>
                </div>
              )}

              {!initialData?.isFromChat && (
                <>
                  <textarea
                    ref={inputRef}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('dun.intent_placeholder')}
                    rows={3}
                    disabled={isCreating}
                    className="w-full px-3 py-2.5 bg-stone-50 border border-stone-200 rounded-xl
                             text-sm text-stone-800 placeholder:text-stone-300 resize-none
                             focus:outline-none focus:border-cyan-400/50 focus:bg-white
                             transition-colors disabled:opacity-50"
                  />

                  {error && (
                    <p className="text-xs text-red-400 mt-2">{error}</p>
                  )}

                  <div className="flex items-center justify-between mt-4">
                    <p className="text-[11px] text-stone-300">
                      {isCreating ? t('dun.generating') : t('dun.create_hint')}
                    </p>
                    <button
                      onClick={handleCreate}
                      disabled={!intent.trim() || isCreating}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl
                               text-sm font-mono bg-cyan-500/15 border border-cyan-500/30
                               text-cyan-500 hover:bg-cyan-500/25 transition-colors
                               disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {isCreating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Sparkles className="w-4 h-4" />
                      )}
                      {isCreating ? t('dun.generating_btn') : t('dun.create_btn')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
