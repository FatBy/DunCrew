import { useState, useCallback } from 'react'
import { Upload, FileText, Check, AlertCircle } from 'lucide-react'
import { cn } from '@/utils/cn'

interface FileDropZoneProps {
  onFileDrop: (content: string, fileName: string, fileType: string) => void
  acceptedTypes?: string[]
  className?: string
}

type DropStatus = 'idle' | 'dragover' | 'success' | 'error'

export function FileDropZone({ 
  onFileDrop, 
  acceptedTypes = ['.md', '.json', '.txt'],
  className 
}: FileDropZoneProps) {
  const [status, setStatus] = useState<DropStatus>('idle')
  const [message, setMessage] = useState('')

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setStatus('dragover')
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setStatus('idle')
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) {
      setStatus('error')
      setMessage('未检测到文件')
      return
    }

    // 处理所有拖入的文件
    files.forEach(file => {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase()
      
      if (!acceptedTypes.some(t => ext === t || file.type.includes(t.replace('.', '')))) {
        setStatus('error')
        setMessage(`不支持的文件类型: ${ext}`)
        setTimeout(() => setStatus('idle'), 2000)
        return
      }

      const reader = new FileReader()
      reader.onload = (event) => {
        const content = event.target?.result as string
        if (content) {
          // 检测文件类型
          let fileType = 'unknown'
          const fileName = file.name.toLowerCase()
          
          if (fileName.includes('soul')) {
            fileType = 'soul'
          } else if (fileName.includes('identity')) {
            fileType = 'identity'
          } else if (fileName.includes('memory')) {
            fileType = 'memory'
          } else if (fileName.includes('skill') || fileName === 'skills.json') {
            fileType = 'skills'
          } else if (ext === '.json') {
            // 尝试检测 JSON 内容
            try {
              const json = JSON.parse(content)
              if (json.soulMd || json.skills || json.memories) {
                fileType = 'config'
              } else if (Array.isArray(json) && json[0]?.name) {
                fileType = 'skills'
              }
            } catch {}
          } else if (ext === '.md') {
            // 检测 Markdown 内容
            if (content.includes('Core Truths') || content.includes('Boundaries')) {
              fileType = 'soul'
            } else if (content.includes('## ')) {
              fileType = 'memory'
            }
          }
          
          onFileDrop(content, file.name, fileType)
          setStatus('success')
          setMessage(`已导入: ${file.name}`)
          setTimeout(() => {
            setStatus('idle')
            setMessage('')
          }, 2000)
        }
      }
      
      reader.onerror = () => {
        setStatus('error')
        setMessage('读取文件失败')
        setTimeout(() => setStatus('idle'), 2000)
      }
      
      reader.readAsText(file)
    })
  }, [acceptedTypes, onFileDrop])

  // 点击上传
  const handleClick = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = acceptedTypes.join(',')
    input.multiple = true
    input.onchange = (e) => {
      const files = (e.target as HTMLInputElement).files
      if (files) {
        // 模拟拖拽事件
        const dataTransfer = new DataTransfer()
        Array.from(files).forEach(f => dataTransfer.items.add(f))
        handleDrop({ 
          preventDefault: () => {},
          stopPropagation: () => {},
          dataTransfer 
        } as unknown as React.DragEvent)
      }
    }
    input.click()
  }, [acceptedTypes, handleDrop])

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      className={cn(
        'relative border-2 border-dashed rounded-lg p-6 transition-all cursor-pointer',
        'flex flex-col items-center justify-center gap-2',
        status === 'idle' && 'border-stone-200 hover:border-white/40 bg-stone-100/80',
        status === 'dragover' && 'border-cyan-400 bg-cyan-400/10 scale-[1.02]',
        status === 'success' && 'border-emerald-400 bg-emerald-400/10',
        status === 'error' && 'border-red-400 bg-red-400/10',
        className
      )}
    >
      {status === 'idle' && (
        <>
          <Upload className="w-8 h-8 text-stone-400" />
          <p className="text-sm font-mono text-stone-500">
            拖拽文件到此处，或点击上传
          </p>
          <p className="text-[13px] font-mono text-stone-300">
            支持: SOUL.md, IDENTITY.md, MEMORY.md, skills.json, ddos-config.json
          </p>
        </>
      )}
      
      {status === 'dragover' && (
        <>
          <FileText className="w-8 h-8 text-cyan-400 animate-bounce" />
          <p className="text-sm font-mono text-cyan-400">
            释放以导入文件
          </p>
        </>
      )}
      
      {status === 'success' && (
        <>
          <Check className="w-8 h-8 text-emerald-400" />
          <p className="text-sm font-mono text-emerald-400">
            {message}
          </p>
        </>
      )}
      
      {status === 'error' && (
        <>
          <AlertCircle className="w-8 h-8 text-red-400" />
          <p className="text-sm font-mono text-red-400">
            {message}
          </p>
        </>
      )}
    </div>
  )
}
