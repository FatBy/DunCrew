"""文档去重器: 三级去重策略

Level 1: SHA-256(content) 完全相同 → 跳过
Level 2: Jaccard n-gram 相似度 > threshold → 保留最新版本
Level 3: 同目录同名不同格式 → 保留文本质量高的
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from pathlib import Path

from .config import DedupConfig
from .models import (
    DeduplicateResult,
    DeduplicateStats,
    DuplicateGroup,
    ParseResult,
)

logger = logging.getLogger(__name__)


class DocumentDeduplicator:
    """文档去重器"""

    def __init__(self, config: DedupConfig | None = None):
        self.config = config or DedupConfig()

    def deduplicate(self, documents: list[ParseResult]) -> DeduplicateResult:
        """三级去重, 返回去重结果"""
        stats = DeduplicateStats(total_input=len(documents))
        duplicates: list[DuplicateGroup] = []
        remaining = list(documents)

        # Level 1: 内容哈希完全相同
        remaining, dups = self._dedup_by_hash(remaining)
        duplicates.extend(dups)
        stats.hash_duplicates = sum(len(d.dropped) for d in dups)

        # Level 2: n-gram 相似度
        remaining, dups = self._dedup_by_similarity(remaining)
        duplicates.extend(dups)
        stats.similarity_duplicates = sum(len(d.dropped) for d in dups)

        # Level 3: 跨格式去重 (同名不同扩展名)
        if self.config.cross_format_dedup:
            remaining, dups = self._dedup_cross_format(remaining)
            duplicates.extend(dups)
            stats.cross_format_duplicates = sum(len(d.dropped) for d in dups)

        stats.unique_output = len(remaining)
        logger.info(
            "去重完成: %d → %d (哈希: -%d, 相似: -%d, 跨格式: -%d)",
            stats.total_input, stats.unique_output,
            stats.hash_duplicates, stats.similarity_duplicates,
            stats.cross_format_duplicates,
        )

        return DeduplicateResult(unique=remaining, duplicates=duplicates, stats=stats)

    # ── Level 1: 哈希去重 ──

    def _dedup_by_hash(
        self, docs: list[ParseResult]
    ) -> tuple[list[ParseResult], list[DuplicateGroup]]:
        """内容哈希完全相同的文档, 保留一份"""
        import hashlib

        groups: dict[str, list[ParseResult]] = defaultdict(list)
        for doc in docs:
            h = hashlib.sha256(doc.content.encode("utf-8")).hexdigest()
            groups[h].append(doc)

        unique: list[ParseResult] = []
        duplicates: list[DuplicateGroup] = []

        for h, group in groups.items():
            kept = self._pick_best(group)
            unique.append(kept)
            dropped = [d for d in group if d is not kept]
            if dropped:
                duplicates.append(DuplicateGroup(
                    kept=kept, dropped=dropped,
                    reason="hash_exact", similarity=1.0,
                ))

        return unique, duplicates

    # ── Level 2: n-gram 相似度去重 ──

    def _dedup_by_similarity(
        self, docs: list[ParseResult]
    ) -> tuple[list[ParseResult], list[DuplicateGroup]]:
        """Jaccard n-gram 相似度高于阈值的文档, 保留一份"""
        if len(docs) < 2:
            return docs, []

        threshold = self.config.similarity_threshold
        # 预计算每个文档的 n-gram 集合
        ngram_sets = [self._text_ngrams(d.content) for d in docs]

        merged: list[bool] = [False] * len(docs)
        unique: list[ParseResult] = []
        duplicates: list[DuplicateGroup] = []

        for i in range(len(docs)):
            if merged[i]:
                continue

            group = [docs[i]]
            for j in range(i + 1, len(docs)):
                if merged[j]:
                    continue
                sim = self._jaccard(ngram_sets[i], ngram_sets[j])
                if sim >= threshold:
                    group.append(docs[j])
                    merged[j] = True

            kept = self._pick_best(group)
            unique.append(kept)
            dropped = [d for d in group if d is not kept]
            if dropped:
                duplicates.append(DuplicateGroup(
                    kept=kept, dropped=dropped,
                    reason="high_similarity",
                    similarity=threshold,
                ))

        return unique, duplicates

    # ── Level 3: 跨格式去重 ──

    def _dedup_cross_format(
        self, docs: list[ParseResult]
    ) -> tuple[list[ParseResult], list[DuplicateGroup]]:
        """同目录、核心文件名相同但扩展名不同 → 保留文本质量最高的"""
        groups: dict[str, list[ParseResult]] = defaultdict(list)

        for doc in docs:
            p = Path(doc.metadata.source_path)
            core_name = self._normalize_name(p.stem)
            dir_key = str(p.parent)
            groups[f"{dir_key}::{core_name}"].append(doc)

        unique: list[ParseResult] = []
        duplicates: list[DuplicateGroup] = []

        for key, group in groups.items():
            if len(group) == 1:
                unique.append(group[0])
                continue

            # 检查是否确实是不同扩展名
            exts = {Path(d.metadata.source_path).suffix.lower() for d in group}
            if len(exts) < 2:
                unique.extend(group)
                continue

            kept = self._pick_best(group)
            unique.append(kept)
            dropped = [d for d in group if d is not kept]
            if dropped:
                duplicates.append(DuplicateGroup(
                    kept=kept, dropped=dropped,
                    reason="cross_format", similarity=0.0,
                ))

        return unique, duplicates

    # ── 工具方法 ──

    def _pick_best(self, group: list[ParseResult]) -> ParseResult:
        """从一组文档中选择最佳版本"""
        if self.config.keep_strategy == "newest":
            return max(group, key=lambda d: d.metadata.modified_at or "")
        else:  # largest
            return max(group, key=lambda d: len(d.content))

    @staticmethod
    def _text_ngrams(text: str, n: int = 3) -> set[str]:
        """提取文本 n-gram 集合 (去空白)"""
        text = re.sub(r"\s+", "", text)
        if len(text) < n:
            return {text}
        return {text[i:i + n] for i in range(len(text) - n + 1)}

    @staticmethod
    def _jaccard(a: set[str], b: set[str]) -> float:
        """Jaccard 相似度"""
        if not a and not b:
            return 1.0
        intersection = len(a & b)
        union = len(a | b)
        return intersection / union if union else 0.0

    @staticmethod
    def _normalize_name(name: str) -> str:
        """
        去掉版本后缀: _v1, _修改, _定稿, _final, (1) 等.
        返回核心文件名用于跨格式比较.
        """
        # 去掉常见版本后缀
        name = re.sub(r"[_\-\s]*(v\d+|修改|定稿|final|最终|终版|副本)\s*$", "", name, flags=re.IGNORECASE)
        # 去掉尾部 (1), (2) 等
        name = re.sub(r"\s*\(\d+\)\s*$", "", name)
        return name.strip().lower()
