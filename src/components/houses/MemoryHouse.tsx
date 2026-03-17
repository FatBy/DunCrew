import { useMemo, useState, useEffect } from 'react'
import {
  BookOpen, Sparkles, Loader2, Inbox,
  Zap, GraduationCap, Coffee, Flame,
  Hash, MessageSquare, Code2, RefreshCw, Calendar,
} from 'lucide-react'
import { GlassCard } from '@/components/GlassCard'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { isLLMConfigured } from '@/services/llmService'
import { useT } from '@/i18n'
import type { MemoryEntry, JournalEntry, JournalMood } from '@/types'

// ============================================
// Mood 配置
// ============================================

const moodConfig: Record<JournalMood, {
  icon: typeof Zap
  label: string
  color: string
  bgColor: string
  glowColor: string
  emoji: string
  gradient: string
}> = {
  productive: {
    icon: Zap, label: '高效日', color: 'text-amber-400',
    bgColor: 'bg-amber-500/10', glowColor: 'amber', emoji: '⚡',
    gradient: 'from-amber-500 to-orange-500',
  },
  learning: {
    icon: GraduationCap, label: '探索日', color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/10', glowColor: 'cyan', emoji: '🔍',
    gradient: 'from-cyan-500 to-blue-500',
  },
  casual: {
    icon: Coffee, label: '休闲日', color: 'text-emerald-400',
    bgColor: 'bg-emerald-500/10', glowColor: 'emerald', emoji: '☕',
    gradient: 'from-emerald-500 to-teal-500',
  },
  challenging: {
    icon: Flame, label: '挑战日', color: 'text-purple-400',
    bgColor: 'bg-purple-500/10', glowColor: 'purple', emoji: '🔥',
    gradient: 'from-purple-500 to-pink-500',
  },
}

// ============================================
// 工具函数
// ============================================

function getTodayStr(): string {
  return new Date().toLocaleDateString('sv-SE')
}

function formatFullDate(dateStr: string): string {
  const today = getTodayStr()
  try {
    const d = new Date(dateStr + 'T00:00:00')
    if (isNaN(d.getTime())) return dateStr
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
    }).format(d)
    if (dateStr === today) return `${formatted} · 今天`
    return formatted
  } catch {
    return dateStr
  }
}

function formatShortDate(dateStr: string): string {
  const today = getTodayStr()
  const yesterday = (() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('sv-SE')
  })()

  if (dateStr === today) return '今天'
  if (dateStr === yesterday) return '昨天'

  try {
    const d = new Date(dateStr + 'T00:00:00')
    if (isNaN(d.getTime())) return dateStr
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(d)
  } catch {
    return dateStr
  }
}

// ============================================
// 编年史时间线 (左侧边栏)
// ============================================

function ChronicleTimeline({
  entries,
  selectedDate,
  onSelectDate,
}: {
  entries: JournalEntry[]
  selectedDate: string
  onSelectDate: (date: string) => void
}) {
  const t = useT()
  const today = getTodayStr()

  // 确保今天在列表中 (即使还没生成日志)
  const dates = useMemo(() => {
    const entryDates = entries.map(e => e.date)
    if (!entryDates.includes(today)) {
      return [today, ...entryDates]
    }
    return entryDates
  }, [entries, today])

  const entryMap = useMemo(() => {
    const map = new Map<string, JournalEntry>()
    entries.forEach(e => map.set(e.date, e))
    return map
  }, [entries])

  return (
    <div className="w-40 border-r border-stone-200 flex flex-col">
      <div className="p-4 pb-2">
        <div className="flex items-center gap-2">
          <Calendar className="w-3.5 h-3.5 text-emerald-400" />
          <h4 className="font-mono text-xs text-emerald-300 uppercase tracking-wider">
            {t('memory.chronicle')}
          </h4>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <div className="relative">
          {/* 时间线竖线 */}
          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-stone-100" />

          <div className="space-y-1">
            {dates.map((date) => {
              const entry = entryMap.get(date)
              const isSelected = date === selectedDate
              const isToday = date === today
              const mood = entry ? moodConfig[entry.mood] : null

              return (
                <button
                  key={date}
                  onClick={() => onSelectDate(date)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-1 py-1.5 rounded-lg text-left transition-all duration-200',
                    'hover:bg-stone-100/80',
                    isSelected && 'bg-stone-100',
                  )}
                >
                  {/* 时间线节点 */}
                  <div className={cn(
                    'relative z-10 w-[15px] h-[15px] rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors',
                    isSelected
                      ? 'border-emerald-400 bg-emerald-400/20'
                      : entry
                        ? 'border-stone-300 bg-stone-100/80'
                        : 'border-stone-200 bg-transparent',
                  )}>
                    {mood && (
                      <span className="text-[8px] leading-none">{mood.emoji}</span>
                    )}
                  </div>

                  {/* 日期文本 */}
                  <div className="min-w-0">
                    <p className={cn(
                      'text-[12px] font-mono truncate',
                      isSelected ? 'text-stone-800' : 'text-stone-400',
                      isToday && 'font-medium',
                    )}>
                      {formatShortDate(date)}
                    </p>
                    {entry && (
                      <p className="text-[10px] font-mono text-stone-300 truncate">
                        {entry.memoryCount} {t('memory.conversations')}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================
// 日记卡片 (3D 翻转: 正面日记 / 背面原始数据)
// ============================================

function DiaryCard({
  entry,
  rawMemories,
  isGeekMode,
  isLoading,
}: {
  entry: JournalEntry | undefined
  rawMemories: MemoryEntry[]
  isGeekMode: boolean
  isLoading: boolean
}) {
  const t = useT()

  if (isLoading && !entry) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          <p className="text-sm font-mono text-stone-400">{t('memory.auto_generating')}</p>
        </div>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center">
          <Inbox className="w-12 h-12 text-stone-200" />
          <p className="text-sm font-mono text-stone-400">{t('memory.no_journal_today')}</p>
          <p className="text-xs font-mono text-stone-300">{t('memory.auto_generate_hint')}</p>
        </div>
      </div>
    )
  }

  const mood = moodConfig[entry.mood]
  const MoodIcon = mood.icon

  return (
    <div className="flex-1 min-h-0 perspective-1000">
      <div className={cn(
        'relative w-full h-full transition-transform duration-500 preserve-3d',
        isGeekMode && '[transform:rotateY(180deg)]',
      )}>
        {/* ===== 正面：日记内容 ===== */}
        <div className="absolute inset-0 backface-hidden overflow-hidden">
          <GlassCard themeColor={mood.glowColor} className="p-0 overflow-hidden h-full">
            {/* Mood 顶部条带 */}
            <div className={cn('h-1 w-full bg-gradient-to-r', mood.gradient)} />

            <div className="p-6 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(100% - 4px)' }}>
              {/* Mood 徽章 + 标题 */}
              <div className="flex items-center gap-3">
                <span className={cn(
                  'px-3 py-1.5 rounded-full text-sm font-mono flex items-center gap-1.5',
                  mood.bgColor, mood.color,
                )}>
                  <MoodIcon className="w-3.5 h-3.5" />
                  {mood.label}
                </span>
                <span className="text-lg">{mood.emoji}</span>
              </div>

              <h2 className="text-xl font-medium text-stone-800">{entry.title}</h2>

              {/* 叙事内容 */}
              <p className="text-sm text-stone-600 leading-relaxed whitespace-pre-wrap">
                {entry.narrative}
              </p>

              {/* 关键事实 */}
              {entry.keyFacts.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {entry.keyFacts.map((fact, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-full text-xs font-mono bg-stone-100/80 text-stone-400 border border-stone-200 flex items-center gap-1"
                    >
                      <Hash className="w-2.5 h-2.5" />
                      {fact}
                    </span>
                  ))}
                </div>
              )}

              {/* 底部 meta */}
              <div className="pt-3 border-t border-stone-100 flex items-center justify-between text-xs font-mono text-stone-300">
                <div className="flex items-center gap-1">
                  <MessageSquare className="w-3 h-3" />
                  <span>{entry.memoryCount} {t('memory.conversations')}</span>
                </div>
                <span>{entry.date}</span>
              </div>
            </div>
          </GlassCard>
        </div>

        {/* ===== 背面：原始记忆数据 ===== */}
        <div className="absolute inset-0 backface-hidden [transform:rotateY(180deg)] overflow-hidden">
          <GlassCard className="p-0 overflow-hidden h-full">
            <div className="h-1 w-full bg-gradient-to-r from-slate-500 to-slate-600" />

            <div className="p-5 overflow-y-auto" style={{ maxHeight: 'calc(100% - 4px)' }}>
              <div className="flex items-center gap-2 mb-4">
                <Code2 className="w-4 h-4 text-stone-400" />
                <h3 className="font-mono text-sm text-stone-400">{t('memory.raw_data')}</h3>
                <span className="text-xs font-mono text-stone-300 ml-auto">
                  {rawMemories.length} 条
                </span>
              </div>

              {rawMemories.length > 0 ? (
                <div className="space-y-2">
                  {rawMemories.map(mem => (
                    <div
                      key={mem.id}
                      className="px-3 py-2 bg-white/[0.03] rounded-lg border border-stone-100 font-mono text-xs"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className={cn(
                          'px-1.5 py-0.5 rounded text-[11px]',
                          mem.role === 'user'
                            ? 'bg-cyan-500/15 text-cyan-400/70'
                            : 'bg-purple-500/15 text-purple-400/70',
                        )}>
                          {mem.role === 'user' ? t('memory.user') : t('memory.ai')}
                        </span>
                        <span className="text-stone-400 truncate">{mem.title}</span>
                        <span className="text-stone-300 ml-auto text-[10px]">
                          {(() => {
                            try {
                              const d = new Date(mem.timestamp)
                              return isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', {
                                hour: '2-digit', minute: '2-digit', hour12: false,
                              }).format(d)
                            } catch { return '' }
                          })()}
                        </span>
                      </div>
                      <p className="text-stone-300 line-clamp-3">{mem.content}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-sm font-mono text-stone-300">{t('memory.no_raw_data')}</p>
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </div>
  )
}

// ============================================
// 主组件
// ============================================

export function MemoryHouse() {
  const t = useT()
  const storeMemories = useStore(s => s.memories)
  const chatMessages = useStore(s => s.getCurrentMessages())
  const journalEntries = useStore(s => s.journalEntries)
  const journalLoading = useStore(s => s.journalLoading)
  const connectionStatus = useStore(s => s.connectionStatus)
  const generateSilentJournal = useStore(s => s.generateSilentJournal)
  const generateJournal = useStore(s => s.generateJournal)

  const isConnected = connectionStatus === 'connected'
  const llmReady = isLLMConfigured()

  const [selectedDate, setSelectedDate] = useState<string>(getTodayStr)
  const [isGeekMode, setIsGeekMode] = useState(false)

  // 按日期降序排列
  const sortedJournals = useMemo(() =>
    [...journalEntries].sort((a, b) => b.date.localeCompare(a.date)),
    [journalEntries],
  )

  // 选中的日志条目
  const selectedEntry = useMemo(() =>
    sortedJournals.find(e => e.date === selectedDate),
    [sortedJournals, selectedDate],
  )

  // 选中日期的原始记忆
  const selectedMemories = useMemo(() =>
    storeMemories.filter(m => {
      try {
        return new Date(m.timestamp).toLocaleDateString('sv-SE') === selectedDate
      } catch { return false }
    }),
    [storeMemories, selectedDate],
  )

  // 组件挂载时从 localStorage 加载缓存日志
  useEffect(() => {
    try {
      const raw = localStorage.getItem('ddos_journal_entries')
      if (raw) {
        const entries: JournalEntry[] = JSON.parse(raw)
        if (entries.length > 0 && journalEntries.length === 0) {
          useStore.getState().setJournalEntries(entries)
        }
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 自动静默生成今天的日志 (有聊天记录或记忆时触发)
  useEffect(() => {
    const hasContent = storeMemories.length > 0 || chatMessages.filter(m => m.role !== 'system').length >= 2
    if (isConnected && hasContent) {
      generateSilentJournal()
    }
  }, [isConnected, storeMemories.length, chatMessages.length, generateSilentJournal])

  // 手动全量重新生成
  const handleRefresh = () => {
    if (llmReady && storeMemories.length > 0 && !journalLoading) {
      try { localStorage.removeItem('ddos_journal_entries') } catch {}
      useStore.getState().setJournalEntries([])
      generateJournal(storeMemories)
    }
  }

  // 底部统计
  const stats = useMemo(() => ({
    totalDays: sortedJournals.length,
    totalMemories: storeMemories.length,
  }), [sortedJournals.length, storeMemories.length])

  return (
    <div className="flex flex-col h-full">
      {/* LLM 未配置提示 */}
      {!llmReady && isConnected && storeMemories.length > 0 && (
        <div className="mx-4 mt-3 px-4 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg">
          <div className="flex items-center gap-2 text-xs font-mono text-stone-400">
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('memory.llm_not_configured')}</span>
          </div>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* 左侧: 编年史时间线 */}
        <ChronicleTimeline
          entries={sortedJournals}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
        />

        {/* 主区域 */}
        <div className="flex-1 flex flex-col p-6 min-h-0">
          {/* 头部 */}
          <div className="flex items-center justify-between mb-4 flex-shrink-0">
            <div className="flex items-center gap-3">
              <BookOpen className="w-5 h-5 text-emerald-400" />
              <h3 className="text-sm font-mono text-stone-700">
                {formatFullDate(selectedDate)}
              </h3>
            </div>

            <div className="flex items-center gap-3">
              {journalLoading && (
                <span className="flex items-center gap-1.5 text-xs font-mono text-amber-400/60">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {t('memory.generating')}
                </span>
              )}

              {/* 极客模式切换 */}
              <button
                onClick={() => setIsGeekMode(!isGeekMode)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-all',
                  isGeekMode
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                    : 'bg-stone-100/80 text-stone-300 border border-stone-200 hover:text-stone-400',
                )}
              >
                <Code2 className="w-3 h-3" />
                {t('memory.geek_mode')}
              </button>

              {/* 手动重新生成 */}
              {llmReady && isConnected && (
                <button
                  onClick={handleRefresh}
                  disabled={journalLoading}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono bg-stone-100/80 text-stone-300 border border-stone-200 hover:text-stone-400 transition-all disabled:opacity-30"
                  title={t('memory.regenerate')}
                >
                  <RefreshCw className={cn('w-3 h-3', journalLoading && 'animate-spin')} />
                </button>
              )}

              {/* 统计摘要 */}
              <div className="flex items-center gap-2 text-xs font-mono text-stone-300">
                <span>{stats.totalDays} {t('memory.adventure_days')}</span>
                <span>·</span>
                <span>{stats.totalMemories} {t('memory.total_memories')}</span>
              </div>
            </div>
          </div>

          {/* 日记卡片 (3D 翻转) */}
          <DiaryCard
            entry={selectedEntry}
            rawMemories={selectedMemories}
            isGeekMode={isGeekMode}
            isLoading={journalLoading}
          />
        </div>
      </div>
    </div>
  )
}
