"""DunCrew Server - Database Initialization and Memory Capacity Management"""
from __future__ import annotations

import json
import time
import uuid
import threading
import sqlite3
from pathlib import Path

from server.constants import HAS_HYBRID_SEARCH
from server.state import (
    _db_lock, _embedding_manager,
    _CATEGORY_CAPACITY_LIMITS, _MERGE_BATCH_SIZE, _CAPACITY_CHECK_INTERVAL,
)

# 条件导入 hybrid_search 符号
if HAS_HYBRID_SEARCH:
    from hybrid_search import (
        HybridSearchEngine, EmbeddingEngine,
        ensure_vector_table, index_memory_vectors,
    )

def init_sqlite_db(db_path: Path) -> sqlite3.Connection:
    """初始化 SQLite 数据库，创建 V2 所需的表"""
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    conn.executescript("""
        -- 会话表
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL DEFAULT '',
            type TEXT NOT NULL DEFAULT 'general',
            dun_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_message_preview TEXT DEFAULT ''
        );

        -- 消息表
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            metadata TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

        -- 检查点表 (断点续作)
        CREATE TABLE IF NOT EXISTS checkpoints (
            session_id TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        -- 记忆表 (FTS5 全文搜索)
        CREATE TABLE IF NOT EXISTS memory (
            id TEXT PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'ephemeral',
            content TEXT NOT NULL,
            dun_id TEXT,
            tags TEXT DEFAULT '[]',
            metadata TEXT DEFAULT '{}',
            created_at INTEGER NOT NULL,
            deleted_at INTEGER,
            category TEXT DEFAULT 'uncategorized'
        );
        CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source);

        -- FTS5 虚拟表 (全文搜索)
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content,
            tags,
            content='memory',
            content_rowid='rowid'
        );

        -- 自动同步 FTS 索引的触发器
        CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
            INSERT INTO memory_fts(rowid, content, tags)
            VALUES (new.rowid, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content, tags)
            VALUES ('delete', old.rowid, old.content, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content, tags)
            VALUES ('delete', old.rowid, old.content, old.tags);
            INSERT INTO memory_fts(rowid, content, tags)
            VALUES (new.rowid, new.content, new.tags);
        END;

        -- 评分表
        CREATE TABLE IF NOT EXISTS dun_scoring (
            dun_id TEXT PRIMARY KEY,
            scoring_data TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- ============================================
        -- Wiki 知识图谱 (V8: Entity-Claim-Evidence 三层模型)
        -- ============================================

        -- 概念实体
        CREATE TABLE IF NOT EXISTS wiki_entity (
            id          TEXT PRIMARY KEY,       -- UUID
            dun_id      TEXT,                   -- NULL = 全局实体
            slug        TEXT,                   -- 可读标识 'emotion-consumption'
            title       TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'concept',  -- concept | topic | pattern
            tldr        TEXT,
            tags        TEXT DEFAULT '[]',      -- JSON array
            status      TEXT DEFAULT 'active',  -- active | archived
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_entity_dun ON wiki_entity(dun_id);
        CREATE INDEX IF NOT EXISTS idx_wiki_entity_status ON wiki_entity(status);

        -- 原子断言 (挂在 Entity 下)
        CREATE TABLE IF NOT EXISTS wiki_claim (
            id              TEXT PRIMARY KEY,       -- UUID
            entity_id       TEXT NOT NULL REFERENCES wiki_entity(id) ON DELETE CASCADE,
            content         TEXT NOT NULL,           -- 断言内容
            type            TEXT,                    -- metric | insight | pattern | fact
            value           TEXT,                    -- 数值型 claim: '+2.66亿'
            trend           TEXT,                    -- up | down | stable
            confidence      REAL DEFAULT 0.8,
            status          TEXT DEFAULT 'active',   -- active | superseded | conflicted
            conflict_with   TEXT,                    -- 冲突对方的 claim_id
            source_ingest_id TEXT,                   -- 哪次 ingest 创建/更新
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_claim_entity ON wiki_claim(entity_id);
        CREATE INDEX IF NOT EXISTS idx_wiki_claim_status ON wiki_claim(status);

        -- 证据/溯源 (挂在 Claim 下)
        CREATE TABLE IF NOT EXISTS wiki_evidence (
            id          TEXT PRIMARY KEY,       -- UUID
            claim_id    TEXT NOT NULL REFERENCES wiki_claim(id) ON DELETE CASCADE,
            source_name TEXT NOT NULL,          -- '《2026全球AI用户报告》'
            chunk_text  TEXT,                   -- 原始文本片段 (nullable, 第一版可不填)
            timestamp   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_evidence_claim ON wiki_evidence(claim_id);

        -- 实体间关系
        CREATE TABLE IF NOT EXISTS wiki_relation (
            id          TEXT PRIMARY KEY,       -- UUID
            source_id   TEXT NOT NULL REFERENCES wiki_entity(id) ON DELETE CASCADE,
            target_id   TEXT NOT NULL REFERENCES wiki_entity(id) ON DELETE CASCADE,
            type        TEXT NOT NULL,          -- related_to | contradicts | subtopic_of
            strength    REAL DEFAULT 0.5,       -- 关系强度 0-1
            description TEXT,
            created_at  INTEGER NOT NULL,
            UNIQUE(source_id, target_id, type)
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_relation_source ON wiki_relation(source_id);
        CREATE INDEX IF NOT EXISTS idx_wiki_relation_target ON wiki_relation(target_id);

        -- Ingest 操作日志 (审计追踪)
        CREATE TABLE IF NOT EXISTS wiki_ingest_log (
            id                TEXT PRIMARY KEY,    -- UUID
            dun_id            TEXT,
            input_text        TEXT,                 -- 触发 ingest 的原始认知
            output_json       TEXT,                 -- LLM 输出的完整 JSON
            entities_affected TEXT,                 -- JSON array of entity IDs
            created_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_wiki_ingest_dun ON wiki_ingest_log(dun_id);
    """)

    # V6: 安全地添加 dun_id 列 (如果不存在) — memory 表
    try:
        conn.execute("SELECT dun_id FROM memory LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE memory ADD COLUMN dun_id TEXT")
        print("[SQLite] Added 'dun_id' column to memory table")

    # V6: 从旧 nexus_id 列迁移数据到 dun_id (如果 nexus_id 列存在)
    try:
        conn.execute("SELECT nexus_id FROM memory LIMIT 1")
        # nexus_id 列存在，把有值的数据拷贝到 dun_id
        migrated = conn.execute(
            "UPDATE memory SET dun_id = nexus_id WHERE nexus_id IS NOT NULL AND nexus_id != '' AND (dun_id IS NULL OR dun_id = '')"
        ).rowcount
        if migrated > 0:
            print(f"[SQLite] Migrated {migrated} rows: nexus_id → dun_id in memory table")
    except sqlite3.OperationalError:
        pass  # nexus_id 列不存在，跳过

    # V6: 安全地添加 dun_id 列 (如果不存在) — sessions 表
    try:
        conn.execute("SELECT dun_id FROM sessions LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE sessions ADD COLUMN dun_id TEXT")
        print("[SQLite] Added 'dun_id' column to sessions table")

    # 创建 dun_id 索引 (在确保列存在之后)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memory_dun ON memory(dun_id)")

    # V3: 安全地添加 confidence 列 (如果不存在)
    try:
        conn.execute("SELECT confidence FROM memory LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE memory ADD COLUMN confidence REAL DEFAULT 0.5")
        print("[SQLite] Added 'confidence' column to memory table")

    # V5: 安全地添加 deleted_at 列 (软删除)
    try:
        conn.execute("SELECT deleted_at FROM memory LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE memory ADD COLUMN deleted_at INTEGER")
        print("[SQLite] Added 'deleted_at' column to memory table")

    # V5: 安全地添加 category 列
    try:
        conn.execute("SELECT category FROM memory LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE memory ADD COLUMN category TEXT DEFAULT 'uncategorized'")
        print("[SQLite] Added 'category' column to memory table")

    conn.commit()

    # V6: 向后兼容：迁移旧表 nexus_scoring 的数据到 dun_scoring
    try:
        cursor = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='nexus_scoring'")
        if cursor.fetchone():
            # 检测 nexus_scoring 的列名（可能是 nexus_id 或 dun_id）
            ns_cols = [c[1] for c in conn.execute("PRAGMA table_info(nexus_scoring)").fetchall()]
            id_col = 'dun_id' if 'dun_id' in ns_cols else 'nexus_id'
            # 将 nexus_scoring 数据复制到 dun_scoring（跳过已存在的）
            migrated = conn.execute(f"""
                INSERT OR IGNORE INTO dun_scoring (dun_id, scoring_data, updated_at)
                SELECT {id_col}, scoring_data, updated_at FROM nexus_scoring
            """).rowcount
            if migrated:
                print(f"[SQLite] Migrated {migrated} rows from nexus_scoring → dun_scoring")
            conn.commit()
    except Exception as e:
        print(f"[SQLite] nexus_scoring migration note: {e}")

    # V6: dun_scoring 表列名迁移 nexus_id → dun_id
    try:
        conn.execute("SELECT dun_id FROM dun_scoring LIMIT 1")
    except sqlite3.OperationalError:
        try:
            conn.execute("SELECT nexus_id FROM dun_scoring LIMIT 1")
            # 旧列名存在，用 ALTER TABLE RENAME COLUMN (SQLite 3.25+)
            conn.execute("ALTER TABLE dun_scoring RENAME COLUMN nexus_id TO dun_id")
            print("[SQLite] Renamed column nexus_id → dun_id in dun_scoring table")
            conn.commit()
        except Exception:
            pass  # 表不存在或其他错误

    # V4: 创建向量存储表 (混合搜索)
    if HAS_HYBRID_SEARCH:
        ensure_vector_table(conn)

    print(f"[SQLite] Database initialized at {db_path}")

    # V9: Library 模块表 (知识库管线)
    from server.library.tracker import LIBRARY_TABLES_SQL
    conn.executescript(LIBRARY_TABLES_SQL)
    conn.commit()

    # V5: 启动容量合并定时任务 (daemon 线程)
    threading.Thread(
        target=_memory_capacity_merge_loop,
        args=(conn,),
        daemon=True,
    ).start()

    return conn

def _memory_capacity_merge_loop(conn: sqlite3.Connection) -> None:
    """后台定时检查各 category 容量，超限时合并或淘汰。

    策略：
    - preference / project (长期记忆): 超限时取最旧的 5 条合并为 1 条
    - discovery / uncategorized (短期记忆): 超限时软删除最旧的多余条目
    """
    print("[MemoryCapacity] Merge loop started (interval: 24h, initial check in 60s)")
    # 启动后延迟 60 秒再首次检查，等数据库完全就绪
    time.sleep(60)

    while True:
        try:
            _run_capacity_check(conn)
        except Exception as e:
            print(f"[MemoryCapacity] Error during capacity check: {e}")
        time.sleep(_CAPACITY_CHECK_INTERVAL)


def _run_capacity_check(conn: sqlite3.Connection) -> None:
    """单次容量检查和处理

    注意：exec_trace 记录被排除在容量管理之外，因为它们是知识编译的原材料。
    由知识编译管道在编译完成后负责清理。
    """
    now_ms = int(time.time() * 1000)

    for category, limit in _CATEGORY_CAPACITY_LIMITS.items():
        with _db_lock:
            row = conn.execute(
                "SELECT COUNT(*) as cnt FROM memory WHERE category = ? AND deleted_at IS NULL AND source != 'exec_trace'",
                (category,),
            ).fetchone()
        count = row['cnt'] if row else 0

        if count <= limit:
            continue

        excess = count - limit
        print(f"[MemoryCapacity] Category '{category}': {count}/{limit} (+{excess} over limit)")

        if category in ('preference', 'project'):
            # 合并策略：取最旧的 _MERGE_BATCH_SIZE 条 → 合并为 1 条
            _merge_oldest(conn, category, now_ms)
        else:
            # 淘汰策略：软删除最旧的多余条目
            _soft_delete_oldest(conn, category, excess, now_ms)


def _merge_oldest(conn: sqlite3.Connection, category: str, now_ms: int) -> None:
    """取最旧的 N 条同类记忆，合并内容为 1 条新记忆，软删除原始条目。

    因为后端无 LLM 访问权限，使用文本拼接作为合并策略。
    这些记忆本身就是短句认知（如 "用户偏好 pnpm"），拼接后仍然可读。
    """
    with _db_lock:
        rows = conn.execute(
            "SELECT id, content, tags, metadata, dun_id FROM memory "
            "WHERE category = ? AND deleted_at IS NULL "
            "ORDER BY created_at ASC LIMIT ?",
            (category, _MERGE_BATCH_SIZE),
        ).fetchall()

    if len(rows) < 2:
        return

    # 提取各条内容，去重
    contents: list[str] = []
    seen: set[str] = set()
    all_tags: set[str] = set()
    source_ids: list[str] = []

    for row in rows:
        text = row['content'].strip()
        # 简单去重：完全相同的内容跳过
        if text.lower() not in seen:
            contents.append(text)
            seen.add(text.lower())
        source_ids.append(row['id'])
        try:
            tags = json.loads(row['tags'] or '[]')
            if isinstance(tags, list):
                all_tags.update(tags)
        except (json.JSONDecodeError, TypeError):
            pass

    if not contents:
        return

    # 合并内容：用分号连接短句
    merged_content = '；'.join(contents)
    # 过长时截断
    if len(merged_content) > 500:
        merged_content = merged_content[:497] + '...'

    merged_id = f"mem-merged-{uuid.uuid4().hex[:12]}"
    merged_tags = json.dumps(list(all_tags | {'merged', f'merged_from_{len(source_ids)}'}))
    merged_metadata = json.dumps({
        'category': category,
        'merged_from': source_ids,
        'merged_at': now_ms,
    })

    with _db_lock:
        # 写入合并后的新条目
        conn.execute(
            "INSERT INTO memory (id, source, content, dun_id, tags, metadata, created_at, category) "
            "VALUES (?, 'memory', ?, NULL, ?, ?, ?, ?)",
            (merged_id, merged_content, merged_tags, merged_metadata, now_ms, category),
        )
        # 软删除原始条目
        placeholders = ','.join('?' * len(source_ids))
        conn.execute(
            f"UPDATE memory SET deleted_at = ? WHERE id IN ({placeholders})",
            [now_ms] + source_ids,
        )
        conn.commit()

    print(f"[MemoryCapacity] Merged {len(source_ids)} '{category}' memories → {merged_id}")


def _soft_delete_oldest(conn: sqlite3.Connection, category: str, excess: int, now_ms: int) -> None:
    """软删除某类中最旧的 excess 条记忆（排除 exec_trace，它们由知识编译管道管理）"""
    with _db_lock:
        rows = conn.execute(
            "SELECT id FROM memory "
            "WHERE category = ? AND deleted_at IS NULL AND source != 'exec_trace' "
            "ORDER BY created_at ASC LIMIT ?",
            (category, excess),
        ).fetchall()

        if not rows:
            return

        ids = [r['id'] for r in rows]
        placeholders = ','.join('?' * len(ids))
        conn.execute(
            f"UPDATE memory SET deleted_at = ? WHERE id IN ({placeholders})",
            [now_ms] + ids,
        )
        conn.commit()

    print(f"[MemoryCapacity] Soft-deleted {len(ids)} oldest '{category}' memories")


def get_hybrid_engine():
    """获取混合搜索引擎 (懒初始化, 模型不存在时返回 None)"""
    import server.state as _st
    if not HAS_HYBRID_SEARCH:
        return None
    if _st._hybrid_engine is not None:
        return _st._hybrid_engine
    model_dir = _embedding_manager._get_model_dir()
    if not model_dir.exists():
        return None
    _st._embedding_engine = EmbeddingEngine(str(model_dir))
    _st._hybrid_engine = HybridSearchEngine(
        embedding_engine=_st._embedding_engine,
        reranker_engine=None,
        llm_call_fn=None,
    )
    return _st._hybrid_engine
