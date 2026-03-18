// ============================================
// DunCrew 极简背景渲染器
// 纯净浅色背景 + 浮动光尘 + 光晕呼吸
// ============================================

import type { BackgroundRenderer, RenderContext } from '../types'

interface DustParticle {
  x: number
  y: number
  size: number
  baseOpacity: number
  speedX: number
  speedY: number
  phase: number
  warm: boolean
}

/**
 * 极简背景渲染器
 * 展厅级纯净背景 + 微妙动态
 */
export class MinimalistBackground implements BackgroundRenderer {
  readonly id = 'minimalist-background'

  private particles: DustParticle[] = []
  private w = 1920
  private h = 1080

  constructor() {
    this.initParticles()
  }

  private initParticles(): void {
    this.particles = []
    for (let i = 0; i < 35; i++) {
      this.particles.push({
        x: Math.random() * this.w,
        y: Math.random() * this.h,
        size: 1 + Math.random() * 2,
        baseOpacity: 0.05 + Math.random() * 0.1,
        speedX: (Math.random() - 0.5) * 0.4,
        speedY: (Math.random() - 0.5) * 0.3,
        phase: Math.random() * Math.PI * 2,
        warm: i < 21, // 60% warm, 40% cool
      })
    }
  }

  resize(width: number, height: number): void {
    this.w = width
    this.h = height
    // 将粒子约束到新边界
    for (const p of this.particles) {
      if (p.x > width) p.x = Math.random() * width
      if (p.y > height) p.y = Math.random() * height
    }
  }

  render(ctx: RenderContext): void {
    const { ctx: c, width, height, time } = ctx

    // ---- 1. 纯净的浅色背景（石膏白/米白） ----
    const bgGradient = c.createLinearGradient(0, 0, 0, height)
    bgGradient.addColorStop(0, '#FAFAFA')
    bgGradient.addColorStop(0.5, '#F5F5F5')
    bgGradient.addColorStop(1, '#F0F0F0')
    c.fillStyle = bgGradient
    c.fillRect(0, 0, width, height)

    // ---- 2. 右上方暖色光晕（带呼吸动画） ----
    const sunX = width * 0.8
    const sunY = height * 0.15
    const sunBreath = 1 + 0.05 * Math.sin(time * 1.5)
    const sunRadius = Math.max(width, height) * 0.5 * sunBreath
    const sunAlpha = 0.15 * (0.9 + 0.1 * Math.sin(time * 1.2))

    const sunGlow = c.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunRadius)
    sunGlow.addColorStop(0, `rgba(255, 245, 220, ${sunAlpha})`)
    sunGlow.addColorStop(0.3, `rgba(255, 240, 200, ${sunAlpha * 0.5})`)
    sunGlow.addColorStop(1, 'rgba(255, 240, 200, 0)')
    c.fillStyle = sunGlow
    c.fillRect(0, 0, width, height)

    // ---- 3. 左下方冷色光晕（带呼吸动画，相位偏移） ----
    const coolX = width * 0.2
    const coolY = height * 0.85
    const coolBreath = 1 + 0.04 * Math.sin(time * 1.8 + Math.PI)
    const coolRadius = Math.max(width, height) * 0.4 * coolBreath
    const coolAlpha = 0.08 * (0.9 + 0.1 * Math.sin(time * 1.5 + Math.PI))

    const coolGlow = c.createRadialGradient(coolX, coolY, 0, coolX, coolY, coolRadius)
    coolGlow.addColorStop(0, `rgba(200, 220, 255, ${coolAlpha})`)
    coolGlow.addColorStop(1, 'rgba(200, 220, 255, 0)')
    c.fillStyle = coolGlow
    c.fillRect(0, 0, width, height)

    // ---- 4. 浮动光尘粒子 ----
    for (const p of this.particles) {
      // 更新位置
      p.x += p.speedX
      p.y += p.speedY

      // 边界回环
      if (p.x < 0) p.x += width
      else if (p.x > width) p.x -= width
      if (p.y < 0) p.y += height
      else if (p.y > height) p.y -= height

      // 闪烁 alpha
      const alpha = p.baseOpacity * (0.7 + 0.3 * Math.sin(time * 3 + p.phase))
      if (alpha < 0.01) continue

      c.beginPath()
      c.arc(p.x, p.y, p.size, 0, Math.PI * 2)
      c.fillStyle = p.warm
        ? `rgba(255, 240, 210, ${alpha})`
        : `rgba(220, 230, 250, ${alpha})`
      c.fill()
    }
  }

  dispose(): void {
    this.particles = []
  }
}
