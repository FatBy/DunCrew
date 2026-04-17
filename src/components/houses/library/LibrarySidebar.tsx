/**
 * LibrarySidebar - 左侧操作面板
 * 三层视图适配：首页/列表/详情
 */

import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, Upload, RefreshCw, BookOpen, Loader2, Home, ChevronLeft } from 'lucide-react'
import {
  INK, INK_DIM, INK_MUTED,
  BG_WARM, BORDER, BORDER_LIGHT, FONT_SERIF, FONT_MONO,
  ACCENT, getMeta, formatRelativeTime,
} from '@/components/shared/wiki-ui/constants'
import type { WikiEntitySummary, LibraryExport } from '@/components/shared/wiki-ui/types'
import type { LibraryView, BatchAction } from './useLibraryData'
import { LibraryBatchBar } from './LibraryBatchBar'

interface LibrarySidebarProps {
  view: LibraryView
  entities: WikiEntitySummary[]
  totalCount: number
  onSelectEntity: (id: string) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  onImport: (data: LibraryExport) => Promise<{ created: number; updated: number; errors: number } | undefined>
  importing: boolean
  importProgress: { current: number; total: number } | null
  onRefresh: () => void
  loading: boolean
  onGoHome: () => void
  onGoCategory: (category?: string) => void
  // P3: 批量操作
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onBatchAction: (action: BatchAction) => Promise<unknown>
  categories: string[]
}

export function LibrarySidebar({
  view, entities, totalCount, onSelectEntity,
  searchQuery, onSearchChange, onImport, importing, importProgress,
  onRefresh, loading, onGoHome, onGoCategory,
  selectedIds, onToggleSelect, onSelectAll, onClearSelection, onBatchAction, categories,
}: LibrarySidebarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [importResult, setImportResult] = useState<string | null>(null)

  const handleFile = useCallback(async (file: File) => {
    if (!file.name.endsWith('.json')) {
      setImportResult('请选择 .json 文件')
      return
    }
    try {
      const text = await file.text()
      const data = JSON.parse(text) as LibraryExport
      if (data.version !== '1.0' || !data.entities?.length) {
        setImportResult('无效的导出文件格式')
        return
      }
      setImportResult(null)
      const result = await onImport(data)
      if (result) {
        setImportResult(`${result.created} 新建, ${result.updated} 更新${result.errors ? `, ${result.errors} 失败` : ''}`)
      }
    } catch {
      setImportResult('文件解析失败')
    }
  }, [onImport])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const isHome = view.type === 'home'
  const isList = view.type === 'list'
  const isDetail = view.type === 'detail'
  const activeEntityId = view.type === 'detail' ? view.entityId : null
  const currentCategory = view.type === 'list' ? view.category : undefined

  return (
    <aside className="flex flex-col h-full overflow-hidden shrink-0"
           style={{ width: 240, borderRight: `1px solid ${BORDER}`, background: '#fff' }}>

      {/* 导航头 */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-2"
           style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
        <button
          onClick={onGoHome}
          className={`p-1.5 rounded transition-colors ${isHome ? 'bg-gray-100' : 'hover:bg-gray-50'}`}
          title="首页"
        >
          <Home className="w-3.5 h-3.5" style={{ color: isHome ? ACCENT : INK_MUTED }} />
        </button>
        {(isList || isDetail) && (
          <button
            onClick={() => isList ? onGoHome() : onGoCategory(currentCategory)}
            className="p-1.5 rounded hover:bg-gray-50 transition-colors"
            title="返回"
          >
            <ChevronLeft className="w-3.5 h-3.5" style={{ color: INK_MUTED }} />
          </button>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[10px] font-bold tracking-[1.2px] uppercase truncate"
               style={{ fontFamily: FONT_MONO, color: ACCENT }}>
            {isHome ? 'LIBRARY' : isList ? (currentCategory || 'ALL ENTITIES') : 'DETAIL'}
          </div>
        </div>
        <button onClick={onRefresh} className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                title="刷新" disabled={loading}>
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} style={{ color: INK_MUTED }} />
        </button>
      </div>

      {/* 导入区 */}
      <div className="px-3 pt-2 pb-2" style={{ borderBottom: `1px solid ${BORDER_LIGHT}` }}>
        <div
          className="relative rounded py-2.5 px-3 text-center cursor-pointer transition-colors"
          style={{
            border: `1.5px dashed ${dragOver ? ACCENT : BORDER}`,
            background: dragOver ? '#fef7f6' : BG_WARM,
          }}
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input ref={fileInputRef} type="file" accept=".json" className="hidden"
                 onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
          {importing ? (
            <div className="flex flex-col items-center gap-1">
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: ACCENT }} />
              <span className="text-[10px]" style={{ color: INK_DIM }}>
                {importProgress ? `${importProgress.current}/${importProgress.total}` : '导入中...'}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-1.5">
              <Upload className="w-3.5 h-3.5" style={{ color: INK_MUTED }} />
              <span className="text-[10px]" style={{ color: INK_DIM }}>
                拖放 JSON 或点击导入
              </span>
            </div>
          )}
        </div>
        {importResult && (
          <div className="text-[10px] mt-1 px-1" style={{ color: INK_DIM }}>
            {importResult}
          </div>
        )}
      </div>

      {/* 列表视图/详情视图：搜索 + 实体列表 */}
      {(isList || isDetail) && (
        <>
          {/* 搜索 + 标题 */}
          <div className="px-3 pt-2.5 pb-2">
            <div className="text-[15px] font-bold mb-2"
                 style={{ fontFamily: FONT_SERIF, color: INK }}>
              {currentCategory || '全部实体'}
              <span className="text-[12px] font-normal ml-1.5" style={{ color: INK_DIM }}>
                ({totalCount})
              </span>
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5"
                      style={{ color: INK_MUTED }} />
              <input
                type="text"
                placeholder="筛选实体..."
                value={searchQuery}
                onChange={e => onSearchChange(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-[12px] focus:outline-none rounded"
                style={{ background: BG_WARM, border: `1px solid ${BORDER_LIGHT}`, color: INK }}
              />
            </div>
          </div>

          {/* 实体列表 */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {entities.length === 0 && !loading && (
              <div className="px-4 py-8 text-center">
                <BookOpen className="w-6 h-6 mx-auto mb-2" style={{ color: INK_MUTED }} />
                <p className="text-[12px]" style={{ color: INK_MUTED }}>
                  {searchQuery ? '未找到匹配实体' : '暂无知识实体'}
                </p>
              </div>
            )}
            <AnimatePresence>
              {entities.map((entity, idx) => {
                const meta = getMeta(entity.type)
                const isActive = entity.id === activeEntityId
                const isSelected = selectedIds.has(entity.id)
                const hasSelection = selectedIds.size > 0
                const Icon = meta.icon
                return (
                  <motion.button
                    key={entity.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: idx * 0.03 }}
                    className="w-full text-left px-3 py-2.5 transition-colors"
                    style={{
                      borderBottom: `1px solid ${BORDER_LIGHT}`,
                      borderLeft: isSelected ? `3px solid ${ACCENT}` : isActive ? `3px solid ${meta.accent}` : '3px solid transparent',
                      background: isSelected ? '#fef7f6' : isActive ? BG_WARM : 'transparent',
                    }}
                    onClick={() => hasSelection ? onToggleSelect(entity.id) : onSelectEntity(entity.id)}
                    onContextMenu={e => { e.preventDefault(); onToggleSelect(entity.id) }}
                    onMouseEnter={e => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.background = '#fafaf8' }}
                    onMouseLeave={e => { if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.background = isSelected ? '#fef7f6' : 'transparent' }}
                  >
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <Icon className="w-3 h-3 shrink-0" style={{ color: meta.accent }} />
                      <span className="text-[10px] font-bold tracking-[0.5px] uppercase"
                            style={{ color: meta.accent }}>
                        {meta.label}
                      </span>
                      {entity.tags.slice(0, 2).map(tag => (
                        <span key={tag} className="text-[9px] px-1 py-0.5 rounded"
                              style={{ background: BG_WARM, color: INK_MUTED }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                    <div className="text-[13px] font-medium truncate"
                         style={{ color: INK }}>
                      {entity.title}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px]" style={{ fontFamily: FONT_MONO, color: INK_MUTED }}>
                        {entity.claimCount} claims
                      </span>
                      <span className="text-[10px]" style={{ color: INK_MUTED }}>
                        {formatRelativeTime(entity.updatedAt)}
                      </span>
                    </div>
                  </motion.button>
                )
              })}
            </AnimatePresence>
          </div>
        </>
      )}

      {/* 首页视图：空间留白 */}
      {isHome && (
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          <BookOpen className="w-8 h-8 mb-2" style={{ color: INK_MUTED }} />
          <p className="text-[12px] text-center leading-relaxed" style={{ color: INK_DIM }}>
            使用搜索栏查找知识
          </p>
          <p className="text-[11px] text-center mt-1" style={{ color: INK_MUTED }}>
            或选择主题分类浏览
          </p>
        </div>
      )}

      {/* 底部: 批量操作栏 或 统计 */}
      {(isList || isDetail) && (
        <div className="relative shrink-0">
          <LibraryBatchBar
            selectedCount={selectedIds.size}
            totalCount={totalCount}
            categories={categories}
            onAction={(op, value) => onBatchAction({ op: op as BatchAction['op'], ids: Array.from(selectedIds), value })}
            onSelectAll={onSelectAll}
            onClearSelection={onClearSelection}
          />
          {selectedIds.size === 0 && (
            <div className="px-3 py-2" style={{ borderTop: `1px solid ${BORDER}`, background: BG_WARM }}>
              <div className="flex items-center justify-between text-[11px]" style={{ color: INK_DIM }}>
                <span>实体 <strong style={{ color: INK }}>{totalCount}</strong></span>
                <span>声明 <strong style={{ color: INK }}>
                  {entities.reduce((s, e) => s + e.claimCount, 0)}
                </strong></span>
              </div>
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
