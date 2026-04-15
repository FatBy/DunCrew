/**
 * LibraryHouse - 图书馆主组件
 *
 * 左侧: 导入面板 + 实体列表
 * 右侧: 实体详情 (WSJ Editorial Style)
 */

import { useLibraryData } from './library/useLibraryData'
import { LibrarySidebar } from './library/LibrarySidebar'
import { LibraryContent } from './library/LibraryContent'

export function LibraryHouse() {
  const data = useLibraryData()

  return (
    <div className="flex h-full">
      <LibrarySidebar
        entities={data.entities}
        totalCount={data.totalCount}
        selectedEntityId={data.selectedEntityId}
        onSelectEntity={data.setSelectedEntityId}
        searchQuery={data.searchQuery}
        onSearchChange={data.setSearchQuery}
        onImport={data.handleImport}
        importing={data.importing}
        importProgress={data.importProgress}
        onRefresh={data.refresh}
        loading={data.loading}
      />
      <LibraryContent
        entity={data.entityDetail}
        loading={data.detailLoading}
        onSelectEntity={data.setSelectedEntityId}
      />
    </div>
  )
}
