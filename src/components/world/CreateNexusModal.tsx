import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence, useDragControls } from 'framer-motion'
import { X, Plus, Building2, FileText, Sparkles, Loader2, Wand2, GripHorizontal, Zap, Tag, Target, ChevronDown, Check, Search } from 'lucide-react'
import { useStore } from '@/store'
import { simpleVisualDNA } from '@/store/slices/worldSlice'
import { createInitialScoring } from '@/types'

export interface NexusInitialData {
  name?: string
  description?: string
  sopContent?: string
  isFromChat?: boolean          // 标记是否从对话分析而来
  suggestedSkills?: string[]    // 建议绑定的技能
  tags?: string[]               // 分类标签
  triggers?: string[]           // 触发词
  objective?: string            // 核心目标
  metrics?: string[]            // 质量指标
  strategy?: string             // 执行策略
}

interface CreateNexusModalProps {
  isOpen: boolean
  onClose: () => void
  initialData?: NexusInitialData
  isAnalyzing?: boolean  // 是否正在分析对话
}

export function CreateNexusModal({ isOpen, onClose, initialData, isAnalyzing }: CreateNexusModalProps) {
  const addNexus = useStore((s) => s.addNexus)
  const availableSkills = useStore((s) => s.skills) // 系统已安装的技能列表
  const dragControls = useDragControls()
  const constraintsRef = useRef<HTMLDivElement>(null)
  
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sopContent, setSopContent] = useState('')
  const [boundSkills, setBoundSkills] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const [skillSearchQuery, setSkillSearchQuery] = useState('')
  
  // 当 initialData 变化时，更新表单内容
  useEffect(() => {
    if (initialData) {
      if (initialData.name) setName(initialData.name)
      if (initialData.description) setDescription(initialData.description)
      if (initialData.sopContent) setSopContent(initialData.sopContent)
      if (initialData.suggestedSkills) setBoundSkills(initialData.suggestedSkills)
      if (initialData.tags) setTags(initialData.tags)
    }
  }, [initialData])
  
  // 当弹窗关闭时重置表单（如果不是正在创建）
  useEffect(() => {
    if (!isOpen && !isCreating) {
      setName('')
      setDescription('')
      setSopContent('')
      setBoundSkills([])
      setTags([])
      setShowSkillPicker(false)
      setSkillSearchQuery('')
    }
  }, [isOpen, isCreating])
  
  // 过滤可选技能（排除已选的，按搜索词过滤）
  const filteredSkills = availableSkills.filter(skill => {
    const skillName = skill.name || skill.id
    const isNotSelected = !boundSkills.includes(skillName)
    const matchesSearch = !skillSearchQuery || 
      skillName.toLowerCase().includes(skillSearchQuery.toLowerCase()) ||
      (skill.description?.toLowerCase().includes(skillSearchQuery.toLowerCase()))
    return isNotSelected && matchesSearch
  })
  
  // 切换技能选中状态
  const toggleSkill = (skillName: string) => {
    setBoundSkills(prev => 
      prev.includes(skillName) 
        ? prev.filter(s => s !== skillName)
        : [...prev, skillName]
    )
  }
  
  // 生成预览 DNA（基于名称实时更新）
  const previewDNA = name.trim() ? simpleVisualDNA(`nexus-${name}-${Date.now()}`) : simpleVisualDNA('preview')
  const hue = previewDNA.primaryHue
  
  // 动态颜色
  const dynamicBg = { backgroundColor: `hsla(${hue}, 70%, 50%, 0.1)` }
  const dynamicBorder = { borderColor: `hsla(${hue}, 70%, 50%, 0.3)` }
  const dynamicText = { color: `hsl(${hue}, 80%, 65%)` }
  
  const handleCreate = useCallback(() => {
    if (!name.trim()) return
    
    setIsCreating(true)
    
    const nexusId = `nexus-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const visualDNA = simpleVisualDNA(nexusId)
    
    // 随机位置
    const gridX = Math.floor(Math.random() * 6) - 3
    const gridY = Math.floor(Math.random() * 6) - 3
    
    addNexus({
      id: nexusId,
      position: { gridX, gridY },
      scoring: createInitialScoring(),
      visualDNA,
      label: name.trim(),
      constructionProgress: 0, // 触发建造动画
      createdAt: Date.now(),
      boundSkillIds: boundSkills,  // 绑定技能
      sopContent: sopContent.trim() || undefined,
      flavorText: description.trim() || `手动创建于 ${new Date().toLocaleDateString()}`,
    })
    
    // 重置表单并关闭
    setName('')
    setDescription('')
    setSopContent('')
    setBoundSkills([])
    setTags([])
    setIsCreating(false)
    onClose()
  }, [name, description, sopContent, boundSkills, addNexus, onClose])
  
  const handleClose = () => {
    if (isCreating || isAnalyzing) return
    setName('')
    setDescription('')
    setSopContent('')
    setBoundSkills([])
    setTags([])
    onClose()
  }
  
  // 移除技能
  const removeSkill = (skill: string) => {
    setBoundSkills(prev => prev.filter(s => s !== skill))
  }
  
  // 移除标签
  const removeTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag))
  }
  
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-stone-900/10 backdrop-blur-[4px] z-[100]"
          />
          
          {/* 拖动约束区域 */}
          <div ref={constraintsRef} className="fixed inset-0 z-[101] pointer-events-none" />
          
          {/* 弹窗 - 居中 + 可拖动 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            drag
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={constraintsRef}
            dragElastic={0.05}
            dragMomentum={false}
            className="fixed inset-0 z-[101] m-auto
                       w-[90%] max-w-lg h-fit max-h-[85vh]
                       bg-white border border-stone-200/98 border-2 border-cyan-500/30 
                       rounded-2xl shadow-[0_0_60px_rgba(6,182,212,0.2)]
                       overflow-hidden pointer-events-auto"
          >
            {/* 头部 - 可拖动区域 */}
            <div 
              className="flex items-center justify-between p-4 border-b border-stone-200 cursor-grab active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="flex items-center gap-2">
                <GripHorizontal className="w-4 h-4 text-stone-300" />
                {initialData?.isFromChat ? (
                  <Wand2 className="w-5 h-5 text-amber-400" />
                ) : (
                  <Plus className="w-5 h-5 text-cyan-400" />
                )}
                <span className={`font-mono text-sm ${initialData?.isFromChat ? 'text-amber-400' : 'text-cyan-400'}`}>
                  {initialData?.isFromChat ? '从对话创建 Nexus' : '创建 Nexus'}
                </span>
              </div>
              <button 
                onClick={handleClose}
                className="p-1 hover:bg-stone-100 rounded transition-colors"
                disabled={isCreating || isAnalyzing}
              >
                <X className="w-4 h-4 text-stone-400" />
              </button>
            </div>
            
            {/* 内容 - 可滚动 */}
            <div className="p-6 space-y-5 overflow-y-auto max-h-[calc(85vh-60px)]">
              {/* 分析中提示 */}
              {isAnalyzing && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-center gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg"
                >
                  <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
                  <span className="text-sm text-amber-400">观察者正在分析对话内容...</span>
                </motion.div>
              )}
              
              {/* 从对话生成提示 + 技能安装状态 */}
              {initialData?.isFromChat && !isAnalyzing && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="flex items-start gap-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg"
                >
                  <Wand2 className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-amber-400/80 space-y-1">
                    <span>已从对话中提取内容，你可以编辑后创建</span>
                    {boundSkills.length > 0 && (() => {
                      const installedCount = boundSkills.filter(s => 
                        availableSkills.some(as => (as.name || as.id) === s)
                      ).length
                      const missingCount = boundSkills.length - installedCount
                      if (missingCount === 0) {
                        return <p className="text-emerald-400/80">所有 {installedCount} 个技能已就绪</p>
                      }
                      return <p className="text-amber-400/60">{installedCount} 个技能已就绪，{missingCount} 个未安装（可手动搜索）</p>
                    })()}
                  </div>
                </motion.div>
              )}
              
              {/* 名称输入 */}
              <div>
                <label className="block text-xs font-mono text-stone-400 mb-2">
                  Nexus 名称 <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：代码审查专家、文档生成器..."
                  className="w-full px-3 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                           text-sm text-stone-800 placeholder:text-stone-300
                           focus:outline-none focus:border-cyan-500/50 transition-colors"
                  autoFocus
                  disabled={isAnalyzing}
                />
              </div>
              
              {/* 描述输入 */}
              <div>
                <label className="block text-xs font-mono text-stone-400 mb-2">
                  简短描述 <span className="text-stone-300">(可选)</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="这个 Nexus 的主要用途..."
                  className="w-full px-3 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                           text-sm text-stone-800 placeholder:text-stone-300
                           focus:outline-none focus:border-cyan-500/50 transition-colors"
                  disabled={isAnalyzing}
                />
              </div>
              
              {/* SOP 内容 */}
              <div>
                <label className="flex items-center gap-1.5 text-xs font-mono text-stone-400 mb-2">
                  <FileText className="w-3.5 h-3.5" />
                  标准作业程序 (SOP) <span className="text-stone-300">(核心)</span>
                </label>
                <textarea
                  value={sopContent}
                  onChange={(e) => setSopContent(e.target.value)}
                  placeholder="定义 Nexus 的行为规范、工作流程、注意事项等...&#10;&#10;支持 Markdown 格式，建议包含：&#10;- 执行流程步骤&#10;- 关键参数配置&#10;- 质量检查点&#10;- 注意事项"
                  rows={8}
                  className="w-full px-3 py-2.5 bg-stone-100/80 border border-stone-200 rounded-lg
                           text-sm text-stone-800 placeholder:text-stone-300 resize-y min-h-[120px]
                           focus:outline-none focus:border-cyan-500/50 transition-colors
                           font-mono text-xs leading-relaxed"
                  disabled={isAnalyzing}
                />
                {sopContent && (
                  <p className="text-xs text-stone-300 mt-1.5">
                    已填充 {sopContent.length} 字符
                  </p>
                )}
              </div>
              
              {/* 绑定技能 */}
              <div>
                <label className="flex items-center justify-between text-xs font-mono text-stone-400 mb-2">
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5" />
                    绑定技能 
                    {boundSkills.length > 0 && (
                      <span className="text-green-400/70">({boundSkills.length})</span>
                    )}
                  </span>
                  <button
                    onClick={() => setShowSkillPicker(!showSkillPicker)}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-cyan-400 
                             hover:bg-cyan-500/10 rounded transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    添加
                    <ChevronDown className={`w-3 h-3 transition-transform ${showSkillPicker ? 'rotate-180' : ''}`} />
                  </button>
                </label>
                
                {/* 技能选择器 */}
                <AnimatePresence>
                  {showSkillPicker && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mb-3 overflow-hidden"
                    >
                      <div className="p-3 bg-stone-50 border border-stone-200 rounded-lg">
                        {/* 搜索框 */}
                        <div className="relative mb-2">
                          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-stone-300" />
                          <input
                            type="text"
                            value={skillSearchQuery}
                            onChange={(e) => setSkillSearchQuery(e.target.value)}
                            placeholder="搜索已安装技能..."
                            className="w-full pl-8 pr-3 py-2 bg-stone-100/80 border border-stone-200 rounded-lg
                                     text-xs text-stone-800 placeholder:text-stone-300
                                     focus:outline-none focus:border-cyan-500/50"
                          />
                        </div>
                        
                        {/* 技能列表 */}
                        <div className="max-h-40 overflow-y-auto space-y-1">
                          {filteredSkills.length > 0 ? (
                            filteredSkills.map(skill => {
                              const skillName = skill.name || skill.id
                              const isSelected = boundSkills.includes(skillName)
                              return (
                                <button
                                  key={skill.id}
                                  onClick={() => toggleSkill(skillName)}
                                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left
                                           transition-colors ${isSelected 
                                             ? 'bg-green-500/20 border border-green-500/30' 
                                             : 'hover:bg-stone-100/80 border border-transparent'}`}
                                >
                                  <div className={`w-4 h-4 rounded border flex items-center justify-center
                                                ${isSelected 
                                                  ? 'bg-green-500 border-green-500' 
                                                  : 'border-stone-300'}`}>
                                    {isSelected && <Check className="w-3 h-3 text-white" />}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs text-stone-800 truncate">{skillName}</p>
                                    {skill.description && (
                                      <p className="text-[10px] text-stone-400 truncate">{skill.description}</p>
                                    )}
                                  </div>
                                  {skill.category && (
                                    <span className="text-[10px] text-stone-300 px-1.5 py-0.5 bg-stone-100/80 rounded">
                                      {skill.category}
                                    </span>
                                  )}
                                </button>
                              )
                            })
                          ) : (
                            <p className="text-xs text-stone-300 text-center py-3">
                              {skillSearchQuery ? '未找到匹配的技能' : '暂无可用技能'}
                            </p>
                          )}
                        </div>
                        
                        <p className="text-[10px] text-stone-300 mt-2 pt-2 border-t border-stone-100">
                          绑定技能后，Nexus 执行时会优先使用这些能力
                        </p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
                
                {/* 已选技能标签 */}
                {boundSkills.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {boundSkills.map((skill) => {
                      // 检查是否为已安装技能
                      const isInstalled = availableSkills.some(s => (s.name || s.id) === skill)
                      return (
                        <span
                          key={skill}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono
                                   ${isInstalled 
                                     ? 'bg-green-500/10 border border-green-500/30 text-green-400' 
                                     : 'bg-amber-500/10 border border-amber-500/30 text-amber-400'}`}
                          title={isInstalled ? '已安装技能' : 'AI 建议（未安装）'}
                        >
                          <Zap className="w-3 h-3" />
                          {skill}
                          {!isInstalled && (
                            <span className="text-[10px] opacity-60">(建议)</span>
                          )}
                          <button
                            onClick={() => removeSkill(skill)}
                            className="ml-0.5 hover:text-red-400 transition-colors"
                            title="移除"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      )
                    })}
                  </div>
                )}
                
                {boundSkills.length === 0 && !showSkillPicker && (
                  <p className="text-xs text-stone-300">点击"添加"从已安装技能中选择</p>
                )}
              </div>
              
              {/* 分类标签 */}
              {tags.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                >
                  <label className="flex items-center gap-1.5 text-xs font-mono text-stone-400 mb-2">
                    <Tag className="w-3.5 h-3.5" />
                    分类标签
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 
                                 bg-purple-500/10 border border-purple-500/30 rounded-full
                                 text-xs text-purple-400"
                      >
                        {tag}
                        <button
                          onClick={() => removeTag(tag)}
                          className="ml-0.5 hover:text-red-400 transition-colors"
                          title="移除"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                </motion.div>
              )}
              
              {/* 核心目标 */}
              {initialData?.objective && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg"
                >
                  <label className="flex items-center gap-1.5 text-xs font-mono text-blue-400/70 mb-1.5">
                    <Target className="w-3.5 h-3.5" />
                    核心目标
                  </label>
                  <p className="text-sm text-stone-700">{initialData.objective}</p>
                </motion.div>
              )}
              
              {/* 预览区域 */}
              {name.trim() && !isAnalyzing && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="flex items-center gap-4 p-3 rounded-lg border"
                  style={{ ...dynamicBg, ...dynamicBorder }}
                >
                  <div 
                    className="w-14 h-14 rounded-lg flex items-center justify-center border"
                    style={{ ...dynamicBg, ...dynamicBorder }}
                  >
                    <Sparkles className="w-6 h-6" style={dynamicText} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-sm text-stone-800 truncate">{name}</p>
                    <p className="text-xs mt-0.5" style={dynamicText}>预览样式</p>
                  </div>
                </motion.div>
              )}
              
              {/* 按钮 */}
              <div className="flex gap-3 pt-2">
                <button
                  onClick={handleClose}
                  disabled={isCreating || isAnalyzing}
                  className="flex-1 py-2.5 px-4 rounded-lg border border-stone-200 
                           text-sm font-mono text-stone-500 hover:bg-stone-100/80 transition-colors
                           disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!name.trim() || isCreating || isAnalyzing}
                  className="flex-1 py-2.5 px-4 rounded-lg flex items-center justify-center gap-2
                           text-sm font-mono bg-cyan-500/20 border border-cyan-500/30 
                           text-cyan-400 hover:bg-cyan-500/30 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Building2 className="w-4 h-4" />
                  {isCreating ? '创建中...' : '创建 Nexus'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
