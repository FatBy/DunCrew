/**
 * AssistantModal - Blueprint 清透 AI 助手弹窗
 *
 * 设计宪法:
 * - bg-white/95 backdrop-blur-3xl 弹窗主体
 * - bg-stone-900/5 backdrop-blur-sm 遮罩 (禁止深色遮罩)
 * - 推流 reasoningBuffer
 * - useEffect + setInterval + startTime 跳动秒表
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  MessageSquare, X, Paperclip, Send,
} from 'lucide-react'
import { useStore } from '@/store'
import { agentEventBus } from '@/services/agentEventBus'
import type { AgentRunState, ChatMessage } from '@/types'

// ── 消息气泡 ──
function MessageBubble({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }) {
  const isUser = msg.role === 'user'

  return (
    <div className={`flex gap-4 max-w-3xl mx-auto ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* 头像 */}
      <div
        className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${
          isUser
            ? 'bg-stone-100 border border-stone-200'
            : 'bg-amber-50 border border-amber-100'
        }`}
      >
        {isUser ? (
          <span className="text-stone-500 text-xs font-bold">U</span>
        ) : (
          <span className="text-lg leading-none filter drop-shadow-sm">{'\uD83E\uDD8C'}</span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <span className="text-stone-400 text-xs font-bold mb-1 ml-1">
          {isUser ? '你' : 'AI'}
        </span>
        <div
          className={`
            px-5 py-4 text-[13px] leading-relaxed shadow-sm whitespace-pre-wrap break-words
            ${
              isUser
                ? 'bg-stone-100 border border-stone-200 rounded-2xl rounded-tr-sm text-stone-700'
                : 'bg-stone-50 border border-stone-100 rounded-2xl rounded-tl-sm text-stone-700'
            }
          `}
        >
          {msg.content}
          {streaming && (
            <span className="inline-block w-2 h-4 bg-amber-400 rounded-sm animate-pulse ml-0.5" />
          )}
        </div>
      </div>
    </div>
  )
}

// ── 主组件 ──
interface AssistantModalProps {
  onClose: () => void
}

export function AssistantModal({ onClose }: AssistantModalProps) {
  const conversations = useStore((s) => s.conversations)
  const activeConversationId = useStore((s) => s.activeConversationId)
  const getCurrentMessages = useStore((s) => s.getCurrentMessages)
  const chatStreaming = useStore((s) => s.chatStreaming)
  const chatStreamContent = useStore((s) => s.chatStreamContent)
  const sendChat = useStore((s) => s.sendChat)
  const createConversation = useStore((s) => s.createConversation)
  const switchConversation = useStore((s) => s.switchConversation)
  const abortChat = useStore((s) => s.abortChat)

  const [input, setInput] = useState('')
  const chatEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ── 订阅 agentEventBus 获取 reasoningBuffer ──
  const [runState, setRunState] = useState<AgentRunState>(agentEventBus.getState())

  useEffect(() => {
    const unsub = agentEventBus.subscribe(() => {
      setRunState({ ...agentEventBus.getState() })
    })
    return unsub
  }, [])

  // ── 跳动秒表 ──
  const [toolElapsed, setToolElapsed] = useState(0)
  useEffect(() => {
    if (!runState.currentTool) {
      setToolElapsed(0)
      return
    }
    const start = runState.currentTool.startTime
    const id = setInterval(() => setToolElapsed(Date.now() - start), 100)
    return () => clearInterval(id)
  }, [runState.currentTool?.callId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 消息列表 ──
  const messages = getCurrentMessages()

  // ── 自动滚动 ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, chatStreamContent])

  // ── 会话列表 (按时间排序) ──
  const sortedConversations = useMemo(() => {
    return [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [conversations])

  // ── 发送消息 ──
  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed || chatStreaming) return
    setInput('')
    sendChat(trimmed, 'world')
  }, [input, chatStreaming, sendChat])

  // ── 新建会话 ──
  const handleNewConversation = useCallback(() => {
    createConversation('general')
  }, [createConversation])

  // ── 键盘事件 ──
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  // ── 格式化时间 ──
  const formatTime = (ts: number) => {
    const diff = Date.now() - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
    return new Date(ts).toLocaleDateString('zh-CN')
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-stone-900/5 backdrop-blur-sm p-8">
      <div className="relative w-full max-w-6xl h-[85vh] flex flex-col bg-white/95 backdrop-blur-3xl border border-white/80 rounded-[2.5rem] shadow-[0_30px_80px_rgba(0,0,0,0.08)] overflow-hidden">
        {/* ── 顶栏 ── */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-100 bg-white/50 z-20">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-50 border border-amber-100 flex items-center justify-center text-amber-500">
              <MessageSquare className="w-4 h-4" />
            </div>
            <h2 className="text-lg font-black text-stone-800 tracking-wide">AI Assistant</h2>
            <span className="ml-2 px-2 py-0.5 rounded-md bg-stone-100 border border-stone-200 text-[10px] font-bold text-stone-400 uppercase tracking-widest">
              world
            </span>
          </div>
          <div className="flex items-center gap-4">
            {chatStreaming && (
              <button
                onClick={abortChat}
                className="px-3 py-1 text-xs font-bold text-red-500 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
              >
                停止
              </button>
            )}
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full text-stone-400 hover:text-rose-500 hover:bg-rose-50 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden bg-[#faf9f8]">
          {/* ── 左侧会话列表 ── */}
          <div className="w-72 border-r border-stone-100/80 bg-stone-50/50 flex flex-col">
            <div className="p-4 border-b border-stone-100">
              <button
                onClick={handleNewConversation}
                className="w-full py-2.5 bg-stone-800 hover:bg-stone-700 text-white rounded-xl text-sm font-bold shadow-sm transition-colors flex items-center justify-center gap-2"
              >
                + 新建会话
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {sortedConversations.map((conv) => {
                const isActive = conv.id === activeConversationId
                const lastMsg = conv.messages[conv.messages.length - 1]
                return (
                  <div
                    key={conv.id}
                    onClick={() => switchConversation(conv.id)}
                    className={`
                      relative rounded-xl p-3 cursor-pointer transition-all
                      ${isActive
                        ? 'bg-white border border-stone-200 shadow-sm'
                        : 'hover:bg-white/60 border border-transparent'
                      }
                    `}
                  >
                    {isActive && (
                      <div className="absolute left-0 top-3 bottom-3 w-1 bg-amber-400 rounded-r-md" />
                    )}
                    <h4 className="text-stone-800 font-bold text-sm truncate">
                      {conv.title || '新会话'}
                    </h4>
                    {lastMsg && (
                      <p className="text-stone-500 text-xs mt-1 truncate">
                        {lastMsg.content.slice(0, 50)}
                      </p>
                    )}
                    <div className="mt-2 text-[10px] text-stone-400 font-bold">
                      {formatTime(conv.updatedAt)}
                    </div>
                  </div>
                )
              })}
              {sortedConversations.length === 0 && (
                <div className="text-center py-8 text-stone-300 text-xs">暂无会话</div>
              )}
            </div>
          </div>

          {/* ── 右侧聊天区 ── */}
          <div className="flex-1 flex flex-col bg-white relative">
            <div className="flex-1 overflow-y-auto p-6 space-y-8 z-10">
              {messages.map((msg, i) => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  streaming={
                    chatStreaming &&
                    i === messages.length - 1 &&
                    msg.role === 'assistant'
                  }
                />
              ))}

              {/* 推流中的占位 */}
              {chatStreaming && chatStreamContent && messages[messages.length - 1]?.role !== 'assistant' && (
                <MessageBubble
                  msg={{
                    id: '__streaming__',
                    role: 'assistant',
                    content: chatStreamContent,
                    timestamp: Date.now(),
                  }}
                  streaming
                />
              )}

              {/* ── 推流 reasoningBuffer ── */}
              {runState.reasoningBuffer && runState.phase !== 'idle' && runState.phase !== 'done' && (
                <div className="max-w-3xl mx-auto">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-stone-400">
                      THINKING
                    </span>
                    {runState.currentTool && (
                      <span className="text-[10px] font-mono text-stone-400 ml-auto">
                        {runState.currentTool.name} &middot; {(toolElapsed / 1000).toFixed(1)}s
                      </span>
                    )}
                  </div>
                  <div className="bg-stone-50 border border-stone-100 rounded-xl px-4 py-3 text-xs text-stone-500 font-mono leading-relaxed whitespace-pre-wrap">
                    {runState.reasoningBuffer.slice(-400)}
                  </div>
                </div>
              )}

              <div ref={chatEndRef} />
            </div>

            {/* ── 清透浮动输入框 ── */}
            <div className="p-6 bg-gradient-to-t from-white via-white to-transparent z-20">
              <div className="max-w-3xl mx-auto flex items-end gap-2 bg-white border-2 border-stone-200 rounded-2xl p-2 focus-within:border-amber-400 shadow-sm transition-all">
                <button className="p-2 text-stone-400 hover:text-stone-600">
                  <Paperclip className="w-4 h-4" />
                </button>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="flex-1 bg-transparent border-none focus:ring-0 focus:outline-none resize-none py-2 px-2 text-stone-700 text-sm placeholder:text-stone-300"
                  rows={1}
                  placeholder="输入消息或快捷命令..."
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || chatStreaming}
                  className="m-1 w-9 h-9 bg-amber-100 hover:bg-amber-200 text-amber-600 rounded-xl flex items-center justify-center transition-colors disabled:opacity-40"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
