"""DunCrew Server - Wiki Knowledge Graph API Mixin

Entity-Claim-Evidence 三层知识模型的 CRUD API。

Tables: wiki_entity, wiki_claim, wiki_evidence, wiki_relation, wiki_ingest_log
"""
from __future__ import annotations

import json
import threading
import time
import uuid

from server.state import _db_lock

# 条件导入 wiki 向量搜索函数
HAS_WIKI_SEARCH = False
try:
    from hybrid_search import (
        search_wiki_vectors,
        index_wiki_entity_vector,
        reindex_all_wiki_vectors,
        EmbeddingEngine,
    )
    HAS_WIKI_SEARCH = True
except ImportError:
    pass


def _now_ms() -> int:
    return int(time.time() * 1000)


def _uuid() -> str:
    return uuid.uuid4().hex[:16]


# ── P4: LLM Librarian 审计提示词 ──
LIBRARIAN_PROMPT = '\n'.join([
    '你是知识库管理员（Librarian）。审查以下实体清单，输出结构化管理操作。',
    '',
    '## 可用操作',
    '- {"op":"archive","entity_ids":["ent-xxx"],"reason":"内容过时/无效"}',
    '- {"op":"set_category","entity_ids":["ent-xxx"],"value":"分类名","reason":"分类缺失或错误"}',
    '- {"op":"merge","source_id":"ent-a","target_id":"ent-b","reason":"主题高度重叠"}',
    '- {"op":"flag_conflict","claim_ids":["clm-xxx"],"reason":"断言内容矛盾"}',
    '',
    '## 规则',
    '- 最多输出 10 个操作',
    '- archive: 仅当实体无实际价值、内容过时、或完全重复时',
    '- merge: 仅当两个实体的主题有 80%+ 重叠时',
    '- set_category: 当实体"未分类"且可明确归类时',
    '- flag_conflict: 仅当发现语义矛盾时',
    '- 保守判断：不确定时不操作',
    '- 输出严格 JSON 数组，不要用 markdown 代码块包裹',
    '- 如果没有需要的操作，输出空数组: []',
])


class WikiMixin:
    """Wiki Knowledge Graph API Mixin"""

    # ============================================
    # Entity CRUD
    # ============================================

    def handle_wiki_entities_list(self, query: dict):
        """GET /api/wiki/entities?dun_id=xxx&category=xxx
        返回 Entity 列表，附带 claim_count。
        dun_id 缺省时返回全局 Entity。
        category 可选，过滤指定分类。
        """
        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]
        category = query.get('category', [None])[0]

        where_parts = ["e.status = 'active'"]
        params: list = []
        if dun_id:
            where_parts.append("e.dun_id = ?")
            params.append(dun_id)
        else:
            where_parts.append("e.dun_id IS NULL")
        if category:
            if category == '未分类':
                where_parts.append("(e.category IS NULL OR e.category = '')")
            else:
                where_parts.append("e.category = ?")
                params.append(category)

        where_clause = " AND ".join(where_parts)
        sql = f"""
            SELECT e.*, COUNT(c.id) AS claim_count
            FROM wiki_entity e
            LEFT JOIN wiki_claim c ON c.entity_id = e.id AND c.status != 'superseded'
            WHERE {where_clause}
            GROUP BY e.id
            ORDER BY e.updated_at DESC
        """

        with _db_lock:
            rows = db.execute(sql, params).fetchall()

        entities = []
        for r in rows:
            entities.append({
                'id': r['id'],
                'dunId': r['dun_id'],
                'slug': r['slug'],
                'title': r['title'],
                'type': r['type'],
                'tldr': r['tldr'],
                'tags': json.loads(r['tags'] or '[]'),
                'category': r['category'] if 'category' in r.keys() else None,
                'temporalScope': r['temporal_scope'] if 'temporal_scope' in r.keys() else None,
                'consensus': r['consensus'] if 'consensus' in r.keys() else 'emerging',
                'status': r['status'],
                'claimCount': r['claim_count'],
                'createdAt': r['created_at'],
                'updatedAt': r['updated_at'],
            })

        self.send_json(entities)

    def handle_wiki_entity_detail(self, entity_id: str):
        """GET /api/wiki/entity/{entityId}
        返回 Entity 详情 + Claims + Evidence + 冲突信息。
        """
        db = self._get_db()

        with _db_lock:
            entity_row = db.execute(
                "SELECT * FROM wiki_entity WHERE id = ?", (entity_id,)
            ).fetchone()

        if not entity_row:
            self.send_error_json(f'Entity {entity_id} not found', 404)
            return

        # 查询 Claims
        with _db_lock:
            claim_rows = db.execute(
                "SELECT * FROM wiki_claim WHERE entity_id = ? ORDER BY status ASC, updated_at DESC",
                (entity_id,)
            ).fetchall()

        claims = []
        claim_ids = []
        for cr in claim_rows:
            claim_ids.append(cr['id'])
            claims.append({
                'id': cr['id'],
                'content': cr['content'],
                'type': cr['type'],
                'value': cr['value'],
                'trend': cr['trend'],
                'confidence': cr['confidence'],
                'status': cr['status'],
                'conflictWith': cr['conflict_with'],
                'sourceIngestId': cr['source_ingest_id'],
                'observedAt': cr['observed_at'] if 'observed_at' in cr.keys() else None,
                'sourceSummary': cr['source_summary'] if 'source_summary' in cr.keys() else None,
                'corroboration': cr['corroboration'] if 'corroboration' in cr.keys() else 1,
                'usageCount': cr['usage_count'] if 'usage_count' in cr.keys() else 0,
                'createdAt': cr['created_at'],
                'updatedAt': cr['updated_at'],
                'evidence': [],
            })

        # 查询 Evidence (批量)
        if claim_ids:
            placeholders = ','.join('?' * len(claim_ids))
            with _db_lock:
                evidence_rows = db.execute(
                    f"SELECT * FROM wiki_evidence WHERE claim_id IN ({placeholders}) ORDER BY timestamp DESC",
                    claim_ids
                ).fetchall()

            # 按 claim_id 分组
            evidence_map: dict[str, list] = {}
            for er in evidence_rows:
                cid = er['claim_id']
                if cid not in evidence_map:
                    evidence_map[cid] = []
                evidence_map[cid].append({
                    'id': er['id'],
                    'sourceName': er['source_name'],
                    'chunkText': er['chunk_text'],
                    'timestamp': er['timestamp'],
                })

            # 注入 evidence 到 claims
            for claim in claims:
                claim['evidence'] = evidence_map.get(claim['id'], [])

        # 查询 Relations
        with _db_lock:
            rel_rows = db.execute(
                """SELECT r.*, e.title AS target_title, e.type AS target_type
                   FROM wiki_relation r
                   JOIN wiki_entity e ON e.id = r.target_id
                   WHERE r.source_id = ?
                   UNION ALL
                   SELECT r.*, e.title AS target_title, e.type AS target_type
                   FROM wiki_relation r
                   JOIN wiki_entity e ON e.id = r.source_id
                   WHERE r.target_id = ?""",
                (entity_id, entity_id)
            ).fetchall()

        relations = []
        for rr in rel_rows:
            relations.append({
                'id': rr['id'],
                'sourceId': rr['source_id'],
                'targetId': rr['target_id'],
                'type': rr['type'],
                'strength': rr['strength'],
                'description': rr['description'],
                'targetTitle': rr['target_title'],
                'targetType': rr['target_type'],
            })

        entity = {
            'id': entity_row['id'],
            'dunId': entity_row['dun_id'],
            'slug': entity_row['slug'],
            'title': entity_row['title'],
            'type': entity_row['type'],
            'tldr': entity_row['tldr'],
            'tags': json.loads(entity_row['tags'] or '[]'),
            'category': entity_row['category'] if 'category' in entity_row.keys() else None,
            'temporalScope': entity_row['temporal_scope'] if 'temporal_scope' in entity_row.keys() else None,
            'consensus': entity_row['consensus'] if 'consensus' in entity_row.keys() else 'emerging',
            'status': entity_row['status'],
            'createdAt': entity_row['created_at'],
            'updatedAt': entity_row['updated_at'],
            'claims': claims,
            'relations': relations,
        }

        self.send_json(entity)

    # ============================================
    # Ingest — 接收前端 LLM 提取的结构化 JSON 并写入 SQLite
    # ============================================

    def handle_wiki_ingest(self, data: dict):
        """POST /api/wiki/ingest
        接收结构化 JSON，写入 Entity/Claim/Evidence/Relation。

        data 格式:
        {
            "dun_id": "xxx" | null,
            "op": "create" | "update" | "noop",
            "entity": { "id?", "title", "type", "tldr", "tags", "slug?" },
            "claims": [
                {
                    "content", "type", "value?", "trend?", "confidence?",
                    "evidence": { "source_name", "chunk_text?" }
                }
            ],
            "relations": [
                { "target_title", "type", "description?" }
            ],
            "input_text": "触发 ingest 的原始认知"
        }
        """
        op = data.get('op', 'noop')
        if op == 'noop':
            self.send_json({'status': 'ok', 'op': 'noop'})
            return

        dun_id = data.get('dun_id') or data.get('dunId')
        entity_data = data.get('entity', {})
        claims_data = data.get('claims', [])
        relations_data = data.get('relations', [])
        input_text = data.get('input_text', '')

        if not entity_data or not entity_data.get('title'):
            self.send_error_json('Missing entity.title', 400)
            return

        db = self._get_db()
        now = _now_ms()
        ingest_id = f"ing-{_uuid()}"
        affected_entities = []

        try:
            with _db_lock:
                # ---- Entity ----
                entity_id = entity_data.get('id')

                if op == 'update' and entity_id:
                    # 更新已有 Entity
                    db.execute(
                        """UPDATE wiki_entity
                           SET title = ?, tldr = ?, tags = ?, category = COALESCE(?, category),
                               temporal_scope = COALESCE(?, temporal_scope),
                               last_corroborated_at = ?, updated_at = ?
                           WHERE id = ?""",
                        (
                            entity_data.get('title'),
                            entity_data.get('tldr'),
                            json.dumps(entity_data.get('tags', []), ensure_ascii=False),
                            entity_data.get('category'),
                            entity_data.get('temporal_scope'),
                            now,
                            now,
                            entity_id,
                        )
                    )
                else:
                    # 创建新 Entity
                    entity_id = f"ent-{_uuid()}"
                    slug = entity_data.get('slug') or entity_data.get('title', '').lower().replace(' ', '-')[:60]
                    db.execute(
                        """INSERT INTO wiki_entity
                           (id, dun_id, slug, title, type, tldr, tags, category, temporal_scope,
                            consensus, last_corroborated_at, status, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'emerging', ?, 'active', ?, ?)""",
                        (
                            entity_id, dun_id, slug,
                            entity_data.get('title'),
                            entity_data.get('type', 'concept'),
                            entity_data.get('tldr'),
                            json.dumps(entity_data.get('tags', []), ensure_ascii=False),
                            entity_data.get('category'),
                            entity_data.get('temporal_scope'),
                            now,
                            now, now,
                        )
                    )

                affected_entities.append(entity_id)

                # ---- Claims ----
                for claim_data in claims_data:
                    claim_id = f"clm-{_uuid()}"
                    db.execute(
                        """INSERT INTO wiki_claim
                           (id, entity_id, content, type, value, trend, confidence,
                            observed_at, source_summary, corroboration, usage_count,
                            status, source_ingest_id, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'active', ?, ?, ?)""",
                        (
                            claim_id, entity_id,
                            claim_data.get('content', ''),
                            claim_data.get('type'),
                            claim_data.get('value'),
                            claim_data.get('trend'),
                            claim_data.get('confidence', 0.8),
                            claim_data.get('observed_at'),
                            claim_data.get('source_summary'),
                            ingest_id, now, now,
                        )
                    )

                    # Evidence (如果有)
                    evidence = claim_data.get('evidence')
                    if evidence and evidence.get('source_name'):
                        ev_id = f"ev-{_uuid()}"
                        db.execute(
                            """INSERT INTO wiki_evidence
                               (id, claim_id, source_name, chunk_text, timestamp)
                               VALUES (?, ?, ?, ?, ?)""",
                            (
                                ev_id, claim_id,
                                evidence.get('source_name', ''),
                                evidence.get('chunk_text'),
                                now,
                            )
                        )

                # ---- Relations ----
                for rel_data in relations_data:
                    target_title = rel_data.get('target_title', '')
                    rel_type = rel_data.get('type', 'related_to')

                    if not target_title:
                        continue

                    # 查找或创建 target entity
                    target_row = db.execute(
                        "SELECT id FROM wiki_entity WHERE title = ? AND (dun_id = ? OR (dun_id IS NULL AND ? IS NULL))",
                        (target_title, dun_id, dun_id)
                    ).fetchone()

                    if target_row:
                        target_id = target_row['id']
                    else:
                        # 创建 stub entity
                        target_id = f"ent-{_uuid()}"
                        target_slug = target_title.lower().replace(' ', '-')[:60]
                        db.execute(
                            """INSERT INTO wiki_entity
                               (id, dun_id, slug, title, type, tldr, tags, status, created_at, updated_at)
                               VALUES (?, ?, ?, ?, 'concept', NULL, '[]', 'active', ?, ?)""",
                            (target_id, dun_id, target_slug, target_title, now, now)
                        )
                        affected_entities.append(target_id)

                    # 插入 relation (忽略重复)
                    rel_id = f"rel-{_uuid()}"
                    try:
                        db.execute(
                            """INSERT OR IGNORE INTO wiki_relation
                               (id, source_id, target_id, type, strength, description, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)""",
                            (
                                rel_id, entity_id, target_id, rel_type,
                                rel_data.get('strength', 0.5),
                                rel_data.get('description'),
                                now,
                            )
                        )
                    except Exception:
                        pass  # UNIQUE constraint violation — relation already exists

                # ---- Ingest Log ----
                db.execute(
                    """INSERT INTO wiki_ingest_log
                       (id, dun_id, input_text, output_json, entities_affected, created_at)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (
                        ingest_id, dun_id, input_text,
                        json.dumps(data, ensure_ascii=False),
                        json.dumps(affected_entities, ensure_ascii=False),
                        now,
                    )
                )

                db.commit()

            self.send_json({
                'status': 'ok',
                'op': op,
                'entityId': entity_id,
                'ingestId': ingest_id,
                'claimsCreated': len(claims_data),
                'relationsCreated': len(relations_data),
            })

            # 后台为受影响的 entity 建向量索引
            for eid in affected_entities:
                self._index_entity_after_ingest(eid)

        except Exception as e:
            self.send_error_json(f'Wiki ingest failed: {e}', 500)

    # ============================================
    # Entity 索引 — 给 Ingest Prompt 用 (轻量级)
    # ============================================

    def handle_wiki_entity_index(self, query: dict):
        """GET /api/wiki/entity-index?dun_id=xxx
        返回 Entity 索引列表 (id, title, type, tldr) — 供 ingest prompt 使用。
        比 entities_list 更轻量，不包含 claim_count。
        """
        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]

        if dun_id:
            sql = "SELECT id, title, type, tldr FROM wiki_entity WHERE dun_id = ? AND status = 'active'"
            params = [dun_id]
        else:
            sql = "SELECT id, title, type, tldr FROM wiki_entity WHERE dun_id IS NULL AND status = 'active'"
            params = []

        with _db_lock:
            rows = db.execute(sql, params).fetchall()

        self.send_json([
            {'id': r['id'], 'title': r['title'], 'type': r['type'], 'tldr': r['tldr']}
            for r in rows
        ])

    # ============================================
    # Entity Claims — 给 Ingest Prompt 用 (相关 Entity 详情)
    # ============================================

    def handle_wiki_entity_claims(self, entity_id: str):
        """GET /api/wiki/entity/{entityId}/claims
        返回某 Entity 下所有 active Claims — 供 ingest 冲突检测用。
        """
        db = self._get_db()

        with _db_lock:
            rows = db.execute(
                "SELECT id, content, type, value, trend, confidence, status FROM wiki_claim WHERE entity_id = ? AND status = 'active'",
                (entity_id,)
            ).fetchall()

        self.send_json([
            {
                'id': r['id'], 'content': r['content'], 'type': r['type'],
                'value': r['value'], 'trend': r['trend'],
                'confidence': r['confidence'], 'status': r['status'],
            }
            for r in rows
        ])

    # ============================================
    # Claim 冲突标记
    # ============================================

    def handle_wiki_claim_conflict(self, data: dict):
        """POST /api/wiki/claim/conflict
        标记两条 Claim 为冲突状态。
        data: { "claim_id_a": "xxx", "claim_id_b": "yyy" }
        """
        cid_a = data.get('claim_id_a')
        cid_b = data.get('claim_id_b')
        if not cid_a or not cid_b:
            self.send_error_json('Missing claim_id_a or claim_id_b', 400)
            return

        db = self._get_db()
        now = _now_ms()
        try:
            with _db_lock:
                db.execute(
                    "UPDATE wiki_claim SET status = 'conflicted', conflict_with = ?, updated_at = ? WHERE id = ?",
                    (cid_b, now, cid_a)
                )
                db.execute(
                    "UPDATE wiki_claim SET status = 'conflicted', conflict_with = ?, updated_at = ? WHERE id = ?",
                    (cid_a, now, cid_b)
                )
                db.commit()
            self.send_json({'status': 'ok', 'claimA': cid_a, 'claimB': cid_b})
        except Exception as e:
            self.send_error_json(f'Failed to mark conflict: {e}', 500)

    # ============================================
    # Entity 文本渲染 — 供 ReAct 上下文注入
    # ============================================

    def handle_wiki_entity_render_text(self, entity_id: str):
        """GET /api/wiki/entity/{entityId}/text
        返回 Entity 的纯文本渲染（供 dunContextEngine 注入到 LLM prompt 中）。
        """
        db = self._get_db()

        with _db_lock:
            entity_row = db.execute(
                "SELECT * FROM wiki_entity WHERE id = ?", (entity_id,)
            ).fetchone()

        if not entity_row:
            self.send_text('')
            return

        with _db_lock:
            claim_rows = db.execute(
                "SELECT * FROM wiki_claim WHERE entity_id = ? AND status != 'superseded' ORDER BY type, updated_at DESC",
                (entity_id,)
            ).fetchall()

        with _db_lock:
            rel_rows = db.execute(
                """SELECT e.title, r.type FROM wiki_relation r
                   JOIN wiki_entity e ON e.id = r.target_id
                   WHERE r.source_id = ?""",
                (entity_id,)
            ).fetchall()

        # 模板渲染
        lines = [f"## {entity_row['title']} [{entity_row['type']}]"]
        if entity_row['tldr']:
            lines.append(entity_row['tldr'])
        lines.append('')

        for cr in claim_rows:
            prefix = ''
            if cr['status'] == 'conflicted':
                prefix = '[!冲突] '
            trend_str = ''
            if cr['trend']:
                trend_map = {'up': '↑', 'down': '↓', 'stable': '→'}
                trend_str = f" ({trend_map.get(cr['trend'], cr['trend'])})"
            value_str = f" [{cr['value']}]" if cr['value'] else ''

            lines.append(f"- {prefix}{cr['content']}{value_str}{trend_str}")

        if rel_rows:
            lines.append('')
            rel_parts = []
            for rr in rel_rows:
                rel_parts.append(f"{rr['title']} ({rr['type']})")
            lines.append(f"关联: {', '.join(rel_parts)}")

        self.send_text('\n'.join(lines))

    # ============================================
    # 批量文本渲染 — Dun 级别
    # ============================================

    def handle_wiki_render_all_text(self, query: dict):
        """GET /api/wiki/render-text?dun_id=xxx
        返回某 Dun 下所有 Entity 的合并文本，供 ReAct 上下文注入。
        """
        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]

        if dun_id:
            sql = "SELECT id FROM wiki_entity WHERE dun_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 20"
            params = [dun_id]
        else:
            sql = "SELECT id FROM wiki_entity WHERE dun_id IS NULL AND status = 'active' ORDER BY updated_at DESC LIMIT 20"
            params = []

        with _db_lock:
            entity_rows = db.execute(sql, params).fetchall()

        if not entity_rows:
            self.send_text('')
            return

        entity_ids = [r['id'] for r in entity_rows]
        sections = []

        for eid in entity_ids:
            # 复用单 entity 渲染逻辑
            with _db_lock:
                entity_row = db.execute("SELECT * FROM wiki_entity WHERE id = ?", (eid,)).fetchone()
                claim_rows = db.execute(
                    "SELECT * FROM wiki_claim WHERE entity_id = ? AND status != 'superseded' ORDER BY type, updated_at DESC",
                    (eid,)
                ).fetchall()

            if not entity_row:
                continue

            lines = [f"## {entity_row['title']} [{entity_row['type']}]"]
            if entity_row['tldr']:
                lines.append(entity_row['tldr'])
            for cr in claim_rows:
                prefix = '[!冲突] ' if cr['status'] == 'conflicted' else ''
                trend_str = ''
                if cr['trend']:
                    trend_map = {'up': '↑', 'down': '↓', 'stable': '→'}
                    trend_str = f" ({trend_map.get(cr['trend'], cr['trend'])})"
                value_str = f" [{cr['value']}]" if cr['value'] else ''
                lines.append(f"- {prefix}{cr['content']}{value_str}{trend_str}")

            sections.append('\n'.join(lines))

        self.send_text('\n\n---\n\n'.join(sections))

    # ============================================
    # 语义搜索 — Wiki Entity 级向量检索
    # ============================================

    def handle_wiki_search(self, query: dict):
        """GET /api/wiki/search?q=xxx&dun_id=yyy&limit=5
        语义搜索 wiki entity，返回按相关度排序的结果。
        如果向量索引不可用，降级为 title/tldr 文本匹配。
        """
        q = query.get('q', [None])[0]
        if not q:
            self.send_json([])
            return

        dun_id = query.get('dun_id', [None])[0]
        limit = int(query.get('limit', ['5'])[0])

        db = self._get_db()

        # 尝试向量搜索
        if HAS_WIKI_SEARCH:
            import server.state as _st
            if _st._embedding_engine and _st._embedding_engine.available:
                results = search_wiki_vectors(
                    db, q, _st._embedding_engine,
                    dun_id=dun_id, limit=limit,
                )
                if results:
                    # 补充 claim 数据用于 render
                    for r in results:
                        eid = r['entityId']
                        with _db_lock:
                            claims = db.execute(
                                "SELECT content, type, value, trend FROM wiki_claim WHERE entity_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 5",
                                (eid,)
                            ).fetchall()
                        r['claims'] = [
                            {'content': c['content'], 'type': c['type'], 'value': c['value'], 'trend': c['trend']}
                            for c in claims
                        ]
                    self.send_json(results)
                    return

        # 降级: LIKE 文本匹配
        if dun_id:
            sql = """
                SELECT id, title, type, tldr, dun_id, tags, updated_at
                FROM wiki_entity
                WHERE dun_id = ? AND status = 'active'
                  AND (title LIKE ? OR tldr LIKE ?)
                ORDER BY updated_at DESC LIMIT ?
            """
            params = [dun_id, f'%{q}%', f'%{q}%', limit]
        else:
            sql = """
                SELECT id, title, type, tldr, dun_id, tags, updated_at
                FROM wiki_entity
                WHERE dun_id IS NULL AND status = 'active'
                  AND (title LIKE ? OR tldr LIKE ?)
                ORDER BY updated_at DESC LIMIT ?
            """
            params = [f'%{q}%', f'%{q}%', limit]

        with _db_lock:
            rows = db.execute(sql, params).fetchall()

        results = []
        for r in rows:
            eid = r['id']
            with _db_lock:
                claims = db.execute(
                    "SELECT content, type, value, trend FROM wiki_claim WHERE entity_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 5",
                    (eid,)
                ).fetchall()
            results.append({
                'entityId': eid,
                'title': r['title'],
                'type': r['type'],
                'tldr': r['tldr'],
                'dunId': r['dun_id'],
                'tags': r['tags'] or '[]',
                'updatedAt': r['updated_at'],
                'score': 0.5,  # 文本匹配无精确分数
                'claims': [
                    {'content': c['content'], 'type': c['type'], 'value': c['value'], 'trend': c['trend']}
                    for c in claims
                ],
            })

        self.send_json(results)

    # ============================================
    # 搜索结果渲染 — 将搜索结果渲染为 LLM 可消费的文本
    # ============================================

    def handle_wiki_search_render(self, query: dict):
        """GET /api/wiki/search-render?q=xxx&dun_id=yyy&limit=5
        语义搜索 + 渲染为纯文本，供 buildDynamicContext 直接注入。
        """
        q = query.get('q', [None])[0]
        if not q:
            self.send_text('')
            return

        dun_id = query.get('dun_id', [None])[0]
        limit = int(query.get('limit', ['5'])[0])

        db = self._get_db()

        # 搜索 entity ids
        entity_ids: list[str] = []

        if HAS_WIKI_SEARCH:
            import server.state as _st
            if _st._embedding_engine and _st._embedding_engine.available:
                results = search_wiki_vectors(
                    db, q, _st._embedding_engine,
                    dun_id=dun_id, limit=limit,
                )
                entity_ids = [r['entityId'] for r in results]

        # 降级
        if not entity_ids:
            if dun_id:
                sql = "SELECT id FROM wiki_entity WHERE dun_id = ? AND status = 'active' AND (title LIKE ? OR tldr LIKE ?) ORDER BY updated_at DESC LIMIT ?"
                params = [dun_id, f'%{q}%', f'%{q}%', limit]
            else:
                sql = "SELECT id FROM wiki_entity WHERE dun_id IS NULL AND status = 'active' AND (title LIKE ? OR tldr LIKE ?) ORDER BY updated_at DESC LIMIT ?"
                params = [f'%{q}%', f'%{q}%', limit]
            with _db_lock:
                rows = db.execute(sql, params).fetchall()
            entity_ids = [r['id'] for r in rows]

        if not entity_ids:
            self.send_text('')
            return

        # 渲染
        sections = []
        for eid in entity_ids:
            with _db_lock:
                entity_row = db.execute("SELECT * FROM wiki_entity WHERE id = ?", (eid,)).fetchone()
                claim_rows = db.execute(
                    "SELECT * FROM wiki_claim WHERE entity_id = ? AND status != 'superseded' ORDER BY type, updated_at DESC",
                    (eid,)
                ).fetchall()

            if not entity_row:
                continue

            lines = [f"## {entity_row['title']} [{entity_row['type']}]"]
            if entity_row['tldr']:
                lines.append(entity_row['tldr'])
            for cr in claim_rows:
                prefix = '[!冲突] ' if cr['status'] == 'conflicted' else ''
                trend_str = ''
                if cr['trend']:
                    trend_map = {'up': '↑', 'down': '↓', 'stable': '→'}
                    trend_str = f" ({trend_map.get(cr['trend'], cr['trend'])})"
                value_str = f" [{cr['value']}]" if cr['value'] else ''
                lines.append(f"- {prefix}{cr['content']}{value_str}{trend_str}")

            sections.append('\n'.join(lines))

        self.send_text('\n\n---\n\n'.join(sections))

    # ============================================
    # Stats API — 首页聚合数据
    # ============================================

    def handle_wiki_stats(self, query: dict):
        """GET /api/wiki/stats?dun_id=xxx
        返回知识库聚合统计数据。
        """
        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]

        dun_filter = "dun_id = ?" if dun_id else "dun_id IS NULL"
        params: list = [dun_id] if dun_id else []

        with _db_lock:
            # 总量统计
            total_entities = db.execute(
                f"SELECT COUNT(*) FROM wiki_entity WHERE {dun_filter} AND status = 'active'", params
            ).fetchone()[0]

            total_claims = db.execute(
                f"SELECT COUNT(*) FROM wiki_claim c JOIN wiki_entity e ON e.id = c.entity_id WHERE {dun_filter} AND e.status = 'active' AND c.status = 'active'",
                params
            ).fetchone()[0]

            total_relations = db.execute(
                f"SELECT COUNT(*) FROM wiki_relation r JOIN wiki_entity e ON e.id = r.source_id WHERE {dun_filter} AND e.status = 'active'",
                params
            ).fetchone()[0]

            # Entity type 分布
            type_rows = db.execute(
                f"SELECT type, COUNT(*) as cnt FROM wiki_entity WHERE {dun_filter} AND status = 'active' GROUP BY type ORDER BY cnt DESC",
                params
            ).fetchall()

            # Category 分布（用于分类浏览）
            category_rows = db.execute(
                f"SELECT COALESCE(category, '未分类') as cat, COUNT(*) as cnt FROM wiki_entity WHERE {dun_filter} AND status = 'active' GROUP BY cat ORDER BY cnt DESC",
                params
            ).fetchall()

            # 最近导入涉及的 Entity 标题（首页展示用）
            recent_entity_rows = db.execute(
                f"SELECT id, title, type, category, updated_at FROM wiki_entity WHERE {dun_filter} AND status = 'active' ORDER BY updated_at DESC LIMIT 8",
                params
            ).fetchall()

            # 最近 ingest 记录
            recent_ingests = db.execute(
                f"SELECT id, created_at, entities_affected FROM wiki_ingest_log WHERE {dun_filter.replace('dun_id', 'wiki_ingest_log.dun_id')} ORDER BY created_at DESC LIMIT 5",
                params
            ).fetchall()

            # 健康问题
            # 冲突 claims
            conflicts = db.execute(
                f"SELECT COUNT(*) FROM wiki_claim c JOIN wiki_entity e ON e.id = c.entity_id WHERE {dun_filter} AND c.status = 'conflicted'",
                params
            ).fetchone()[0]

            # 空壳 entities (无 active claim)
            empty_entities = db.execute(
                f"""SELECT COUNT(*) FROM wiki_entity e
                    WHERE {dun_filter} AND e.status = 'active'
                    AND NOT EXISTS (SELECT 1 FROM wiki_claim c WHERE c.entity_id = e.id AND c.status = 'active')""",
                params
            ).fetchone()[0]

        stats = {
            'totalEntities': total_entities,
            'totalClaims': total_claims,
            'totalRelations': total_relations,
            'types': [{'name': r['type'], 'count': r['cnt']} for r in type_rows],
            'categories': [{'name': r['cat'], 'count': r['cnt']} for r in category_rows],
            'recentEntities': [
                {
                    'id': r['id'],
                    'title': r['title'],
                    'type': r['type'],
                    'category': r['category'],
                    'updatedAt': r['updated_at'],
                }
                for r in recent_entity_rows
            ],
            'recentIngests': [
                {
                    'id': r['id'],
                    'createdAt': r['created_at'],
                    'entitiesAffected': json.loads(r['entities_affected'] or '[]'),
                }
                for r in recent_ingests
            ],
            'healthIssues': {
                'conflicts': conflicts,
                'emptyEntities': empty_entities,
            },
        }

        self.send_json(stats)

    # ============================================
    # Wiki 向量索引管理
    # ============================================

    def handle_wiki_reindex(self, data: dict):
        """POST /api/wiki/reindex
        全量重建 wiki 向量索引。
        """
        if not HAS_WIKI_SEARCH:
            self.send_error_json('Wiki search module not available', 503)
            return

        import server.state as _st
        if not _st._embedding_engine or not _st._embedding_engine.available:
            self.send_error_json('Embedding engine not available', 503)
            return

        db = self._get_db()
        count = reindex_all_wiki_vectors(db, _st._embedding_engine, _db_lock)
        self.send_json({'status': 'ok', 'indexedEntities': count})

    def _index_entity_after_ingest(self, entity_id: str):
        """Ingest 后自动为新/更新的 entity 建向量索引"""
        if not HAS_WIKI_SEARCH:
            return

        import server.state as _st
        if not _st._embedding_engine or not _st._embedding_engine.available:
            return

        db = self._get_db()
        with _db_lock:
            row = db.execute(
                "SELECT id, title, tldr FROM wiki_entity WHERE id = ?", (entity_id,)
            ).fetchone()
            if not row:
                return
            claims = db.execute(
                "SELECT content FROM wiki_claim WHERE entity_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 5",
                (entity_id,)
            ).fetchall()

        parts = [row['title']]
        if row['tldr']:
            parts.append(row['tldr'])
        for c in claims:
            parts.append(c['content'])
        text = ' | '.join(parts)

        # 在后台线程中索引，不阻塞 ingest 响应
        def _do_index():
            try:
                index_wiki_entity_vector(db, entity_id, text, _st._embedding_engine, _db_lock)
            except Exception as e:
                import sys
                print(f"[Wiki] Vector index failed for {entity_id}: {e}", file=sys.stderr)

        t = threading.Thread(target=_do_index, daemon=True)
        t.start()

    # ============================================
    # searchWiki 工具 — ReAct 可调用
    # ============================================

    def _tool_search_wiki(self, args: dict) -> str:
        """searchWiki 工具: 语义搜索知识库，返回格式化文本供 LLM 消费"""
        query = args.get('query', '')
        if not query:
            raise ValueError("query 参数必填")

        limit = int(args.get('limit', 5))
        # 获取当前 Dun context (如果有)
        dun_id = args.get('dunId') or None

        db = self._get_db()

        # 尝试向量搜索
        results: list[dict] = []
        if HAS_WIKI_SEARCH:
            import server.state as _st
            if _st._embedding_engine and _st._embedding_engine.available:
                results = search_wiki_vectors(
                    db, query, _st._embedding_engine,
                    dun_id=dun_id, limit=limit,
                )

        # 降级: LIKE 文本匹配
        if not results:
            if dun_id:
                sql = "SELECT id, title, type, tldr FROM wiki_entity WHERE dun_id = ? AND status = 'active' AND (title LIKE ? OR tldr LIKE ?) ORDER BY updated_at DESC LIMIT ?"
                params: list = [dun_id, f'%{query}%', f'%{query}%', limit]
            else:
                sql = "SELECT id, title, type, tldr FROM wiki_entity WHERE status = 'active' AND (title LIKE ? OR tldr LIKE ?) ORDER BY updated_at DESC LIMIT ?"
                params = [f'%{query}%', f'%{query}%', limit]
            with _db_lock:
                rows = db.execute(sql, params).fetchall()
            results = [
                {'entityId': r['id'], 'title': r['title'], 'type': r['type'], 'tldr': r['tldr'], 'score': 0.5}
                for r in rows
            ]

        if not results:
            return f"知识库中没有找到与 \"{query}\" 相关的知识"

        # P5: 使用即验证 — 被搜索命中的 claims 自增 usage_count
        hit_entity_ids = [r['entityId'] for r in results]
        if hit_entity_ids:
            try:
                with _db_lock:
                    placeholders = ','.join(['?' for _ in hit_entity_ids])
                    db.execute(
                        f"UPDATE wiki_claim SET usage_count = usage_count + 1 WHERE entity_id IN ({placeholders}) AND status = 'active'",
                        hit_entity_ids
                    )
                    db.execute(
                        f"UPDATE wiki_entity SET last_corroborated_at = ? WHERE id IN ({placeholders})",
                        [_now_ms()] + hit_entity_ids
                    )
                    db.commit()
            except Exception:
                pass  # usage tracking 不阻塞主流程

        # 渲染为 LLM 可消费文本
        sections = []
        for r in results:
            eid = r['entityId']
            with _db_lock:
                claims = db.execute(
                    "SELECT content, type, value, trend FROM wiki_claim WHERE entity_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 5",
                    (eid,)
                ).fetchall()

            lines = [f"## {r['title']} [{r['type']}] (相关度:{r['score']})"]
            if r.get('tldr'):
                lines.append(r['tldr'])
            for c in claims:
                trend_str = ''
                if c['trend']:
                    trend_map = {'up': '↑', 'down': '↓', 'stable': '→'}
                    trend_str = f" ({trend_map.get(c['trend'], c['trend'])})"
                value_str = f" [{c['value']}]" if c['value'] else ''
                lines.append(f"- [{c['type']}] {c['content']}{value_str}{trend_str}")
            sections.append('\n'.join(lines))

        return f"找到 {len(results)} 条相关知识:\n\n" + '\n\n---\n\n'.join(sections)

    # ============================================
    # P3: 批量操作 CRUD
    # ============================================

    def handle_wiki_batch(self, data: dict):
        """POST /api/wiki/batch
        批量操作: archive, unarchive, tag, untag, set_category, delete

        data 格式:
        {
            "entity_ids": ["ent-xxx", ...],
            "action": "archive" | "unarchive" | "tag" | "untag" | "set_category" | "delete",
            "value": "tag_name" | "category_name"  (tag/untag/set_category 时必需)
        }
        """
        entity_ids = data.get('entity_ids') or data.get('ids', [])
        action = data.get('action') or data.get('op', '')
        value = data.get('value', '')

        if not entity_ids:
            self.send_error_json('entity_ids 不能为空', 400)
            return
        if action not in ('archive', 'unarchive', 'tag', 'untag', 'set_category', 'delete'):
            self.send_error_json(f'未知操作: {action}', 400)
            return
        if action in ('tag', 'untag', 'set_category') and not value:
            self.send_error_json(f'{action} 操作需要 value 参数', 400)
            return

        db = self._get_db()
        now = _now_ms()
        affected = 0
        placeholders = ','.join(['?' for _ in entity_ids])

        try:
            with _db_lock:
                if action == 'archive':
                    affected = db.execute(
                        f"UPDATE wiki_entity SET status = 'archived', updated_at = ? WHERE id IN ({placeholders}) AND status = 'active'",
                        [now] + entity_ids
                    ).rowcount

                elif action == 'unarchive':
                    affected = db.execute(
                        f"UPDATE wiki_entity SET status = 'active', updated_at = ? WHERE id IN ({placeholders}) AND status = 'archived'",
                        [now] + entity_ids
                    ).rowcount

                elif action == 'tag':
                    # 为每个 entity 的 tags JSON 数组追加新 tag
                    rows = db.execute(
                        f"SELECT id, tags FROM wiki_entity WHERE id IN ({placeholders})",
                        entity_ids
                    ).fetchall()
                    for r in rows:
                        tags = json.loads(r['tags'] or '[]')
                        if value not in tags:
                            tags.append(value)
                            db.execute(
                                "UPDATE wiki_entity SET tags = ?, updated_at = ? WHERE id = ?",
                                (json.dumps(tags, ensure_ascii=False), now, r['id'])
                            )
                            affected += 1

                elif action == 'untag':
                    rows = db.execute(
                        f"SELECT id, tags FROM wiki_entity WHERE id IN ({placeholders})",
                        entity_ids
                    ).fetchall()
                    for r in rows:
                        tags = json.loads(r['tags'] or '[]')
                        if value in tags:
                            tags.remove(value)
                            db.execute(
                                "UPDATE wiki_entity SET tags = ?, updated_at = ? WHERE id = ?",
                                (json.dumps(tags, ensure_ascii=False), now, r['id'])
                            )
                            affected += 1

                elif action == 'set_category':
                    affected = db.execute(
                        f"UPDATE wiki_entity SET category = ?, updated_at = ? WHERE id IN ({placeholders})",
                        [value, now] + entity_ids
                    ).rowcount

                elif action == 'delete':
                    # 级联删除: claims → evidence → relations → entity
                    db.execute(
                        f"DELETE FROM wiki_evidence WHERE claim_id IN (SELECT id FROM wiki_claim WHERE entity_id IN ({placeholders}))",
                        entity_ids
                    )
                    db.execute(
                        f"DELETE FROM wiki_claim WHERE entity_id IN ({placeholders})",
                        entity_ids
                    )
                    db.execute(
                        f"DELETE FROM wiki_relation WHERE source_id IN ({placeholders}) OR target_id IN ({placeholders})",
                        entity_ids + entity_ids
                    )
                    affected = db.execute(
                        f"DELETE FROM wiki_entity WHERE id IN ({placeholders})",
                        entity_ids
                    ).rowcount
                    # 清理向量索引
                    db.execute(
                        f"DELETE FROM wiki_vectors WHERE entity_id IN ({placeholders})",
                        entity_ids
                    )

                db.commit()

            self.send_json({
                'status': 'ok',
                'action': action,
                'affected': affected,
                'requested': len(entity_ids),
            })

        except Exception as e:
            self.send_error_json(f'Batch operation failed: {e}', 500)

    # ============================================
    # P4: LLM Librarian — 知识库审计与管理
    # ============================================

    def handle_wiki_librarian(self, data: dict):
        """POST /api/wiki/librarian
        LLM 审计知识库，生成结构化管理操作计划。

        data 格式:
        {
            "scope": "full" | "category",
            "category": "xxx"  (scope=category 时)
        }
        """
        scope = data.get('scope', 'full')
        category_filter = data.get('category')

        db = self._get_db()

        with _db_lock:
            # 获取实体概览
            if scope == 'category' and category_filter:
                entities = db.execute(
                    "SELECT id, title, type, tldr, category, consensus, status, updated_at FROM wiki_entity WHERE status = 'active' AND category = ? ORDER BY updated_at DESC LIMIT 50",
                    (category_filter,)
                ).fetchall()
            else:
                entities = db.execute(
                    "SELECT id, title, type, tldr, category, consensus, status, updated_at FROM wiki_entity WHERE status = 'active' ORDER BY updated_at DESC LIMIT 50"
                ).fetchall()

            # 获取每个 entity 的 claim 统计
            entity_ids = [e['id'] for e in entities]
            if entity_ids:
                placeholders = ','.join(['?' for _ in entity_ids])
                claim_stats = db.execute(
                    f"""SELECT entity_id, COUNT(*) as total,
                        SUM(CASE WHEN status = 'conflicted' THEN 1 ELSE 0 END) as conflicts,
                        SUM(usage_count) as total_usage,
                        MAX(updated_at) as latest_claim
                    FROM wiki_claim WHERE entity_id IN ({placeholders})
                    GROUP BY entity_id""",
                    entity_ids
                ).fetchall()
                stats_map = {r['entity_id']: dict(r) for r in claim_stats}
            else:
                stats_map = {}

        # 构建 LLM 输入
        lines = ['# 知识库实体清单', '']
        for e in entities:
            s = stats_map.get(e['id'], {})
            age_days = (_now_ms() - e['updated_at']) / 86_400_000
            lines.append(
                f"- [{e['type']}] {e['title']} | "
                f"分类:{e['category'] or '未分类'} | "
                f"共识:{e['consensus'] or 'emerging'} | "
                f"claims:{s.get('total', 0)} | "
                f"冲突:{s.get('conflicts', 0)} | "
                f"使用:{s.get('total_usage', 0)}次 | "
                f"距今:{age_days:.0f}天"
            )

        input_text = '\n'.join(lines)

        # 返回结构化数据供前端 LLM 调用
        self.send_json({
            'status': 'ok',
            'entityCount': len(entities),
            'entityOverview': input_text,
            'prompt': LIBRARIAN_PROMPT,
        })

    def handle_wiki_librarian_execute(self, data: dict):
        """POST /api/wiki/librarian/execute
        执行 LLM Librarian 输出的操作计划。

        data 格式:
        {
            "actions": [
                {"op": "archive", "entity_ids": ["ent-xxx"]},
                {"op": "set_category", "entity_ids": ["ent-xxx"], "value": "AI"},
                {"op": "merge", "source_id": "ent-a", "target_id": "ent-b"},
                {"op": "flag_conflict", "claim_ids": ["clm-xxx"]}
            ]
        }
        """
        actions = data.get('actions', [])
        if not actions:
            self.send_json({'status': 'ok', 'executed': 0})
            return

        db = self._get_db()
        now = _now_ms()
        executed = 0
        errors = []

        try:
            with _db_lock:
                for action in actions:
                    op = action.get('op')

                    if op == 'archive':
                        eids = action.get('entity_ids', [])
                        if eids:
                            placeholders = ','.join(['?' for _ in eids])
                            db.execute(
                                f"UPDATE wiki_entity SET status = 'archived', updated_at = ? WHERE id IN ({placeholders})",
                                [now] + eids
                            )
                            executed += 1

                    elif op == 'set_category':
                        eids = action.get('entity_ids', [])
                        val = action.get('value', '')
                        if eids and val:
                            placeholders = ','.join(['?' for _ in eids])
                            db.execute(
                                f"UPDATE wiki_entity SET category = ?, updated_at = ? WHERE id IN ({placeholders})",
                                [val, now] + eids
                            )
                            executed += 1

                    elif op == 'merge':
                        source_id = action.get('source_id')
                        target_id = action.get('target_id')
                        if source_id and target_id:
                            # 把 source 的 claims 移给 target
                            db.execute(
                                "UPDATE wiki_claim SET entity_id = ?, updated_at = ? WHERE entity_id = ?",
                                (target_id, now, source_id)
                            )
                            # 把指向 source 的 relations 改指 target
                            db.execute(
                                "UPDATE wiki_relation SET target_id = ? WHERE target_id = ?",
                                (target_id, source_id)
                            )
                            db.execute(
                                "UPDATE wiki_relation SET source_id = ? WHERE source_id = ?",
                                (target_id, source_id)
                            )
                            # 归档 source
                            db.execute(
                                "UPDATE wiki_entity SET status = 'merged', updated_at = ? WHERE id = ?",
                                (now, source_id)
                            )
                            db.execute(
                                "UPDATE wiki_entity SET updated_at = ? WHERE id = ?",
                                (now, target_id)
                            )
                            executed += 1

                    elif op == 'flag_conflict':
                        cids = action.get('claim_ids', [])
                        if cids:
                            placeholders = ','.join(['?' for _ in cids])
                            db.execute(
                                f"UPDATE wiki_claim SET status = 'conflicted', updated_at = ? WHERE id IN ({placeholders})",
                                [now] + cids
                            )
                            executed += 1
                    else:
                        errors.append(f"Unknown op: {op}")

                db.commit()

            self.send_json({
                'status': 'ok',
                'executed': executed,
                'errors': errors,
            })

        except Exception as e:
            self.send_error_json(f'Librarian execute failed: {e}', 500)

    # ============================================
    # P5: 知识温度计算
    # ============================================

    def handle_wiki_temperature(self, query: dict):
        """GET /api/wiki/temperature?dun_id=xxx
        返回实体温度排序列表。

        温度 = log(usage+1) * recency_weight * corroboration_bonus
        """
        import math

        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]

        dun_filter = "e.dun_id = ?" if dun_id else "e.dun_id IS NULL"
        params: list = [dun_id] if dun_id else []

        with _db_lock:
            rows = db.execute(
                f"""SELECT
                    e.id, e.title, e.type, e.category, e.consensus,
                    e.updated_at, e.last_corroborated_at,
                    COALESCE(SUM(c.usage_count), 0) as total_usage,
                    COALESCE(AVG(c.corroboration), 1) as avg_corroboration,
                    COUNT(c.id) as claim_count
                FROM wiki_entity e
                LEFT JOIN wiki_claim c ON c.entity_id = e.id AND c.status = 'active'
                WHERE {dun_filter} AND e.status = 'active'
                GROUP BY e.id
                ORDER BY e.updated_at DESC""",
                params
            ).fetchall()

        now = _now_ms()
        results = []
        for r in rows:
            # 使用量分（对数压缩，防马太）
            usage_score = math.log(r['total_usage'] + 1)

            # 新鲜度分（14 天满分，28 天衰减到 0）
            age_days = (now - r['updated_at']) / 86_400_000
            if age_days <= 14:
                recency = 1.0
            elif age_days <= 42:
                recency = 1.0 - (age_days - 14) / 28
            else:
                recency = 0.0

            # 共识加成（多来源确认）
            corr_bonus = min(math.log(r['avg_corroboration'] + 1) / math.log(5), 1.0)

            # 综合温度 = usage_log * 0.4 + recency * 0.3 + corroboration * 0.3
            temperature = usage_score * 0.4 + recency * 0.3 + corr_bonus * 0.3

            # 温度等级
            if temperature >= 0.6:
                level = 'hot'
            elif temperature >= 0.3:
                level = 'warm'
            else:
                level = 'cold'

            results.append({
                'id': r['id'],
                'title': r['title'],
                'type': r['type'],
                'category': r['category'],
                'consensus': r['consensus'],
                'temperature': round(temperature, 3),
                'level': level,
                'totalUsage': r['total_usage'],
                'claimCount': r['claim_count'],
                'ageDays': round(age_days, 1),
            })

        # 按温度排序
        results.sort(key=lambda x: x['temperature'], reverse=True)

        self.send_json(results)
