/**
 * DiaryView - 每日日记展示组件
 *
 * 在任务屋中展示按天聚合的对话日记。
 * 支持：
 * - 日记列表（按日期倒序）
 * - 展开/收起日记详情
 * - 手动生成今天的日记
 * - 自动生成昨天的日记
 */

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Loader2,
  Calendar,
  MessageSquare,
  Sparkles,
  PenLine,
} from 'lucide-react'
import { diaryService, type DiaryEntry } from '@/services/diaryService'
import { cn } from '@/utils/cn'

/** 将 YYYY-MM-DD 格式化为友好的中文日期 */
function formatFriendlyDate(dateStr: string): string {
  const today = new Date()
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`

  if (dateStr === todayStr) return '今天'
  if (dateStr === yesterdayStr) return '昨天'

  const parts = dateStr.split('-')
  if (parts.length === 3) {
    return `${parseInt(parts[1])}月${parseInt(parts[2])}日`
  }
  return dateStr
}

/** 获取星期几 */
function getWeekday(dateStr: string): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const date = new Date(dateStr + 'T00:00:00')
  return weekdays[date.getDay()]
}

export function DiaryView() {
  const [diaries, setDiaries] = useState<DiaryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // 加载日记列表
  const loadDiaries = useCallback(async () => {
    setLoading(true)
    try {
      const entries = await diaryService.listDiaries()
      setDiaries(entries)
      // 自动展开最新的一篇
      if (entries.length > 0 && !expandedId) {
        setExpandedId(entries[0].id)
      }
    } catch (error) {
      console.warn('[DiaryView] Failed to load diaries:', error)
    } finally {
      setLoading(false)
    }
  }, [expandedId])

  // 初始加载 + 自动生成昨天日记
  useEffect(() => {
    const initialize = async () => {
      await diaryService.autoGenerateYesterdayDiary()
      await loadDiaries()
    }
    initialize()
  }, [])

  // 手动生成今天的日记
  const handleGenerateToday = useCallback(async () => {
    setGenerating(true)
    try {
      const content = await diaryService.generateTodayDiary()
      if (content) {
        await loadDiaries()
      }
    } catch (error) {
      console.warn('[DiaryView] Failed to generate today diary:', error)
    } finally {
      setGenerating(false)
    }
  }, [loadDiaries])

  // 切换展开/收起
  const toggleExpand = (diaryId: string) => {
    setExpandedId(prev => prev === diaryId ? null : diaryId)
  }

  // 加载态
  if (loading && diaries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-amber-400 animate-spin" />
          <p className="text-sm text-stone-400">加载日记中...</p>
        </div>
      </div>
    )
  }

  // 空状态
  if (diaries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4 text-center max-w-sm">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-200/60 flex items-center justify-center">
            <BookOpen className="w-8 h-8 text-amber-300" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-stone-600 mb-1">暂无日记</h3>
            <p className="text-xs text-stone-400 leading-relaxed">
              日记由 AI 从每天的对话记忆中自动提炼生成。当你与 AI 进行有意义的对话后，系统会在次日自动生成前一天的日记。
            </p>
          </div>
          <button
            onClick={handleGenerateToday}
            disabled={generating}
            className="flex items-center gap-2 px-4 py-2 text-xs font-bold rounded-lg
              bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200
              transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <PenLine className="w-3.5 h-3.5" />
            )}
            生成今天的日记
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部操作栏 */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200/60 shrink-0">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-amber-500" />
          <span className="text-xs font-semibold text-stone-700">
            {diaries.length} 篇日记
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleGenerateToday}
            disabled={generating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg
              bg-amber-50 hover:bg-amber-100 text-amber-700 border border-amber-200
              transition-colors disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <PenLine className="w-3 h-3" />
            )}
            写今天的日记
          </button>
          <button
            onClick={loadDiaries}
            disabled={loading}
            className="p-1.5 text-stone-400 hover:text-stone-600 transition-colors disabled:opacity-50"
            title="刷新"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* 日记列表 */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
        {diaries.map((diary, index) => {
          const isExpanded = expandedId === diary.id
          return (
            <motion.div
              key={diary.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.03, duration: 0.2 }}
              className={cn(
                'rounded-xl border transition-all duration-200',
                isExpanded
                  ? 'bg-white border-amber-200/80 shadow-sm'
                  : 'bg-white/60 border-stone-200/60 hover:border-stone-300',
              )}
            >
              {/* 日记头部（可点击展开） */}
              <button
                onClick={() => toggleExpand(diary.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left"
              >
                {/* 日期圆圈 */}
                <div className={cn(
                  'w-10 h-10 rounded-xl flex flex-col items-center justify-center shrink-0 transition-colors',
                  isExpanded
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-stone-100 text-stone-500',
                )}>
                  <span className="text-xs font-bold leading-none">
                    {parseInt(diary.date.split('-')[2])}
                  </span>
                  <span className="text-[9px] leading-none mt-0.5">
                    {getWeekday(diary.date)}
                  </span>
                </div>

                {/* 标题信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-700">
                      {formatFriendlyDate(diary.date)}
                    </span>
                    <span className="text-[10px] font-mono text-stone-400">
                      {diary.date}
                    </span>
                    {!!(diary.raw.metadata as Record<string, unknown> | undefined)?.isPartial && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-100 text-amber-600">
                        进行中
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1 text-[10px] text-stone-400">
                      <MessageSquare className="w-3 h-3" />
                      {diary.sessionCount} 次对话
                    </span>
                    {!isExpanded && (
                      <span className="text-[10px] text-stone-400 truncate">
                        {diary.content.slice(0, 60)}...
                      </span>
                    )}
                  </div>
                </div>

                {/* 展开箭头 */}
                {isExpanded ? (
                  <ChevronDown className="w-4 h-4 text-stone-400 shrink-0" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
                )}
              </button>

              {/* 展开的日记内容 */}
              <AnimatePresence>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 pt-1">
                      <div className="pl-[52px]">
                        {/* 日记正文 */}
                        <div className="relative">
                          <div className="absolute -left-6 top-0 bottom-0 w-px bg-amber-200/60" />
                          <Sparkles className="absolute -left-[29px] top-0 w-3.5 h-3.5 text-amber-400" />
                          <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-wrap">
                            {diary.content}
                          </p>
                        </div>

                        {/* 底部元信息 */}
                        <div className="mt-3 flex items-center gap-3 text-[10px] font-mono text-stone-400">
                          <span className="flex items-center gap-1">
                            <Calendar className="w-3 h-3" />
                            生成于 {new Date(diary.generatedAt).toLocaleString('zh-CN')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
