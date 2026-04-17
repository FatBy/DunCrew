/**
 * LibraryHome - 智能首页（Layer 1）
 * WSJ Editorial Style 首页：搜索、最近实体、健康告警、分类浏览、统计概览
 */

import { motion } from 'framer-motion'
import {
  Search, AlertTriangle, BookOpen, Loader2,
  ArrowRight, TrendingUp, Link2, FileText,
} from 'lucide-react'
import {
  INK, INK_LIGHT, INK_DIM, INK_MUTED,
  BG, BG_WARM, BORDER, BORDER_LIGHT, ACCENT, GREEN,
  FONT_SERIF, FONT_MONO,
  getMeta, formatRelativeTime,
} from '@/components/shared/wiki-ui/constants'
import type { WikiStats, SearchResult, LibrarianContext } from './useLibraryData'
import { LibrarianPanel } from './LibrarianPanel'

interface LibraryHomeProps {
  stats: WikiStats | null
  statsLoading: boolean
  searchQuery: string
  onSearchChange: (q: string) => void
  searchResults: SearchResult[] | null
  searchLoading: boolean
  onSelectEntity: (entityId: string) => void
  onSelectCategory: (category?: string) => void
  // P4: Librarian
  librarianContext: LibrarianContext | null
  librarianLoading: boolean
  onStartLibrarian: (scope?: string, category?: string) => void
  onExecuteLibrarian: (actions: Record<string, unknown>[]) => Promise<{ executed: number; errors: string[] } | undefined>
}

export function LibraryHome({
  stats, statsLoading,
  searchQuery, onSearchChange,
  searchResults, searchLoading,
  onSelectEntity, onSelectCategory,
  librarianContext, librarianLoading,
  onStartLibrarian, onExecuteLibrarian,
}: LibraryHomeProps) {
  const hasIssues = stats && (stats.healthIssues.conflicts > 0 || stats.healthIssues.emptyEntities > 0)

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: BG }}>
      <div className="px-8 pt-8 pb-12 max-w-[860px] mx-auto">

        {/* Masthead */}
        <div className="text-center mb-8">
          <div className="text-[10px] font-bold tracking-[2px] uppercase mb-1"
               style={{ fontFamily: FONT_MONO, color: ACCENT }}>
            DUNCREW LIBRARY
          </div>
          <h1 className="text-[32px] font-bold leading-tight"
              style={{ fontFamily: FONT_SERIF, color: INK }}>
            知识图书馆
          </h1>
          {stats && (
            <p className="text-[13px] mt-1" style={{ color: INK_DIM }}>
              {stats.totalEntities} 实体 &middot; {stats.totalClaims} 断言 &middot; {stats.totalRelations} 关联
            </p>
          )}
        </div>

        {/* 搜索栏 */}
        <div className="relative mb-8 max-w-[540px] mx-auto">
          {searchLoading ? (
            <Loader2 className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin"
                     style={{ color: ACCENT }} />
          ) : (
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4"
                    style={{ color: INK_MUTED }} />
          )}
          <input
            type="text"
            placeholder="语义搜索知识库..."
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            className="w-full pl-11 pr-4 py-3 text-[14px] focus:outline-none rounded-lg transition-shadow"
            style={{
              background: '#fff',
              border: `1px solid ${searchQuery ? ACCENT : BORDER}`,
              color: INK,
              boxShadow: searchQuery ? `0 0 0 1px ${ACCENT}20` : 'none',
            }}
          />
        </div>

        {/* 搜索结果覆盖层 */}
        {searchResults && searchResults.length > 0 && (
          <div className="mb-8 max-w-[540px] mx-auto">
            <div className="text-[10px] font-bold tracking-[1.2px] uppercase mb-3"
                 style={{ fontFamily: FONT_MONO, color: ACCENT }}>
              SEARCH RESULTS ({searchResults.length})
            </div>
            <div className="space-y-2">
              {searchResults.map((r, i) => {
                const meta = getMeta(r.type)
                const Icon = meta.icon
                return (
                  <motion.button
                    key={r.entityId}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="w-full text-left px-4 py-3 rounded-lg transition-colors group"
                    style={{ background: '#fff', border: `1px solid ${BORDER_LIGHT}` }}
                    onClick={() => onSelectEntity(r.entityId)}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = meta.accent }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = BORDER_LIGHT }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="w-3 h-3" style={{ color: meta.accent }} />
                      <span className="text-[10px] font-bold tracking-[0.5px] uppercase"
                            style={{ color: meta.accent }}>{meta.label}</span>
                      <span className="text-[10px] ml-auto" style={{ fontFamily: FONT_MONO, color: INK_MUTED }}>
                        {Math.round(r.score * 100)}%
                      </span>
                    </div>
                    <div className="text-[14px] font-medium" style={{ color: INK }}>{r.title}</div>
                    {r.tldr && (
                      <div className="text-[12px] mt-0.5 line-clamp-1" style={{ color: INK_DIM }}>{r.tldr}</div>
                    )}
                  </motion.button>
                )
              })}
            </div>
          </div>
        )}

        {searchResults && searchResults.length === 0 && searchQuery && (
          <div className="mb-8 max-w-[540px] mx-auto text-center py-6">
            <p className="text-[13px]" style={{ color: INK_MUTED }}>未找到与 &ldquo;{searchQuery}&rdquo; 语义相关的知识</p>
          </div>
        )}

        {/* 非搜索状态：首页内容 */}
        {!searchResults && (
          <>
            {/* P4: Librarian 审计面板 */}
            <div className="mb-6 flex justify-end">
              <LibrarianPanel
                context={librarianContext}
                loading={librarianLoading}
                onStart={onStartLibrarian}
                onExecute={onExecuteLibrarian}
                onClose={() => {/* context will be cleared by execute */}}
              />
            </div>
            {statsLoading && !stats && (
              <div className="flex justify-center py-12">
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: INK_MUTED }} />
              </div>
            )}

            {stats && (
              <>
                {/* 最近更新 */}
                {stats.recentEntities.length > 0 && (
                  <section className="mb-8">
                    <SectionLabel label="RECENT UPDATES" />
                    <h3 className="text-[18px] font-bold mb-3"
                        style={{ fontFamily: FONT_SERIF, color: INK }}>最近更新</h3>
                    <div className="grid grid-cols-2 gap-3">
                      {stats.recentEntities.slice(0, 6).map((ent, i) => {
                        const meta = getMeta(ent.type)
                        const Icon = meta.icon
                        return (
                          <motion.button
                            key={ent.id}
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: i * 0.04 }}
                            className="text-left px-4 py-3 rounded transition-colors group"
                            style={{ background: '#fff', border: `1px solid ${BORDER_LIGHT}` }}
                            onClick={() => onSelectEntity(ent.id)}
                            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = meta.accent }}
                            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = BORDER_LIGHT }}
                          >
                            <div className="flex items-center gap-1.5 mb-1">
                              <Icon className="w-3 h-3" style={{ color: meta.accent }} />
                              <span className="text-[10px] font-bold tracking-[0.5px] uppercase"
                                    style={{ color: meta.accent }}>{meta.label}</span>
                            </div>
                            <div className="text-[13px] font-medium truncate" style={{ color: INK }}>
                              {ent.title}
                            </div>
                            <div className="text-[10px] mt-1" style={{ color: INK_MUTED }}>
                              {formatRelativeTime(ent.updatedAt)}
                              {ent.category && <span> &middot; {ent.category}</span>}
                            </div>
                          </motion.button>
                        )
                      })}
                    </div>
                  </section>
                )}

                {/* 健康告警 */}
                {hasIssues && (
                  <section className="mb-8">
                    <SectionLabel label="ATTENTION" />
                    <div className="px-4 py-3 rounded-lg"
                         style={{ background: '#fef7f6', border: `1px solid ${ACCENT}30` }}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <AlertTriangle className="w-4 h-4" style={{ color: ACCENT }} />
                        <span className="text-[13px] font-bold" style={{ color: INK }}>需要关注</span>
                      </div>
                      <div className="space-y-1">
                        {stats.healthIssues.conflicts > 0 && (
                          <p className="text-[12px]" style={{ color: INK_LIGHT }}>
                            {stats.healthIssues.conflicts} 个断言存在冲突，需要审核
                          </p>
                        )}
                        {stats.healthIssues.emptyEntities > 0 && (
                          <p className="text-[12px]" style={{ color: INK_LIGHT }}>
                            {stats.healthIssues.emptyEntities} 个实体没有有效断言（空壳）
                          </p>
                        )}
                      </div>
                    </div>
                  </section>
                )}

                {/* 按主题浏览 */}
                {stats.categories.length > 0 && (
                  <section className="mb-8">
                    <SectionLabel label="BROWSE BY TOPIC" />
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[18px] font-bold"
                          style={{ fontFamily: FONT_SERIF, color: INK }}>按主题浏览</h3>
                      <button
                        className="text-[12px] flex items-center gap-1 transition-opacity hover:opacity-70"
                        style={{ color: ACCENT }}
                        onClick={() => onSelectCategory()}
                      >
                        查看全部 <ArrowRight className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {stats.categories.map((cat, i) => (
                        <motion.button
                          key={cat.name}
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: i * 0.03 }}
                          className="px-3 py-2 rounded-lg transition-colors text-left"
                          style={{ background: '#fff', border: `1px solid ${BORDER_LIGHT}` }}
                          onClick={() => onSelectCategory(cat.name)}
                          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = BG_WARM }}
                          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = '#fff' }}
                        >
                          <span className="text-[13px] font-medium" style={{ color: INK }}>{cat.name}</span>
                          <span className="text-[11px] ml-1.5" style={{ fontFamily: FONT_MONO, color: INK_DIM }}>
                            ({cat.count})
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  </section>
                )}

                {/* 知识概览 */}
                <section className="mb-8">
                  <SectionLabel label="OVERVIEW" />
                  <h3 className="text-[18px] font-bold mb-3"
                      style={{ fontFamily: FONT_SERIF, color: INK }}>知识概览</h3>
                  <div className="grid grid-cols-3 gap-3">
                    <StatCard icon={BookOpen} label="实体" value={stats.totalEntities} color={ACCENT} />
                    <StatCard icon={FileText} label="断言" value={stats.totalClaims} color={GREEN} />
                    <StatCard icon={Link2} label="关联" value={stats.totalRelations} color="#1a5276" />
                  </div>
                  {stats.types.length > 0 && (
                    <div className="mt-3 px-4 py-3 rounded-lg" style={{ background: '#fff', border: `1px solid ${BORDER_LIGHT}` }}>
                      <div className="text-[11px] font-medium mb-2" style={{ color: INK_DIM }}>类型分布</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {stats.types.map(t => {
                          const meta = getMeta(t.name)
                          return (
                            <div key={t.name} className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full" style={{ background: meta.accent }} />
                              <span className="text-[12px]" style={{ color: INK_LIGHT }}>{meta.label}</span>
                              <span className="text-[11px]" style={{ fontFamily: FONT_MONO, color: INK_MUTED }}>{t.count}</span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ── Sub-components ──

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="text-[10px] font-bold tracking-[1.5px] uppercase mb-1"
         style={{ fontFamily: FONT_MONO, color: ACCENT }}>
      {label}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof TrendingUp
  label: string
  value: number
  color: string
}) {
  return (
    <div className="text-center py-4 px-3 rounded-lg"
         style={{ background: '#fff', border: `1px solid ${BORDER_LIGHT}` }}>
      <Icon className="w-4 h-4 mx-auto mb-1.5" style={{ color }} />
      <div className="text-[22px] font-medium leading-none mb-1"
           style={{ fontFamily: FONT_MONO, color: INK }}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px]" style={{ color: INK_DIM }}>{label}</div>
    </div>
  )
}
