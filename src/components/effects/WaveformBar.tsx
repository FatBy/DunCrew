import { useEffect, useRef } from 'react'

interface WaveformBarProps {
  color?: string
  height?: number
}

/**
 * 波形动画条 - 使用 Canvas 直接绘制，绕过 React 渲染循环
 * 避免每帧 setState 导致的 60fps React 重渲染
 */
export function WaveformBar({ color = '#f59e0b', height = 40 }: WaveformBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number>(0)
  const phaseRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const width = 300
    const waves = [
      { amplitude: 8, frequency: 0.03, phaseOffset: 0, opacity: 0.8 },
      { amplitude: 5, frequency: 0.05, phaseOffset: 1.5, opacity: 0.5 },
      { amplitude: 6, frequency: 0.02, phaseOffset: 3, opacity: 0.3 },
    ]

    const dpr = window.devicePixelRatio || 1
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    const draw = () => {
      phaseRef.current += 0.08
      ctx.clearRect(0, 0, width, height)

      for (const wave of waves) {
        ctx.beginPath()
        ctx.strokeStyle = color
        ctx.lineWidth = 1.5
        ctx.globalAlpha = wave.opacity
        for (let x = 0; x <= width; x += 2) {
          const y = height / 2 + wave.amplitude *
            Math.sin((x + phaseRef.current * 40) * wave.frequency + wave.phaseOffset)
          if (x === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      animRef.current = requestAnimationFrame(draw)
    }
    draw()

    return () => cancelAnimationFrame(animRef.current)
  }, [color, height])

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height }}
    />
  )
}
