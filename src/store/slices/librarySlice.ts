/**
 * librarySlice — 知识库 (Library House) 状态管理
 */

import type { StateCreator } from 'zustand'

// ============================================
// 数据类型
// ============================================

export interface LibraryDocument {
  id: string
  path: string
  name: string
  extension: string
  size_bytes: number
  modified_at: number
  doc_type: string | null
  parsed_at: number | null
  parser_name: string | null
  cleaned_char_count: number | null
  content_preview: string | null
  duplicate_of: string | null
  wiki_status: 'pending' | 'ingested' | 'skipped' | 'error'
  wiki_entity_ids: string | null
  wiki_claim_count: number
  error_message: string | null
  library_id: string
  created_at: number
}

export interface LibraryStats {
  total_documents: number
  by_status: Record<string, number>
  by_type: Record<string, number>
  by_extension: Record<string, number>
  total_input_tokens: number
  total_output_tokens: number
}

export interface IngestProgress {
  stage: string
  message: string
  percent: number
  detail?: Record<string, unknown>
}

export interface DryRunResult {
  files_scanned: number
  files_parsed: number
  files_unique: number
  ingest_units: number
  total_chars: number
  estimated_tokens: number
  elapsed_seconds?: number
}

// ============================================
// Slice 接口
// ============================================

export interface LibrarySlice {
  // State
  libraryDocuments: LibraryDocument[]
  libraryStats: LibraryStats | null
  libraryLoading: boolean
  ingestProgress: IngestProgress | null
  ingestRunning: boolean
  dryRunResult: DryRunResult | null
  selectedDocId: string | null
  libraryLogLines: string[]
  scanPaths: string[]
  showConfirmModal: boolean

  // Actions
  setScanPaths: (paths: string[]) => void
  setLibraryDocuments: (docs: LibraryDocument[]) => void
  setLibraryStats: (stats: LibraryStats | null) => void
  setIngestProgress: (p: IngestProgress | null) => void
  setDryRunResult: (r: DryRunResult | null) => void
  setSelectedDocId: (id: string | null) => void
  appendLogLine: (line: string) => void
  clearLogLines: () => void
  setIngestRunning: (running: boolean) => void
  setLibraryLoading: (loading: boolean) => void
  setShowConfirmModal: (show: boolean) => void
}

// ============================================
// 创建 Slice
// ============================================

export const createLibrarySlice: StateCreator<LibrarySlice> = (set) => ({
  libraryDocuments: [],
  libraryStats: null,
  libraryLoading: false,
  ingestProgress: null,
  ingestRunning: false,
  dryRunResult: null,
  selectedDocId: null,
  libraryLogLines: [],
  scanPaths: [],
  showConfirmModal: false,

  setScanPaths: (paths) => set({ scanPaths: paths }),
  setLibraryDocuments: (docs) => set({ libraryDocuments: docs }),
  setLibraryStats: (stats) => set({ libraryStats: stats }),
  setIngestProgress: (p) => set({ ingestProgress: p }),
  setDryRunResult: (r) => set({ dryRunResult: r }),
  setSelectedDocId: (id) => set({ selectedDocId: id }),
  appendLogLine: (line) =>
    set((state) => ({
      libraryLogLines: [...state.libraryLogLines, line],
    })),
  clearLogLines: () => set({ libraryLogLines: [] }),
  setIngestRunning: (running) => set({ ingestRunning: running }),
  setLibraryLoading: (loading) => set({ libraryLoading: loading }),
  setShowConfirmModal: (show) => set({ showConfirmModal: show }),
})
