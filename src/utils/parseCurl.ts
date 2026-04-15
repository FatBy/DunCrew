/**
 * cURL 命令解析器
 *
 * 从用户粘贴的 cURL 命令中提取 API 配置信息：
 * - baseUrl: API 根地址（自动去除具体接口路径）
 * - apiKey: 从 Authorization: Bearer 头中提取
 * - model: 从请求体 JSON 的 model 字段提取
 * - method: HTTP 方法
 * - fullUrl: 完整的请求 URL
 */

export interface ParsedCurlResult {
  baseUrl: string
  apiKey: string
  model: string
  method: string
  fullUrl: string
  contentType: string
  body: Record<string, unknown> | null
}

/**
 * 已知的 API 接口路径后缀，用于从完整 URL 中剥离出 Base URL
 * 例如 https://api.minimaxi.com/v1/image_generation → https://api.minimaxi.com/v1
 */
const KNOWN_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/image_generation',
  '/images/generations',
  '/embeddings',
  '/audio/speech',
  '/audio/transcriptions',
  '/audio/translations',
  '/video/generations',
  '/models',
  '/messages',
]

/**
 * 将 cURL 命令字符串拆分为 token 数组
 * 处理单引号、双引号、反斜杠续行符等
 */
function tokenizeCurl(curlString: string): string[] {
  // 移除续行符（反斜杠 + 换行）
  const normalized = curlString
    .replace(/\\\r?\n\s*/g, ' ')
    .replace(/\r?\n/g, ' ')
    .trim()

  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escapeNext = false

  for (const char of normalized) {
    if (escapeNext) {
      current += char
      escapeNext = false
      continue
    }

    if (char === '\\' && !inSingleQuote) {
      escapeNext = true
      continue
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

/**
 * 从完整 URL 中提取 Base URL（去除已知的接口路径后缀）
 */
function extractBaseUrl(fullUrl: string): string {
  let url = fullUrl.replace(/\/+$/, '')

  for (const suffix of KNOWN_ENDPOINT_SUFFIXES) {
    if (url.endsWith(suffix)) {
      return url.slice(0, -suffix.length)
    }
  }

  // 没有匹配到已知后缀，尝试智能截断：
  // 如果 URL 以 /v1/xxx 或 /v1beta/xxx 结尾，保留到 /v1 或 /v1beta
  const versionMatch = url.match(/^(.*\/v\d+(?:beta)?)\/[^/]+$/)
  if (versionMatch) {
    return versionMatch[1]
  }

  return url
}

/**
 * 解析 cURL 命令字符串，提取 API 配置信息
 */
export function parseCurlCommand(curlString: string): ParsedCurlResult | null {
  const trimmed = curlString.trim()
  if (!trimmed.toLowerCase().startsWith('curl')) {
    return null
  }

  const tokens = tokenizeCurl(trimmed)
  if (tokens.length < 2) return null

  let method = 'GET'
  let fullUrl = ''
  let apiKey = ''
  let contentType = ''
  let bodyString = ''
  const headers: Record<string, string> = {}

  let index = 1 // 跳过 'curl'

  while (index < tokens.length) {
    const token = tokens[index]

    if (token === '-X' || token === '--request') {
      index++
      if (index < tokens.length) {
        method = tokens[index].toUpperCase()
      }
    } else if (token === '--url') {
      index++
      if (index < tokens.length) {
        fullUrl = tokens[index]
      }
    } else if (token === '-H' || token === '--header') {
      index++
      if (index < tokens.length) {
        const headerValue = tokens[index]
        const colonIndex = headerValue.indexOf(':')
        if (colonIndex > 0) {
          const headerName = headerValue.slice(0, colonIndex).trim().toLowerCase()
          const headerVal = headerValue.slice(colonIndex + 1).trim()
          headers[headerName] = headerVal

          if (headerName === 'authorization') {
            const bearerMatch = headerVal.match(/^Bearer\s+(.+)$/i)
            if (bearerMatch) {
              apiKey = bearerMatch[1].trim()
            }
          }
          if (headerName === 'content-type') {
            contentType = headerVal
          }
        }
      }
    } else if (token === '-d' || token === '--data' || token === '--data-raw' || token === '--data-binary') {
      index++
      if (index < tokens.length) {
        bodyString = tokens[index]
      }
    } else if (token.startsWith('http://') || token.startsWith('https://')) {
      // 裸 URL（没有 --url 前缀）
      if (!fullUrl) {
        fullUrl = token
      }
    }

    index++
  }

  if (!fullUrl) return null

  // 解析请求体 JSON
  let body: Record<string, unknown> | null = null
  let model = ''

  if (bodyString) {
    try {
      body = JSON.parse(bodyString)
      if (body && typeof body.model === 'string') {
        model = body.model
      }
    } catch {
      // JSON 解析失败，忽略
    }
  }

  // 如果有 body 但没有显式 method，推断为 POST
  if (bodyString && method === 'GET') {
    method = 'POST'
  }

  const baseUrl = extractBaseUrl(fullUrl)

  return {
    baseUrl,
    apiKey,
    model,
    method,
    fullUrl,
    contentType: contentType || 'application/json',
    body,
  }
}
