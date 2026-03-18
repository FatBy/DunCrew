import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { 
  MessageSquare, X, Send, Trash2, Square, Sparkles, Loader2, Zap,
  Image, Paperclip, Puzzle, Server, Command, GripHorizontal, Wand2,
  PanelLeftClose, PanelLeft, CheckCircle, AlertCircle
} from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'
import { getQuickCommands } from '@/services/contextBuilder'
import { ChatMessage, StreamingMessage } from './ChatMessage'
import { ChatErrorBoundary } from './ChatErrorBoundary'
import { AddMCPModal } from './AddMCPModal'
import { AddSkillModal } from './AddSkillModal'
import { CreateNexusModal, NexusInitialData } from '@/components/world/CreateNexusModal'
import { autoInstallSkills } from '@/services/installService'
import { ConversationSidebar } from './ConversationSidebar'
import { useT } from '@/i18n'

export function AIChatPanel() {
  const t = useT()
  const isOpen = useStore((s) => s.isChatOpen)
  const setIsOpen = useStore((s) => s.setChatOpen)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Array<{ type: string; name: string; data?: string; file?: File }>>([])
  const [showMCPModal, setShowMCPModal] = useState(false)
  const [showSkillModal, setShowSkillModal] = useState(false)
  const [showNexusModal, setShowNexusModal] = useState(false)
  const [nexusInitialData, setNexusInitialData] = useState<NexusInitialData | undefined>()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [parsingFiles, setParsingFiles] = useState(false)
  const [parseProgress, setParseProgress] = useState<Array<{ name: string; status: 'uploading' | 'done' | 'error' }>>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const constraintsRef = useRef<HTMLDivElement>(null)
  const dragControls = useDragControls()
  const sendingRef = useRef(false)
  const uploadAbortRef = useRef<AbortController | null>(null)
  
  // 存储后台分析的结果
  const pendingAnalysisResult = useRef<NexusInitialData | null>(null)

  const currentView = useStore((s) => s.currentView)
  // 多会话系统：从当前活动会话获取消息
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const getCurrentMessages = useStore((s) => s.getCurrentMessages)
  const chatMessages = useMemo(() => getCurrentMessages(), [conversations, activeConversationId, getCurrentMessages])
  const activeConv = activeConversationId ? conversations.get(activeConversationId) : null
  const isMessagesLoading = activeConv ? activeConv.messagesLoaded === false : false
  const chatStreaming = useStore((s) => s.chatStreaming)
  const chatStreamContent = useStore((s) => s.chatStreamContent)
  const chatError = useStore((s) => s.chatError)
  const sendChat = useStore((s) => s.sendChat)
  const clearChat = useStore((s) => s.clearChat)
  const abortChat = useStore((s) => s.abortChat)
  const agentStatus = useStore((s) => s.agentStatus)
  
  // Observer 观察者 - 负责分析对话
  const analyzeConversationForBuilder = useStore((s) => s.analyzeConversationForBuilder)
  const isObserverAnalyzing = useStore((s) => s.isAnalyzing)
  
  // Toast 通知
  const addToast = useStore((s) => s.addToast)

  const configured = isLLMConfigured()
  const quickCommands = getQuickCommands(currentView)

  // Ctrl/Cmd + K 全局快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(!useStore.getState().isChatOpen)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setIsOpen])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages, chatStreamContent])

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        textareaRef.current?.focus()
        messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
      }, 300)
    }
  }, [isOpen])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'
    }
  }, [input])

  const getServerUrl = () => {
    return localStorage.getItem('duncrew_server_url') || 'http://localhost:3001'
  }

  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 // 10MB，与后端 MAX_FILE_SIZE 一致

  const handleSend = async () => {
    if (sendingRef.current) return
    const msg = input.trim()
    if ((!msg && attachments.length === 0) || chatStreaming || parsingFiles) return
    sendingRef.current = true

    // 需要上传解析的文件/图片附件
    const fileAttachments = attachments.filter(a => a.file && (a.type === 'file' || a.type === 'image'))
    // 其他附件（skill、mcp 等保持原样）
    const otherAttachments = attachments.filter(a => !a.file || (a.type !== 'file' && a.type !== 'image'))

    let fullMessage = msg
    let hiddenContext: string | undefined

    if (fileAttachments.length > 0) {
      setParsingFiles(true)
      setParseProgress(fileAttachments.map(a => ({ name: a.name, status: 'uploading' as const })))
      uploadAbortRef.current = new AbortController()
      try {
        const parsed = await Promise.all(fileAttachments.map(async (att, idx) => {
          const formData = new FormData()
          formData.append('file', att.file!, att.name)
          const res = await fetch(`${getServerUrl()}/api/files/upload`, {
            method: 'POST',
            body: formData,
            signal: uploadAbortRef.current?.signal,
          })
          const result = await res.json()
          if (!res.ok) {
            setParseProgress(prev => prev.map((p, i) => i === idx ? { ...p, status: 'error' } : p))
            return { name: att.name, text: `[解析失败: ${result.error || '未知错误'}]` }
          }
          setParseProgress(prev => prev.map((p, i) => i === idx ? { ...p, status: 'done' } : p))
          return { name: att.name, text: result.parsedText || '[无内容]', filePath: result.filePath || '' }
        }))

        const parsedContent = parsed.map(p => {
          const header = p.filePath ? `📎 ${p.name} (路径: ${p.filePath})` : `📎 ${p.name}`
          return `${header}:\n${p.text}`
        }).join('\n\n---\n\n')

        // 附件解析内容放入隐形上下文，用户只看到附件名
        hiddenContext = parsedContent
        const attachmentSummary = parsed.map(p => `📎 ${p.name}`).join('、')
        fullMessage = fullMessage
          ? `${fullMessage}\n\n[附件: ${attachmentSummary}]`
          : `[附件: ${attachmentSummary}]`
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          addToast({ type: 'info', title: '已取消', message: '文件上传已取消' })
          setParsingFiles(false)
          setParseProgress([])
          uploadAbortRef.current = null
          sendingRef.current = false
          return
        }
        console.error('文件解析失败:', e)
        const fallback = fileAttachments.map(a => `[附件: ${a.type}/${a.name}]`).join(' ')
        fullMessage = fullMessage ? `${fullMessage}\n\n${fallback}` : fallback
      } finally {
        setParsingFiles(false)
        setParseProgress([])
        uploadAbortRef.current = null
      }
    }

    if (otherAttachments.length > 0) {
      const info = otherAttachments.map(a => `[附件: ${a.type}/${a.name}]`).join(' ')
      fullMessage = fullMessage ? `${fullMessage}\n\n${info}` : info
    }

    setInput('')
    setAttachments([])
    sendChat(fullMessage, currentView, hiddenContext)
    sendingRef.current = false
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    
    Array.from(files).forEach(file => {
      if (file.size > MAX_UPLOAD_SIZE) {
        addToast({ type: 'error', title: '文件过大', message: `${file.name} 超过 10MB 限制` })
        return
      }
      if (file.type.startsWith('image/')) {
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            type: 'image',
            name: file.name,
            data: reader.result as string,
            file,
          }])
        }
        reader.readAsDataURL(file)
      }
    })
    e.target.value = ''
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    
    Array.from(files).forEach(file => {
      if (file.size > MAX_UPLOAD_SIZE) {
        addToast({ type: 'error', title: '文件过大', message: `${file.name} 超过 10MB 限制` })
        return
      }
      setAttachments(prev => [...prev, {
        type: 'file',
        name: file.name,
        file,
      }])
    })
    e.target.value = ''
  }

  const handleCancelUpload = () => {
    uploadAbortRef.current?.abort()
  }

  const handleAddSkill = (skillName: string) => {
    setAttachments(prev => [...prev, {
      type: 'skill',
      name: skillName,
    }])
  }

  const handleAddMCP = (serverName: string) => {
    setAttachments(prev => [...prev, {
      type: 'mcp',
      name: serverName,
    }])
  }

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  const handleQuickCommand = (prompt: string) => {
    if (chatStreaming) return
    sendChat(prompt, currentView)
  }

  const visibleMsgCount = chatMessages.filter(m => m.role !== 'system').length

  /**
   * 创建 Nexus 处理
   * 流程：Observer（观察者）后台分析对话 → Toast 通知 → Builder（建构者/CreateNexusModal）展示编辑
   */
  const handleCreateNexus = useCallback(async () => {
    // 如果没有对话，直接打开空表单（建构者模式）
    if (chatMessages.length < 2) {
      setNexusInitialData(undefined)
      setShowNexusModal(true)
      return
    }

    // 显示"开始分析"Toast
    addToast({
      type: 'info',
      title: '观察者启动',
      message: '正在分析对话内容，完成后将通知你...',
      duration: 3000,
    })

    // 后台运行分析（不阻塞用户操作）
    const messagesToAnalyze = chatMessages.map(m => ({ role: m.role, content: m.content }))
    
    // 异步分析，使用 Promise 但不 await
    analyzeConversationForBuilder(messagesToAnalyze).then(async (analysisResult) => {
      if (analysisResult) {
        // 自动安装建议技能（非阻塞）
        let installSummary = ''
        if (analysisResult.suggestedSkills && analysisResult.suggestedSkills.length > 0) {
          try {
            addToast({
              type: 'info',
              title: '正在安装技能',
              message: `检测到 ${analysisResult.suggestedSkills.length} 个技能，尝试自动安装...`,
              duration: 5000,
            })
            const installedNames = useStore.getState().skills.map((s: { name?: string; id: string }) => s.name || s.id)
            const results = await autoInstallSkills(analysisResult.suggestedSkills, installedNames)
            const installed = results.filter(r => r.status === 'installed')
            const notFound = results.filter(r => r.status === 'not_found' || r.status === 'failed')
            if (installed.length > 0) {
              installSummary = `，已安装 ${installed.length} 个技能`
              // 刷新前端技能列表
              try {
                const serverUrl = localStorage.getItem('duncrew_server_url') || 'http://localhost:3001'
                const res = await fetch(`${serverUrl}/skills`)
                if (res.ok) {
                  const skills = await res.json()
                  useStore.getState().setOpenClawSkills(skills)
                }
              } catch { /* 刷新失败不影响 */ }
            }
            // 将 suggestedSkills 映射为实际安装的技能名称
            const nameMap = new Map<string, string>()
            for (const r of results) {
              if (r.installedName && (r.status === 'installed' || r.status === 'already')) {
                nameMap.set(r.skillName, r.installedName)
              }
            }
            if (nameMap.size > 0) {
              analysisResult.suggestedSkills = analysisResult.suggestedSkills.map(
                s => nameMap.get(s) || s
              )
            }
            if (notFound.length > 0) {
              installSummary += `，${notFound.length} 个未找到`
            }
          } catch {
            // 安装流程整体失败，不阻塞
            installSummary = '，技能自动安装失败'
          }
        }

        // 存储分析结果
        const resultData: NexusInitialData = {
          name: analysisResult.name,
          description: analysisResult.description,
          sopContent: analysisResult.sopContent,
          suggestedSkills: analysisResult.suggestedSkills,
          tags: analysisResult.tags,
          triggers: analysisResult.triggers,
          objective: analysisResult.objective,
          metrics: analysisResult.metrics,
          strategy: analysisResult.strategy,
          isFromChat: true,
        }
        pendingAnalysisResult.current = resultData
        
        // 显示成功 Toast（可点击打开弹窗）
        addToast({
          type: 'success',
          title: 'Nexus 分析完成',
          message: `已提取「${analysisResult.name}」${installSummary}`,
          duration: 8000,
          onClick: () => {
            // 点击 Toast 时打开 Modal 并填入数据
            setNexusInitialData(pendingAnalysisResult.current || undefined)
            setShowNexusModal(true)
          },
        })
        
        console.log('[Observer → Builder] 后台分析完成:', {
          name: analysisResult.name,
          skillCount: analysisResult.suggestedSkills?.length || 0,
          sopLength: analysisResult.sopContent?.length || 0,
        })
      } else {
        // 分析失败，提示用户手动创建
        addToast({
          type: 'warning',
          title: '分析未能提取有效内容',
          message: '点击手动创建 Nexus',
          duration: 6000,
          onClick: () => {
            setNexusInitialData(undefined)
            setShowNexusModal(true)
          },
        })
        console.log('[Observer → Builder] 分析无结果')
      }
    }).catch((error) => {
      console.error('[Observer] 分析失败:', error)
      addToast({
        type: 'error',
        title: '分析失败',
        message: '点击手动创建 Nexus',
        duration: 6000,
        onClick: () => {
          setNexusInitialData(undefined)
          setShowNexusModal(true)
        },
      })
    })
  }, [chatMessages, analyzeConversationForBuilder, addToast])

  // 关闭 Nexus Modal 时清理状态
  const handleCloseNexusModal = useCallback(() => {
    setShowNexusModal(false)
    setNexusInitialData(undefined)
  }, [])

  return (
    <>
      {/* ====== 底部胶囊触发栏 (面板关闭时显示) ====== */}
      <AnimatePresence>
        {!isOpen && (
          <motion.button
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            onClick={() => setIsOpen(true)}
            className="fixed bottom-6 left-1/2 z-[45]
                       flex items-center gap-4 px-8 py-4 
                       bg-white/90 backdrop-blur-xl backdrop-blur-2xl 
                       border border-stone-200 rounded-2xl
                       hover:bg-white/95 backdrop-blur-3xl hover:border-stone-300
                       transition-all cursor-pointer
                       shadow-[0_8px_40px_rgba(0,0,0,0.08)]
                       group"
            style={{ transform: 'translateX(-50%)' }}
          >
            <Sparkles className="w-5 h-5 text-skin-accent-amber group-hover:text-skin-accent-amber/80" />
            <span className="text-base font-mono text-stone-500 group-hover:text-stone-700 transition-colors">
              {t('chat.input_placeholder')}
            </span>
            <span className="flex items-center gap-1.5 text-xs font-mono text-stone-400 border border-stone-200 rounded-lg px-2 py-1">
              <Command className="w-3.5 h-3.5" />K
            </span>
            {visibleMsgCount > 0 && (
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-skin-accent-amber/20 text-skin-accent-amber text-xs font-mono font-bold">
                {visibleMsgCount}
              </span>
            )}
            {chatStreaming && (
              <Loader2 className="w-4 h-4 text-skin-accent-cyan animate-spin" />
            )}
          </motion.button>
        )}
      </AnimatePresence>

      {/* ====== 聊天面板 (居中弹出，固定大小) ====== */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* 背景蒙版 */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 z-[50] bg-stone-900/5 backdrop-blur-sm"
            />
            
            {/* 拖动约束区域 */}
            <div ref={constraintsRef} className="fixed inset-0 z-[51] pointer-events-none" />
            
            {/* 居中对话面板 - 固定大小，可拖动 */}
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              drag
              dragListener={false}
              dragControls={dragControls}
              dragConstraints={constraintsRef}
              dragElastic={0.05}
              dragMomentum={false}
              className="fixed top-0 bottom-0 left-[70px] right-0 m-auto z-[52]
                         w-[1200px] max-w-[calc(100%-90px)] h-[80vh] max-h-[850px]
                         bg-white/95 backdrop-blur-3xl 
                         border border-white/80
                         rounded-[2rem]
                         flex flex-col overflow-hidden
                         shadow-[0_20px_60px_rgba(0,0,0,0.05)]
                         pointer-events-auto"
            >
              {/* Header - 可拖动区域 */}
              <div 
                className="flex items-center justify-between px-6 py-4 border-b border-stone-100 bg-white/50 z-20 cursor-grab active:cursor-grabbing"
                onPointerDown={(e) => dragControls.start(e)}
              >
                <div className="flex items-center gap-3">
                  <GripHorizontal className="w-4 h-4 text-stone-300" />
                  {/* 侧边栏折叠按钮 */}
                  <button
                    onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                    className="p-1.5 text-stone-400 hover:text-stone-600 
                               hover:bg-stone-100 rounded-lg transition-colors"
                    title={sidebarCollapsed ? "展开会话列表" : "收起会话列表"}
                  >
                    {sidebarCollapsed ? (
                      <PanelLeft className="w-4 h-4" />
                    ) : (
                      <PanelLeftClose className="w-4 h-4" />
                    )}
                  </button>
                  <div className="w-8 h-8 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                  </div>
                  <h2 className="text-lg font-black text-stone-800 tracking-wide">AI Assistant</h2>
                  <span className="ml-1 px-2 py-0.5 rounded-md bg-stone-100 border border-stone-200 text-[10px] font-bold text-stone-400 uppercase tracking-widest">
                    {currentView}
                  </span>
                  {agentStatus === 'thinking' && (
                    <span className="text-sm font-mono text-stone-500 animate-pulse flex items-center gap-1.5 ml-2">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('task.agent_thinking')}
                    </span>
                  )}
                  {agentStatus === 'executing' && (
                    <span className="text-sm font-mono text-amber-600 animate-pulse flex items-center gap-1.5 ml-2">
                      <Zap className="w-3.5 h-3.5" /> {t('task.agent_executing')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {/* 创建 Nexus 按钮 */}
                  <button
                    onClick={handleCreateNexus}
                    disabled={chatStreaming || isObserverAnalyzing}
                    className="flex items-center gap-1.5 text-xs font-bold text-amber-600 
                             bg-amber-50 hover:bg-amber-100 px-3 py-1.5 rounded-lg
                             transition-colors disabled:opacity-30 disabled:pointer-events-none"
                    title="从对话创建 Nexus"
                  >
                    {isObserverAnalyzing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="w-3.5 h-3.5" />
                    )}
                    <span>创建 Nexus</span>
                  </button>
                  <div className="w-px h-4 bg-stone-200" />
                  <button
                    onClick={clearChat}
                    className="text-stone-400 hover:text-red-400 transition-colors"
                    title={t('chat.clear')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setIsOpen(false)}
                    className="text-stone-400 hover:text-rose-500 transition-colors"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* 主体内容区：侧边栏 + 聊天区 */}
              <div className="flex-1 flex overflow-hidden bg-[#faf9f8]">
                {/* 会话侧边栏 */}
                <AnimatePresence mode="wait">
                  {!sidebarCollapsed && (
                    <motion.div
                      initial={{ width: 0, opacity: 0 }}
                      animate={{ width: 240, opacity: 1 }}
                      exit={{ width: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="flex-shrink-0 overflow-hidden"
                    >
                      <ConversationSidebar className="h-full" />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* 聊天主区域 */}
                <div className="flex-1 flex flex-col min-w-0 bg-white relative">
                  {/* 背景轻微纹理 */}
                  <div className="absolute inset-0 pointer-events-none opacity-[0.02]" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '24px 24px' }} />
                  {/* Messages */}
                  <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 z-10">
                <ChatErrorBoundary onReset={clearChat}>
                {!configured ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <Sparkles className="w-16 h-16 text-stone-200 mb-5" />
                    <p className="text-lg font-mono text-stone-500 mb-2">{t('chat.not_configured')}</p>
                    <p className="text-base font-mono text-stone-400">
                      {t('chat.configure_prompt')}
                    </p>
                  </div>
                ) : isMessagesLoading ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <Loader2 className="w-10 h-10 text-stone-300 mb-4 animate-spin" />
                    <p className="text-sm font-mono text-stone-400">
                      加载对话记录...
                    </p>
                  </div>
                ) : chatMessages.length === 0 && !chatStreaming ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <MessageSquare className="w-16 h-16 text-stone-200 mb-5" />
                    <p className="text-lg font-mono text-stone-400 mb-4">
                      {t('chat.input_placeholder')}
                    </p>
                    
                    {/* 创建 Nexus 引导按钮 */}
                    <button
                      onClick={handleCreateNexus}
                      className="flex items-center gap-3 px-6 py-3.5 mb-8
                                 bg-amber-50 border border-amber-200 rounded-xl
                                 text-amber-600 hover:bg-amber-100 hover:border-amber-300
                                 transition-all duration-300 group"
                    >
                      <Wand2 className="w-5 h-5 group-hover:rotate-12 transition-transform duration-300" />
                      <span className="font-mono text-base font-medium">创建 Nexus</span>
                    </button>
                    
                    {quickCommands.length > 0 && (
                      <div className="flex flex-wrap gap-2.5 justify-center max-w-lg">
                        {quickCommands.map((cmd) => (
                          <button
                            key={cmd.label}
                            onClick={() => handleQuickCommand(cmd.prompt)}
                            className="px-4 py-2.5 text-sm font-mono bg-white border border-stone-200 
                                       rounded-xl text-stone-600 hover:text-amber-600 hover:border-amber-300 hover:bg-amber-50
                                       transition-colors"
                          >
                            {cmd.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    {chatMessages.filter(m => m.role !== 'system').map((msg) => (
                      <ChatMessage key={msg.id} message={msg} containerWidth="main" />
                    ))}
                    {chatStreaming && chatStreamContent && (
                      <StreamingMessage content={chatStreamContent} />
                    )}
                    {chatError && (
                      <div className="px-5 py-4 bg-red-500/10 border border-red-500/20 rounded-xl text-base font-mono text-red-400">
                        {chatError}
                      </div>
                    )}
                  </>
                )}
                <div ref={messagesEndRef} />
                </ChatErrorBoundary>
              </div>

              {/* Quick Commands Bar */}
              {configured && chatMessages.length > 0 && quickCommands.length > 0 && (
                <div className="px-6 py-3 border-t border-stone-100 flex gap-2 overflow-x-auto z-10">
                  {quickCommands.map((cmd) => (
                    <button
                      key={cmd.label}
                      onClick={() => handleQuickCommand(cmd.prompt)}
                      disabled={chatStreaming}
                      className="flex-shrink-0 px-4 py-2 text-sm font-mono bg-white border border-stone-200 
                                 rounded-xl text-stone-500 hover:text-amber-600 hover:border-amber-300 hover:bg-amber-50
                                 transition-colors disabled:opacity-50"
                    >
                      {cmd.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Input - 清透浮动式 */}
              {configured && (
                <div className="px-6 py-5 bg-gradient-to-t from-white via-white to-transparent z-20">
                  {/* 附件预览 / 解析进度 */}
                  {(attachments.length > 0 || parseProgress.length > 0) && (
                    <div className="flex flex-wrap gap-2 mb-3 max-w-3xl mx-auto">
                      {parsingFiles ? parseProgress.map((p, idx) => (
                        <div
                          key={`parse-${idx}`}
                          className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-xs font-mono
                            ${p.status === 'done' ? 'bg-emerald-50 border-emerald-200 text-emerald-600' :
                              p.status === 'error' ? 'bg-red-50 border-red-200 text-red-500' :
                              'bg-white border-stone-200 text-stone-600'}`}
                        >
                          {p.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-500" />}
                          {p.status === 'done' && <CheckCircle className="w-3.5 h-3.5" />}
                          {p.status === 'error' && <AlertCircle className="w-3.5 h-3.5" />}
                          <span className="max-w-[140px] truncate">{p.name}</span>
                        </div>
                      )) : attachments.map((att, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 px-3 py-1.5 bg-white border border-stone-200 
                                     rounded-lg text-xs font-mono text-stone-600"
                        >
                          {att.type === 'image' && <Image className="w-3.5 h-3.5 text-emerald-500" />}
                          {att.type === 'file' && <Paperclip className="w-3.5 h-3.5 text-stone-500" />}
                          {att.type === 'skill' && <Puzzle className="w-3.5 h-3.5 text-amber-500" />}
                          {att.type === 'mcp' && <Server className="w-3.5 h-3.5 text-violet-500" />}
                          <span className="max-w-[120px] truncate">{att.name}</span>
                          <button
                            onClick={() => removeAttachment(idx)}
                            className="text-stone-400 hover:text-red-400 ml-0.5"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* 浮岛输入框 */}
                  <div className="max-w-3xl mx-auto relative flex items-end gap-2 bg-white border-2 border-stone-200 rounded-2xl p-2 focus-within:border-amber-400 focus-within:shadow-[0_0_15px_rgba(251,191,36,0.15)] transition-all shadow-sm">
                    {/* 工具按钮 */}
                    <div className="flex gap-1 p-1">
                      <input ref={imageInputRef} type="file" accept="image/*" multiple onChange={handleImageUpload} className="hidden" />
                      <input ref={fileInputRef} type="file" accept=".pdf,.docx,.pptx,.txt,.md,.csv" multiple onChange={handleFileUpload} className="hidden" />
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        disabled={chatStreaming}
                        className="p-1.5 text-stone-400 hover:text-stone-600 bg-stone-50 hover:bg-stone-100 
                                   rounded-lg transition-colors disabled:opacity-50"
                        title="Image"
                      >
                        <Image className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={chatStreaming}
                        className="p-1.5 text-stone-400 hover:text-stone-600 bg-stone-50 hover:bg-stone-100 
                                   rounded-lg transition-colors disabled:opacity-50"
                        title="File"
                      >
                        <Paperclip className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setShowSkillModal(true)}
                        disabled={chatStreaming}
                        className="p-1.5 text-stone-400 hover:text-stone-600 bg-stone-50 hover:bg-stone-100 
                                   rounded-lg transition-colors disabled:opacity-50"
                        title="SKILL"
                      >
                        <Puzzle className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setShowMCPModal(true)}
                        disabled={chatStreaming}
                        className="p-1.5 text-stone-400 hover:text-stone-600 bg-stone-50 hover:bg-stone-100 
                                   rounded-lg transition-colors disabled:opacity-50"
                        title="MCP"
                      >
                        <Server className="w-4 h-4" />
                      </button>
                    </div>
                    
                    {/* 输入框 */}
                    <textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t('chat.input_placeholder')}
                      disabled={chatStreaming}
                      rows={1}
                      className="flex-1 bg-transparent border-none focus:ring-0 resize-none py-3.5 px-2 
                                 text-stone-700 text-sm font-medium placeholder:text-stone-300
                                 focus:outline-none disabled:opacity-50 min-h-[44px] max-h-[120px]"
                    />
                    
                    {/* 发送/停止按钮 */}
                    {parsingFiles ? (
                      <button
                        onClick={handleCancelUpload}
                        className="m-1.5 w-10 h-10 flex items-center justify-center bg-stone-100 border border-amber-200 
                                   rounded-xl hover:bg-red-50 hover:border-red-200 transition-colors group"
                        title="取消上传"
                      >
                        <Loader2 className="w-4 h-4 text-amber-500 animate-spin group-hover:hidden" />
                        <X className="w-4 h-4 text-red-400 hidden group-hover:block" />
                      </button>
                    ) : chatStreaming ? (
                      <button
                        onClick={abortChat}
                        className="m-1.5 w-10 h-10 flex items-center justify-center bg-red-50 border border-red-200 rounded-xl 
                                   text-red-500 hover:bg-red-100 transition-colors"
                      >
                        <Square className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={handleSend}
                        disabled={(!input.trim() && attachments.length === 0) || parsingFiles}
                        className="m-1.5 w-10 h-10 flex items-center justify-center bg-amber-100 hover:bg-amber-200 
                                   text-amber-600 rounded-xl shadow-sm transition-colors
                                   disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  
                  <div className="text-center mt-3 flex items-center justify-center gap-4 text-[10px] text-stone-400 font-bold uppercase tracking-widest">
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Enter</kbd> 发送</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Shift+Enter</kbd> 换行</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Ctrl+K</kbd> 关闭</span>
                  </div>
                </div>
              )}
                </div>
                {/* 关闭：聊天主区域 */}
              </div>
              {/* 关闭：主体内容区 */}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* MCP / SKILL / Nexus 引导模态框 */}
      <AddMCPModal
        isOpen={showMCPModal}
        onClose={() => setShowMCPModal(false)}
        onConfirm={handleAddMCP}
      />
      <AddSkillModal
        isOpen={showSkillModal}
        onClose={() => setShowSkillModal(false)}
        onConfirm={handleAddSkill}
      />
      <CreateNexusModal
        isOpen={showNexusModal}
        onClose={handleCloseNexusModal}
        initialData={nexusInitialData}
      />
    </>
  )
}
