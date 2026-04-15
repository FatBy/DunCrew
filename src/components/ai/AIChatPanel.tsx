import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { 
  MessageSquare, X, Send, Trash2, Square, Sparkles, Loader2, Zap,
  Image, Paperclip, Puzzle, Server, Command, GripHorizontal, Wand2,
  PanelLeftClose, PanelLeft, CheckCircle, AlertCircle, Box
} from 'lucide-react'
import { useStore } from '@/store'
import { isLLMConfigured } from '@/services/llmService'
import { getQuickCommands } from '@/services/contextBuilder'
import { ChatMessage, StreamingMessage } from './ChatMessage'
import { AgentProgressTicker } from './AgentProgressTicker'
import { ChatErrorBoundary } from './ChatErrorBoundary'
import { AddMCPModal } from './AddMCPModal'
import { AddSkillModal } from './AddSkillModal'
import { MentionDropdown, detectMention, closeMention, filterMentionItems, type MentionState, type MentionItem } from './MentionDropdown'
import { CreateDunModal, DunInitialData } from '@/components/world/CreateDunModal'
import { autoInstallSkills } from '@/services/installService'
import { ConversationSidebar } from './ConversationSidebar'
import { useT } from '@/i18n'
import { getServerUrl as _getServerUrl } from '@/utils/env'

export function AIChatPanel() {
  const t = useT()
  const isOpen = useStore((s) => s.isChatOpen)
  const setIsOpen = useStore((s) => s.setChatOpen)
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Array<{ type: string; name: string; data?: string; file?: File; filePath?: string }>>([])
  const [showMCPModal, setShowMCPModal] = useState(false)
  const [showSkillModal, setShowSkillModal] = useState(false)
  const [showDunModal, setShowDunModal] = useState(false)
  const [dunInitialData, setDunInitialData] = useState<DunInitialData | undefined>()
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
  
  // @ mention 状态
  const [mentionState, setMentionState] = useState<MentionState>(() => closeMention())
  const isComposingRef = useRef(false)

  // 存储后台分析的结果
  const pendingAnalysisResult = useRef<DunInitialData | null>(null)

  const currentView = useStore((s) => s.currentView)
  // 多会话系统：从当前活动会话获取消息
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const getCurrentMessages = useStore((s) => s.getCurrentMessages)
  const chatMessages = useMemo(() => getCurrentMessages(), [conversations, activeConversationId, getCurrentMessages])
  const activeConv = activeConversationId ? conversations.get(activeConversationId) : null
  const isMessagesLoading = activeConv ? activeConv.messagesLoaded === false : false
  const chatStreaming = useStore((s) => s.chatStreaming)
  const rawStreamContent = useStore((s) => s.chatStreamContent)
  const chatError = useStore((s) => s.chatError)

  // L4: RAF 攒批流式内容，避免每个 token delta 都触发 re-render
  const [chatStreamContent, setChatStreamContent] = useState(rawStreamContent)
  const rafIdRef = useRef<number | null>(null)
  useEffect(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    rafIdRef.current = requestAnimationFrame(() => {
      setChatStreamContent(rawStreamContent)
      rafIdRef.current = null
    })
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [rawStreamContent])
  const sendChat = useStore((s) => s.sendChat)
  const clearChat = useStore((s) => s.clearChat)
  const abortChat = useStore((s) => s.abortChat)
  const agentStatus = useStore((s) => s.agentStatus)
  
  // Observer 观察者 - 负责分析对话
  const analyzeConversationForBuilder = useStore((s) => s.analyzeConversationForBuilder)
  const isObserverAnalyzing = useStore((s) => s.isAutoAnalyzing || s.isUserAnalyzing)
  
  // Toast 通知
  const addToast = useStore((s) => s.addToast)

  // @ mention 数据源
  const openClawSkills = useStore((s) => s.openClawSkills)
  const mcpServers = useStore((s) => s.linkStation.mcpServers)
  const duns = useStore((s) => s.duns)

  const mentionItems = useMemo<MentionItem[]>(() => {
    const items: MentionItem[] = []
    // Skills
    for (const s of openClawSkills) {
      if (s.status !== 'active') continue
      items.push({
        category: 'skill',
        name: s.name,
        displayName: s.emoji ? `${s.emoji} ${s.name}` : s.name,
        description: s.description,
        keywords: s.keywords,
      })
    }
    // MCP servers
    for (const m of mcpServers) {
      if (m.enabled === false) continue
      items.push({
        category: 'mcp',
        name: m.name,
        displayName: m.name,
        description: `MCP: ${m.command} ${m.args?.join(' ') || ''}`.trim(),
      })
    }
    // Duns
    if (duns instanceof Map) {
      for (const [, d] of duns) {
        items.push({
          category: 'dun',
          name: d.label || d.id,
          displayName: d.agentIdentity?.emoji ? `${d.agentIdentity.emoji} ${d.label || d.id}` : (d.label || d.id),
          description: d.flavorText || d.sopContent?.slice(0, 80),
          keywords: d.triggers,
        })
      }
    }
    return items
  }, [openClawSkills, mcpServers, duns])

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
    // 流式期间用 instant 避免 smooth 动画在高频 token 更新下叠加
    const behavior = chatStreaming ? 'instant' : 'smooth'
    messagesEndRef.current?.scrollIntoView({ behavior })
  }, [chatMessages, chatStreamContent, chatStreaming])

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
    return localStorage.getItem('duncrew_server_url') || _getServerUrl()
  }

  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 // 10MB，与后端 MAX_FILE_SIZE 一致

  const handleSend = async () => {
    if (sendingRef.current) return
    const msg = input.trim()
    if ((!msg && attachments.length === 0) || chatStreaming || parsingFiles) return
    sendingRef.current = true

    // 需要上传解析的文件/图片附件（有 File 对象的）
    const fileAttachments = attachments.filter(a => a.file && (a.type === 'file' || a.type === 'image'))
    // 本地路径附件（Electron 粘贴的文件，只有 filePath 没有 File 对象）
    const pathAttachments = attachments.filter(a => a.filePath && !a.file)
    // 其他附件（skill、mcp 等保持原样）
    const otherAttachments = attachments.filter(a => !a.file && !a.filePath || (a.type !== 'file' && a.type !== 'image'))

    let fullMessage = msg
    let hiddenContext: string | undefined
    const allParsed: Array<{ name: string; text: string; filePath?: string }> = []

    // 处理需要上传的文件附件
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
            return { name: att.name, text: `[${t('chat.parse_failed')}: ${result.error || t('chat.unknown_error')}]` }
          }
          setParseProgress(prev => prev.map((p, i) => i === idx ? { ...p, status: 'done' } : p))
          return { name: att.name, text: result.parsedText || `[${t('chat.no_content')}]`, filePath: result.filePath || '' }
        }))
        allParsed.push(...parsed)
      } catch (e: unknown) {
        if (e instanceof Error && e.name === 'AbortError') {
          addToast({ type: 'info', title: t('chat.cancelled'), message: t('chat.upload_cancelled') })
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

    // 处理本地路径附件（Electron 粘贴的文件，直接传路径给后端解析）
    if (pathAttachments.length > 0) {
      setParsingFiles(true)
      setParseProgress(pathAttachments.map(a => ({ name: a.name, status: 'uploading' as const })))
      try {
        const parsed = await Promise.all(pathAttachments.map(async (att, idx) => {
          const res = await fetch(`${getServerUrl()}/api/files/parse-local`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: att.filePath }),
          })
          const result = await res.json()
          if (!res.ok) {
            setParseProgress(prev => prev.map((p, i) => i === idx ? { ...p, status: 'error' } : p))
            return { name: att.name, text: `[${t('chat.parse_failed')}: ${result.error || t('chat.unknown_error')}]`, filePath: att.filePath }
          }
          setParseProgress(prev => prev.map((p, i) => i === idx ? { ...p, status: 'done' } : p))
          return { name: att.name, text: result.parsedText || `[${t('chat.no_content')}]`, filePath: att.filePath }
        }))
        allParsed.push(...parsed)
      } catch (e) {
        console.error('本地文件解析失败:', e)
      } finally {
        setParsingFiles(false)
        setParseProgress([])
      }
    }

    // 组合所有解析结果
    if (allParsed.length > 0) {
      const parsedContent = allParsed.map(p => {
        const header = p.filePath ? `📎 ${p.name} (路径: ${p.filePath})` : `📎 ${p.name}`
        return `${header}:\n${p.text}`
      }).join('\n\n---\n\n')

      hiddenContext = parsedContent
      const attachmentSummary = allParsed.map(p => `📎 ${p.name}`).join('、')
      fullMessage = fullMessage
        ? `${fullMessage}\n\n[附件: ${attachmentSummary}]`
        : `[附件: ${attachmentSummary}]`
    }

    if (otherAttachments.length > 0) {
      const info = otherAttachments.map(a => `[附件: ${a.type}/${a.name}]`).join(' ')
      fullMessage = fullMessage ? `${fullMessage}\n\n${info}` : info
    }

    setInput('')
    setAttachments([])
    setMentionState(closeMention())
    sendChat(fullMessage, currentView, hiddenContext)
    sendingRef.current = false
  }

  // @ mention 选中处理：替换 @xxx 文本，加入 attachment
  const handleMentionSelect = useCallback((item: MentionItem) => {
    const { mentionStart } = mentionState
    if (mentionStart < 0) return

    const textarea = textareaRef.current
    const cursorPos = textarea?.selectionStart ?? input.length

    // 替换 @xxx 为空（技能以 attachment chip 形式展示）
    const before = input.slice(0, mentionStart)
    const after = input.slice(cursorPos)
    const newInput = before + after
    setInput(newInput)

    // 加入 attachment
    const typeMap: Record<string, string> = { skill: 'skill', mcp: 'mcp', dun: 'dun' }
    setAttachments(prev => [...prev, {
      type: typeMap[item.category] || item.category,
      name: item.name,
    }])

    // 关闭 mention
    setMentionState(closeMention())

    // 聚焦回输入框
    setTimeout(() => {
      if (textarea) {
        textarea.focus()
        const pos = before.length
        textarea.setSelectionRange(pos, pos)
      }
    }, 0)
  }, [mentionState, input])

  // 输入变更：检测 @ mention（IME 兼容）
  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    if (!isComposingRef.current) {
      const cursorPos = e.target.selectionStart ?? val.length
      const next = detectMention(val, cursorPos)
      setMentionState(next.isOpen ? { ...next, activeIndex: 0 } : closeMention())
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 当 mention 下拉框打开时，劫持键盘事件
    if (mentionState.isOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionState(prev => ({ ...prev, activeIndex: prev.activeIndex + 1 }))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionState(prev => ({ ...prev, activeIndex: Math.max(0, prev.activeIndex - 1) }))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        // 直接计算过滤后的列表，选中当前高亮项
        const categoryItems = mentionState.activeCategory
          ? mentionItems.filter(i => i.category === mentionState.activeCategory)
          : mentionItems
        const filtered = filterMentionItems(categoryItems, mentionState.query)
        const idx = Math.min(mentionState.activeIndex, filtered.length - 1)
        if (filtered[idx]) {
          handleMentionSelect(filtered[idx])
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionState(closeMention())
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Ctrl+V 粘贴处理：支持图片和文件（Electron 环境下支持从资源管理器粘贴文件）
  // 注意：e.preventDefault() 必须在同步阶段调用，拆分为同步入口 + 异步处理
  const handlePasteAsync = async (clipboardData: DataTransfer | null) => {
    if (!clipboardData) return

    const electronAPI = (window as unknown as { electronAPI?: {
      clipboard: {
        readFilePaths: () => Promise<string[]>
        readImage: () => Promise<string | null>
      }
    } }).electronAPI

    // Electron 环境：优先用原生 API 读取剪贴板
    if (electronAPI?.clipboard) {
      // 1. 尝试读取文件路径（从资源管理器 Ctrl+C 复制的文件）
      try {
        const filePaths = await electronAPI.clipboard.readFilePaths()
        if (filePaths.length > 0) {
          for (const fp of filePaths) {
            const name = fp.split(/[/\\]/).pop() || 'file'
            const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
            const isImage = ['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp', '.gif', '.svg'].includes(ext)
            setAttachments(prev => [...prev, {
              type: isImage ? 'image' : 'file',
              name,
              filePath: fp,
            }])
          }
          addToast({ type: 'success', title: t('chat.pasted'), message: `${filePaths.length} ${t('chat.files_added')}` })
          return
        }
      } catch (err) {
        console.error('Electron clipboard readFilePaths failed:', err)
      }

      // 2. 尝试读取剪贴板图片（截图等）
      try {
        const imgDataUrl = await electronAPI.clipboard.readImage()
        if (imgDataUrl && imgDataUrl !== 'data:image/png;base64,') {
          // 检查 clipboardData 中是否有纯文本且无文件（若仅有纯文本则不是截图场景）
          const hasText = clipboardData.types?.includes('text/plain')
          const hasFiles = Array.from(clipboardData.items).some(i => i.kind === 'file')
          if (!hasText || hasFiles) {
            setAttachments(prev => [...prev, {
              type: 'image',
              name: `paste-${Date.now()}.png`,
              data: imgDataUrl,
            }])
            return
          }
        }
      } catch (err) {
        console.error('Electron clipboard readImage failed:', err)
      }
    }

    // 3. 浏览器标准 API fallback：处理截图和拖拽粘贴的图片
    const items = clipboardData.items
    if (!items) return

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (!file) continue
        if (file.size > MAX_UPLOAD_SIZE) {
          addToast({ type: 'error', title: t('chat.file_too_large'), message: t('chat.image_too_large') })
          continue
        }
        const reader = new FileReader()
        reader.onload = () => {
          setAttachments(prev => [...prev, {
            type: 'image',
            name: file.name || `paste-${Date.now()}.png`,
            data: reader.result as string,
            file,
          }])
        }
        reader.readAsDataURL(file)
        return  // 已处理，不需要继续
      }
    }
    // 纯文本粘贴走默认行为，不拦截
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    // 同步阶段：判断是否含有图片或文件，若有则阻止默认粘贴（须在 await 前同步调用）
    const items = e.clipboardData?.items
    const hasImageOrFile = items && Array.from(items).some(
      i => i.type.startsWith('image/') || i.kind === 'file'
    )
    if (hasImageOrFile) {
      e.preventDefault()
    }
    // 异步处理图片/文件内容（Electron 环境下也会尝试读取剪贴板文件/图片）
    handlePasteAsync(e.clipboardData)
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
        addToast({ type: 'error', title: t('chat.file_too_large'), message: `${file.name} ${t('chat.file_too_large_msg')}` })
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
   * 创建 Dun 处理
   * 流程：Observer（观察者）后台分析对话 → Toast 通知 → Builder（建构者/CreateNexusModal）展示编辑
   */
  const handleCreateDun = useCallback(async () => {
    // 如果没有对话，直接打开空表单（建构者模式）
    if (chatMessages.length < 2) {
      setDunInitialData(undefined)
      setShowDunModal(true)
      return
    }

    // 显示"开始分析"Toast
    addToast({
      type: 'info',
      title: t('chat.observer_started'),
      message: t('chat.analyzing_conversation'),
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
              title: t('chat.installing_skills'),
              message: `${t('chat.detected_skills')} ${analysisResult.suggestedSkills.length} ${t('chat.skills_detected_msg')}`,
              duration: 5000,
            })
            const installedNames = useStore.getState().skills.map((s: { name?: string; id: string }) => s.name || s.id)
            const results = await autoInstallSkills(analysisResult.suggestedSkills, installedNames)
            const installed = results.filter(r => r.status === 'installed')
            const notFound = results.filter(r => r.status === 'not_found' || r.status === 'failed')
            if (installed.length > 0) {
              installSummary = `${t('chat.skills_installed')} ${installed.length} ${t('chat.skills_count')}`
              // 刷新前端技能列表
              try {
                const serverUrl = localStorage.getItem('duncrew_server_url') || _getServerUrl()
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
              installSummary += `${t('chat.skills_comma')}${notFound.length} ${t('chat.skills_not_found')}`
            }
          } catch {
            // 安装流程整体失败，不阻塞
            installSummary = `${t('chat.skills_comma')}${t('chat.skills_install_failed')}`
          }
        }

        // 存储分析结果
        const resultData: DunInitialData = {
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
          title: t('chat.nexus_analysis_complete'),
          message: `${t('chat.extracted_nexus')}${analysisResult.name}${t('chat.nexus_name_end')}${installSummary}`,
          duration: 8000,
          onClick: () => {
            // 点击 Toast 时打开 Modal 并填入数据
            setDunInitialData(pendingAnalysisResult.current || undefined)
            setShowDunModal(true)
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
          title: t('chat.analysis_no_content'),
          message: t('chat.click_create_dun'),
          duration: 6000,
          onClick: () => {
            setDunInitialData(undefined)
            setShowDunModal(true)
          },
        })
        console.log('[Observer → Builder] 分析无结果')
      }
    }).catch((error) => {
      console.error('[Observer] 分析失败:', error)
      addToast({
        type: 'error',
        title: t('chat.analysis_failed'),
        message: t('chat.click_create_dun'),
        duration: 6000,
        onClick: () => {
          setDunInitialData(undefined)
          setShowDunModal(true)
        },
      })
    })
  }, [chatMessages, analyzeConversationForBuilder, addToast])

  // 关闭 Nexus Modal 时清理状态
  const handleCloseDunModal = useCallback(() => {
    setShowDunModal(false)
    setDunInitialData(undefined)
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
                    title={sidebarCollapsed ? t('chat.expand_sidebar') : t('chat.collapse_sidebar')}
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
                  {/* 创建 Dun 按钮 */}
                  <button
                    onClick={handleCreateDun}
                    disabled={chatStreaming || isObserverAnalyzing}
                    className="flex items-center gap-1.5 text-xs font-bold text-amber-600 
                             bg-amber-50 hover:bg-amber-100 px-3 py-1.5 rounded-lg
                             transition-colors disabled:opacity-30 disabled:pointer-events-none"
                    title={t('chat.create_dun_from_chat')}
                  >
                    {isObserverAnalyzing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="w-3.5 h-3.5" />
                    )}
                    <span>{t('chat.create_dun')}</span>
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
                      {t('chat.loading_conversations')}
                    </p>
                  </div>
                ) : chatMessages.length === 0 && !chatStreaming ? (
                  <div className="flex flex-col items-center justify-center h-full text-center">
                    <MessageSquare className="w-16 h-16 text-stone-200 mb-5" />
                    <p className="text-lg font-mono text-stone-400 mb-4">
                      {t('chat.input_placeholder')}
                    </p>
                    
                    {/* 创建 Dun 引导按钮 */}
                    <button
                      onClick={handleCreateDun}
                      className="flex items-center gap-3 px-6 py-3.5 mb-8
                                 bg-amber-50 border border-amber-200 rounded-xl
                                 text-amber-600 hover:bg-amber-100 hover:border-amber-300
                                 transition-all duration-300 group"
                    >
                      <Wand2 className="w-5 h-5 group-hover:rotate-12 transition-transform duration-300" />
                      <span className="font-mono text-base font-medium">创建 Dun</span>
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
                    {chatStreaming && (
                      <>
                        <AgentProgressTicker />
                        {chatStreamContent && (
                          <StreamingMessage content={chatStreamContent} />
                        )}
                      </>
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
                          {att.type === 'dun' && <Box className="w-3.5 h-3.5 text-emerald-500" />}
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
                      <input ref={fileInputRef} type="file" accept=".pdf,.docx,.pptx,.xlsx,.xls,.csv,.txt,.md,.rtf,.epub,.odt,.json,.yaml,.yml,.xml,.toml,.html,.htm,.py,.js,.ts,.jsx,.tsx,.java,.c,.cpp,.h,.hpp,.cs,.go,.rs,.rb,.php,.swift,.kt,.scala,.lua,.sh,.bat,.ps1,.sql,.r,.vue,.svelte,.ini,.cfg,.conf,.env,.log,.properties" multiple onChange={handleFileUpload} className="hidden" />
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
                      onChange={handleInputChange}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
                      onCompositionStart={() => { isComposingRef.current = true }}
                      onCompositionEnd={(e) => {
                        isComposingRef.current = false
                        // compositionEnd 后手动触发一次 mention 检测
                        const target = e.target as HTMLTextAreaElement
                        const cursorPos = target.selectionStart ?? target.value.length
                        setMentionState(detectMention(target.value, cursorPos))
                      }}
                      placeholder={t('chat.input_placeholder')}
                      disabled={chatStreaming}
                      rows={1}
                      className="flex-1 bg-transparent border-none focus:ring-0 resize-none py-3.5 px-2 
                                 text-stone-700 text-sm font-medium placeholder:text-stone-300
                                 focus:outline-none disabled:opacity-50 min-h-[44px] max-h-[120px]"
                    />

                    {/* @ mention 下拉面板 */}
                    <MentionDropdown
                      isOpen={mentionState.isOpen}
                      query={mentionState.query}
                      activeCategory={mentionState.activeCategory}
                      items={mentionItems}
                      activeIndex={mentionState.activeIndex}
                      onSelect={handleMentionSelect}
                      onActiveIndexChange={(idx) => setMentionState(prev => ({ ...prev, activeIndex: idx }))}
                    />
                    
                    {/* 发送/停止按钮 */}
                    {parsingFiles ? (
                      <button
                        onClick={handleCancelUpload}
                        className="m-1.5 w-10 h-10 flex items-center justify-center bg-stone-100 border border-amber-200 
                                   rounded-xl hover:bg-red-50 hover:border-red-200 transition-colors group"
                        title={t('chat.cancel_upload')}
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
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Enter</kbd> {t('chat.send_shortcut')}</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Shift+Enter</kbd> {t('chat.newline_shortcut')}</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">@</kbd> Mention</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Ctrl+V</kbd> {t('chat.paste_shortcut')}</span>
                    <span><kbd className="font-sans px-1 py-0.5 rounded border border-stone-200 bg-stone-50">Ctrl+K</kbd> {t('chat.close_shortcut')}</span>
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
      <CreateDunModal
        isOpen={showDunModal}
        onClose={handleCloseDunModal}
        initialData={dunInitialData}
      />
    </>
  )
}
