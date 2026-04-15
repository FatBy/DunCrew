"""DunCrew Server - Wiki Knowledge Graph API Mixin

Entity-Claim-Evidence 三层知识模型的 CRUD API。

Tables: wiki_entity, wiki_claim, wiki_evidence, wiki_relation, wiki_ingest_log
"""
from __future__ import annotations

import json
import time
import uuid

from server.state import _db_lock


def _now_ms() -> int:
    return int(time.time() * 1000)


def _uuid() -> str:
    return uuid.uuid4().hex[:16]


class WikiMixin:
    """Wiki Knowledge Graph API Mixin"""

    # ============================================
    # Entity CRUD
    # ============================================

    def handle_wiki_entities_list(self, query: dict):
        """GET /api/wiki/entities?dun_id=xxx
        返回 Entity 列表，附带 claim_count。
        dun_id 缺省时返回全局 Entity。
        """
        db = self._get_db()
        dun_id = query.get('dun_id', [None])[0]

        if dun_id:
            sql = """
                SELECT e.*, COUNT(c.id) AS claim_count
                FROM wiki_entity e
                LEFT JOIN wiki_claim c ON c.entity_id = e.id AND c.status != 'superseded'
                WHERE e.dun_id = ? AND e.status = 'active'
                GROUP BY e.id
                ORDER BY e.updated_at DESC
            """
            params = [dun_id]
        else:
            sql = """
                SELECT e.*, COUNT(c.id) AS claim_count
                FROM wiki_entity e
                LEFT JOIN wiki_claim c ON c.entity_id = e.id AND c.status != 'superseded'
                WHERE e.dun_id IS NULL AND e.status = 'active'
                GROUP BY e.id
                ORDER BY e.updated_at DESC
            """
            params = []

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
                           SET title = ?, tldr = ?, tags = ?, updated_at = ?
                           WHERE id = ?""",
                        (
                            entity_data.get('title'),
                            entity_data.get('tldr'),
                            json.dumps(entity_data.get('tags', []), ensure_ascii=False),
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
                           (id, dun_id, slug, title, type, tldr, tags, status, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
                        (
                            entity_id, dun_id, slug,
                            entity_data.get('title'),
                            entity_data.get('type', 'concept'),
                            entity_data.get('tldr'),
                            json.dumps(entity_data.get('tags', []), ensure_ascii=False),
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
                            status, source_ingest_id, created_at, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
                        (
                            claim_id, entity_id,
                            claim_data.get('content', ''),
                            claim_data.get('type'),
                            claim_data.get('value'),
                            claim_data.get('trend'),
                            claim_data.get('confidence', 0.8),
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
