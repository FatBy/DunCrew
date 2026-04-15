"""数据模型: Library 全模块共用的 dataclass 定义"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional


# ──────────────────────────────────────────────
# Scanner
# ──────────────────────────────────────────────

@dataclass
class FileInfo:
    path: str               # 绝对路径
    relative_path: str      # 相对于扫描根目录
    name: str               # 文件名
    extension: str          # 扩展名 (含 '.', e.g. '.pdf')
    size_bytes: int
    modified_at: float      # os.stat st_mtime
    content_hash: str       # SHA-256 hex
    mime_type: str
    parent_dir: str         # 直接上层目录名 (主题分组用)


@dataclass
class ScanDiff:
    added: list[FileInfo] = field(default_factory=list)
    modified: list[FileInfo] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)


# ──────────────────────────────────────────────
# Parser
# ──────────────────────────────────────────────

@dataclass
class Section:
    title: str
    content: str            # Markdown
    level: int              # 标题层级 1-6
    char_count: int
    page_range: Optional[tuple[int, int]] = None
    has_tables: bool = False
    has_data: bool = False


@dataclass
class DocumentMetadata:
    source_path: str
    source_name: str
    file_size: int
    created_at: Optional[str] = None
    modified_at: str = ""
    author: Optional[str] = None
    page_count: Optional[int] = None
    word_count: int = 0
    content_hash: str = ""


@dataclass
class ParseResult:
    title: str
    content: str                # Markdown 正文
    summary: str                # 前 500 字
    sections: list[Section] = field(default_factory=list)
    key_data: list[str] = field(default_factory=list)
    metadata: DocumentMetadata = field(default_factory=lambda: DocumentMetadata("", "", 0))
    doc_type: str = "general"   # report|proposal|research|data|slides|general
    parse_time_ms: int = 0
    parser_name: str = ""


# ──────────────────────────────────────────────
# Deduplicator
# ──────────────────────────────────────────────

@dataclass
class DuplicateGroup:
    kept: ParseResult
    dropped: list[ParseResult] = field(default_factory=list)
    reason: str = ""            # hash_exact | high_similarity | cross_format
    similarity: float = 1.0


@dataclass
class DeduplicateStats:
    total_input: int = 0
    unique_output: int = 0
    hash_duplicates: int = 0
    similarity_duplicates: int = 0
    cross_format_duplicates: int = 0


@dataclass
class DeduplicateResult:
    unique: list[ParseResult] = field(default_factory=list)
    duplicates: list[DuplicateGroup] = field(default_factory=list)
    stats: DeduplicateStats = field(default_factory=DeduplicateStats)


# ──────────────────────────────────────────────
# Grouper
# ──────────────────────────────────────────────

@dataclass
class IngestUnit:
    id: str
    content: str                # LLM 输入文本 (含元数据头)
    char_count: int = 0
    source_documents: list[str] = field(default_factory=list)
    source_sections: list[str] = field(default_factory=list)
    doc_type: str = "general"
    context_header: str = ""


# ──────────────────────────────────────────────
# WikiBridge
# ──────────────────────────────────────────────

@dataclass
class EntitySummary:
    """Wiki Entity 索引摘要 (缓存用)"""
    id: str
    title: str
    type: str           # concept | topic | pattern
    tldr: str = ""
    slug: str = ""
    tags: list[str] = field(default_factory=list)


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass
class BatchProgress:
    total: int = 0
    processed: int = 0
    succeeded: int = 0
    failed: int = 0
    skipped: int = 0
    entities_created: int = 0
    entities_updated: int = 0
    claims_created: int = 0
    total_tokens: TokenUsage = field(default_factory=TokenUsage)
    current_file: str = ""
    current_stage: str = ""

    @property
    def progress_percent(self) -> float:
        return (self.processed / self.total * 100) if self.total else 0


@dataclass
class BatchResult:
    progress: BatchProgress = field(default_factory=BatchProgress)
    errors: list[dict] = field(default_factory=list)
    duration_seconds: float = 0
