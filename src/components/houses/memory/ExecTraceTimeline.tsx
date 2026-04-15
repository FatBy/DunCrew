import { Eye, PenTool, Edit3, Terminal, Circle } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/utils/cn'
import type { TraceEntry } from './useMemoryData'

/** 相对时间格式化 */
function relativeTime(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  const mon = Math.floor(day / 30)
  return `${mon}个月前`
}

const opConfig: Record<TraceEntry['operationType'], {
  icon: typeof Eye
  color: string
  bgColor: string
  dotColor: string
}> = {
  read:    { icon: Eye,      color: 'text-cyan-600',    bgColor: 'bg-cyan-100',    dotColor: 'bg-cyan-500' },
  write:   { icon: PenTool,  color: 'text-emerald-600', bgColor: 'bg-emerald-100', dotColor: 'bg-emerald-500' },
  edit:    { icon: Edit3,    color: 'text-amber-600',   bgColor: 'bg-amber-100',   dotColor: 'bg-amber-500' },
  command: { icon: Terminal,  color: 'text-indigo-600',  bgColor: 'bg-indigo-100',  dotColor: 'bg-indigo-500' },
  unknown: { icon: Circle,   color: 'text-stone-500',   bgColor: 'bg-stone-100',   dotColor: 'bg-stone-400' },
}

interface ExecTraceTimelineProps {
  traces: TraceEntry[]
}

export function ExecTraceTimeline({ traces }: ExecTraceTimelineProps) {
  if (traces.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-3 text-center">
          <Terminal className="w-14 h-14 text-stone-200" />
          <p className="text-sm text-stone-500">暂无执行轨迹</p>
          <p className="text-xs text-stone-400">Agent 执行操作后，轨迹将记录在这里</p>
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto p-6 h-full">
      <div className="relative">
        {/* 时间线竖线 */}
        <div className="absolute left-[15px] top-3 bottom-3 w-0.5 bg-indigo-100" />

        <div className="space-y-1">
          {traces.map((trace, idx) => {
            const cfg = opConfig[trace.operationType]
            const Icon = cfg.icon

            return (
              <motion.div
                key={trace.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.02, duration: 0.2 }}
                className="relative flex items-start gap-4 py-2.5 pl-1"
              >
                {/* 节点圆点 */}
                <div className={cn(
                  'relative z-10 w-[30px] h-[30px] rounded-full flex items-center justify-center shrink-0 border-2 border-white',
                  cfg.bgColor,
                )}>
                  <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
                </div>

                {/* 条目内容 */}
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] font-medium',
                      cfg.bgColor, cfg.color,
                    )}>
                      {trace.operationType}
                    </span>
                    {trace.dunLabel && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-emerald-100/80 text-emerald-700">
                        {trace.dunLabel}
                      </span>
                    )}
                    <span className="ml-auto text-[10px] font-mono text-stone-400 shrink-0">
                      {relativeTime(trace.timestamp)}
                    </span>
                  </div>

                  <p className="text-xs text-stone-700 leading-relaxed line-clamp-2">
                    {trace.summary}
                  </p>

                  {trace.filePath && (
                    <p className="mt-1 text-[11px] font-mono text-indigo-500/80 truncate">
                      {trace.filePath}
                    </p>
                  )}
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
