import { useState, useEffect } from 'react'
import { useMemoryData } from './memory/useMemoryData'
import { MemoryToolbar, type MemoryTab } from './memory/MemoryToolbar'
import { MemorySidebar } from './memory/MemorySidebar'
import { L0MemoryWall } from './memory/L0MemoryWall'
import { BaseAnalysisPanel } from './memory/BaseAnalysisPanel'
import { NexusGraph } from './memory/DunGraph'
import { TemporalLens } from './memory/TemporalLens'
import { MemoryStatusBar } from './memory/MemoryStatusBar'

export function MemoryHouse() {
  const data = useMemoryData()
  const [activeTab, setActiveTab] = useState<MemoryTab>('wall')
  const [hasAutoSwitched, setHasAutoSwitched] = useState(false)

  // 数据首次加载完成后，智能选择默认 Tab
  useEffect(() => {
    if (!data.loading && !hasAutoSwitched) {
      if (data.l0Count === 0 && data.traceCount > 0) {
        setActiveTab('traces')
      }
      setHasAutoSwitched(true)
    }
  }, [data.loading, data.l0Count, data.traceCount, hasAutoSwitched])

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 */}
      <MemoryToolbar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        l0Count={data.l0Count}
        traceCount={data.traceCount}
        onSearch={data.searchMemories}
        onRefresh={data.refresh}
        loading={data.loading}
      />

      {/* 主体三栏 */}
      <div className="flex flex-1 min-h-0">
        {/* 左侧栏 */}
        <MemorySidebar
          l0Memories={data.l0Memories}
          traces={data.traces}
          neuronStats={data.neuronStats}
          selectedMemoryId={data.selectedMemoryId}
          onSelectMemory={data.selectMemory}
        />

        {/* 中央主视图 */}
        <main className="flex-1 min-h-0 overflow-hidden">
          {activeTab === 'wall' && (
            <L0MemoryWall
              memories={data.l0Memories}
              selectedMemoryId={data.selectedMemoryId}
              onSelectMemory={data.selectMemory}
              loading={data.loading}
            />
          )}
          {activeTab === 'traces' && (
            <BaseAnalysisPanel />
          )}
          {activeTab === 'graph' && (
            <NexusGraph nodes={data.graphNodes} edges={data.graphEdges} />
          )}
        </main>

        {/* 右侧透视镜 */}
        <TemporalLens
          lensData={data.lensData}
          onClose={() => data.selectMemory(null)}
        />
      </div>

      {/* 底部状态栏 */}
      <MemoryStatusBar
        l0Count={data.l0Count}
        traceCount={data.traceCount}
        solidificationPercent={data.neuronStats.solidificationPercent}
      />
    </div>
  )
}
