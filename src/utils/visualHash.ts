import type { VisualDNA } from '@/types'

/**
 * 将字符串通过 SHA-256 哈希为字节数组
 */
export async function hashStringToBytes(input: string): Promise<Uint8Array> {
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hashBuffer)
}

/**
 * 确定性生成视觉 DNA：基于 entityId 的 SHA-256 哈希映射到视觉参数
 * 每个 Nexus 都会生成独特的颜色和几何样式
 * 不消耗 LLM token，纯本地计算
 */
export async function generateVisualDNA(entityId: string): Promise<VisualDNA> {
  const bytes = await hashStringToBytes(entityId)

  // 颜色参数
  const primaryHue = ((bytes[0] << 8) | bytes[1]) % 360
  const primarySaturation = 40 + (((bytes[2] << 8) | bytes[3]) % 61)   // 40-100
  const primaryLightness = 30 + (((bytes[4] << 8) | bytes[5]) % 41)    // 30-70
  const accentHue = (primaryHue + 30 + (bytes[6] % 120)) % 360

  // 纹理模式
  const textureByte = bytes[8]
  const textureMode: VisualDNA['textureMode'] =
    textureByte < 85 ? 'solid' :
    textureByte < 170 ? 'wireframe' : 'gradient'

  // 发光强度和几何变体
  const glowIntensity = bytes[9] / 255
  const geometryVariant = bytes[10] % 4

  return {
    primaryHue,
    primarySaturation,
    primaryLightness,
    accentHue,
    textureMode,
    glowIntensity,
    geometryVariant,
  }
}
