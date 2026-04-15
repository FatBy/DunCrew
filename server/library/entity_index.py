"""Entity 索引管理器: 维护 Entity 缓存, 防止批量摄入时重复创建

核心职责:
1. 从 Wiki DB/API 拉取全量 Entity 索引
2. 为每个 IngestUnit 匹配相关已有 Entity
3. LLM 输出后二次校验 (防 slug/title 重复)
4. 写入成功后立即更新缓存
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
from difflib import SequenceMatcher
from typing import Optional

import httpx

from .models import EntitySummary

logger = logging.getLogger(__name__)


class EntityIndexManager:
    """Entity 索引管理器"""

    def __init__(self, db_path: Optional[str] = None, api_base: Optional[str] = None):
        """
        db_path: CLI 模式直接读 duncrew.db
        api_base: Server 模式通过 API (e.g. "http://localhost:3001")
        """
        self._db_path = db_path
        self._api_base = api_base
        self._cache: list[EntitySummary] = []

    @property
    def cache(self) -> list[EntitySummary]:
        return self._cache

    async def refresh(self, dun_id: Optional[str] = None):
        """从 Wiki 拉取全量 Entity 索引到缓存"""
        if self._db_path:
            self._refresh_from_db(dun_id)
        elif self._api_base:
            await self._refresh_from_api(dun_id)
        else:
            logger.warning("EntityIndexManager: 无 DB 路径也无 API 地址, 缓存为空")
        logger.info("Entity 索引已加载: %d 个", len(self._cache))

    def _refresh_from_db(self, dun_id: Optional[str] = None):
        """直接从 SQLite 读取 Entity 索引"""
        conn = sqlite3.connect(self._db_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=10000")

        try:
            if dun_id:
                rows = conn.execute(
                    "SELECT id, title, type, tldr, slug, tags FROM wiki_entity "
                    "WHERE (dun_id IS NULL OR dun_id = ?) AND status = 'active'",
                    (dun_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, title, type, tldr, slug, tags FROM wiki_entity "
                    "WHERE status = 'active'"
                ).fetchall()

            self._cache = [
                EntitySummary(
                    id=r["id"],
                    title=r["title"],
                    type=r["type"],
                    tldr=r["tldr"] or "",
                    slug=r["slug"] or "",
                    tags=json.loads(r["tags"]) if r["tags"] else [],
                )
                for r in rows
            ]
        finally:
            conn.close()

    async def _refresh_from_api(self, dun_id: Optional[str] = None):
        """通过 HTTP API 读取 Entity 索引"""
        url = f"{self._api_base.rstrip('/')}/api/wiki/entity-index"
        params = {}
        if dun_id:
            params["dun_id"] = dun_id

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        self._cache = [
            EntitySummary(
                id=item["id"],
                title=item["title"],
                type=item["type"],
                tldr=item.get("tldr", ""),
            )
            for item in data
        ]

    def find_relevant(self, text: str, top_k: int = 10) -> list[EntitySummary]:
        """
        为给定文本找到最相关的已有 Entity.
        使用简单关键词匹配 (TF-IDF 太重, 这里够用).
        """
        if not self._cache:
            return []

        # 提取关键词: 去停用词, 取 2-4 字的中文词
        keywords = self._extract_keywords(text)
        if not keywords:
            return []

        # 计算每个 Entity 的匹配得分
        scored: list[tuple[float, EntitySummary]] = []
        for entity in self._cache:
            score = self._match_score(entity, keywords)
            if score > 0:
                scored.append((score, entity))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [e for _, e in scored[:top_k]]

    def format_for_prompt(self, entities: list[EntitySummary]) -> str:
        """格式化为 LLM prompt 中的 Entity 索引段"""
        if not entities:
            return ""

        lines = ["已有 Entity 索引 (如果新知识属于已有 Entity, 请用 op=update 并带上已有 id):"]
        for e in entities:
            tags_str = f" [{', '.join(e.tags)}]" if e.tags else ""
            lines.append(f"- {e.id}: {e.title} [{e.type}]{tags_str} — {e.tldr}")
        return "\n".join(lines)

    def update(self, payload: dict):
        """
        LLM 输出 + Wiki 写入成功后, 立即更新缓存.
        确保后续文档能看到前面文档创建的 Entity.
        """
        items = payload if isinstance(payload, list) else [payload]
        for item in items:
            op = item.get("op")
            entity_data = item.get("entity", {})
            if not entity_data:
                continue

            if op == "create":
                self._cache.append(EntitySummary(
                    id=entity_data.get("id", ""),
                    title=entity_data.get("title", ""),
                    type=entity_data.get("type", "concept"),
                    tldr=entity_data.get("tldr", ""),
                    slug=entity_data.get("slug", ""),
                    tags=entity_data.get("tags", []),
                ))
            elif op == "update":
                eid = entity_data.get("id", "")
                for cached in self._cache:
                    if cached.id == eid:
                        if entity_data.get("tldr"):
                            cached.tldr = entity_data["tldr"]
                        if entity_data.get("tags"):
                            cached.tags = entity_data["tags"]
                        break

    def validate_no_duplicate(self, payload: dict) -> dict:
        """
        二次校验: LLM 输出 op=create 时, 检查是否真的需要新建.
        - slug 完全匹配 → 改为 update
        - title 编辑距离很小且 type 相同 → 改为 update
        """
        items = payload if isinstance(payload, list) else [payload]
        for item in items:
            if item.get("op") != "create":
                continue

            entity_data = item.get("entity", {})
            new_slug = entity_data.get("slug", "")
            new_title = entity_data.get("title", "")
            new_type = entity_data.get("type", "")

            for cached in self._cache:
                # slug 完全匹配
                if new_slug and cached.slug and new_slug == cached.slug:
                    logger.info(
                        "二次校验: create→update (slug匹配: %s)", new_slug
                    )
                    item["op"] = "update"
                    entity_data["id"] = cached.id
                    break

                # title 相似度很高且 type 相同
                if (new_type == cached.type
                    and _title_similarity(new_title, cached.title) > 0.85):
                    logger.info(
                        "二次校验: create→update (title相似: '%s' ≈ '%s')",
                        new_title, cached.title,
                    )
                    item["op"] = "update"
                    entity_data["id"] = cached.id
                    break

        return payload

    # ── 内部方法 ──

    @staticmethod
    def _extract_keywords(text: str, max_keywords: int = 30) -> set[str]:
        """简单关键词提取: 中文 2-6 字词 + 英文单词"""
        # 中文: 用标点切分后取 2-6 字片段
        cn_words: set[str] = set()
        segments = re.split(r"[，。、；：！？\s\n\r\t,.;:!?()\[\]{}\"\']+", text)
        for seg in segments:
            seg = seg.strip()
            if 2 <= len(seg) <= 6 and re.match(r"^[\u4e00-\u9fff]+$", seg):
                cn_words.add(seg)

        # 英文: 取 3+ 字母的单词
        en_words = {w.lower() for w in re.findall(r"[A-Za-z]{3,}", text)}

        combined = cn_words | en_words
        # 按在文本中出现频率排序, 取 top
        if len(combined) > max_keywords:
            scored = sorted(combined, key=lambda w: text.count(w), reverse=True)
            return set(scored[:max_keywords])
        return combined

    @staticmethod
    def _match_score(entity: EntitySummary, keywords: set[str]) -> float:
        """计算 Entity 与关键词集的匹配得分"""
        score = 0.0
        search_text = f"{entity.title} {entity.tldr} {' '.join(entity.tags)}".lower()

        for kw in keywords:
            kw_lower = kw.lower()
            if kw_lower in entity.title.lower():
                score += 3.0  # title 匹配权重高
            elif any(kw_lower in tag.lower() for tag in entity.tags):
                score += 2.0  # tags 匹配
            elif kw_lower in search_text:
                score += 1.0  # tldr 匹配

        return score


def _title_similarity(a: str, b: str) -> float:
    """标题相似度 (SequenceMatcher)"""
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()
