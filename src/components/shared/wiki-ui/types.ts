/**
 * Wiki 数据类型定义 (共享)
 */

export interface WikiEvidence {
  id: string
  sourceName: string
  chunkText: string | null
  timestamp: number
}

export interface WikiClaim {
  id: string
  content: string
  type: string | null
  value: string | null
  trend: string | null
  confidence: number
  status: string
  conflictWith: string | null
  sourceIngestId: string | null
  createdAt: number
  updatedAt: number
  evidence: WikiEvidence[]
}

export interface WikiRelation {
  id: string
  sourceId: string
  targetId: string
  type: string
  strength: number
  description: string | null
  targetTitle: string
  targetType: string
}

export interface WikiEntityDetail {
  id: string
  dunId: string | null
  slug: string
  title: string
  type: string
  tldr: string | null
  tags: string[]
  status: string
  createdAt: number
  updatedAt: number
  claims: WikiClaim[]
  relations: WikiRelation[]
}

export interface WikiEntitySummary {
  id: string
  dunId: string | null
  slug: string
  title: string
  type: string
  tldr: string | null
  tags: string[]
  status: string
  claimCount: number
  createdAt: number
  updatedAt: number
}

/** Library Processor 导出的 JSON 格式 */
export interface LibraryExport {
  version: string
  exported_at: string
  source: string
  scan_paths: string[]
  stats: {
    files_scanned: number
    files_parsed: number
    duplicates_removed: number
    ingest_units: number
    entities_extracted: number
    claims_extracted: number
    relations_extracted: number
    total_tokens: { input: number; output: number }
  }
  entities: LibraryExportEntity[]
  documents: LibraryExportDocument[]
}

export interface LibraryExportEntity {
  title: string
  type: string
  tldr: string
  tags: string[]
  slug: string
  claims: Array<{
    content: string
    type: string
    value?: string | null
    trend?: string | null
    confidence: number
    evidence: { source_name: string; chunk_text?: string | null }
  }>
  relations: Array<{
    target_title: string
    type: string
    strength: number
    description: string
  }>
}

export interface LibraryExportDocument {
  name: string
  path: string
  doc_type: string
  size_bytes: number
  sections_count: number
  entities_generated: string[]
}
