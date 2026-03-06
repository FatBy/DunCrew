import { useState, useMemo, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { User, Bot, AlertCircle, Clock, Loader2, CheckCircle2, XCircle, Copy, Check, MessageSquare, Cloud, Search, FileText, Terminal, FolderOpen } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { cn } from '@/utils/cn'
import type { ChatMessage as ChatMessageType, ExecutionStatus } from '@/types'
import { MarkdownRenderer } from './markdown/MarkdownRenderer'
import { DocumentView, isLongFormContent } from './markdown/DocumentView'
import { parseSuggestions, SuggestionChips } from './SuggestionChips'

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
  const lines = content.split('\n').filter(l => l.trim())
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-cyan-400">
        <Cloud className="w-5 h-5" />
        <span className="text-sm font-medium">天气信息</span>
      </div>
      
      <div className="grid gap-2">
        {lines.map((line, i) => {
          const trimmed = line.trim()
          if (!trimmed) return null
          
          if (trimmed.startsWith('查询时间') || trimmed.startsWith('Location')) {
            return (
              <div key={i} className="text-xs text-white/40 border-b border-white/10 pb-1">
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
                <span className="text-sm text-white/60">{trimmed}</span>
              </div>
            )
          }
          
          return (
            <div key={i} className="text-sm text-white/70 leading-relaxed pl-3 border-l-2 border-white/10">
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
  const lines = content.split('\n').filter(l => l.trim())
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-purple-400">
        <Search className="w-5 h-5" />
        <span className="text-sm font-medium">搜索结果</span>
      </div>
      
      <div className="space-y-1.5 max-h-80 overflow-y-auto">
        {lines.map((line, i) => (
          <div key={i} className="text-sm text-white/70 leading-relaxed py-1 border-b border-white/5 last:border-0">
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}

// 格式化文件输出
function FileOutput({ content }: { content: string }) {
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-amber-400">
        <FileText className="w-5 h-5" />
        <span className="text-sm font-medium">文件内容</span>
      </div>
      
      <pre className="text-sm text-white/70 leading-relaxed bg-black/30 rounded-lg p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
        {content}
      </pre>
    </div>
  )
}

// 格式化命令输出
function CommandOutput({ content }: { content: string }) {
  // 解析 Exit Code 并高亮显示
  const exitCodeMatch = content.match(/Exit Code:\s*(\d+)(?:\s*\(([^)]+)\))?/)
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1]) : null
  const exitHint = exitCodeMatch?.[2] || null
  const isSuccess = exitCode === 0

  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-emerald-400">
        <Terminal className="w-5 h-5" />
        <span className="text-sm font-medium">命令输出</span>
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
      
      <pre className="text-sm font-mono text-emerald-400/80 leading-relaxed bg-black/40 rounded-lg p-3 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap">
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
  const [opening, setOpening] = useState(false)
  
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
  
  const handleOpenFile = async () => {
    if (!data.filePath) return
    setOpening(true)
    
    try {
      const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
      const response = await fetch(`${serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'openInExplorer',
          args: { path: data.filePath }
        })
      })
      
      if (!response.ok) throw new Error('打开失败')
    } catch (error) {
      console.error('打开文件失败:', error)
    } finally {
      setOpening(false)
    }
  }
  
  return (
    <div className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-emerald-400">
        <CheckCircle2 className="w-5 h-5" />
        <span className="text-sm font-medium">文件已创建</span>
      </div>
      
      {/* 文件信息卡片 */}
      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-emerald-400/60" />
          <span className="text-sm font-mono text-white/80">{data.fileName}</span>
          {data.fileSize !== undefined && (
            <span className="text-xs text-white/40 ml-auto">{data.fileSize} 字节</span>
          )}
        </div>
        
        {data.filePath && (
          <div className="flex items-start gap-2">
            <span className="text-xs text-white/40 flex-shrink-0 mt-0.5">路径</span>
            <span 
              className="text-xs font-mono text-white/50 break-all" 
              title={data.filePath}
            >
              {data.filePath}
            </span>
          </div>
        )}
        
        <div className="text-xs text-emerald-400/80">{data.message}</div>
      </div>
      
      {/* 操作按钮 - 直接打开文件 */}
      {data.filePath && (
        <button
          onClick={handleOpenFile}
          disabled={opening}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          {opening ? '打开中...' : '打开文件'}
        </button>
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
        <div className="text-xs font-mono text-emerald-400/80 leading-relaxed px-1 min-h-[1.25rem]">
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
            任务建议
          </span>
          <span className="text-[13px] font-mono text-white/30 ml-auto">
            本地服务未启动
          </span>
        </div>
        
        <div className="text-sm font-mono text-white/70 mb-3 leading-relaxed">
          {content ? <MarkdownRenderer content={content} /> : ''}
        </div>
        
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors',
              copied
                ? 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-400'
                : 'bg-white/5 border border-white/10 text-white/60 hover:text-purple-400 hover:border-purple-500/30'
            )}
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                已复制
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                复制任务
              </>
            )}
          </button>
        </div>
      </motion.div>
    )
  }
  
  // 执行状态配置
  const configs: Record<string, { icon: typeof Clock; color: string; label: string }> = {
    pending: { icon: Clock, color: 'amber', label: '准备执行...' },
    running: { icon: Loader2, color: 'cyan', label: '执行中...' },
    success: { icon: CheckCircle2, color: 'emerald', label: '执行完成' },
    error: { icon: XCircle, color: 'red', label: '执行失败' },
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
      className="rounded-lg border border-white/10 overflow-hidden bg-slate-900/80"
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
        <span className="text-xs font-mono text-white/40 ml-1 truncate flex-1">
          {content && content.slice(0, 60)}{content && content.length > 60 ? '...' : ''}
        </span>
        {logLines.length > 0 && (
          <button
            onClick={handleCopyOutput}
            className="text-white/30 hover:text-white/60 transition-colors flex-shrink-0"
            title="复制输出"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>
      
      {/* 输出内容 - 默认展开、全宽、大字体 */}
      {logLines.length > 0 && (
        <div className="border-t border-white/5">
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

// 文件创建卡片 (基于结构化数据，用于消息附件)
function FileCreatedCard({ file }: { file: { filePath: string; fileName: string; message: string; fileSize?: number } }) {
  const [opening, setOpening] = useState(false)

  const handleOpenFile = async () => {
    if (!file.filePath) return
    setOpening(true)
    try {
      const serverUrl = localStorage.getItem('ddos_server_url') || 'http://localhost:3001'
      await fetch(`${serverUrl}/api/tools/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'openInExplorer', args: { path: file.filePath } })
      })
    } catch (error) {
      console.error('打开文件失败:', error)
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <FileText className="w-4 h-4 text-emerald-400/60" />
        <span className="text-sm font-mono text-white/80">{file.fileName}</span>
        {file.fileSize !== undefined && (
          <span className="text-xs text-white/40 ml-auto">{file.fileSize} 字节</span>
        )}
      </div>

      {file.filePath && (
        <div className="flex items-start gap-2">
          <span className="text-xs text-white/40 flex-shrink-0 mt-0.5">路径</span>
          <span className="text-xs font-mono text-white/50 break-all" title={file.filePath}>
            {file.filePath}
          </span>
        </div>
      )}

      {file.filePath && (
        <button
          onClick={handleOpenFile}
          disabled={opening}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          {opening ? '打开中...' : '打开文件'}
        </button>
      )}
    </div>
  )
}

interface ChatMessageProps {
  message: ChatMessageType
  containerWidth?: 'main' | 'nexus'
}

export function ChatMessage({ message, containerWidth = 'main' }: ChatMessageProps) {
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
      className="space-y-2"
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
        </>
      )}

      {/* 普通文本消息气泡 */}
      {!isAssistantLongForm && !(message.execution?.status === 'suggestion') && message.content && !hasExecution && (
        <div className={cn('flex gap-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
          <div className={cn(
            'w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0',
            isUser ? 'bg-cyan-500/20' : 'bg-amber-500/20'
          )}>
            {isUser 
              ? <User className="w-3.5 h-3.5 text-cyan-400" />
              : <Bot className="w-3.5 h-3.5 text-amber-400" />
            }
          </div>
          <div className={cn(
            isUser ? 'max-w-[80%]' : 'max-w-[85%]',
            'space-y-0'
          )}>
            <div className={cn(
              'px-3 py-2 rounded-lg text-sm leading-relaxed',
              isUser
                ? 'bg-cyan-500/10 border border-cyan-500/20 text-white/80 font-mono'
                : isError
              ? 'bg-red-500/10 border border-red-500/20 text-red-300 font-mono'
              : 'bg-white/5 border border-white/10 text-white/70'
          )}>
            {isError && (
              <div className="flex items-center gap-1 mb-1 text-red-400">
                <AlertCircle className="w-3 h-3" />
                <span className="text-[13px]">错误</span>
              </div>
            )}
            {isUser ? (
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            ) : (
              <MarkdownRenderer content={displayContent} />
            )}
          </div>
            {/* 建议选项卡片 — 放在气泡外部，独立渲染 */}
            {!isUser && suggestions && (
              <SuggestionChips
                prompt={suggestions.prompt}
                items={suggestions.items}
                aiContent={message.content}
              />
            )}
          </div>
        </div>
      )}

      {/* 纯文本气泡 (有执行但也有文本内容时) */}
      {hasExecution && !(message.execution?.status === 'suggestion') && message.content && (
        <div className="flex gap-2">
          <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-amber-500/20">
            <Bot className="w-3.5 h-3.5 text-amber-400" />
          </div>
          <div className="max-w-[80%] px-3 py-2 rounded-lg text-sm leading-relaxed bg-white/5 border border-white/10 text-white/70">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      )}

      {/* 执行卡片 - 全宽独立展示 */}
      {hasExecution && (
        <ExecutionCard execution={message.execution!} content={message.content} />
      )}

      {/* 文件创建卡片 - 显示执行过程中创建的文件 */}
      {message.createdFiles && message.createdFiles.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-emerald-400 px-1">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-xs font-mono font-medium">
              {message.createdFiles.length === 1 ? '已创建文件' : `已创建 ${message.createdFiles.length} 个文件`}
            </span>
          </div>
          {message.createdFiles.map((file, i) => (
            <FileCreatedCard key={`${file.filePath}-${i}`} file={file} />
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
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-2"
    >
      <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-amber-500/20">
        <Bot className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
      </div>
      <div className="max-w-[80%] px-3 py-2 rounded-lg text-sm leading-relaxed bg-white/5 border border-amber-500/20 text-white/70">
        <MarkdownRenderer content={content} />
        <span className="inline-block w-1.5 h-3.5 bg-amber-400/60 ml-0.5 animate-pulse" />
      </div>
    </motion.div>
  )
}
