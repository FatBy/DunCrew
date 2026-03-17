import { useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Upload, X, Loader2, Check, FileText, Tag } from 'lucide-react'
import { useStore } from '@/store'
import { clawHubService } from '@/services/clawHubService'

interface SkillPublishDialogProps {
  skillName: string
  onClose: () => void
}

export function SkillPublishDialog({ skillName, onClose }: SkillPublishDialogProps) {
  const isAuthenticated = useStore(s => s.clawHubAuthenticated)
  const clawHubLogin = useStore(s => s.clawHubLogin)
  const authLoading = useStore(s => s.clawHubAuthLoading)

  const [name, setName] = useState(skillName)
  const [slug, setSlug] = useState(skillName.toLowerCase().replace(/\s+/g, '-'))
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('1.0.0')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [fileList, setFileList] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'preview' | 'publishing' | 'done' | 'error'>('preview')
  const [error, setError] = useState('')
  const [publishUrl, setPublishUrl] = useState('')

  // 加载技能预览信息
  const loadPreview = useCallback(async () => {
    const raw = await clawHubService.getSkillRaw(skillName)
    if (raw) {
      setFileList(raw.files.map(f => f.path))
    }
    const pkg = await clawHubService.packageViaBackend(skillName)
    if (pkg.success) {
      if (pkg.name) setName(pkg.name)
      if (pkg.description) setDescription(pkg.description)
      if (pkg.version) setVersion(pkg.version)
      if (pkg.tags) setTags(pkg.tags)
      if (pkg.file_list) setFileList(pkg.file_list)
    }
  }, [skillName])

  // 首次加载
  useState(() => { loadPreview() })

  const handleAddTag = () => {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput('')
  }

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter(t => t !== tag))
  }

  const handlePublish = async () => {
    if (!isAuthenticated) return

    setStep('publishing')
    setLoading(true)
    setError('')

    try {
      // 先打包
      const pkg = await clawHubService.packageViaBackend(skillName)
      if (!pkg.success || !pkg.archive_base64) {
        throw new Error(pkg.error || '打包失败')
      }

      // base64 转 Blob
      const binaryStr = atob(pkg.archive_base64)
      const bytes = new Uint8Array(binaryStr.length)
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i)
      }
      const archive = new Blob([bytes], { type: 'application/gzip' })

      // 发布
      const result = await clawHubService.publishSkill({
        name,
        slug,
        description,
        version,
        skillArchive: archive,
        tags,
      })

      if (result) {
        setPublishUrl(result.url)
        setStep('done')
      } else {
        throw new Error('发布失败，请检查网络和认证状态')
      }
    } catch (e) {
      setError(String(e))
      setStep('error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/10 backdrop-blur-[4px] backdrop-blur-sm"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="w-full max-w-lg mx-4 bg-white border border-stone-200 border border-stone-200 rounded-xl overflow-hidden shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-stone-200">
            <div className="flex items-center gap-2">
              <Upload className="w-5 h-5 text-cyan-400" />
              <h2 className="text-lg font-semibold text-stone-800">发布到 ClawHub</h2>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-stone-100">
              <X className="w-5 h-5 text-stone-400" />
            </button>
          </div>

          {/* 内容 */}
          <div className="px-6 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
            {/* 认证检查 */}
            {!isAuthenticated && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                <p className="text-sm text-amber-400 mb-2">需要先连接 ClawHub 账户</p>
                <button
                  onClick={() => clawHubLogin()}
                  disabled={authLoading}
                  className="px-4 py-1.5 text-sm bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 disabled:opacity-50"
                >
                  {authLoading ? '连接中...' : '连接 ClawHub'}
                </button>
              </div>
            )}

            {/* 基本信息 */}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-stone-400 uppercase mb-1 block">技能名称</label>
                <input
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg text-sm text-stone-800 focus:border-cyan-500/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs text-stone-400 uppercase mb-1 block">Slug (唯一标识)</label>
                <input
                  value={slug}
                  onChange={e => setSlug(e.target.value)}
                  className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg text-sm text-stone-600 focus:border-cyan-500/50 focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs text-stone-400 uppercase mb-1 block">描述</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg text-sm text-stone-800 resize-none focus:border-cyan-500/50 focus:outline-none"
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-xs text-stone-400 uppercase mb-1 block">版本</label>
                  <input
                    value={version}
                    onChange={e => setVersion(e.target.value)}
                    className="w-full px-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg text-sm text-stone-800 focus:border-cyan-500/50 focus:outline-none"
                  />
                </div>
              </div>

              {/* 标签 */}
              <div>
                <label className="text-xs text-stone-400 uppercase mb-1 block">标签</label>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {tags.map(tag => (
                    <span key={tag} className="flex items-center gap-1 px-2 py-0.5 text-xs bg-cyan-500/10 text-cyan-400 rounded-full">
                      <Tag className="w-3 h-3" />
                      {tag}
                      <button onClick={() => handleRemoveTag(tag)} className="hover:text-red-400">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), handleAddTag())}
                    placeholder="输入标签后回车"
                    className="flex-1 px-3 py-1.5 bg-stone-100/80 border border-stone-200 rounded-lg text-xs text-stone-800 focus:border-cyan-500/50 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* 文件列表 */}
            {fileList.length > 0 && (
              <div>
                <label className="text-xs text-stone-400 uppercase mb-1 block">包含文件 ({fileList.length})</label>
                <div className="max-h-32 overflow-y-auto bg-stone-100/80 rounded-lg p-2 space-y-0.5">
                  {fileList.map(f => (
                    <div key={f} className="flex items-center gap-1.5 text-xs text-stone-500">
                      <FileText className="w-3 h-3 shrink-0" />
                      <span className="truncate">{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 状态信息 */}
            {step === 'done' && (
              <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                <div className="flex items-center gap-2 text-emerald-400 text-sm">
                  <Check className="w-4 h-4" />
                  发布成功
                </div>
                {publishUrl && (
                  <a href={publishUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-400 hover:underline mt-1 block">
                    {publishUrl}
                  </a>
                )}
              </div>
            )}

            {step === 'error' && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}
          </div>

          {/* 底部按钮 */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-stone-200">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-stone-500 hover:text-stone-700 transition-colors"
            >
              {step === 'done' ? '关闭' : '取消'}
            </button>
            {step !== 'done' && (
              <button
                onClick={handlePublish}
                disabled={loading || !isAuthenticated || !name || !slug}
                className="flex items-center gap-2 px-5 py-2 text-sm font-medium bg-cyan-500/20 text-cyan-400 rounded-lg hover:bg-cyan-500/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    发布中...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4" />
                    发布
                  </>
                )}
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
