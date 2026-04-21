/**
 * LinkStationSlice - 联络站状态管理
 *
 * 职责：
 * 1. 管理所有 AI 模型 Provider 和通道绑定
 * 2. 管理 MCP 服务器连接
 * 3. 提供 getActiveChatConfig() 等快捷方法供 llmService 消费
 * 4. 持久化到 data/link_station.json（SSoT）
 */

import type { StateCreator } from 'zustand'
import type {
  LLMConfig,
  ModelProvider,
  ChannelBindings,
  ModelBinding,
  LinkStationState,
  LinkStationSheet,
  MCPServerEntry,
  MCPServerStatus,
  MCPToolEntry,
  ProviderGuide,
  ApiProtocol,
} from '@/types'
import { getServerUrl } from '@/utils/env'

// ProviderRegion 仅在 PROVIDER_GUIDES 中使用，无需从 types 导入

// ============================================
// 持久化 Key
// ============================================

const PERSIST_KEY = 'link_station'
const LOCAL_CACHE_KEY = 'duncrew_link_station_cache'

// 防抖保存 timer（减少网络请求频率）
let _saveLinkStationTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 核心保存逻辑（被 saveLinkStation 防抖调用 和 forceSaveAll 直接调用共享）
 * 1. POST /data/link_station
 * 2. 同步主对话配置到 llm_config.json
 * 3. 写 mcp-servers.json + reload MCP
 */
async function _executeLinkStationSave(
  payload: { providers: ModelProvider[]; channelBindings: ChannelBindings; mcpServers: MCPServerEntry[] },
  getState: () => any,
) {
  const currentServerUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()

  // 1. 保存通用配置到 /data/link_station
  await fetch(`${currentServerUrl}/data/${PERSIST_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: payload }),
  })

  // 2. 同步主对话配置到 llm_config.json（根本修复：防止旧配置残留）
  const chatConfig = buildLLMConfigFromBinding(payload.providers, payload.channelBindings.chat)
  if (chatConfig) {
    const { saveLLMConfig } = await import('@/services/llmService')
    saveLLMConfig(chatConfig)
  }

  // 3. 同步 MCP 配置到后端 mcp-servers.json
  const mcpServersConfig: Record<string, Record<string, unknown>> = {}
  for (const server of payload.mcpServers) {
    const serverConfig: Record<string, unknown> = {
      command: server.command,
      args: server.args,
      enabled: server.enabled,
    }
    if (server.env && Object.keys(server.env).length > 0) {
      serverConfig.env = server.env
    }
    if (server.transportType === 'sse' && server.url) {
      serverConfig.transportType = 'sse'
      serverConfig.url = server.url
    }
    if (server.timeout) {
      serverConfig.timeout = server.timeout
    }
    mcpServersConfig[server.name] = serverConfig
  }

  const mcpConfigPath = 'mcp-servers.json'
  if (mcpConfigPath.includes('..') || mcpConfigPath.startsWith('/')) {
    console.error('[LinkStation] Invalid mcp-servers.json path')
    return
  }

  const writeRes = await fetch(`${currentServerUrl}/api/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'writeFile',
      args: {
        path: mcpConfigPath,
        content: JSON.stringify({ servers: mcpServersConfig }, null, 2),
      },
    }),
  })
  if (!writeRes.ok) {
    console.error('[LinkStation] Failed to write mcp-servers.json, skipping reload')
    return
  }
  const writeData = await writeRes.json()
  if (writeData.status === 'error') {
    console.error('[LinkStation] writeFile error:', writeData.error || writeData.result)
    return
  }

  // 4. 触发后端 MCP reload
  const reloadRes = await fetch(`${currentServerUrl}/mcp/reload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })

  if (reloadRes.ok) {
    const reloadData = await reloadRes.json()
    console.log('[LinkStation] MCP reloaded:', reloadData.message)

    const statusRes = await fetch(`${currentServerUrl}/mcp/servers`)
    if (statusRes.ok) {
      const statusData = await statusRes.json()
      const serverStatus = statusData.servers || {}

      for (const [serverName, info] of Object.entries(serverStatus)) {
        const serverInfo = info as { connected: boolean; tools: number }
        getState().updateMCPStatus(
          serverName,
          serverInfo.connected ? 'connected' : 'disconnected'
        )
      }

      if (statusData.tools && Array.isArray(statusData.tools)) {
        getState().setMCPTools(
          statusData.tools.map((tool: Record<string, unknown>) => ({
            name: tool.name as string,
            serverName: tool.server as string,
            description: (tool.description as string) || '',
          }))
        )
      }
    }
  }

  // 5. 通知 LocalClawService 刷新工具列表
  try {
    const { localClawService } = await import('@/services/LocalClawService')
    await localClawService.refreshTools()
  } catch (refreshError) {
    console.debug('[LinkStation] Failed to refresh tools after MCP reload:', refreshError)
  }

  console.log('[LinkStation] Config saved & synced')
}

// MCP 状态轮询 timer
let _mcpPollingTimer: ReturnType<typeof setInterval> | null = null

// ============================================
// 旧版 localStorage Keys（用于迁移）
// ============================================

const LEGACY_STORAGE_KEYS = {
  API_KEY: 'duncrew_llm_api_key',
  BASE_URL: 'duncrew_llm_base_url',
  MODEL: 'duncrew_llm_model',
  API_FORMAT: 'duncrew_llm_api_format',
  EMBED_API_KEY: 'duncrew_embed_api_key',
  EMBED_BASE_URL: 'duncrew_embed_base_url',
  EMBED_MODEL: 'duncrew_embed_model',
} as const

// ============================================
// Provider 注册引导配置
// ============================================

export const PROVIDER_GUIDES: Record<string, ProviderGuide> = {
  qwen: {
    label: '通义千问',
    tagline: '⭐ 推荐首选',
    icon: '🔮',
    region: 'domestic',
    signupUrl: 'https://dashscope.console.aliyun.com',
    apiKeyPageUrl: 'https://dashscope.console.aliyun.com/apiKey',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiProtocol: 'openai',
    steps: [
      '访问阿里云百炼平台 dashscope.console.aliyun.com',
      '使用支付宝/淘宝/手机号注册登录',
      '进入「API-KEY 管理」页面，点击「创建新的 API-KEY」',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '新用户赠送大量免费 Token，国内直连速度快，模型种类最全',
    recommendedModel: 'qwen-max',
  },
  deepseek: {
    label: 'DeepSeek',
    tagline: '深度推理',
    icon: '🧠',
    region: 'domestic',
    signupUrl: 'https://platform.deepseek.com',
    apiKeyPageUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 DeepSeek 开放平台 platform.deepseek.com',
      '使用手机号注册/登录',
      '进入「API Keys」页面，点击「创建 API Key」',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '新用户注册即送免费额度，deepseek-chat 性价比极高',
    recommendedModel: 'deepseek-chat',
  },
  kimi: {
    label: 'Kimi',
    tagline: '长文本强',
    icon: '🌙',
    region: 'domestic',
    signupUrl: 'https://platform.moonshot.cn',
    apiKeyPageUrl: 'https://platform.moonshot.cn/console/api-keys',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Moonshot 开放平台 platform.moonshot.cn',
      '使用手机号注册/登录',
      '进入「API Key 管理」页面',
      '点击「新建」，复制粘贴到下方',
    ],
    tip: '国内直连，无需代理，支持 128K 超长上下文',
    recommendedModel: 'moonshot-v1-128k',
  },
  minimax: {
    label: 'MiniMax',
    tagline: '语音多模态',
    icon: '🎵',
    region: 'domestic',
    signupUrl: 'https://platform.minimaxi.com',
    apiKeyPageUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
    baseUrl: 'https://api.minimax.chat/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 MiniMax 开放平台 platform.minimaxi.com',
      '使用手机号注册/登录',
      '进入「用户中心 → 接口密钥」页面',
      '点击「创建新的密钥」，复制粘贴到下方',
    ],
    tip: '语音合成和多模态能力突出，新用户有免费额度',
    recommendedModel: 'MiniMax-Text-01',
    imageGenProfile: {
      endpoint: 'v1/image_generation',
      sizeMode: 'ratio',
      responseFormat: 'url',
      responseLayout: 'wrapped',
    },
  },
  ollama: {
    label: 'Ollama',
    tagline: '本地部署',
    icon: '🦙',
    region: 'local',
    signupUrl: 'https://ollama.com/download',
    apiKeyPageUrl: '',
    baseUrl: 'http://localhost:11434/v1',
    apiProtocol: 'openai',
    steps: [
      '下载并安装 Ollama：ollama.com/download',
      '打开终端，运行 ollama pull qwen2.5 下载模型',
      '运行 ollama serve 启动服务',
      'API Key 留空即可（本地不需要认证）',
    ],
    tip: '完全免费，数据不出本地，需要较好的 GPU',
    recommendedModel: 'qwen2.5',
  },
  openai: {
    label: 'OpenAI',
    tagline: '功能最全',
    icon: '🤖',
    region: 'overseas',
    signupUrl: 'https://platform.openai.com/signup',
    apiKeyPageUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 OpenAI 平台 platform.openai.com',
      '注册/登录账号（需要海外手机号验证）',
      '进入「API Keys」页面，点击「Create new secret key」',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '⚠️ 需要海外手机号注册 + 绑定信用卡，国内可能需要代理访问',
    recommendedModel: 'gpt-4o',
  },
  anthropic: {
    label: 'Claude',
    tagline: '推理最强',
    icon: '🧩',
    region: 'overseas',
    signupUrl: 'https://console.anthropic.com',
    apiKeyPageUrl: 'https://console.anthropic.com/settings/keys',
    baseUrl: 'https://api.anthropic.com',
    apiProtocol: 'anthropic',
    steps: [
      '访问 Anthropic 控制台 console.anthropic.com',
      '注册/登录账号（需要海外手机号验证）',
      '进入「Settings → API Keys」页面',
      '点击「Create Key」，复制粘贴到下方',
    ],
    tip: '⚠️ 需要海外手机号注册，国内可能需要代理访问',
    recommendedModel: 'claude-sonnet-4-20250514',
  },
  // ── 海外 Provider ──
  google: {
    label: 'Google Gemini',
    tagline: '多模态旗舰',
    icon: '💎',
    region: 'overseas',
    signupUrl: 'https://aistudio.google.com',
    apiKeyPageUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiProtocol: 'openai',
    steps: [
      '访问 Google AI Studio aistudio.google.com',
      '使用 Google 账号登录',
      '点击「Get API Key」创建密钥',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '⚠️ 需要海外网络访问，Gemini 2.5 Pro 多模态能力极强',
    recommendedModel: 'gemini-2.5-pro',
  },
  groq: {
    label: 'Groq',
    tagline: '极速推理',
    icon: '⚡',
    region: 'overseas',
    signupUrl: 'https://console.groq.com',
    apiKeyPageUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Groq 控制台 console.groq.com',
      '使用 Google/GitHub 账号注册登录',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '基于 LPU 硬件的超快推理，免费额度慷慨，延迟极低',
    recommendedModel: 'llama-3.3-70b-versatile',
  },
  mistral: {
    label: 'Mistral',
    tagline: '欧洲开源',
    icon: '🌊',
    region: 'overseas',
    signupUrl: 'https://console.mistral.ai',
    apiKeyPageUrl: 'https://console.mistral.ai/api-keys',
    baseUrl: 'https://api.mistral.ai/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Mistral 控制台 console.mistral.ai',
      '注册/登录账号',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '欧洲 AI 领军，Mistral Large 推理能力出色',
    recommendedModel: 'mistral-large-latest',
  },
  xai: {
    label: 'xAI (Grok)',
    tagline: '实时联网',
    icon: '🚀',
    region: 'overseas',
    signupUrl: 'https://console.x.ai',
    apiKeyPageUrl: 'https://console.x.ai/team/default/api-keys',
    baseUrl: 'https://api.x.ai/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 xAI 控制台 console.x.ai',
      '注册/登录账号',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '⚠️ 需要海外网络，Grok 具备实时联网搜索能力',
    recommendedModel: 'grok-4',
  },
  nvidia: {
    label: 'NVIDIA',
    tagline: 'Nemotron 推理',
    icon: '🟢',
    region: 'overseas',
    signupUrl: 'https://catalog.ngc.nvidia.com',
    apiKeyPageUrl: 'https://catalog.ngc.nvidia.com',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 NVIDIA NGC catalog.ngc.nvidia.com',
      '注册/登录 NVIDIA 账号',
      '创建 API Key（格式 nvapi-...）',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: 'NVIDIA 官方推理 API，Nemotron 系列模型性能强劲',
    recommendedModel: 'nvidia/llama-3.1-nemotron-70b-instruct',
  },
  huggingface: {
    label: 'Hugging Face',
    tagline: '开源模型聚合',
    icon: '🤗',
    region: 'overseas',
    signupUrl: 'https://huggingface.co/settings/tokens',
    apiKeyPageUrl: 'https://huggingface.co/settings/tokens/new?ownUserPermissions=inference.serverless.write&tokenType=fineGrained',
    baseUrl: 'https://router.huggingface.co/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Hugging Face huggingface.co',
      '注册/登录账号',
      '进入 Settings → Tokens，创建 Fine-grained Token',
      '勾选「Make calls to Inference Providers」权限，复制粘贴到下方',
    ],
    tip: '一个 Token 访问多种开源模型，有免费额度',
    recommendedModel: 'deepseek-ai/DeepSeek-R1',
  },
  together: {
    label: 'Together AI',
    tagline: '开源模型云',
    icon: '🤝',
    region: 'overseas',
    signupUrl: 'https://api.together.ai',
    apiKeyPageUrl: 'https://api.together.ai/settings/api-keys',
    baseUrl: 'https://api.together.ai/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Together AI api.together.ai',
      '注册/登录账号',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '支持 Llama、DeepSeek、Kimi 等主流开源模型',
    recommendedModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  bedrock: {
    label: 'Amazon Bedrock',
    tagline: 'AWS 云模型',
    icon: '🏔️',
    region: 'overseas',
    signupUrl: 'https://console.aws.amazon.com/bedrock',
    apiKeyPageUrl: '',
    baseUrl: '',
    apiProtocol: 'openai',
    steps: [
      '登录 AWS 控制台，开通 Bedrock 服务',
      '配置 IAM 用户并获取 Access Key',
      '设置环境变量 AWS_ACCESS_KEY_ID 和 AWS_SECRET_ACCESS_KEY',
      '在 Base URL 填写 Bedrock 兼容端点',
    ],
    tip: '⚠️ 使用 AWS 凭证认证，需要有 AWS 账号和 Bedrock 权限',
    recommendedModel: 'anthropic.claude-sonnet-4-20250514-v1:0',
  },

  // ── 代理 / 聚合 ──
  openrouter: {
    label: 'OpenRouter',
    tagline: '一键多模型',
    icon: '🔀',
    region: 'overseas',
    signupUrl: 'https://openrouter.ai',
    apiKeyPageUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 OpenRouter openrouter.ai',
      '使用 Google/GitHub 账号注册登录',
      '进入「Keys」页面，创建新 API Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '一个 Key 访问所有主流模型（Claude/GPT/Gemini/Llama 等），按量计费',
    recommendedModel: 'anthropic/claude-sonnet-4-20250514',
  },
  venice: {
    label: 'Venice AI',
    tagline: '隐私优先',
    icon: '🎭',
    region: 'overseas',
    signupUrl: 'https://venice.ai',
    apiKeyPageUrl: 'https://venice.ai/settings/api',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiProtocol: 'openai',
    steps: [
      '访问 Venice AI venice.ai',
      '注册/登录账号',
      '进入 Settings → API，创建 API Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '隐私推理，不记录不训练，支持无审查模型',
    recommendedModel: 'llama-3.3-70b',
  },

  // ── 国内 Provider ──
  zai: {
    label: '智谱 Z.AI',
    tagline: 'GLM 系列',
    icon: '🔬',
    region: 'domestic',
    signupUrl: 'https://open.bigmodel.cn',
    apiKeyPageUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiProtocol: 'openai',
    steps: [
      '访问智谱开放平台 open.bigmodel.cn',
      '使用手机号注册/登录',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '国内直连，GLM-5 推理能力强，新用户有免费额度',
    recommendedModel: 'glm-5',
  },
  qianfan: {
    label: '百度千帆',
    tagline: '文心一言',
    icon: '🌤️',
    region: 'domestic',
    signupUrl: 'https://console.bce.baidu.com/qianfan',
    apiKeyPageUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apiKey',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    apiProtocol: 'openai',
    steps: [
      '访问百度千帆控制台 console.bce.baidu.com/qianfan',
      '使用百度账号注册/登录',
      '进入「API Key」页面，创建应用并获取 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '国内直连，支持文心大模型和多种第三方模型',
    recommendedModel: 'ernie-4.5-8k',
  },
  volcengine: {
    label: '火山引擎',
    tagline: '字节豆包',
    icon: '🌋',
    region: 'domestic',
    signupUrl: 'https://console.volcengine.com/ark',
    apiKeyPageUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiProtocol: 'openai',
    steps: [
      '访问火山引擎方舟平台 console.volcengine.com/ark',
      '使用手机号注册/登录',
      '进入「API Key 管理」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '字节跳动旗下，豆包模型国内直连，速度快',
    recommendedModel: 'doubao-pro-32k',
  },
  xiaomi: {
    label: '小米 MiMo',
    tagline: '推理新秀',
    icon: '📱',
    region: 'domestic',
    signupUrl: 'https://platform.xiaomimimo.com',
    apiKeyPageUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiProtocol: 'openai',
    steps: [
      '访问小米 MiMo 平台 platform.xiaomimimo.com',
      '使用手机号注册/登录',
      '进入「API Keys」页面，创建新 Key',
      '复制生成的 Key，粘贴到下方',
    ],
    tip: '小米自研推理模型，MiMo-v2-Pro 百万级上下文',
    recommendedModel: 'mimo-v2-flash',
  },

  // ── 本地部署 ──
  lmstudio: {
    label: 'LM Studio',
    tagline: '本地图形化',
    icon: '🖥️',
    region: 'local',
    signupUrl: 'https://lmstudio.ai',
    apiKeyPageUrl: '',
    baseUrl: 'http://localhost:1234/v1',
    apiProtocol: 'openai',
    steps: [
      '下载并安装 LM Studio：lmstudio.ai',
      '在应用内搜索并下载模型（如 Qwen2.5）',
      '点击「Start Server」启动本地服务',
      'API Key 留空即可（本地不需要认证）',
    ],
    tip: '图形化界面管理本地模型，一键下载和运行',
    recommendedModel: '',
  },

  // ── 自定义 ──
  custom: {
    label: '自定义',
    tagline: '其他 API / 代理',
    icon: '⚙️',
    region: 'any',
    signupUrl: '',
    apiKeyPageUrl: '',
    baseUrl: '',
    apiProtocol: 'auto',
    steps: [
      '填写 API 服务的 Base URL（如 https://your-proxy.com/v1）',
      '填写 API Key',
      '选择 API 协议（OpenAI 兼容 / Anthropic / 自动检测）',
      '点击「测试连接」验证配置',
    ],
    tip: '支持任何 OpenAI 兼容的 API 代理，适合使用中转站的用户',
    recommendedModel: '',
  },
}

// ============================================
// 默认状态
// ============================================

/** 将联络站配置写入 localStorage 缓存（后端不可用时的备份） */
function saveToLocalCache(data: Partial<LinkStationState>) {
  try {
    localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(data))
  } catch {
    // localStorage 满了或不可用，静默忽略
  }
}

function createDefaultChannelBindings(): ChannelBindings {
  return {
    chat: null,
    chatSecondary: null,
    embed: null,
    imageGen: null,
    videoGen: null,
    search: null,
  }
}

function createDefaultState(): LinkStationState {
  return {
    activeSheet: 'model-channel',
    providers: [],
    channelBindings: createDefaultChannelBindings(),
    mcpServers: [],
    mcpStatus: {},
    mcpTools: [],
  }
}

// ============================================
// Slice 接口
// ============================================

export interface LinkStationSlice {
  linkStation: LinkStationState

  // Sheet 切换
  setActiveSheet: (sheet: LinkStationSheet) => void

  // === 模型通道 ===
  addProvider: (provider: ModelProvider) => void
  updateProvider: (id: string, patch: Partial<ModelProvider>) => void
  removeProvider: (id: string) => void
  setChannelBinding: (channel: keyof ChannelBindings, binding: ModelBinding | null) => void

  // 快捷方法：供 llmService / AiSlice 消费
  getActiveChatConfig: () => LLMConfig | null
  getActiveSecondaryChatConfig: () => LLMConfig | null
  getActiveEmbedConfig: () => { apiKey: string; baseUrl: string; model: string } | null
  /** 通用通道配置读取（供 llmService.injectStoreConfigReader 注入） */
  getChannelConfig: (channel: string) => LLMConfig | null

  // === MCP 服务 ===
  setMCPServers: (servers: MCPServerEntry[]) => void
  updateMCPStatus: (name: string, status: MCPServerStatus) => void
  setMCPTools: (tools: MCPToolEntry[]) => void
  toggleMCPServer: (name: string, enabled: boolean) => void
  addMCPServer: (server: MCPServerEntry) => void
  updateMCPServer: (name: string, patch: Partial<MCPServerEntry>) => void
  removeMCPServer: (name: string) => void

  // 持久化
  loadLinkStation: () => Promise<void>
  saveLinkStation: () => Promise<void>
  /** 跳过防抖，立即全量保存（含 MCP reload + llm_config 同步） */
  forceSaveAll: () => Promise<{ success: boolean; error?: string }>

  // MCP 状态轮询
  startMCPStatusPolling: () => void
  stopMCPStatusPolling: () => void

  // 迁移
  migrateFromLegacyConfig: () => void
}

// ============================================
// 辅助函数
// ============================================

/** 从 Provider + ModelBinding 构建 LLMConfig */
function buildLLMConfigFromBinding(
  providers: ModelProvider[],
  binding: ModelBinding | null,
): LLMConfig | null {
  if (!binding) return null
  const provider = providers.find(p => p.id === binding.providerId)
  if (!provider) return null

  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: binding.modelId,
    apiFormat: provider.apiProtocol === 'auto' ? 'auto' : provider.apiProtocol,
    imageGenProfile: provider.imageGenProfile,
  }
}

/** 推断 API 协议 */
function inferApiProtocol(baseUrl: string, apiFormat?: string): ApiProtocol {
  if (apiFormat === 'openai' || apiFormat === 'anthropic') return apiFormat
  if (/anthropic/i.test(baseUrl)) return 'anthropic'
  return 'openai'
}

// ============================================
// Slice 创建
// ============================================

export const createLinkStationSlice: StateCreator<
  LinkStationSlice,
  [],
  [],
  LinkStationSlice
> = (set, get) => ({
  linkStation: createDefaultState(),

  // ── Sheet 切换 ──
  setActiveSheet: (sheet) => {
    set((state) => ({
      linkStation: { ...state.linkStation, activeSheet: sheet },
    }))
  },

  // ── Provider 管理 ──
  addProvider: (provider) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        providers: [...state.linkStation.providers, provider],
      },
    }))
    get().saveLinkStation()
  },

  updateProvider: (id, patch) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        providers: state.linkStation.providers.map(p =>
          p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p
        ),
      },
    }))
    get().saveLinkStation()
  },

  removeProvider: (id) => {
    set((state) => {
      const bindings = { ...state.linkStation.channelBindings }
      // 清除引用了被删除 Provider 的通道绑定
      for (const channel of Object.keys(bindings) as Array<keyof ChannelBindings>) {
        if (bindings[channel]?.providerId === id) {
          bindings[channel] = null
        }
      }
      return {
        linkStation: {
          ...state.linkStation,
          providers: state.linkStation.providers.filter(p => p.id !== id),
          channelBindings: bindings,
        },
      }
    })
    get().saveLinkStation()
  },

  setChannelBinding: (channel, binding) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        channelBindings: {
          ...state.linkStation.channelBindings,
          [channel]: binding,
        },
      },
    }))
    get().saveLinkStation()
  },

  // ── 快捷配置读取 ──
  getActiveChatConfig: () => {
    const { providers, channelBindings } = get().linkStation
    return buildLLMConfigFromBinding(providers, channelBindings.chat)
  },

  getActiveSecondaryChatConfig: () => {
    const { providers, channelBindings } = get().linkStation
    return buildLLMConfigFromBinding(providers, channelBindings.chatSecondary)
  },

  getActiveEmbedConfig: () => {
    const { providers, channelBindings } = get().linkStation
    const binding = channelBindings.embed
    if (!binding) return null
    const provider = providers.find(p => p.id === binding.providerId)
    if (!provider) return null
    return {
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model: binding.modelId,
    }
  },

  getChannelConfig: (channel) => {
    const { providers, channelBindings } = get().linkStation
    const binding = channelBindings[channel as keyof ChannelBindings]
    return buildLLMConfigFromBinding(providers, binding ?? null)
  },

  // ── MCP 管理 ──
  setMCPServers: (servers) => {
    set((state) => ({
      linkStation: { ...state.linkStation, mcpServers: servers },
    }))
  },

  updateMCPStatus: (name, status) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        mcpStatus: { ...state.linkStation.mcpStatus, [name]: status },
      },
    }))
  },

  setMCPTools: (tools) => {
    set((state) => ({
      linkStation: { ...state.linkStation, mcpTools: tools },
    }))
  },

  toggleMCPServer: (name, enabled) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        mcpServers: state.linkStation.mcpServers.map(s =>
          s.name === name ? { ...s, enabled } : s
        ),
      },
    }))
    get().saveLinkStation()
  },

  addMCPServer: (server) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        mcpServers: [...state.linkStation.mcpServers, server],
      },
    }))
    get().saveLinkStation()
  },

  updateMCPServer: (name, patch) => {
    set((state) => ({
      linkStation: {
        ...state.linkStation,
        mcpServers: state.linkStation.mcpServers.map(s =>
          s.name === name ? { ...s, ...patch } : s
        ),
      },
    }))
    get().saveLinkStation()
  },

  removeMCPServer: (name) => {
    set((state) => {
      const mcpStatus = { ...state.linkStation.mcpStatus }
      delete mcpStatus[name]
      return {
        linkStation: {
          ...state.linkStation,
          mcpServers: state.linkStation.mcpServers.filter(s => s.name !== name),
          mcpStatus,
          mcpTools: state.linkStation.mcpTools.filter(t => t.serverName !== name),
        },
      }
    })
    get().saveLinkStation()
  },

  // ── 持久化 ──
  loadLinkStation: async () => {
    // 1. 先尝试从 localStorage 缓存恢复（即时可用，不依赖后端）
    let loaded = false
    try {
      const cached = localStorage.getItem(LOCAL_CACHE_KEY)
      if (cached) {
        const saved = JSON.parse(cached) as Partial<LinkStationState>
        if (saved.providers && saved.providers.length > 0) {
          set((state) => ({
            linkStation: {
              ...state.linkStation,
              providers: saved.providers || [],
              channelBindings: saved.channelBindings || createDefaultChannelBindings(),
              mcpServers: saved.mcpServers || [],
            },
          }))
          console.log('[LinkStation] Config restored from localStorage cache')
          loaded = true
        }
      }
    } catch {
      // localStorage 解析失败，继续尝试后端
    }

    // 2. 始终尝试从后端加载（后端数据为 SSoT，覆盖 localStorage 缓存）
    try {
      const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
      const res = await fetch(`${serverUrl}/data/${PERSIST_KEY}`)
      if (res.ok) {
        const data = await res.json()
        if (data.exists && data.value) {
          const saved = data.value as Partial<LinkStationState>
          set((state) => ({
            linkStation: {
              ...state.linkStation,
              providers: saved.providers || [],
              channelBindings: saved.channelBindings || createDefaultChannelBindings(),
              mcpServers: saved.mcpServers || [],
            },
          }))
          saveToLocalCache(saved)
          console.log('[LinkStation] Config loaded from server (overrides local cache)')
          loaded = true
        }
      }
    } catch {
      console.debug('[LinkStation] Failed to load from server')
    }

    // 3. 都没有数据，尝试从旧配置迁移
    if (!loaded) {
      get().migrateFromLegacyConfig()
    }

    // 4. 获取后端 MCP 服务器连接状态
    try {
      const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
      const statusRes = await fetch(`${serverUrl}/mcp/servers`, {
        signal: AbortSignal.timeout(5000),
      })
      if (statusRes.ok) {
        const statusData = await statusRes.json()
        const serverStatus = statusData.servers || {}

        for (const [serverName, info] of Object.entries(serverStatus)) {
          const serverInfo = info as { connected: boolean; tools: number }
          get().updateMCPStatus(
            serverName,
            serverInfo.connected ? 'connected' : 'disconnected'
          )
        }

        if (statusData.tools && Array.isArray(statusData.tools)) {
          get().setMCPTools(
            statusData.tools.map((tool: Record<string, unknown>) => ({
              name: tool.name as string,
              serverName: tool.server as string,
              description: (tool.description as string) || '',
            }))
          )
        }
        console.log('[LinkStation] MCP status loaded from server')
      }
    } catch {
      console.debug('[LinkStation] Failed to fetch MCP status')
    }

    // 启动 MCP 状态轮询（每 30s 更新一次）
    get().startMCPStatusPolling()
  },

  saveLinkStation: async () => {
    const { providers, channelBindings, mcpServers } = get().linkStation
    const payload = { providers, channelBindings, mcpServers }

    // 始终立即写入 localStorage 缓存（确保下次启动可用）
    saveToLocalCache(payload)

    // HIGH #4: 立即同步 mcpTools：移除不在活跃 mcpServers 中的服务器工具
    const activeServerNames = new Set(
      mcpServers.filter(s => s.enabled !== false).map(s => s.name)
    )
    const currentTools = get().linkStation.mcpTools
    const filteredTools = currentTools.filter(t => activeServerNames.has(t.serverName))
    if (filteredTools.length !== currentTools.length) {
      get().setMCPTools(filteredTools)
    }
    // 同步移除 LocalClawService 中不活跃服务器的 MCP 工具
    try {
      const { localClawService } = await import('@/services/LocalClawService')
      localClawService.filterOutMCPTools(activeServerNames)
    } catch {
      // 静默失败
    }

    // 防抖网络请求（1.5秒），避免 UI 操作频繁触发网络请求
    if (_saveLinkStationTimer) {
      clearTimeout(_saveLinkStationTimer)
    }

    _saveLinkStationTimer = setTimeout(async () => {
      _saveLinkStationTimer = null
      try {
        await _executeLinkStationSave(payload, () => get() as any)
      } catch (error) {
        console.debug('[LinkStation] Failed to persist config to server:', error)
      }
    }, 1500)
  },

  forceSaveAll: async () => {
    try {
      // 清除挂起的防抖 timer，避免重复保存
      if (_saveLinkStationTimer) {
        clearTimeout(_saveLinkStationTimer)
        _saveLinkStationTimer = null
      }

      const { providers, channelBindings, mcpServers } = get().linkStation
      const payload = { providers, channelBindings, mcpServers }
      saveToLocalCache(payload)

      // 立即执行全量保存（含 MCP reload + llm_config 同步）
      await _executeLinkStationSave(payload, () => get() as any)

      return { success: true }
    } catch (e: any) {
      return { success: false, error: e?.message || '写入失败' }
    }
  },

  // ── MCP 状态轮询 ──
  startMCPStatusPolling: () => {
    if (_mcpPollingTimer) return
    _mcpPollingTimer = setInterval(async () => {
      try {
        const serverUrl = localStorage.getItem('duncrew_server_url') || getServerUrl()
        const statusRes = await fetch(`${serverUrl}/mcp/servers`, {
          signal: AbortSignal.timeout(5000),
        })
        if (statusRes.ok) {
          const statusData = await statusRes.json()
          if (statusData.servers) {
            set((state) => ({
              linkStation: {
                ...state.linkStation,
                mcpStatus: statusData.servers,
              },
            }))
          }
          if (statusData.tools && Array.isArray(statusData.tools)) {
            get().setMCPTools(
              statusData.tools.map((tool: Record<string, unknown>) => ({
                name: tool.name as string,
                serverName: tool.server as string,
                description: (tool.description as string) || '',
              }))
            )
          }
        }
      } catch {
        // 静默失败
      }
    }, 30000)
  },

  stopMCPStatusPolling: () => {
    if (_mcpPollingTimer) {
      clearInterval(_mcpPollingTimer)
      _mcpPollingTimer = null
    }
  },

  // ── 旧配置迁移 ──
  migrateFromLegacyConfig: () => {
    const apiKey = localStorage.getItem(LEGACY_STORAGE_KEYS.API_KEY)
    const baseUrl = localStorage.getItem(LEGACY_STORAGE_KEYS.BASE_URL)
    const model = localStorage.getItem(LEGACY_STORAGE_KEYS.MODEL)
    const apiFormat = localStorage.getItem(LEGACY_STORAGE_KEYS.API_FORMAT)

    // 没有旧配置，跳过迁移
    if (!apiKey && !baseUrl && !model) {
      console.log('[LinkStation] No legacy config found, skipping migration')
      return
    }

    console.log('[LinkStation] Migrating legacy LLM config...')

    const now = Date.now()
    const providerId = `migrated-${now}`
    const protocol = inferApiProtocol(baseUrl || '', apiFormat || undefined)

    // 构建迁移的 Provider
    const migratedProvider: ModelProvider = {
      id: providerId,
      label: inferProviderLabel(baseUrl || ''),
      baseUrl: baseUrl || '',
      apiKey: apiKey || '',
      apiProtocol: protocol,
      source: 'manual',
      models: model ? [{ id: model, name: model }] : [],
      createdAt: now,
      updatedAt: now,
    }

    // 构建通道绑定
    const chatBinding: ModelBinding | null = model
      ? { providerId, modelId: model }
      : null

    // 处理 Embedding 配置
    const embedApiKey = localStorage.getItem(LEGACY_STORAGE_KEYS.EMBED_API_KEY)
    const embedBaseUrl = localStorage.getItem(LEGACY_STORAGE_KEYS.EMBED_BASE_URL)
    const embedModel = localStorage.getItem(LEGACY_STORAGE_KEYS.EMBED_MODEL)

    const providers: ModelProvider[] = [migratedProvider]
    let embedBinding: ModelBinding | null = null

    if (embedApiKey || embedBaseUrl) {
      const embedProviderId = `migrated-embed-${now}`
      const embedProvider: ModelProvider = {
        id: embedProviderId,
        label: `Embed (${inferProviderLabel(embedBaseUrl || baseUrl || '')})`,
        baseUrl: embedBaseUrl || baseUrl || '',
        apiKey: embedApiKey || apiKey || '',
        apiProtocol: 'openai',
        source: 'manual',
        models: embedModel ? [{ id: embedModel, name: embedModel }] : [],
        createdAt: now,
        updatedAt: now,
      }
      providers.push(embedProvider)
      if (embedModel) {
        embedBinding = { providerId: embedProviderId, modelId: embedModel }
      }
    }

    set((state) => ({
      linkStation: {
        ...state.linkStation,
        providers,
        channelBindings: {
          ...createDefaultChannelBindings(),
          chat: chatBinding,
          embed: embedBinding,
        },
      },
    }))

    // 保存到后端 + localStorage 缓存
    get().saveLinkStation()

    console.log(`[LinkStation] Migration complete: ${providers.length} provider(s), chat=${model || 'none'}`)
  },
})

// ============================================
// 辅助：从 URL 推断 Provider 名称
// ============================================

function inferProviderLabel(baseUrl: string): string {
  const url = baseUrl.toLowerCase()
  if (url.includes('deepseek')) return 'DeepSeek'
  if (url.includes('anthropic')) return 'Claude'
  if (url.includes('openai')) return 'OpenAI'
  if (url.includes('moonshot')) return 'Kimi'
  if (url.includes('dashscope') || url.includes('aliyun')) return '通义千问'
  if (url.includes('minimax')) return 'MiniMax'
  if (url.includes('localhost') || url.includes('127.0.0.1')) return '本地模型'
  return '自定义 Provider'
}
