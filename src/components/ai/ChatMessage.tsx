import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { User, Bot, AlertCircle, Clock, Loader2, CheckCircle2, XCircle, Copy, Check, MessageSquare, Cloud, Search, FileText, Terminal, ThumbsUp, RefreshCw } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { cn } from '@/utils/cn'
import type { ChatMessage as ChatMessageType, ExecutionStatus } from '@/types'
import { MarkdownRenderer } from './markdown/MarkdownRenderer'
import { DocumentView, isLongFormContent } from './markdown/DocumentView'
import { parseSuggestions, SuggestionChips } from './SuggestionChips'
import { FileCard } from '@/components/shared/FileCard'
import { useT } from '@/i18n'
import { useStore } from '@/store'

// 检测输出类型
function detectOutputType(output: string): 'weather' | 'search' | 'file' | 'file_created' | 'command' | 'plain' {
  // 优先检测结构化 JSON 输出（文件创建）
  try {
    const parsed = JSON.parse(output)
    if (parsed.action === 'file_created' && parsed.filePath) {
      return 'file_created'
    }
  } catch {
    // 非 JSON，继续正则检测
  }
  
  // 兼容旧格式：正则匹配 "Written ... bytes to ..."
  if (/Written \d+ bytes to .+/.test(output)) {
    return 'file_created'
  }
  
  if (output.includes('查询时间:') || output.includes('Weather') || output.includes('°C') || output.includes('天气')) {
    return 'weather'
  }
  if (output.includes('搜索结果') || output.includes('DuckDuckGo') || output.includes('Search')) {
    return 'search'
  }
  if (output.includes('文件内容') || output.includes('File content') || output.startsWith('#')) {
    return 'file'
  }
  if (output.includes('执行命令') || output.includes('Command') || output.includes('Exit Code') || output.includes('Exit code')) {
    return 'command'
  }
  return 'plain'
}

// 格式化天气输出
function WeatherOutput({ content }: { content: string }) {
  const t = useT()
  const lines = content.split('\n').filter(l => l.trim())
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-cyan-400">
        <Cloud className="w-5 h-5" />
        <span className="text-sm font-medium">{t('msg.weather_info')}</span>
      </div>
      
      <div className="grid gap-2">
        {lines.map((line, i) => {
          const trimmed = line.trim()
          if (!trimmed) return null
          
          if (trimmed.startsWith('查询时间') || trimmed.startsWith('Location')) {
            return (
              <div key={i} className="text-xs text-stone-400 border-b border-stone-200 pb-1">
                {trimmed}
              </div>
            )
          }
          
          if (trimmed.includes('°') || trimmed.includes('temp')) {
            return (
              <div key={i} className="flex items-center gap-2 bg-cyan-500/10 rounded px-3 py-2">
                <span className="text-xl font-bold text-cyan-400">
                  {trimmed.match(/\d+°?C?/)?.[0] || ''}
                </span>
                <span className="text-sm text-stone-500">{trimmed}</span>
              </div>
            )
          }
          
          return (
            <div key={i} className="text-sm text-stone-600 leading-relaxed pl-3 border-l-2 border-stone-200">
              {trimmed}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// 格式化搜索输出
function SearchOutput({ content }: { content: string }) {
  const t = useT()
  const lines = content.split('\n').filter(l => l.trim())
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-purple-400">
        <Search className="w-5 h-5" />
        <span className="text-sm font-medium">{t('msg.search_results')}</span>
      </div>
      
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {lines.map((line, i) => (
          <div key={i} className="text-sm text-stone-600 leading-relaxed py-1 border-b border-stone-100 last:border-0">
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}

// 格式化文件输出
function FileOutput({ content }: { content: string }) {
  const t = useT()
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-amber-400">
        <FileText className="w-5 h-5" />
        <span className="text-sm font-medium">{t('msg.file_content')}</span>
      </div>
      
      <pre className="text-sm text-stone-600 leading-relaxed bg-stone-100/80 rounded-lg p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  )
}

// 格式化命令输出
function CommandOutput({ content }: { content: string }) {
  const t = useT()
  // 解析 Exit Code 并高亮显示
  const exitCodeMatch = content.match(/Exit Code:\s*(\d+)(?:\s*\(([^)]+)\))?/)
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : null
  const exitHint = exitCodeMatch?.[2] || null
  const isSuccess = exitCode === 0

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-emerald-400">
        <Terminal className="w-5 h-5" />
        <span className="text-sm font-medium">{t('msg.command_output')}</span>
        {exitCode !== null && (
          <span className={cn(
            'ml-auto text-xs font-mono px-2 py-0.5 rounded',
            isSuccess 
              ? 'bg-emerald-500/15 text-emerald-400' 
              : 'bg-red-500/15 text-red-400'
          )}>
            {isSuccess ? 'Exit 0' : `Exit ${exitCode}`}
            {exitHint && !isSuccess && ` · ${exitHint}`}
          </span>
        )}
      </div>
      
      <pre className="text-sm font-mono text-emerald-400/80 leading-relaxed bg-stone-900/10 rounded-lg p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  )
}

// 文件创建成功输出
interface FileCreatedData {
  filePath: string
  fileName: string
  message: string
  fileSize?: number
}

function FileCreatedOutput({ content }: { content: string }) {
  const t = useT()
  // 解析数据
  const data: FileCreatedData = useMemo(() => {
    try {
      const parsed = JSON.parse(content)
      return {
        filePath: parsed.filePath || '',
        fileName: parsed.fileName || '',
        message: parsed.message || '',
        fileSize: parsed.fileSize,
      }
    } catch {
      // 兼容旧格式：提取文件名
      const match = content.match(/Written (\d+) bytes to (.+)/)
      if (match) {
        return {
          filePath: '',
          fileName: match[2],
          message: `已写入 ${match[1]} 字节`,
        }
      }
      return { filePath: '', fileName: '未知文件', message: content }
    }
  }, [content])
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-emerald-400">
        <CheckCircle2 className="w-5 h-5" />
        <span className="text-sm font-medium">{t('msg.file_created')}</span>
      </div>
      
      {data.filePath ? (
        <FileCard filePath={data.filePath} fileName={data.fileName} fileSize={data.fileSize} />
      ) : (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-emerald-400/60" />
            <span className="text-sm font-mono text-stone-700">{data.fileName}</span>
          </div>
          <div className="text-xs text-emerald-400/80">{data.message}</div>
        </div>
      )}
    </div>
  )
}

// 智能输出渲染器
function SmartOutputViewer({ content }: { content: string }) {
  const outputType = detectOutputType(content)
  
  switch (outputType) {
    case 'weather':
      return <WeatherOutput content={content} />
    case 'search':
      return <SearchOutput content={content} />
    case 'file':
      return <FileOutput content={content} />
    case 'file_created':
      return <FileCreatedOutput content={content} />
    case 'command':
      return <CommandOutput content={content} />
    default:
      return <PlainOutput content={content} />
  }
}

// 纯文本输出（改进版）
function PlainOutput({ content }: { content: string }) {
  const lines = content.split('\n')
  
  return (
    <div className="p-4 max-h-80 overflow-y-auto">
      {lines.map((line, i) => (
        <div 
          key={i} 
          className={cn(
            "text-sm font-mono leading-relaxed py-0.5",
            line.trim() ? "text-emerald-400/80" : "h-2"
          )}
        >
          {line || '\u00A0'}
        </div>
      ))}
    </div>
  )
}

// 虚拟化日志查看器 (保留用于大量输出)
function LogViewer({ lines }: { lines: string[] }) {
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const [atBottom, setAtBottom] = useState(true)
  
  useEffect(() => {
    if (atBottom && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: lines.length - 1, behavior: 'smooth' })
    }
  }, [lines.length, atBottom])

  return (
    <Virtuoso
      ref={virtuosoRef}
      style={{ height: '10rem' }}
      data={lines}
      atBottomStateChange={setAtBottom}
      itemContent={(_index: number, line: string) => (
        <div className="text-sm font-mono text-emerald-400/80 leading-relaxed px-1 min-h-[1.25rem]">
          {line || '\u00A0'}
        </div>
      )}
    />
  )
}

// 执行状态卡片 - 全宽设计
function ExecutionCard({ execution, content }: { execution: ExecutionStatus; content?: string }) {
  const [copied, setCopied] = useState(false)
  
  // 按行分割日志输出
  const logLines = useMemo(() => {
    if (execution.outputLines && execution.outputLines.length > 0) {
      return execution.outputLines
    }
    if (execution.output) {
      return execution.output.split('\n')
    }
    return []
  }, [execution.outputLines, execution.output])
  
  // 任务建议模式
  if (execution.status === 'suggestion') {
    const t = useT()
    const handleCopy = async () => {
      if (content) {
        await navigator.clipboard.writeText(content)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
    
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className="p-3 rounded-lg border bg-purple-500/10 border-purple-500/30"
      >
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-4 h-4 text-purple-400" />
          <span className="text-xs font-mono text-purple-400 font-medium">
            {t('msg.task_suggestion')}
          </span>
          <span className="text-[13px] font-mono text-stone-300 ml-auto">
            {t('msg.local_service_not_started')}
          </span>
        </div>
        
        <div className="text-sm font-mono text-stone-600 mb-3 leading-relaxed">
          {content ? <MarkdownRenderer content={content} /> : ''}
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors',
              copied
                ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
                : 'bg-stone-100/80 border border-stone-200 text-stone-500 hover:text-purple-400 hover:border-purple-500/30'
            )}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                {t('msg.copied')}
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                {t('msg.copy_task')}
              </>
            )}
          </button>
        </div>
      </motion.div>
    )
  }
  
  // 执行状态配置
  const t = useT()
  const configs: Record<string, { icon: typeof Clock; color: string; label: string }> = {
    pending: { icon: Clock, color: 'amber', label: t('msg.pending_execution') },
    running: { icon: Loader2, color: 'cyan', label: t('msg.executing') },
    success: { icon: CheckCircle2, color: 'emerald', label: t('msg.execution_complete') },
    error: { icon: XCircle, color: 'red', label: t('msg.execution_failed') },
  }
  const config = configs[execution.status] || configs.pending
  const Icon = config.icon

  const handleCopyOutput = async () => {
    const text = execution.output || logLines.join('\n')
    if (text) {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-lg border border-stone-200 overflow-hidden bg-white/90 backdrop-blur-xl"
    >
      {/* 状态栏 - 精简 */}
      <div className={cn(
        'flex items-center gap-2 px-4 py-2',
        execution.status === 'success' ? 'bg-emerald-500/10' :
        execution.status === 'error' ? 'bg-red-500/10' :
        execution.status === 'running' ? 'bg-cyan-500/10' :
        'bg-amber-500/10'
      )}>
        <Icon className={cn(
          'w-4 h-4',
          `text-${config.color}-400`,
          execution.status === 'running' && 'animate-spin'
        )} />
        <span className={cn('text-sm font-mono font-medium', `text-${config.color}-400`)}>
          {config.label}
        </span>
        {/* 仅当 content 与 output 不同时才在状态栏显示 content 摘要，避免重复 */}
        {content && content !== execution.output && (
          <span className="text-xs font-mono text-stone-400 ml-1 truncate flex-1">
            {content.slice(0, 60)}{content.length > 60 ? '...' : ''}
          </span>
        )}
        {logLines.length > 0 && (
          <button
            onClick={handleCopyOutput}
            className="text-stone-300 hover:text-stone-500 transition-colors flex-shrink-0"
            title="复制输出"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      
      {/* 输出内容 - 默认展开、全宽、大字体 */}
      {logLines.length > 0 && (
        <div className="border-t border-stone-100">
          {logLines.length > 100 ? (
            <div style={{ height: '20rem' }}>
              <LogViewer lines={logLines} />
            </div>
          ) : (
            <SmartOutputViewer content={execution.output || logLines.join('\n')} />
          )}
        </div>
      )}
      
      {/* 错误信息 */}
      {execution.error && (
        <div className="px-4 py-3 bg-red-500/5 border-t border-red-500/20">
          <p className="text-sm font-mono text-red-400/80">
            {execution.error}
          </p>
        </div>
      )}
    </motion.div>
  )
}

// 消息操作栏 (复制、重新生成、点赞)
function MessageActions({ message }: { message: ChatMessageType }) {
  const [copied, setCopied] = useState(false)
  const likeMessage = useStore(s => s.likeMessage)
  const regenerateMessage = useStore(s => s.regenerateMessage)
  const chatContext = useStore(s => s.chatContext)
  const chatStreaming = useStore(s => s.chatStreaming)

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [message.content])

  const handleRegenerate = useCallback(() => {
    if (chatStreaming) return
    regenerateMessage(message.id, chatContext)
  }, [message.id, chatContext, chatStreaming, regenerateMessage])

  const handleLike = useCallback(() => {
    likeMessage(message.id)
  }, [message.id, likeMessage])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex items-center gap-0.5 mt-1 ml-1"
    >
      {/* 复制 */}
      <button
        onClick={handleCopy}
        className="p-1.5 rounded-md text-stone-400 hover:text-stone-600 hover:bg-stone-100 transition-colors"
        title="复制"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>

      {/* 重新生成 */}
      <button
        onClick={handleRegenerate}
        disabled={chatStreaming}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          chatStreaming
            ? 'text-stone-300 cursor-not-allowed'
            : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100'
        )}
        title="重新生成"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>

      {/* 点赞 */}
      <button
        onClick={handleLike}
        className={cn(
          'p-1.5 rounded-md transition-colors',
          message.liked
            ? 'text-amber-500 bg-amber-50'
            : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100'
        )}
        title="点赞"
      >
        <ThumbsUp className={cn('w-3.5 h-3.5', message.liked && 'fill-amber-500')} />
      </button>
    </motion.div>
  )
}

// 文件创建卡片 (基于结构化数据，用于消息附件)
interface ChatMessageProps {
  message: ChatMessageType
  containerWidth?: 'main' | 'nexus'
}

export function ChatMessage({ message, containerWidth = 'main' }: ChatMessageProps) {
  const t = useT()
  const isUser = message.role === 'user'
  const isError = message.error
  const hasExecution = !!message.execution
  const isAssistantLongForm = !isUser && !hasExecution && message.content && isLongFormContent(message.content)

  // 解析建议选项（仅 assistant 消息）
  const suggestions = useMemo(() => {
    if (isUser || !message.content) return null
    return parseSuggestions(message.content)
  }, [isUser, message.content])

  // 如果有 suggestions，渲染时用去掉 suggestions 块的内容
  const displayContent = suggestions
    ? [suggestions.contentBefore, suggestions.contentAfter].filter(Boolean).join('\n\n')
    : message.content

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-2 group/msg"
    >
      {/* 长文档视图 (助手消息，非 execution，内容较长) */}
      {isAssistantLongForm && !(message.execution?.status === 'suggestion') && (
        <>
          <DocumentView content={displayContent} containerWidth={containerWidth} />
          {suggestions && (
            <SuggestionChips
              prompt={suggestions.prompt}
              items={suggestions.items}
              aiContent={message.content}
            />
          )}
          <div className="max-w-3xl mx-auto opacity-0 group-hover/msg:opacity-100 transition-opacity">
            <MessageActions message={message} />
          </div>
        </>
      )}

      {/* 普通文本消息气泡 */}
      {!isAssistantLongForm && !(message.execution?.status === 'suggestion') && message.content && !hasExecution && (
        <div className={cn('flex gap-4 max-w-3xl mx-auto', isUser ? 'flex-row-reverse' : 'flex-row')}>
          {/* Avatar */}
          {isUser ? (
            <div className="w-8 h-8 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center flex-shrink-0">
              <User className="w-4 h-4 text-stone-500" />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-amber-500" />
            </div>
          )}
          <div className={cn(
            'flex-1 flex flex-col',
            isUser ? 'items-end' : 'items-start'
          )}>
            {/* Name label */}
            <span className="text-stone-400 text-xs font-bold mb-1 mx-1">
              {isUser ? 'YOU' : 'Assistant'}
            </span>
            <div className={cn(
              'px-5 py-3.5 text-[13px] leading-relaxed shadow-sm',
              isUser
                ? 'bg-stone-800 text-stone-50 rounded-2xl rounded-tr-sm max-w-[80%]'
                : isError
                  ? 'bg-red-50 border border-red-200 text-red-600 rounded-2xl rounded-tl-sm'
                  : 'bg-stone-50 border border-stone-100 text-stone-700 rounded-2xl rounded-tl-sm'
            )}>
              {isError && (
                <div className="flex items-center gap-1 mb-1 text-red-500">
                  <AlertCircle className="w-3 h-3" />
                  <span className="text-[13px] font-bold">错误</span>
                </div>
              )}
              {isUser ? (
                <div className="whitespace-pre-wrap break-words">{message.content}</div>
              ) : (
                <MarkdownRenderer content={displayContent} />
              )}
            </div>
            {/* 建议选项卡片 */}
            {!isUser && suggestions && (
              <SuggestionChips
                prompt={suggestions.prompt}
                items={suggestions.items}
                aiContent={message.content}
              />
            )}
            {/* 消息操作栏 (仅 assistant) */}
            {!isUser && (
              <div className="opacity-0 group-hover/msg:opacity-100 transition-opacity">
                <MessageActions message={message} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 执行卡片 - 全宽独立展示（不再额外渲染文本气泡，避免 content 重复显示） */}
      {hasExecution && (
        <ExecutionCard execution={message.execution!} content={message.content} />
      )}

      {/* 文件创建卡片 - 显示执行过程中创建的文件 */}
      {message.createdFiles && message.createdFiles.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-emerald-400 px-1">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-xs font-mono font-medium">
              {message.createdFiles.length === 1 ? t('msg.created_file') : `${t('msg.created_files')} ${message.createdFiles.length} ${t('msg.files_count')}`}
            </span>
          </div>
          {message.createdFiles.map((file, i) => (
            <FileCard key={`${file.filePath}-${i}`} filePath={file.filePath} fileName={file.fileName} fileSize={file.fileSize} />
          ))}
        </div>
      )}
    </motion.div>
  )
}

interface StreamingMessageProps {
  content: string
}

export function StreamingMessage({ content }: StreamingMessageProps) {
  const t = useT()
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-4 max-w-3xl mx-auto"
    >
      <div className="w-8 h-8 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center flex-shrink-0">
        <Bot className="w-4 h-4 text-amber-500 animate-pulse" />
      </div>
      <div className="flex-1 flex flex-col items-start">
        <span className="text-stone-400 text-xs font-bold mb-1 ml-1 flex items-center gap-1.5">
          Assistant
          <Loader2 className="w-3 h-3 animate-spin text-amber-400" />
        </span>
        <div className="bg-stone-50 border border-stone-100 rounded-2xl rounded-tl-sm px-5 py-3.5 text-[13px] text-stone-700 leading-relaxed shadow-sm">
          {content ? (
            <>
              <MarkdownRenderer content={content} />
              <span className="inline-block w-1.5 h-3.5 bg-amber-400/60 ml-0.5 animate-pulse" />
            </>
          ) : (
            <span className="flex items-center gap-2 text-stone-400">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-300 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-400" />
              </span>
              <span className="animate-pulse">{t('task.agent_thinking')}</span>
            </span>
          )}
        </div>
      </div>
    </motion.div>
  )
}
