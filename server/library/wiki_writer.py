"""Wiki 写入器: 将 LLM 提取结果写入 DunCrew Wiki

两种模式:
- write_via_db: CLI 模式直接写 SQLite (复制 wiki.py handle_wiki_ingest 逻辑)
- write_via_api: Server 模式 POST /api/wiki/ingest
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


def _uuid() -> str:
    return uuid.uuid4().hex[:12]


def _now_ms() -> int:
    return int(time.time() * 1000)


class WikiWriter:
    """Wiki 写入器"""

    def __init__(
        self,
        db_path: Optional[str] = None,
        api_base: Optional[str] = None,
    ):
        self._db_path = db_path
        self._api_base = api_base

    async def write(
        self, payload: dict, dun_id: Optional[str] = None
    ) -> dict:
        """
        写入一条 Wiki ingest payload.
        返回 {"entity_id": str, "claim_count": int, "op": str}
        """
        if payload.get("op") == "noop":
            return {"entity_id": None, "claim_count": 0, "op": "noop"}

        payload.setdefault("dun_id", dun_id)

        if self._db_path:
            return self._write_via_db(payload)
        elif self._api_base:
            return await self._write_via_api(payload)
        else:
            raise RuntimeError("WikiWriter: 未配置 db_path 或 api_base")

    def _write_via_db(self, data: dict) -> dict:
        """直接写 SQLite — 等价于 wiki.py handle_wiki_ingest"""
        conn = sqlite3.connect(self._db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")

        op = data.get("op", "noop")
        dun_id = data.get("dun_id")
        entity_data = data.get("entity", {})
        claims_data = data.get("claims", [])
        relations_data = data.get("relations", [])

        now = _now_ms()
        ingest_id = f"ing-{_uuid()}"
        affected_entities = []
        claim_count = 0

        try:
            conn.execute("BEGIN")

            # ---- Entity ----
            entity_id = entity_data.get("id")

            if op == "update" and entity_id:
                conn.execute(
                    """UPDATE wiki_entity
                       SET title = ?, tldr = ?, tags = ?, category = ?,
                           temporal_scope = ?, updated_at = ?
                       WHERE id = ?""",
                    (
                        entity_data.get("title"),
                        entity_data.get("tldr"),
                        json.dumps(entity_data.get("tags", []), ensure_ascii=False),
                        entity_data.get("category"),
                        entity_data.get("temporal_scope"),
                        now,
                        entity_id,
                    ),
                )
            else:
                entity_id = f"ent-{_uuid()}"
                slug = (
                    entity_data.get("slug")
                    or entity_data.get("title", "").lower().replace(" ", "-")[:60]
                )
                conn.execute(
                    """INSERT INTO wiki_entity
                       (id, dun_id, slug, title, type, tldr, tags, category,
                        temporal_scope, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)""",
                    (
                        entity_id,
                        dun_id,
                        slug,
                        entity_data.get("title"),
                        entity_data.get("type", "concept"),
                        entity_data.get("tldr"),
                        json.dumps(entity_data.get("tags", []), ensure_ascii=False),
                        entity_data.get("category"),
                        entity_data.get("temporal_scope"),
                        now,
                        now,
                    ),
                )

            affected_entities.append(entity_id)

            # ---- Claims ----
            for claim_data in claims_data:
                claim_id = f"clm-{_uuid()}"
                conn.execute(
                    """INSERT INTO wiki_claim
                       (id, entity_id, content, type, value, trend, confidence,
                        observed_at, source_summary,
                        status, source_ingest_id, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)""",
                    (
                        claim_id,
                        entity_id,
                        claim_data.get("content", ""),
                        claim_data.get("type"),
                        claim_data.get("value"),
                        claim_data.get("trend"),
                        claim_data.get("confidence", 0.8),
                        claim_data.get("observed_at"),
                        claim_data.get("source_summary"),
                        ingest_id,
                        now,
                        now,
                    ),
                )
                claim_count += 1

                # Evidence
                evidence = claim_data.get("evidence")
                if evidence and evidence.get("source_name"):
                    ev_id = f"ev-{_uuid()}"
                    conn.execute(
                        """INSERT INTO wiki_evidence
                           (id, claim_id, source_name, chunk_text, timestamp)
                           VALUES (?, ?, ?, ?, ?)""",
                        (
                            ev_id,
                            claim_id,
                            evidence.get("source_name", ""),
                            evidence.get("chunk_text"),
                            now,
                        ),
                    )

            # ---- Relations ----
            for rel_data in relations_data:
                target_title = rel_data.get("target_title", "")
                if not target_title:
                    continue

                rel_type = rel_data.get("type", "related_to")

                # 查找或创建 target entity
                target_row = conn.execute(
                    "SELECT id FROM wiki_entity WHERE title = ? "
                    "AND (dun_id = ? OR (dun_id IS NULL AND ? IS NULL))",
                    (target_title, dun_id, dun_id),
                ).fetchone()

                if target_row:
                    target_id = target_row["id"]
                else:
                    target_id = f"ent-{_uuid()}"
                    target_slug = target_title.lower().replace(" ", "-")[:60]
                    conn.execute(
                        """INSERT INTO wiki_entity
                           (id, dun_id, slug, title, type, tldr, tags, status, created_at, updated_at)
                           VALUES (?, ?, ?, ?, 'concept', NULL, '[]', 'active', ?, ?)""",
                        (target_id, dun_id, target_slug, target_title, now, now),
                    )
                    affected_entities.append(target_id)

                rel_id = f"rel-{_uuid()}"
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO wiki_relation
                           (id, source_id, target_id, type, strength, description, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (
                            rel_id,
                            entity_id,
                            target_id,
                            rel_type,
                            rel_data.get("strength", 0.5),
                            rel_data.get("description"),
                            now,
                        ),
                    )
                except Exception:
                    pass

            # ---- Ingest Log ----
            conn.execute(
                """INSERT INTO wiki_ingest_log
                   (id, dun_id, input_text, output_json, entities_affected, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    ingest_id,
                    dun_id,
                    f"[Library ingest]",
                    json.dumps(data, ensure_ascii=False),
                    json.dumps(affected_entities, ensure_ascii=False),
                    now,
                ),
            )

            conn.commit()

            # 回填 entity_id 到 payload (供 EntityIndexManager 缓存更新)
            entity_data["id"] = entity_id

            return {
                "entity_id": entity_id,
                "claim_count": claim_count,
                "op": op,
            }

        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    async def _write_via_api(self, data: dict) -> dict:
        """通过 HTTP API 写入"""
        url = f"{self._api_base.rstrip('/')}/api/wiki/ingest"

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(url, json=data)
            resp.raise_for_status()
            result = resp.json()

        entity_data = data.get("entity", {})
        entity_data["id"] = result.get("entityId", "")

        return {
            "entity_id": result.get("entityId"),
            "claim_count": len(data.get("claims", [])),
            "op": data.get("op"),
        }
