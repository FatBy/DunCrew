"""进度追踪: 记录文档处理状态到 duncrew.db library_* 表"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Optional

from .models import DeduplicateResult, FileInfo, ParseResult

logger = logging.getLogger(__name__)


# ── 建表 SQL ──

LIBRARY_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS library_documents (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    extension TEXT,
    size_bytes INTEGER,
    modified_at INTEGER,
    doc_type TEXT,
    parsed_at INTEGER,
    parser_name TEXT,
    cleaned_char_count INTEGER,
    content_preview TEXT,
    duplicate_of TEXT,
    wiki_status TEXT DEFAULT 'pending',
    wiki_entity_ids TEXT,
    wiki_claim_count INTEGER DEFAULT 0,
    error_message TEXT,
    library_id TEXT DEFAULT 'default',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_scan_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_path TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scanned_at INTEGER NOT NULL,
    library_id TEXT DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS library_ingest_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id TEXT,
    action TEXT,
    target TEXT,
    status TEXT,
    message TEXT,
    wiki_entity_id TEXT,
    llm_input_tokens INTEGER,
    llm_output_tokens INTEGER,
    duration_ms INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    scan_paths TEXT,
    include_patterns TEXT,
    exclude_patterns TEXT,
    dun_id TEXT,
    llm_model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_ingest_at INTEGER
);
"""


class Tracker:
    """进度追踪器: 操作 library_* 表"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._ensure_tables()

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")
        return conn

    def _ensure_tables(self):
        """建表 (幂等)"""
        conn = self._get_conn()
        try:
            conn.executescript(LIBRARY_TABLES_SQL)
            conn.commit()
        finally:
            conn.close()

    # ── 扫描记录 ──

    def save_scan_records(
        self, files: list[FileInfo], scan_root: str, library_id: str = "default"
    ):
        """保存扫描记录 (全量替换该 scan_path 下的记录), 分块写入避免长时间锁表"""
        CHUNK_SIZE = 500
        conn = self._get_conn()
        now = int(time.time() * 1000)
        try:
            # autocommit 模式: 单条 DELETE 自动提交
            conn.execute(
                "DELETE FROM library_scan_records WHERE scan_path = ? AND library_id = ?",
                (scan_root, library_id),
            )

            rows = [
                (scan_root, f.path, f.content_hash, now, library_id)
                for f in files
            ]
            for i in range(0, len(rows), CHUNK_SIZE):
                chunk = rows[i : i + CHUNK_SIZE]
                conn.execute("BEGIN")
                conn.executemany(
                    """INSERT INTO library_scan_records
                       (scan_path, file_path, content_hash, scanned_at, library_id)
                       VALUES (?, ?, ?, ?, ?)""",
                    chunk,
                )
                conn.execute("COMMIT")
        finally:
            conn.close()

    def get_previous_scan(
        self, scan_root: str, library_id: str = "default"
    ) -> dict[str, str]:
        """获取上次扫描记录: {file_path: content_hash}"""
        conn = self._get_conn()
        try:
            rows = conn.execute(
                "SELECT file_path, content_hash FROM library_scan_records "
                "WHERE scan_path = ? AND library_id = ?",
                (scan_root, library_id),
            ).fetchall()
            return {r["file_path"]: r["content_hash"] for r in rows}
        finally:
            conn.close()

    # ── 文档记录 ──

    def save_document(
        self,
        file_info: FileInfo,
        parse_result: Optional[ParseResult] = None,
        library_id: str = "default",
    ):
        """保存/更新文档处理记录"""
        conn = self._get_conn()
        now = int(time.time() * 1000)
        try:
            conn.execute(
                """INSERT OR REPLACE INTO library_documents
                   (id, path, name, extension, size_bytes, modified_at,
                    doc_type, parsed_at, parser_name, cleaned_char_count,
                    content_preview, wiki_status, library_id, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)""",
                (
                    file_info.content_hash,
                    file_info.path,
                    file_info.name,
                    file_info.extension,
                    file_info.size_bytes,
                    int(file_info.modified_at * 1000),
                    parse_result.doc_type if parse_result else None,
                    now if parse_result else None,
                    parse_result.parser_name if parse_result else None,
                    len(parse_result.content) if parse_result else None,
                    parse_result.content[:500] if parse_result else None,
                    library_id,
                    now,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    def mark_duplicate(
        self, file_hash: str, duplicate_of: str
    ):
        """标记为重复文档"""
        conn = self._get_conn()
        try:
            conn.execute(
                "UPDATE library_documents SET duplicate_of = ?, wiki_status = 'skipped' WHERE id = ?",
                (duplicate_of, file_hash),
            )
            conn.commit()
        finally:
            conn.close()

    def mark_ingested(
        self, file_hash: str, entity_ids: list[str], claim_count: int
    ):
        """标记为已摄入"""
        conn = self._get_conn()
        try:
            conn.execute(
                """UPDATE library_documents
                   SET wiki_status = 'ingested',
                       wiki_entity_ids = ?,
                       wiki_claim_count = ?
                   WHERE id = ?""",
                (json.dumps(entity_ids), claim_count, file_hash),
            )
            conn.commit()
        finally:
            conn.close()

    def mark_error(self, file_hash: str, error_message: str):
        """标记处理错误"""
        conn = self._get_conn()
        try:
            conn.execute(
                "UPDATE library_documents SET wiki_status = 'error', error_message = ? WHERE id = ?",
                (error_message[:1000], file_hash),
            )
            conn.commit()
        finally:
            conn.close()

    # ── 日志 ──

    def log(
        self,
        action: str,
        target: str,
        status: str = "success",
        message: str = "",
        wiki_entity_id: Optional[str] = None,
        llm_input_tokens: int = 0,
        llm_output_tokens: int = 0,
        duration_ms: int = 0,
        library_id: str = "default",
    ):
        """写入处理日志"""
        conn = self._get_conn()
        now = int(time.time() * 1000)
        try:
            conn.execute(
                """INSERT INTO library_ingest_log
                   (library_id, action, target, status, message,
                    wiki_entity_id, llm_input_tokens, llm_output_tokens,
                    duration_ms, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    library_id, action, target, status, message,
                    wiki_entity_id, llm_input_tokens, llm_output_tokens,
                    duration_ms, now,
                ),
            )
            conn.commit()
        finally:
            conn.close()

    # ── 查询 ──

    def get_stats(self, library_id: str = "default") -> dict:
        """获取处理统计"""
        conn = self._get_conn()
        try:
            total = conn.execute(
                "SELECT COUNT(*) FROM library_documents WHERE library_id = ?",
                (library_id,),
            ).fetchone()[0]

            by_status = {}
            for row in conn.execute(
                "SELECT wiki_status, COUNT(*) as cnt FROM library_documents "
                "WHERE library_id = ? GROUP BY wiki_status",
                (library_id,),
            ):
                by_status[row["wiki_status"]] = row["cnt"]

            by_type = {}
            for row in conn.execute(
                "SELECT doc_type, COUNT(*) as cnt FROM library_documents "
                "WHERE library_id = ? AND doc_type IS NOT NULL GROUP BY doc_type",
                (library_id,),
            ):
                by_type[row["doc_type"]] = row["cnt"]

            by_ext = {}
            for row in conn.execute(
                "SELECT extension, COUNT(*) as cnt FROM library_documents "
                "WHERE library_id = ? GROUP BY extension",
                (library_id,),
            ):
                by_ext[row["extension"]] = row["cnt"]

            token_stats = conn.execute(
                "SELECT COALESCE(SUM(llm_input_tokens), 0), COALESCE(SUM(llm_output_tokens), 0) "
                "FROM library_ingest_log WHERE library_id = ?",
                (library_id,),
            ).fetchone()

            return {
                "total_documents": total,
                "by_status": by_status,
                "by_type": by_type,
                "by_extension": by_ext,
                "total_input_tokens": token_stats[0],
                "total_output_tokens": token_stats[1],
            }
        finally:
            conn.close()

    def get_documents(
        self,
        library_id: str = "default",
        status: Optional[str] = None,
        extension: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """查询文档列表"""
        conn = self._get_conn()
        try:
            sql = "SELECT * FROM library_documents WHERE library_id = ?"
            params: list = [library_id]

            if status:
                sql += " AND wiki_status = ?"
                params.append(status)
            if extension:
                sql += " AND extension = ?"
                params.append(extension)

            sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])

            rows = conn.execute(sql, params).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
