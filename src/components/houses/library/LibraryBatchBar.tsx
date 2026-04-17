/**
 * LibraryBatchBar - 批量操作工具栏
 * 当有实体被选中时在列表底部浮现
 */

import { useState } from 'react'
import { Archive, Tag, Trash2, FolderOpen, X, CheckSquare } from 'lucide-react'
import {
  INK, INK_DIM, INK_MUTED,
  BG_WARM, BORDER, ACCENT, FONT_MONO,
} from '@/components/shared/wiki-ui/constants'

interface LibraryBatchBarProps {
  selectedCount: number
  totalCount: number
  categories: string[]
  onAction: (op: string, value?: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
}

export function LibraryBatchBar({
  selectedCount, totalCount, categories,
  onAction, onSelectAll, onClearSelection,
}: LibraryBatchBarProps) {
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showTagInput, setShowTagInput] = useState(false)
  const [tagValue, setTagValue] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  if (selectedCount === 0) return null

  const handleAction = (op: string, value?: string) => {
    onAction(op, value)
    setConfirming(null)
    setShowCategoryPicker(false)
    setShowTagInput(false)
    setTagValue('')
  }

  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-2.5"
         style={{ background: '#fff', borderTop: `2px solid ${ACCENT}`, boxShadow: '0 -2px 8px rgba(0,0,0,0.08)' }}>
      {/* 选择状态 */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] font-bold" style={{ fontFamily: FONT_MONO, color: ACCENT }}>
          {selectedCount} / {totalCount} SELECTED
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onSelectAll} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-gray-100"
                  style={{ color: INK_DIM }}>
            <CheckSquare className="w-3 h-3 inline mr-0.5" />全选
          </button>
          <button onClick={onClearSelection} className="text-[10px] px-1.5 py-0.5 rounded hover:bg-gray-100"
                  style={{ color: INK_DIM }}>
            <X className="w-3 h-3 inline mr-0.5" />取消
          </button>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex flex-wrap gap-1.5">
        <ActionBtn icon={Archive} label="归档" onClick={() => handleAction('archive')} />
        <ActionBtn icon={FolderOpen} label="分类" onClick={() => setShowCategoryPicker(!showCategoryPicker)} />
        <ActionBtn icon={Tag} label="打标签" onClick={() => setShowTagInput(!showTagInput)} />
        {confirming === 'delete' ? (
          <button onClick={() => handleAction('delete')}
                  className="text-[10px] px-2 py-1 rounded font-bold"
                  style={{ background: ACCENT, color: '#fff' }}>
            确认删除
          </button>
        ) : (
          <ActionBtn icon={Trash2} label="删除" color={ACCENT}
                     onClick={() => setConfirming('delete')} />
        )}
      </div>

      {/* 分类选择浮层 */}
      {showCategoryPicker && (
        <div className="mt-2 flex flex-wrap gap-1">
          {categories.map(cat => (
            <button key={cat} onClick={() => handleAction('set_category', cat)}
                    className="text-[10px] px-2 py-1 rounded transition-colors hover:opacity-80"
                    style={{ background: BG_WARM, border: `1px solid ${BORDER}`, color: INK_DIM }}>
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* 标签输入 */}
      {showTagInput && (
        <div className="mt-2 flex gap-1">
          <input type="text" placeholder="标签名..." value={tagValue}
                 onChange={e => setTagValue(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && tagValue) handleAction('tag', tagValue) }}
                 className="flex-1 text-[11px] px-2 py-1 rounded focus:outline-none"
                 style={{ background: BG_WARM, border: `1px solid ${BORDER}`, color: INK }} />
          <button onClick={() => tagValue && handleAction('tag', tagValue)}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ background: ACCENT, color: '#fff' }}>
            添加
          </button>
        </div>
      )}
    </div>
  )
}

function ActionBtn({ icon: Icon, label, color, onClick }: {
  icon: typeof Archive; label: string; color?: string; onClick: () => void
}) {
  return (
    <button onClick={onClick}
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded transition-colors hover:bg-gray-50"
            style={{ border: `1px solid ${BORDER}`, color: color || INK_MUTED }}>
      <Icon className="w-3 h-3" />
      {label}
    </button>
  )
}
