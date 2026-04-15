/**
 * DunKnowledgeTab - Dun 知识库 Tab (V3: WSJ Editorial Style)
 *
 * 从 wiki API 加载 Entity 列表，点击打开详情弹窗。
 * 设计语言：衬线标题 + 暖色中性调 + 编辑式排版
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  BookOpen, Loader2, Search, FileText,
  Globe2, Sparkles, TrendingUp, Layers,
  ChevronDown, AlertTriangle,
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { getServerUrl } from '@/utils/env'
import { KnowledgeDetailModal } from './KnowledgeDetailModal'

// ============================================
// Types
// ============================================

interface WikiEntity {
  id: string
  dunId: string | null
  slug: string
  title: string
  type: string
  tldr: string | null
  tags: string[]
  status: string
  claimCount: number
  createdAt: number
  updatedAt: number
}

// ============================================
// WSJ palette (shared with Modal)
// ============================================

const INK = '#1a1a1a'
const INK_LIGHT = '#4a4a4a'
const INK_DIM = '#6b6b6b'
const INK_MUTED = '#a0a0a0'
const BORDER = '#e0ddd8'
const BORDER_LIGHT = '#f0eeeb'
const BG_WARM = '#f5f4f0'
const ACCENT = '#c4392d'
const GREEN = '#2d6a2d'
const FONT_SERIF = "'Georgia', 'Noto Serif SC', 'SimSun', serif"
const FONT_MONO = "'JetBrains Mono', 'Cascadia Code', 'Consolas', monospace"

const TYPE_META: Record<string, { icon: typeof BookOpen; accent: string; label: string }> = {
  concept:  { icon: BookOpen,   accent: ACCENT,    label: 'CONCEPT' },
  pattern:  { icon: Sparkles,   accent: '#8b6914', label: 'PATTERN' },
  tool:     { icon: Layers,     accent: GREEN,     label: 'TOOL' },
  domain:   { icon: Globe2,     accent: '#1a5276', label: 'DOMAIN' },
  metric:   { icon: TrendingUp, accent: ACCENT,    label: 'METRIC' },
}
const DEFAULT_META = { icon: FileText, accent: INK_DIM, label: 'ENTITY' }
function getMeta(type: string) { return TYPE_META[type] || DEFAULT_META }

function formatRelativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  if (hours < 1) return '刚刚'
  if (hours < 24) return `${hours}h前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d前`
  return `${Math.floor(days / 30)}月前`
}

// ============================================
// Entity 卡片 (WSJ entity-item + signal-card hybrid)
// ============================================

function EntityCard({
  entity,
  onViewDetail,
}: {
  entity: WikiEntity
  onViewDetail: () => void
}) {
  const meta = getMeta(entity.type)
  const Icon = meta.icon

  return (
    <motion.button
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onViewDetail}
      className="w-full text-left transition-colors group"
      style={{
        background: '#fff',
        border: `1px solid ${BORDER}`,
        borderLeft: `3px solid ${meta.accent}`,
        borderRadius: 4,
        padding: '14px 16px',
      }}
      whileHover={{ backgroundColor: '#fefefe' }}
    >
      {/* Top line: type label + claim count + time */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5" style={{ color: meta.accent }} />
          <span className="text-[10px] font-bold tracking-[0.8px] uppercase"
                style={{ color: meta.accent }}>
            {meta.label}
          </span>
          {entity.tags.slice(0, 2).map(tag => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded truncate max-w-[80px]"
                  style={{ background: BG_WARM, color: INK_DIM }}>
              {tag}
            </span>
          ))}
        </div>
        <span className="text-[10px]" style={{ color: INK_MUTED }}>
          {formatRelativeTime(entity.updatedAt)}
        </span>
      </div>

      {/* Title */}
      <h4 className="text-[15px] font-bold leading-snug mb-1 group-hover:underline"
          style={{ fontFamily: FONT_SERIF, color: INK, textDecorationColor: '#d0d0d0' }}>
        {entity.title}
      </h4>

      {/* TLDR */}
      {entity.tldr && (
        <p className="text-[13px] leading-[1.6] line-clamp-2 mb-2"
           style={{ color: INK_LIGHT, fontWeight: 300 }}>
          {entity.tldr}
        </p>
      )}

      {/* Bottom meta */}
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded"
              style={{ fontFamily: FONT_MONO, background: BG_WARM, color: INK_DIM }}>
          {entity.claimCount} claims
        </span>
      </div>
    </motion.button>
  )
}

// ============================================
// 旧文件折叠区
// ============================================

interface LegacyFile {
  filename: string
  summary: string
  lastHit: string
}

function LegacyFilesSection({ files }: { files: LegacyFile[] }) {
  const [expanded, setExpanded] = useState(false)

  if (files.length === 0) return null

  return (
    <div className="overflow-hidden rounded" style={{ border: `1px solid ${BORDER_LIGHT}`, background: BG_WARM }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-[#eeede9]"
      >
        <AlertTriangle className="w-3.5 h-3.5" style={{ color: INK_MUTED }} />
        <span className="text-[12px] font-medium flex-1 text-left" style={{ color: INK_DIM }}>
          旧格式文件 ({files.length}) — 将在后台自动迁移
        </span>
        <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-180')}
                     style={{ color: INK_MUTED }} />
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-1.5">
              {files.map(f => (
                <div key={f.filename} className="flex items-center gap-2 text-[12px] py-1"
                     style={{ color: INK_MUTED }}>
                  <FileText className="w-3 h-3 shrink-0" />
                  <span style={{ fontFamily: FONT_MONO }}>{f.filename}</span>
                  {f.summary && (
                    <>
                      <span style={{ color: '#d0d0d0' }}>&middot;</span>
                      <span className="truncate">{f.summary}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ============================================
// 主组件
// ============================================

interface DunKnowledgeTabProps {
  dunId: string
}

export function DunKnowledgeTab({ dunId }: DunKnowledgeTabProps) {
  const [entities, setEntities] = useState<WikiEntity[]>([])
  const [legacyFiles, setLegacyFiles] = useState<LegacyFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const [selectedEntityId, setSelectedEntityId] = useState<string | null>(null)

  const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()

  const loadEntities = useCallback(async () => {
    try {
      const resp = await fetch(`${serverUrl}/api/wiki/entities?dun_id=${encodeURIComponent(dunId)}`)
      if (!resp.ok) return []
      return await resp.json() as WikiEntity[]
    } catch { return [] }
  }, [dunId, serverUrl])

  const loadLegacyFiles = useCallback(async () => {
    try {
      const resp = await fetch(`${serverUrl}/duns/${dunId}/knowledge`)
      if (!resp.ok) return []
      const data = await resp.json()
      const LEGACY_NAMES = new Set([
        'environment.md', 'preferences.md', 'domain.md', 'tools.md', 'strategies.md',
      ])
      return ((data.files || []) as Array<{ filename: string }>)
        .filter(f => LEGACY_NAMES.has(f.filename))
        .map(f => ({ filename: f.filename, summary: '', lastHit: '' }))
    } catch { return [] }
  }, [dunId, serverUrl])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [ents, legacy] = await Promise.all([loadEntities(), loadLegacyFiles()])
      setEntities(ents)
      setLegacyFiles(legacy)
    } catch {
      setError('加载知识库失败')
    } finally {
      setLoading(false)
    }
  }, [loadEntities, loadLegacyFiles])

  useEffect(() => { loadAll() }, [loadAll])

  const filteredEntities = useMemo(() => {
    if (!searchQuery) return entities
    const q = searchQuery.toLowerCase()
    return entities.filter(e =>
      e.title.toLowerCase().includes(q) ||
      (e.tldr || '').toLowerCase().includes(q) ||
      e.tags.some(t => t.toLowerCase().includes(q))
    )
  }, [entities, searchQuery])

  // ── Render ──

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin" style={{ color: INK_MUTED }} />
      </div>
    )
  }

  return (
    <div className="space-y-4 py-2">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
                style={{ color: INK_MUTED }} />
        <input
          type="text"
          placeholder="搜索知识实体..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full pl-9 pr-3 py-2.5 text-[13px] focus:outline-none transition-colors"
          style={{
            background: '#fff',
            border: `1px solid ${BORDER}`,
            borderRadius: 4,
            color: INK,
          }}
          onFocus={e => { e.currentTarget.style.borderColor = INK_DIM }}
          onBlur={e => { e.currentTarget.style.borderColor = BORDER }}
        />
      </div>

      {error && <p className="text-[12px]" style={{ color: ACCENT }}>{error}</p>}

      {/* Entity list */}
      {filteredEntities.length > 0 ? (
        <div className="space-y-3">
          {/* Section header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[10px] font-bold tracking-[1.5px] uppercase"
                   style={{ fontFamily: FONT_MONO, color: ACCENT }}>
                KNOWLEDGE BASE
              </div>
              <h3 className="text-[16px] font-bold tracking-tight"
                  style={{ fontFamily: FONT_SERIF, color: INK }}>
                知识实体
                <span className="text-[12px] font-normal ml-1.5" style={{ color: INK_DIM }}>
                  ({filteredEntities.length})
                </span>
              </h3>
            </div>
          </div>

          {/* Cards */}
          <div className="space-y-2">
            {filteredEntities.map((entity, idx) => (
              <motion.div
                key={entity.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.04 }}
              >
                <EntityCard
                  entity={entity}
                  onViewDetail={() => setSelectedEntityId(entity.id)}
                />
              </motion.div>
            ))}
          </div>
        </div>
      ) : !error && (
        <div className="text-center py-10">
          <BookOpen className="w-8 h-8 mx-auto mb-2" style={{ color: BORDER }} />
          <p className="text-[14px]" style={{ color: INK_MUTED }}>
            {searchQuery ? '无匹配结果' : '暂无知识实体'}
          </p>
          {!searchQuery && (
            <p className="text-[12px] mt-1" style={{ color: '#c8c8c8' }}>
              执行任务后，知识摄入管道会自动沉淀经验
            </p>
          )}
        </div>
      )}

      {/* Legacy files */}
      <LegacyFilesSection files={legacyFiles} />

      {/* Detail modal */}
      <KnowledgeDetailModal
        entityId={selectedEntityId}
        serverUrl={serverUrl}
        allEntities={entities}
        onClose={() => setSelectedEntityId(null)}
      />
    </div>
  )
}
