/**
 * LLM Service Client
 * 支持 OpenAI 兼容格式 和 Anthropic 原生格式
 * 支持流式 (SSE) 和非流式请求
 */

import type { LLMConfig, ToolInfo } from '@/types'

// ============================================
// Function Calling 类型定义
// ============================================

/** OpenAI Function Definition schema */
export interface FunctionDefinition {
  name: string
  description?: string
  parameters?: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

/** 流式 delta 中的 tool_call 片段 */
interface ToolCallDelta {
  index: number
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
}

/** 累积后的完整 tool_call */
export interface FCToolCall {
  id: string
  function: {
    name: string
    arguments: string
  }
}

/** streamChat 返回值 (FC 模式) */
export interface LLMStreamResult {
  content: string
  toolCalls: FCToolCall[]
  finishReason: string | null
  // DeepSeek 思维模式的推理内容
  reasoningContent?: string
}

// ============================================
// 消息类型
// ============================================

/** 支持 tool role 和 tool_calls 的消息类型 */
export type SimpleChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool' | string
  content: string | null
  // assistant 消息携带的 tool_calls
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  // tool 消息需要的 tool_call_id
  tool_call_id?: string
  // tool 消息可选的 name
  name?: string
  // DeepSeek 思维模式的推理内容 (reasoning_content)
  reasoning_content?: string
}

// localStorage keys
const STORAGE_KEYS = {
  API_KEY: 'duncrew_llm_api_key',
  BASE_URL: 'duncrew_llm_base_url',
  MODEL: 'duncrew_llm_model',
  API_FORMAT: 'duncrew_llm_api_format',
  // Embedding 专用配置
  EMBED_API_KEY: 'duncrew_embed_api_key',
  EMBED_BASE_URL: 'duncrew_embed_base_url',
  EMBED_MODEL: 'duncrew_embed_model',
}

// ============================================
// 配置管理
// ============================================

/** 获取本地后端服务器 URL (用于 LLM 代理) */
function getLocalServerUrl(): string {
  const isDevMode = import.meta.env?.DEV ?? false
  const isTauriMode = typeof window !== 'undefined' && '__TAURI__' in window
  if (isDevMode) return 'http://localhost:3001'
  if (isTauriMode) return 'http://127.0.0.1:3001'
  return ''  // 生产模式: 相对路径 (Python 托管同域)
}

export function getLLMConfig(): LLMConfig {
  const formatRaw = localStorage.getItem(STORAGE_KEYS.API_FORMAT)
  return {
    apiKey: localStorage.getItem(STORAGE_KEYS.API_KEY) || '',
    baseUrl: localStorage.getItem(STORAGE_KEYS.BASE_URL) || '',
    model: localStorage.getItem(STORAGE_KEYS.MODEL) || '',
    apiFormat: (formatRaw as LLMConfig['apiFormat']) || 'auto',
    // Embedding 配置（可选）
    embedApiKey: localStorage.getItem(STORAGE_KEYS.EMBED_API_KEY) || undefined,
    embedBaseUrl: localStorage.getItem(STORAGE_KEYS.EMBED_BASE_URL) || undefined,
    embedModel: localStorage.getItem(STORAGE_KEYS.EMBED_MODEL) || undefined,
  }
}

export function saveLLMConfig(config: Partial<LLMConfig>) {
  if (config.apiKey !== undefined) localStorage.setItem(STORAGE_KEYS.API_KEY, config.apiKey)
  if (config.baseUrl !== undefined) localStorage.setItem(STORAGE_KEYS.BASE_URL, config.baseUrl)
  if (config.model !== undefined) localStorage.setItem(STORAGE_KEYS.MODEL, config.model)
  // API 格式
  if (config.apiFormat !== undefined) {
    if (config.apiFormat && config.apiFormat !== 'auto') localStorage.setItem(STORAGE_KEYS.API_FORMAT, config.apiFormat)
    else localStorage.removeItem(STORAGE_KEYS.API_FORMAT)
  }
  // Embedding 配置
  if (config.embedApiKey !== undefined) {
    if (config.embedApiKey) localStorage.setItem(STORAGE_KEYS.EMBED_API_KEY, config.embedApiKey)
    else localStorage.removeItem(STORAGE_KEYS.EMBED_API_KEY)
  }
  if (config.embedBaseUrl !== undefined) {
    if (config.embedBaseUrl) localStorage.setItem(STORAGE_KEYS.EMBED_BASE_URL, config.embedBaseUrl)
    else localStorage.removeItem(STORAGE_KEYS.EMBED_BASE_URL)
  }
  if (config.embedModel !== undefined) {
    if (config.embedModel) localStorage.setItem(STORAGE_KEYS.EMBED_MODEL, config.embedModel)
    else localStorage.removeItem(STORAGE_KEYS.EMBED_MODEL)
  }
  
  // 同时保存到后端文件系统（跨端口/域名持久化）
  persistLLMConfigToServer(getLLMConfig())
}

export function isLLMConfigured(): boolean {
  const config = getLLMConfig()
  return !!(config.apiKey && config.baseUrl && config.model)
}

/**
 * 将LLM配置持久化到后端服务器
 * 用于解决不同端口访问时localStorage不共享的问题
 */
async function persistLLMConfigToServer(config: LLMConfig) {
  try {
    const serverUrl = localStorage.getItem('duncrew_server_url') || 'http://localhost:3001'
    await fetch(`${serverUrl}/data/llm_config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: config })
    })
  } catch (e) {
    // 静默失败，后端可能未运行
    console.debug('[LLM] Failed to persist config to server:', e)
  }
}

/**
 * 从后端服务器恢复LLM配置
 * 应在应用初始化时调用
 */
export async function restoreLLMConfigFromServer(): Promise<LLMConfig | null> {
  try {
    const serverUrl = localStorage.getItem('duncrew_server_url') || 'http://localhost:3001'
    const res = await fetch(`${serverUrl}/data/llm_config`)
    if (!res.ok) return null
    
    const data = await res.json()
    if (data.exists && data.value) {
      const config = data.value as LLMConfig
      // 恢复到localStorage
      if (config.apiKey) localStorage.setItem(STORAGE_KEYS.API_KEY, config.apiKey)
      if (config.baseUrl) localStorage.setItem(STORAGE_KEYS.BASE_URL, config.baseUrl)
      if (config.model) localStorage.setItem(STORAGE_KEYS.MODEL, config.model)
      if (config.apiFormat) localStorage.setItem(STORAGE_KEYS.API_FORMAT, config.apiFormat)
      console.log('[LLM] Config restored from server')
      return config
    }
  } catch (e) {
    console.debug('[LLM] Failed to restore config from server:', e)
  }
  return null
}

// ============================================
// API 请求
// ============================================

interface ChatCompletionRequest {
  [key: string]: unknown
  model: string
  messages: Array<{
    role: string
    content: string | null
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    tool_call_id?: string
    name?: string
  }>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  // Function Calling 参数
  tools?: Array<{ type: 'function'; function: FunctionDefinition }>
  tool_choice?: 'auto' | 'none' | 'required'
}

function buildUrl(baseUrl: string): string {
  // 确保 baseUrl 以 /chat/completions 结尾
  let url = baseUrl.replace(/\/+$/, '')
  if (!url.endsWith('/chat/completions')) {
    if (!url.endsWith('/v1')) {
      url += '/v1'
    }
    url += '/chat/completions'
  }
  return url
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  }
}

// ============================================
// Anthropic API 适配层
// ============================================

/** 根据配置解析实际使用的 API 协议格式 */
export function resolveApiFormat(config: LLMConfig): 'openai' | 'anthropic' {
  if (config.apiFormat === 'openai' || config.apiFormat === 'anthropic') {
    return config.apiFormat
  }
  // auto 或 undefined: 根据 URL 推断
  if (config.baseUrl && /anthropic/i.test(config.baseUrl)) {
    return 'anthropic'
  }
  return 'openai'
}

/** Anthropic 端点: /v1/messages */
function buildAnthropicUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '')
  if (!url.endsWith('/messages')) {
    if (!url.endsWith('/v1')) {
      url += '/v1'
    }
    url += '/messages'
  }
  return url
}

/** Anthropic 请求头: x-api-key + anthropic-version */
function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }
}

// --- Anthropic 请求体类型 ---

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

interface AnthropicConvertResult {
  system: string
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  tool_choice?: { type: string }
}

/**
 * 将内部 OpenAI 格式的消息/tools 转换为 Anthropic API 请求格式
 * 
 * 核心转换:
 * - system 消息提取为顶层 system 字段
 * - assistant + tool_calls → content 块数组 (text + tool_use)
 * - role:'tool' → role:'user' + tool_result 块 (连续 tool 消息合并)
 * - tools 参数格式转换
 * - Anthropic 要求消息严格交替 user/assistant
 */
function convertMessagesToAnthropic(
  messages: SimpleChatMessage[],
  tools?: Array<{ type: 'function'; function: FunctionDefinition }>,
  toolChoice?: 'auto' | 'none' | 'required',
): AnthropicConvertResult {
  // 1. 提取 system 消息
  const systemParts: string[] = []
  const nonSystemMessages = messages.filter(m => {
    if (m.role === 'system') {
      if (m.content) systemParts.push(m.content)
      return false
    }
    return true
  })

  // 2. 逐条转换，暂存 tool result
  const converted: AnthropicMessage[] = []
  let pendingToolResults: AnthropicContentBlock[] = []

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      converted.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
  }

  for (const msg of nonSystemMessages) {
    if (msg.role === 'tool') {
      // 暂存 tool result，等下次非 tool 消息时 flush
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || '',
        content: msg.content || '',
      })
      continue
    }

    // 遇到非 tool 消息，先 flush 暂存的 tool results
    flushToolResults()

    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // assistant + tool_calls → content 块数组
        const blocks: AnthropicContentBlock[] = []
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content })
        }
        for (const tc of msg.tool_calls) {
          let parsedInput: Record<string, unknown> = {}
          try { parsedInput = JSON.parse(tc.function.arguments) } catch { /* empty */ }
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          })
        }
        converted.push({ role: 'assistant', content: blocks })
      } else {
        converted.push({ role: 'assistant', content: msg.content || '' })
      }
    } else if (msg.role === 'user') {
      converted.push({ role: 'user', content: msg.content || '' })
    }
    // 其他未知 role 作为 user 处理
    else {
      converted.push({ role: 'user', content: msg.content || '' })
    }
  }

  // 尾部可能还有未 flush 的 tool results
  flushToolResults()

  // 3. 合并连续同角色消息 (Anthropic 要求严格交替)
  const merged: AnthropicMessage[] = []
  for (const msg of converted) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === msg.role) {
      // 合并 content
      const prevBlocks = typeof prev.content === 'string'
        ? [{ type: 'text' as const, text: prev.content }]
        : prev.content
      const curBlocks = typeof msg.content === 'string'
        ? [{ type: 'text' as const, text: msg.content }]
        : msg.content
      prev.content = [...prevBlocks, ...curBlocks]
    } else {
      merged.push(msg)
    }
  }

  // 4. tools 转换
  let anthropicTools: AnthropicTool[] | undefined
  if (tools && tools.length > 0) {
    anthropicTools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Record<string, unknown> | undefined,
    }))
  }

  // 5. tool_choice 转换
  let anthropicToolChoice: { type: string } | undefined
  if (toolChoice && anthropicTools) {
    if (toolChoice === 'auto') anthropicToolChoice = { type: 'auto' }
    else if (toolChoice === 'required') anthropicToolChoice = { type: 'any' }
    // 'none' → 不传 tool_choice
  }

  return {
    system: systemParts.join('\n'),
    messages: merged,
    tools: anthropicTools,
    tool_choice: anthropicToolChoice,
  }
}

/**
 * 将 Anthropic 非流式响应转换为内部 OpenAI 格式
 */
function convertAnthropicResponseToOpenAI(data: any): {
  content: string
  toolCalls: FCToolCall[]
  finishReason: string | null
} {
  const content = data.content
  let text = ''
  const toolCalls: FCToolCall[] = []

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        text += block.text || ''
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || '',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          },
        })
      }
    }
  }

  // stop_reason 映射
  let finishReason: string | null = null
  if (data.stop_reason === 'end_turn') finishReason = 'stop'
  else if (data.stop_reason === 'tool_use') finishReason = 'tool_calls'
  else if (data.stop_reason) finishReason = data.stop_reason

  return { content: text, toolCalls, finishReason }
}

/**
 * 非流式调用 (支持 Function Calling + Anthropic 适配)
 */
export async function chat(
  messages: SimpleChatMessage[],
  config?: Partial<LLMConfig>,
  tools?: Array<{ type: 'function'; function: FunctionDefinition }>,
): Promise<string> {
  const cfg = { ...getLLMConfig(), ...config }
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    throw new Error('LLM 未配置，请在设置中配置 API')
  }

  const format = resolveApiFormat(cfg as LLMConfig)
  const localServer = getLocalServerUrl()
  const proxyUrl = `${localServer}/api/llm/proxy`

  let targetUrl: string
  let headers: Record<string, string>
  let requestBody: Record<string, unknown>

  if (format === 'anthropic') {
    // --- Anthropic 格式 ---
    targetUrl = buildAnthropicUrl(cfg.baseUrl)
    headers = buildAnthropicHeaders(cfg.apiKey)
    const converted = convertMessagesToAnthropic(
      messages,
      tools && tools.length > 0 ? tools : undefined,
      tools && tools.length > 0 ? 'auto' : undefined,
    )
    requestBody = {
      model: cfg.model,
      max_tokens: 16384,
      stream: false,
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages,
      ...(converted.tools ? { tools: converted.tools } : {}),
      ...(converted.tool_choice ? { tool_choice: converted.tool_choice } : {}),
    }
  } else {
    // --- OpenAI 格式 (原有逻辑) ---
    targetUrl = buildUrl(cfg.baseUrl)
    headers = buildHeaders(cfg.apiKey)
    const body: ChatCompletionRequest = {
      model: cfg.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      stream: false,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    requestBody = body
  }

  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      headers,
      apiKey: cfg.apiKey,
      body: requestBody,
      stream: false,
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`LLM API 错误 (${res.status}): ${errText}`)
  }

  const data = await res.json()

  if (format === 'anthropic') {
    const result = convertAnthropicResponseToOpenAI(data)
    return result.content
  }

  return data.choices?.[0]?.message?.content || ''
}

/**
 * 流式调用 (SSE) - 支持 Function Calling + Anthropic 适配
 * 
 * 当传入 tools 参数时，返回 LLMStreamResult 包含 toolCalls;
 * 未传 tools 时行为与旧版一致 (toolCalls 为空数组)。
 */
export async function streamChat(
  messages: SimpleChatMessage[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  config?: Partial<LLMConfig>,
  tools?: Array<{ type: 'function'; function: FunctionDefinition }>,
): Promise<LLMStreamResult> {
  const cfg = { ...getLLMConfig(), ...config }
  if (!cfg.apiKey || !cfg.baseUrl || !cfg.model) {
    throw new Error('LLM 未配置，请在设置中配置 API')
  }

  const format = resolveApiFormat(cfg as LLMConfig)
  const localServer = getLocalServerUrl()
  const proxyUrl = `${localServer}/api/llm/proxy`

  let targetUrl: string
  let headers: Record<string, string>
  let requestBody: Record<string, unknown>

  if (format === 'anthropic') {
    // --- Anthropic 格式 ---
    targetUrl = buildAnthropicUrl(cfg.baseUrl)
    headers = buildAnthropicHeaders(cfg.apiKey)
    const converted = convertMessagesToAnthropic(
      messages,
      tools && tools.length > 0 ? tools : undefined,
      tools && tools.length > 0 ? 'auto' : undefined,
    )
    requestBody = {
      model: cfg.model,
      max_tokens: 16384,
      stream: true,
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages,
      ...(converted.tools ? { tools: converted.tools } : {}),
      ...(converted.tool_choice ? { tool_choice: converted.tool_choice } : {}),
    }
  } else {
    // --- OpenAI 格式 (原有逻辑) ---
    targetUrl = buildUrl(cfg.baseUrl)
    headers = buildHeaders(cfg.apiKey)
    const body: ChatCompletionRequest = {
      model: cfg.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        ...(m.name ? { name: m.name } : {}),
        // DeepSeek 思维模式: 必须传递 reasoning_content
        ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      })),
      stream: true,
    }
    if (tools && tools.length > 0) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    requestBody = body
  }

  const res = await fetch(proxyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: targetUrl,
      headers,
      apiKey: cfg.apiKey,
      body: requestBody,
      stream: true,
    }),
    signal,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`LLM API 错误 (${res.status}): ${errText}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('无法读取响应流')

  const decoder = new TextDecoder()
  let buffer = ''

  // 累积结果 (两种格式共享)
  let fullContent = ''
  let fullReasoningContent = ''  // DeepSeek 思维模式推理内容
  let finishReason: string | null = null
  // tool_calls 累积器: index → { id, name, arguments }
  const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map()

  /** 构建最终结果的辅助函数 */
  const buildResult = (): LLMStreamResult => {
    const toolCalls: FCToolCall[] = []
    for (const [, acc] of toolCallAccumulator) {
      toolCalls.push({
        id: acc.id,
        function: { name: acc.name, arguments: acc.arguments },
      })
    }
    return {
      content: fullContent,
      toolCalls,
      finishReason,
      reasoningContent: fullReasoningContent || undefined,
    }
  }

  try {
    if (format === 'anthropic') {
      // ==========================================
      // Anthropic SSE 解析
      // 事件结构: event: xxx\ndata: {...}\n\n
      // ==========================================
      // Anthropic content_block 到 toolCallAccumulator 的 index 映射
      // content_block_start 中 type=tool_use 的 index 对应 toolCallAccumulator 的 key
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          // 跳过 event: 行和空行，只处理 data: 行
          if (!trimmed || trimmed.startsWith('event:')) continue
          if (!trimmed.startsWith('data:')) continue

          const dataStr = trimmed.slice(5).trim()
          if (!dataStr) continue

          try {
            const parsed = JSON.parse(dataStr)
            const eventType = parsed.type as string

            if (eventType === 'content_block_start') {
              // 工具调用开始: 记录 id 和 name
              const block = parsed.content_block
              if (block?.type === 'tool_use') {
                const idx = parsed.index ?? toolCallAccumulator.size
                toolCallAccumulator.set(idx, {
                  id: block.id || '',
                  name: block.name || '',
                  arguments: '',
                })
              }
            } else if (eventType === 'content_block_delta') {
              const delta = parsed.delta
              if (delta?.type === 'text_delta' && delta.text) {
                // 文本增量
                fullContent += delta.text
                onChunk(delta.text)
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                // 工具参数增量
                const idx = parsed.index ?? 0
                const acc = toolCallAccumulator.get(idx)
                if (acc) {
                  acc.arguments += delta.partial_json
                }
              }
            } else if (eventType === 'message_delta') {
              // 消息结束信息
              const stopReason = parsed.delta?.stop_reason
              if (stopReason === 'end_turn') finishReason = 'stop'
              else if (stopReason === 'tool_use') finishReason = 'tool_calls'
              else if (stopReason) finishReason = stopReason
            } else if (eventType === 'message_stop') {
              // 流结束
              return buildResult()
            }
          } catch {
            // 忽略解析错误
          }
        }
      }
    } else {
      // ==========================================
      // OpenAI SSE 解析 (原有逻辑)
      // ==========================================
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const data = trimmed.slice(5).trim()
          if (data === '[DONE]') {
            return buildResult()
          }

          try {
            const parsed = JSON.parse(data)
            const choice = parsed.choices?.[0]

            if (choice?.finish_reason) {
              finishReason = choice.finish_reason
            }

            const delta = choice?.delta
            if (!delta) continue

            if (delta.content) {
              fullContent += delta.content
              onChunk(delta.content)
            }

            if (delta.reasoning_content) {
              fullReasoningContent += delta.reasoning_content
            }

            if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls as ToolCallDelta[]) {
                const idx = tc.index
                if (!toolCallAccumulator.has(idx)) {
                  toolCallAccumulator.set(idx, { id: '', name: '', arguments: '' })
                }
                const acc = toolCallAccumulator.get(idx)!
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.name += tc.function.name
                if (tc.function?.arguments) acc.arguments += tc.function.arguments
              }
            }
          } catch {
            // 忽略解析错误，继续处理
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  // 流结束但没收到结束标记，也返回已累积的结果
  return buildResult()
}

/**
 * 测试连接
 */
export async function testConnection(config?: Partial<LLMConfig>): Promise<boolean> {
  const cfg = { ...getLLMConfig(), ...config }
  const testMessages: SimpleChatMessage[] = [
    { role: 'user', content: '请回复 OK' },
  ]
  
  try {
    const reply = await chat(testMessages, cfg)
    return reply.length > 0
  } catch {
    return false
  }
}

// ============================================
// P4: Embedding API
// ============================================

/**
 * 构建 embedding 端点 URL
 * OpenAI 兼容格式: /v1/embeddings
 */
function buildEmbeddingUrl(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '')
  // 移除可能存在的 /chat/completions 后缀
  url = url.replace(/\/chat\/completions$/, '').replace(/\/v1$/, '')
  return url + '/v1/embeddings'
}

/**
 * 生成文本嵌入向量
 * 
 * 优先级：
 * 1. 独立的 Embedding API 配置
 * 2. 主 LLM API（如果支持 /embeddings）
 * 3. 本地 TF-IDF 嵌入（无需外部 API）
 * 
 * @param text 要嵌入的文本
 * @param config 可选的配置覆盖
 * @param useLocalFallback 是否启用本地嵌入回退（默认 true）
 * @returns 嵌入向量 (float[])
 */
// Embed API 可用性缓存: 记录哪些 baseUrl 不支持 embeddings，避免重复 400/404
let _embedUnsupportedProviders: Set<string> = new Set()

export async function embed(
  text: string,
  config?: Partial<LLMConfig>,
  useLocalFallback = true
): Promise<number[]> {
  const fullCfg = { ...getLLMConfig(), ...config }
  
  // 优先使用独立的 Embedding 配置
  const apiKey = fullCfg.embedApiKey || fullCfg.apiKey
  const baseUrl = fullCfg.embedBaseUrl || fullCfg.baseUrl
  const model = fullCfg.embedModel || 'text-embedding-3-small'
  
  // 如果没有配置 API，直接使用本地嵌入
  if (!apiKey || !baseUrl) {
    if (useLocalFallback) {
      return localEmbed(text)
    }
    console.warn('[Embed] API not configured, skipping embedding')
    return []
  }

  // 如果该 provider 已知不支持 embeddings，直接跳过 API 调用
  if (_embedUnsupportedProviders.has(baseUrl)) {
    return useLocalFallback ? localEmbed(text) : []
  }

  try {
    const res = await fetch(buildEmbeddingUrl(baseUrl), {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        model,
        input: text,
      }),
    })

    if (!res.ok) {
      // 400/404 表示该 provider 不支持 embeddings 端点，缓存避免重复请求
      if (res.status === 400 || res.status === 404) {
        _embedUnsupportedProviders.add(baseUrl)
        console.warn(`[Embed] Provider ${baseUrl} does not support embeddings (${res.status}), permanently falling back to local TF-IDF`)
      } else {
        console.warn(`[Embed] API error (${res.status}), using local TF-IDF fallback`)
      }
      return useLocalFallback ? localEmbed(text) : []
    }

    const data = await res.json()
    return data.data?.[0]?.embedding || (useLocalFallback ? localEmbed(text) : [])
  } catch (err) {
    console.warn('[Embed] Request failed, using local TF-IDF fallback:', err)
    return useLocalFallback ? localEmbed(text) : []
  }
}

// ============================================
// 本地 TF-IDF 嵌入（无需外部 API）
// ============================================

// 全局词汇表（运行时构建）
let globalVocab: Map<string, number> = new Map()
let vocabSize = 0
const MAX_VOCAB_SIZE = 2000 // 限制词汇表大小

/**
 * 简单分词：支持中英文
 */
function tokenize(text: string): string[] {
  // 转小写，移除标点
  const cleaned = text.toLowerCase().replace(/[^\w\u4e00-\u9fff\s]/g, ' ')
  // 英文按空格分，中文按字符分
  const tokens: string[] = []
  for (const part of cleaned.split(/\s+/)) {
    if (!part) continue
    // 检测是否包含中文
    if (/[\u4e00-\u9fff]/.test(part)) {
      // 中文按字/词分割（简单按字）
      tokens.push(...part.split(''))
    } else if (part.length > 1) {
      tokens.push(part)
    }
  }
  return tokens
}

/**
 * 计算词频 (TF)
 */
function computeTF(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1)
  }
  // 归一化
  const maxFreq = Math.max(...tf.values(), 1)
  for (const [word, freq] of tf) {
    tf.set(word, freq / maxFreq)
  }
  return tf
}

/**
 * 本地 TF-IDF 嵌入
 * 返回固定长度的向量（基于词汇表索引的稀疏向量）
 */
export function localEmbed(text: string): number[] {
  const tokens = tokenize(text)
  const tf = computeTF(tokens)
  
  // 更新全局词汇表
  for (const token of tokens) {
    if (!globalVocab.has(token) && vocabSize < MAX_VOCAB_SIZE) {
      globalVocab.set(token, vocabSize++)
    }
  }
  
  // 生成向量
  const vector = new Array(MAX_VOCAB_SIZE).fill(0)
  for (const [word, score] of tf) {
    const idx = globalVocab.get(word)
    if (idx !== undefined) {
      vector[idx] = score
    }
  }
  
  return vector
}

/**
 * 重置本地词汇表（可选，用于重新构建索引）
 */
export function resetLocalVocab(): void {
  globalVocab = new Map()
  vocabSize = 0
}

// ============================================
// 向量相似度计算
// ============================================

/**
 * 计算两个向量的余弦相似度
 * @returns -1 到 1 之间的值，1 表示完全相似
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

// ============================================
// ToolInfo → OpenAI Function Schema 转换
// ============================================

/**
 * 将 DunCrew ToolInfo 转换为 OpenAI Function Calling 的 tools 参数格式
 */
export function convertToolInfoToFunctions(
  tools: ToolInfo[]
): Array<{ type: 'function'; function: FunctionDefinition }> {
  return tools
    .filter(t => {
      // 排除没有 description 的 instruction skill (无法被 LLM 正确使用)
      if (t.type === 'instruction' && !t.description) return false
      return true
    })
    .map(t => ({
      type: 'function' as const,
      function: toolInfoToFunctionDef(t),
    }))
}

/**
 * 单个 ToolInfo → FunctionDefinition
 */
function toolInfoToFunctionDef(tool: ToolInfo): FunctionDefinition {
  const def: FunctionDefinition = {
    name: tool.name,
    description: tool.description || tool.name,
  }

  // 将 ToolInfo.inputs 转换为 JSON Schema parameters
  if (tool.inputs && Object.keys(tool.inputs).length > 0) {
    const properties: Record<string, any> = {}
    const required: string[] = []

    for (const [key, schema] of Object.entries(tool.inputs)) {
      if (typeof schema === 'object' && schema !== null) {
        // 已经是 JSON Schema 格式 (如 { type: 'string', description: '...', required: true })
        const { required: isRequired, ...rest } = schema
        properties[key] = rest
        // 确保有 type 字段
        if (!properties[key].type) {
          properties[key].type = 'string'
        }
        if (isRequired) {
          required.push(key)
        }
      } else {
        // 简单值，推断为 string
        properties[key] = { type: 'string', description: String(schema) }
      }
    }

    def.parameters = {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  } else {
    // 无参数的工具
    def.parameters = { type: 'object', properties: {} }
  }

  return def
}

