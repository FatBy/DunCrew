import { useState, useMemo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { 
  Plus, MessageSquare, Globe2, Trash2, Edit2, Check, X,
  ChevronDown, Search, ChevronRight, CheckCircle2
} from 'lucide-react'
import { useStore } from '@/store'
import { cn } from '@/utils/cn'
import { formatTime } from '@/utils/formatTime'
import type { Conversation, ConversationType } from '@/types'

interface ConversationSidebarProps {
  className?: string
}

export function ConversationSidebar({ className }: ConversationSidebarProps) {
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const createConversation = useStore((s) => s.createConversation)
  const switchConversation = useStore((s) => s.switchConversation)
  const deleteConversation = useStore((s) => s.deleteConversation)
  const renameConversation = useStore((s) => s.renameConversation)
  const getOrCreateDunConversation = useStore((s) => s.getOrCreateDunConversation)
  // M6: 通过 dunCount 触发 re-render，duns 数据通过 ref 按需读取
  const dunCount = useStore((s) => s.duns.size)
  const dunsRef = useRef(useStore.getState().duns)
  // 保持 ref 同步（不触发 re-render）
  dunsRef.current = useStore.getState().duns
  const getDunById = useCallback((dunId: string) => useStore.getState().duns.get(dunId), [])
  
  const [showNewMenu, setShowNewMenu] = useState(false)
  const [showDunPicker, setShowDunPicker] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  
  const dunList = useMemo(() => 
    [...dunsRef.current.values()].filter(n => n.constructionProgress >= 1 || (Date.now() - n.createdAt >= 3000)),
    [dunCount]
  )
  
  // M7: useMemo 缓存排序过滤结果，避免每次 render 都重新计算
  const conversationList = useMemo(() => 
    [...conversations.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter(conv => 
        !searchQuery || 
        conv.title.toLowerCase().includes(searchQuery.toLowerCase())
      ),
    [conversations, searchQuery]
  )
  
  const handleCreate = (type: ConversationType) => {
    if (type === 'dun') {
      setShowDunPicker(true)
      return
    }
    createConversation(type)
    setShowNewMenu(false)
  }
  
  const handleSelectDun = (dunId: string) => {
    getOrCreateDunConversation(dunId)
    setShowNewMenu(false)
    setShowDunPicker(false)
  }
  
  const handleStartRename = (conv: Conversation) => {
    setEditingId(conv.id)
    setEditTitle(conv.title)
  }
  
  const handleSaveRename = () => {
    if (editingId && editTitle.trim()) {
      renameConversation(editingId, editTitle.trim())
    }
    setEditingId(null)
    setEditTitle('')
  }
  
  const handleCancelRename = () => {
    setEditingId(null)
    setEditTitle('')
  }
  
  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (confirm('确定要删除这个会话吗？')) {
      deleteConversation(id)
    }
  }
  
  const getDunInfo = (dunId?: string) => {
    if (!dunId) return null
    return getDunById(dunId)
  }
  
  return (
    <div className={cn(
      'w-60 h-full flex flex-col border-r border-stone-100/80 bg-stone-50/50',
      className
    )}>
      {/* Header */}
      <div className="p-4 border-b border-stone-100">
        <div className="relative">
          <button
            onClick={() => { setShowNewMenu(!showNewMenu); if (showNewMenu) setShowDunPicker(false) }}
            className="w-full py-2.5 bg-stone-800 hover:bg-stone-700 text-white rounded-xl text-sm font-bold shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <Plus className="w-4 h-4" />
            新建会话
            <ChevronDown className={cn(
              'w-3 h-3 ml-1 transition-transform',
              showNewMenu && 'rotate-180'
            )} />
          </button>
          
          <AnimatePresence>
            {showNewMenu && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="absolute top-full left-0 right-0 mt-1 z-10
                           bg-white border border-stone-200 rounded-xl 
                           shadow-lg overflow-hidden"
              >
                <button
                  onClick={() => handleCreate('general')}
                  className="w-full flex items-center gap-2 px-3 py-2.5 
                             hover:bg-stone-50 text-sm font-bold text-stone-600 
                             hover:text-stone-800 transition-colors"
                >
                  <MessageSquare className="w-4 h-4 text-stone-400" />
                  通用对话
                </button>
                
                <button
                  onClick={() => handleCreate('dun')}
                  className="w-full flex items-center gap-2 px-3 py-2.5 
                             hover:bg-stone-50 text-sm font-bold text-stone-600 
                             hover:text-stone-800 transition-colors border-t border-stone-100"
                >
                  <Globe2 className="w-4 h-4 text-stone-400" />
                  Dun 会话
                  <ChevronRight className={cn(
                    'w-3 h-3 ml-auto transition-transform text-stone-300',
                    showDunPicker && 'rotate-90'
                  )} />
                </button>
                
                <AnimatePresence>
                  {showDunPicker && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.15 }}
                      className="overflow-hidden border-t border-stone-100"
                    >
                      {dunList.length === 0 ? (
                        <div className="px-3 py-3 text-[11px] font-mono text-stone-400 text-center">
                          还没有可用的 Dun
                        </div>
                      ) : (
                        <div className="max-h-[200px] overflow-y-auto py-1">
                          {dunList.map(n => (
                            <button
                              key={n.id}
                              onClick={() => handleSelectDun(n.id)}
                              className="w-full flex items-center gap-2 px-4 py-2 
                                         hover:bg-stone-50 text-xs font-mono text-stone-500 
                                         hover:text-stone-700 transition-colors"
                            >
                              <div 
                                className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{ backgroundColor: `hsl(${n.visualDNA?.primaryHue ?? 270}, 60%, 55%)` }}
                              />
                              <span className="truncate">{n.label || `Dun-${n.id.slice(-6)}`}</span>
                              <span className="ml-auto text-[10px] text-stone-300 flex-shrink-0">{n.scoring?.score ?? 0}pt</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        
        {/* Search */}
        <div className="relative mt-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索会话..."
            className="w-full bg-white border border-stone-200 rounded-lg pl-8 pr-3 py-1.5 
                       text-xs text-stone-600 focus:outline-none focus:border-amber-300 focus:ring-2 focus:ring-amber-100 transition-all"
          />
        </div>
      </div>
      
      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
        {conversationList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <MessageSquare className="w-8 h-8 text-stone-200 mb-2" />
            <p className="text-xs font-mono text-stone-400">
              {searchQuery ? '没有匹配的会话' : '还没有会话'}
            </p>
          </div>
        ) : (
          conversationList.map((conv) => {
            const isActive = conv.id === activeConversationId
            const isEditing = editingId === conv.id
            const dun = getDunInfo(conv.dunId)
            const lastMsg = conv.messagesLoaded !== false && conv.messages.length > 0 
              ? conv.messages[conv.messages.length - 1] : null
            const preview = lastMsg?.content.slice(0, 40) || (conv.messagesLoaded === false ? '...' : '(空会话)')
            
            return (
              <div
                key={conv.id}
                onClick={() => !isEditing && switchConversation(conv.id)}
                className={cn(
                  'group rounded-xl p-3 cursor-pointer transition-all relative',
                  isActive 
                    ? 'bg-white border border-stone-200 shadow-sm' 
                    : 'hover:bg-white border border-transparent hover:border-stone-100'
                )}
              >
                {/* Active indicator bar */}
                {isActive && (
                  <div className="absolute left-0 top-3 bottom-3 w-1 bg-amber-400 rounded-r-md" />
                )}
                
                <div className="flex items-start gap-2">
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveRename()
                            if (e.key === 'Escape') handleCancelRename()
                          }}
                          className="flex-1 px-1.5 py-0.5 bg-white border border-stone-200 
                                     rounded text-xs font-mono text-stone-800 outline-none focus:border-amber-300"
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSaveRename() }}
                          className="p-1 text-emerald-500 hover:text-emerald-600"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleCancelRename() }}
                          className="p-1 text-stone-400 hover:text-stone-500"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <h4 className={cn(
                          'text-sm font-bold truncate',
                          isActive ? 'text-stone-800' : 'text-stone-600'
                        )}>
                          {conv.title}
                        </h4>
                        {dun && (
                          <span 
                            className="text-xs font-mono truncate block mt-0.5"
                            style={{ color: `hsl(${dun.visualDNA?.primaryHue || 270}, 50%, 45%)` }}
                          >
                            {dun.label}
                          </span>
                        )}
                        <p className="text-xs text-stone-400 truncate mt-1">
                          {preview}
                        </p>
                      </>
                    )}
                  </div>
                  
                  {/* Actions */}
                  {!isEditing && (
                    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStartRename(conv) }}
                        className="p-1 text-stone-300 hover:text-stone-500 rounded"
                        title="重命名"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => handleDelete(conv.id, e)}
                        className="p-1 text-stone-300 hover:text-red-400 rounded"
                        title="删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>
                
                {/* Timestamp */}
                <div className="flex items-center justify-between mt-2 text-[10px] text-stone-400 font-bold">
                  <span className={cn(
                    'flex items-center gap-1',
                    isActive && 'text-emerald-500'
                  )}>
                    {isActive && <CheckCircle2 className="w-3 h-3" />}
                    {conv.messages.length} 条消息
                  </span>
                  <span>{formatTime(conv.updatedAt)}</span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
