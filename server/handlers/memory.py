"""DunCrew Server - Memory API Mixin"""
from __future__ import annotations

import json
import time
import uuid
import threading

from server.state import _db_lock
import server.state as _state
from server.db import get_hybrid_engine
from server.constants import HAS_HYBRID_SEARCH
try:
    from hybrid_search import index_memory_vectors
except ImportError:
    pass

class MemoryMixin:
    """Memory API Mixin"""

    # ---- Memory ----

    @staticmethod
    def safe_parse_tags(raw_tags):
        """安全解析 tags JSON 字符串，确保返回 list"""
        if not raw_tags:
            return []
        try:
            parsed = json.loads(raw_tags)
            return parsed if isinstance(parsed, list) else []
        except (json.JSONDecodeError, TypeError):
            return []

    def handle_memory_soft_delete(self, mem_id: str):
        """DELETE /api/memory/{id} - 软删除记忆"""
        db = self._get_db()
        now_ms = int(time.time() * 1000)
        with _db_lock:
            cursor = db.execute("UPDATE memory SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL", (now_ms, mem_id))
            db.commit()
        if cursor.rowcount > 0:
            self.send_json({'status': 'ok', 'id': mem_id})
        else:
            self.send_error_json(f'Memory {mem_id} not found or already deleted', 404)

    def handle_memory_search_grouped(self, data: dict):
        """POST /api/memory/search-grouped - 按 source 分组搜索记忆"""
        db = self._get_db()
        query_text = data.get('query', '') or data.get('q', '')
        dun_id = data.get('dunId') or data.get('nexusId')
        groups = data.get('groups') or data.get('sourceLimits', {})
        # groups/sourceLimits 格式: { "memory": 10, "exec_trace": 5, "session": 3 }

        result: dict[str, list] = {}

        for source_name, max_count in groups.items():
            max_count = min(int(max_count), 100)
            sql = "SELECT * FROM memory WHERE source = ? AND deleted_at IS NULL"
            params: list = [source_name]

            if dun_id:
                if dun_id == '__system__':
                    sql += " AND (dun_id IS NULL OR dun_id = '')"
                else:
                    sql += " AND dun_id = ?"
                    params.append(dun_id)

            if query_text and query_text != '*':
                sql += " AND content LIKE ?"
                params.append(f"%{query_text}%")

            sql += " ORDER BY created_at DESC LIMIT ?"
            params.append(max_count)

            rows = db.execute(sql, params).fetchall()
            result[source_name] = [{
                'id': r['id'], 'source': r['source'], 'content': r['content'],
                'snippet': r['content'],
                'dunId': r['dun_id'],
                'tags': self.safe_parse_tags(r['tags']),
                'metadata': json.loads(r['metadata'] or '{}'),
                'createdAt': r['created_at'],
                'confidence': r['confidence'] if 'confidence' in r.keys() else 0.5,
                'category': r['category'] if 'category' in r.keys() else 'uncategorized',
                'score': 1.0,
            } for r in rows]

        self.send_json(result)

    def handle_memory_write(self, data: dict):
        """POST /api/memory/write - 写入单条记忆"""
        db = self._get_db()
        mem_id = f"mem-{uuid.uuid4().hex[:12]}"
        source = data.get('source', 'ephemeral')
        content = data.get('content', '')
        dun_id = data.get('dunId') or data.get('nexusId')
        tags = json.dumps(data.get('tags', []), ensure_ascii=False)
        metadata = json.dumps(data.get('metadata', {}), ensure_ascii=False)
        confidence = data.get('confidence', 0.5)
        category = data.get('category', 'uncategorized')
        now = int(time.time() * 1000)
        
        with _db_lock:
            db.execute("INSERT INTO memory (id, source, content, dun_id, tags, metadata, created_at, confidence, category) VALUES (?,?,?,?,?,?,?,?,?)",
                       (mem_id, source, content, dun_id, tags, metadata, now, confidence, category))
            db.commit()

        # V4: 异步生成向量索引
        if HAS_HYBRID_SEARCH and _state._embedding_engine:
            threading.Thread(
                target=index_memory_vectors,
                args=(db, mem_id, content, _state._embedding_engine, _db_lock),
                daemon=True,
            ).start()

        self.send_json({'status': 'ok', 'id': mem_id})

    def handle_memory_write_batch(self, data: dict):
        """POST /api/memory/write-batch - 批量写入记忆"""
        db = self._get_db()
        entries = data.get('entries', [])
        count = 0
        now = int(time.time() * 1000)
        written_ids: list[tuple[str, str]] = []  # (mem_id, content) for async indexing
        with _db_lock:
            for entry in entries:
                mem_id = f"mem-{uuid.uuid4().hex[:12]}"
                content = entry.get('content', '')
                db.execute("INSERT INTO memory (id, source, content, dun_id, tags, metadata, created_at) VALUES (?,?,?,?,?,?,?)",
                           (mem_id, entry.get('source', 'ephemeral'), content,
                            entry.get('dunId') or entry.get('nexusId'), json.dumps(entry.get('tags', []), ensure_ascii=False),
                            json.dumps(entry.get('metadata', {}), ensure_ascii=False), now))
                written_ids.append((mem_id, content))
                count += 1
            db.commit()

        # V4: 异步批量向量索引
        if HAS_HYBRID_SEARCH and _state._embedding_engine:
            for mid, content in written_ids:
                if content:
                    threading.Thread(
                        target=index_memory_vectors,
                        args=(db, mid, content, _state._embedding_engine, _db_lock),
                        daemon=True,
                    ).start()

        self.send_json({'status': 'ok', 'count': count})

    def handle_memory_search(self, query: dict):
        """GET /api/memory/search?q=xxx&source=xxx&dunId=xxx&limit=20&hybrid=1"""
        db = self._get_db()
        q = query.get('q', [''])[0]
        source = query.get('source', [None])[0]
        dun_id = query.get('dunId', query.get('nexusId', [None]))[0]
        limit = min(int(query.get('limit', ['20'])[0]), 500)  # 上限 500
        use_hybrid = query.get('hybrid', ['1'])[0] == '1'
        since = query.get('since', [None])[0]  # ISO 时间字符串或 ms 时间戳

        # 通配符视为空查询，跳过混合搜索
        if q == '*':
            q = ''

        # V4: 优先使用混合搜索
        engine = get_hybrid_engine()
        if q and use_hybrid and engine:
            try:
                results = engine.search(
                    conn=db, query=q, dun_id=dun_id, limit=limit,
                    use_expansion=True, use_reranker=False,
                )
                self.send_json(results)
                return
            except Exception as error:
                print(f"[HybridSearch] Fallback to FTS5: {error}")

        # 降级: 原有 FTS5 逻辑
        if q:
            # FTS5 搜索
            fts_sql = """
                SELECT m.*, rank
                FROM memory_fts fts
                JOIN memory m ON m.rowid = fts.rowid
                WHERE memory_fts MATCH ?
                AND m.deleted_at IS NULL
            """
            params: list = [q]
            if source:
                fts_sql += " AND m.source = ?"
                params.append(source)
            if dun_id:
                if dun_id == '__system__':
                    fts_sql += " AND (m.dun_id IS NULL OR m.dun_id = '')"
                else:
                    fts_sql += " AND m.dun_id = ?"
                    params.append(dun_id)
            if since:
                fts_sql += " AND m.created_at >= ?"
                params.append(since)
            fts_sql += " ORDER BY rank LIMIT ?"
            params.append(limit)
            
            try:
                rows = db.execute(fts_sql, params).fetchall()
            except Exception:
                # FTS 查询失败时降级到 LIKE 搜索
                like_sql = "SELECT * FROM memory WHERE content LIKE ? AND deleted_at IS NULL"
                like_params: list = [f"%{q}%"]
                if dun_id:
                    if dun_id == '__system__':
                        like_sql += " AND (dun_id IS NULL OR dun_id = '')"
                    else:
                        like_sql += " AND dun_id = ?"
                        like_params.append(dun_id)
                if since:
                    like_sql += " AND created_at >= ?"
                    like_params.append(since)
                like_sql += " ORDER BY created_at DESC LIMIT ?"
                like_params.append(limit)
                rows = db.execute(like_sql, like_params).fetchall()
        else:
            sql = "SELECT * FROM memory WHERE deleted_at IS NULL"
            params = []
            if source:
                sql += " AND source = ?"
                params.append(source)
            if dun_id:
                if dun_id == '__system__':
                    sql += " AND (dun_id IS NULL OR dun_id = '')"
                else:
                    sql += " AND dun_id = ?"
                    params.append(dun_id)
            if since:
                sql += " AND created_at >= ?"
                params.append(since)
            sql += " ORDER BY created_at DESC LIMIT ?"
            params.append(limit)
            rows = db.execute(sql, params).fetchall()
        
        results = [{
            'id': r['id'], 'source': r['source'], 'content': r['content'],
            'snippet': r['content'],
            'dunId': r['dun_id'],
            'tags': self.safe_parse_tags(r['tags']),
            'metadata': json.loads(r['metadata'] or '{}'), 'createdAt': r['created_at'],
            'confidence': r['confidence'] if 'confidence' in r.keys() else 0.5,
            'score': abs(r['rank']) if 'rank' in r.keys() else 1.0,
        } for r in rows]
        self.send_json(results)

    def handle_memory_stats(self):
        """GET /api/memory/stats"""
        db = self._get_db()
        total = db.execute("SELECT COUNT(*) as cnt FROM memory WHERE deleted_at IS NULL").fetchone()['cnt']
        by_source = {}
        for row in db.execute("SELECT source, COUNT(*) as cnt FROM memory WHERE deleted_at IS NULL GROUP BY source").fetchall():
            by_source[row['source']] = row['cnt']
        oldest = db.execute("SELECT MIN(created_at) as ts FROM memory WHERE deleted_at IS NULL").fetchone()['ts']
        newest = db.execute("SELECT MAX(created_at) as ts FROM memory WHERE deleted_at IS NULL").fetchone()['ts']
        self.send_json({'totalEntries': total, 'bySource': by_source, 'oldestEntry': oldest, 'newestEntry': newest})

    def handle_memory_by_dun(self, dun_id: str, limit: int):
        """GET /api/memory/dun/{dunId}?limit=20"""
        db = self._get_db()
        rows = db.execute("SELECT * FROM memory WHERE dun_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
                          (dun_id, limit)).fetchall()
        results = [{
            'id': r['id'], 'source': r['source'], 'content': r['content'],
            'snippet': r['content'],
            'dunId': r['dun_id'],
            'tags': self.safe_parse_tags(r['tags']),
            'createdAt': r['created_at'],
            'confidence': r['confidence'] if 'confidence' in r.keys() else 0.5,
            'metadata': json.loads(r['metadata']) if r['metadata'] else {},
            'score': 1.0,
        } for r in rows]
        self.send_json(results)

    def handle_compilable_duns(self):
        """GET /api/memory/compilable-duns - 返回有足够 exec_trace 数据可编译知识的 Dun 列表"""
        db = self._get_db()
        rows = db.execute(
            "SELECT dun_id, COUNT(*) as cnt FROM memory "
            "WHERE source IN ('exec_trace', 'memory') AND deleted_at IS NULL AND dun_id IS NOT NULL "
            "GROUP BY dun_id HAVING cnt >= 2 ORDER BY cnt DESC"
        ).fetchall()

        # 检查每个 Dun 是否已有 knowledge 文件
        result = []
        for row in rows:
            dun_id = row['dun_id']
            count = row['cnt']
            has_knowledge = False
            # 使用 _resolve_dun_dir 统一查找（支持 frontmatter name 匹配）
            dun_dir = self._resolve_dun_dir(dun_id)
            if dun_dir:
                k_dir = dun_dir / 'knowledge'
                if k_dir.exists():
                    md_files = [f for f in k_dir.iterdir() if f.suffix == '.md' and f.name != '_index.md']
                    if md_files:
                        has_knowledge = True
            result.append({
                'dunId': dun_id,
                'traceCount': count,
                'hasKnowledge': has_knowledge,
            })
        self.send_json(result)

    def handle_memory_prune(self, data: dict):
        """POST /api/memory/prune - 清理过期记忆"""
        db = self._get_db()
        older_than_days = data.get('olderThanDays', 30)
        cutoff = int((time.time() - older_than_days * 86400) * 1000)
        with _db_lock:
            cursor = db.execute(
                "UPDATE memory SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL",
                (datetime.now().isoformat(), cutoff)
            )
            db.commit()
        self.send_json({'status': 'ok', 'deleted': cursor.rowcount})

    def handle_memory_decay(self, data: dict):
        """POST /api/memory/decay - 批量衰减 L0 记忆置信度"""
        import math
        db = self._get_db()
        half_life_days = data.get('halfLifeDays', 30)
        min_confidence = data.get('minConfidence', 0.05)
        now_ms = int(time.time() * 1000)
        half_life_ms = half_life_days * 86400 * 1000

        with _db_lock:
            rows = db.execute(
                "SELECT id, confidence, created_at FROM memory WHERE source = 'memory' AND confidence > ?",
                (min_confidence,)
            ).fetchall()

            updated = 0
            cleaned = 0
            for row in rows:
                age_ms = now_ms - row['created_at']
                if age_ms <= 0:
                    continue
                decay_factor = math.pow(0.5, age_ms / half_life_ms)
                new_confidence = row['confidence'] * decay_factor

                if new_confidence < min_confidence:
                    db.execute(
                        "UPDATE memory SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL",
                        (datetime.now().isoformat(), row['id'])
                    )
                    cleaned += 1
                else:
                    db.execute("UPDATE memory SET confidence = ? WHERE id = ?",
                               (round(new_confidence, 4), row['id']))
                    updated += 1

            db.commit()

        self.send_json({'status': 'ok', 'updated': updated, 'cleaned': cleaned})

    # ---- Scoring ----

    def _tool_save_memory(self, args: dict) -> str:
        """保存记忆到文件 + SQLite 双写"""
        key = args.get('key', '')
        content = args.get('content', '')
        memory_type = args.get('type', 'general')
        dun_id = args.get('dunId') or args.get('nexusId', None)
        category = args.get('category', 'uncategorized')
        
        if not key or not content:
            raise ValueError("key 和 content 参数必填")
        
        # ---- 路径 1: MD 文件 (向后兼容) ----
        memory_dir = self.clawd_path / 'memory'
        memory_dir.mkdir(parents=True, exist_ok=True)
        
        today = datetime.now().strftime('%Y-%m-%d')
        memory_file = memory_dir / f'{today}.md'
        
        timestamp = datetime.now().strftime('%H:%M:%S')
        entry = f"\n## [{timestamp}] {key}\n- **类型**: {memory_type}\n- **内容**: {content}\n"
        
        with open(memory_file, 'a', encoding='utf-8') as f:
            f.write(entry)
        
        # ---- 路径 2: SQLite memory 表 (支持 FTS5 搜索) ----
        try:
            db = self._get_db()
            mem_id = f"mem-{uuid.uuid4().hex[:12]}"
            now_ms = int(time.time() * 1000)
            tags = json.dumps(['saveMemory', memory_type, key])
            # content 存完整文本，便于 FTS5 全文搜索命中
            full_content = f"[{key}] {content}"
            with _db_lock:
                db.execute(
                    "INSERT INTO memory (id, source, content, dun_id, tags, metadata, created_at, category, confidence) VALUES (?,?,?,?,?,?,?,?,?)",
                    (mem_id, 'memory', full_content, dun_id, tags,
                     json.dumps({'key': key, 'type': memory_type, 'category': category}), now_ms, category, 0.5)
                )
                db.commit()

            # V4: 异步生成向量索引
            if HAS_HYBRID_SEARCH and _state._embedding_engine:
                threading.Thread(
                    target=index_memory_vectors,
                    args=(db, mem_id, full_content, _state._embedding_engine, _db_lock),
                    daemon=True,
                ).start()
        except Exception as e:
            # SQLite 写入失败不影响主流程，MD 已写入
            print(f"[saveMemory] SQLite dual-write failed: {e}")
        
        return f"记忆已保存: {key} (类型: {memory_type})"
    
    def _tool_search_memory(self, args: dict) -> str:
        """检索历史记忆 - 混合搜索优先，FTS5 + MD 文件兜底"""
        query = args.get('query', '')
        dun_id = args.get('dunId') or args.get('nexusId', None)
        limit = int(args.get('limit', 5))
        
        if not query:
            raise ValueError("query 参数必填")

        # V4: 优先使用混合搜索
        engine = get_hybrid_engine()
        if engine:
            try:
                db = self._get_db()
                results = engine.search(
                    conn=db, query=query, dun_id=dun_id, limit=limit,
                    use_expansion=False,  # 工具调用时不做 expansion，节省延迟
                    use_reranker=False,
                )
                if results:
                    lines = []
                    for r in results:
                        ts = time.strftime('%Y-%m-%d %H:%M',
                                          time.localtime(r['createdAt'] / 1000)) if r.get('createdAt') else '未知'
                        lines.append(f"[{ts}] (score:{r['score']:.3f}) {r['snippet'][:200]}")
                    return f"找到 {len(results)} 条相关记忆:\n" + "\n".join(lines)
            except Exception as error:
                print(f"[searchMemory] Hybrid search failed, fallback: {error}")

        # 降级: 原有 FTS5 + MD 搜索逻辑
        results = []
        
        # ---- 路径 1: SQLite FTS5 搜索 (高优先级) ----
        try:
            db = self._get_db()
            fts_sql = """
                SELECT m.*, rank
                FROM memory_fts fts
                JOIN memory m ON m.rowid = fts.rowid
                WHERE memory_fts MATCH ?
                AND m.deleted_at IS NULL
            """
            params: list = [query]
            if dun_id:
                fts_sql += " AND m.dun_id = ?"
                params.append(dun_id)
            fts_sql += " ORDER BY rank LIMIT ?"
            params.append(limit)
            
            try:
                rows = db.execute(fts_sql, params).fetchall()
            except Exception:
                # FTS 语法错误时降级 LIKE
                like_sql = "SELECT * FROM memory WHERE content LIKE ? AND deleted_at IS NULL"
                like_params: list = [f"%{query}%"]
                if dun_id:
                    like_sql += " AND dun_id = ?"
                    like_params.append(dun_id)
                like_sql += " ORDER BY created_at DESC LIMIT ?"
                like_params.append(limit)
                rows = db.execute(like_sql, like_params).fetchall()
            
            for r in rows:
                ts = datetime.fromtimestamp(r['created_at'] / 1000).strftime('%Y-%m-%d %H:%M')
                results.append(f"[{ts}] {r['content'][:200]}")
        except Exception as e:
            print(f"[searchMemory] SQLite search failed: {e}")
        
        # ---- 路径 2: MD 文件搜索 (兜底 / 补充) ----
        if len(results) < limit:
            remaining = limit - len(results)
            memory_dir = self.clawd_path / 'memory'
            if memory_dir.exists():
                query_lower = query.lower()
                for memory_file in sorted(memory_dir.glob('*.md'), reverse=True)[:7]:
                    try:
                        content = memory_file.read_text(encoding='utf-8')
                        entries = content.split('\n## ')
                        for entry in entries:
                            if query_lower in entry.lower():
                                date = memory_file.stem
                                item = f"[{date}] {entry.strip()[:200]}"
                                if item not in results:  # 去重
                                    results.append(item)
                                    remaining -= 1
                                    if remaining <= 0:
                                        break
                    except Exception:
                        continue
                    if remaining <= 0:
                        break
        
        if results:
            return f"找到 {len(results)} 条相关记忆:\n\n" + "\n\n---\n\n".join(results)
        else:
            return f"未找到与 '{query}' 相关的记忆。"
    

