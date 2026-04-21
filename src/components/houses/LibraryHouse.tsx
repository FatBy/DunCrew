/**
 * LibraryHouse - 图书馆主组件
 *
 * 三层视图架构:
 *   Layer 1: 智能首页 (LibraryHome) - 搜索、分类浏览、统计、Librarian
 *   Layer 2: 分类列表 (LibrarySidebar 实体列表 + 批量操作)
 *   Layer 3: 实体详情 (LibraryContent WSJ Style)
 */

import { useLibraryData } from './library/useLibraryData'
import { LibrarySidebar } from './library/LibrarySidebar'
import { LibraryContent } from './library/LibraryContent'
import { LibraryHome } from './library/LibraryHome'

export function LibraryHouse() {
  const data = useLibraryData()
  const isHome = data.view.type === 'home'
  const categories = data.stats?.categories.map(c => c.name) || []

  return (
    <div className="flex h-full">
      <LibrarySidebar
        view={data.view}
        entities={data.entities}
        totalCount={data.totalCount}
        onSelectEntity={data.goEntity}
        searchQuery={data.searchQuery}
        onSearchChange={data.setSearchQuery}
        onImport={data.handleImport}
        importing={data.importing}
        importProgress={data.importProgress}
        onRefresh={data.refresh}
        loading={data.loading}
        onGoHome={data.goHome}
        onGoCategory={data.goCategory}
        selectedIds={data.selectedIds}
        onToggleSelect={data.toggleSelect}
        onSelectAll={data.selectAll}
        onClearSelection={data.clearSelection}
        onBatchAction={data.batchAction}
        onDeleteEntity={data.deleteEntity}
        categories={categories}
      />
      {isHome ? (
        <LibraryHome
          stats={data.stats}
          statsLoading={data.statsLoading}
          searchQuery={data.searchQuery}
          onSearchChange={data.setSearchQuery}
          searchResults={data.searchResults}
          searchLoading={data.searchLoading}
          onSelectEntity={data.goEntity}
          onSelectCategory={data.goCategory}
          librarianContext={data.librarianContext}
          librarianLoading={data.librarianLoading}
          onStartLibrarian={data.startLibrarian}
          onExecuteLibrarian={data.executeLibrarianActions}
        />
      ) : (
        <LibraryContent
          entity={data.entityDetail}
          loading={data.detailLoading}
          onSelectEntity={data.goEntity}
          onDeleteEntity={data.deleteEntity}
        />
      )}
    </div>
  )
}
