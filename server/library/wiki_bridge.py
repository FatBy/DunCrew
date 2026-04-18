"""WikiBridge: 连接解析管线和 DunCrew Wiki 的核心模块

三大职责:
1. Entity 冲突管理 (通过 EntityIndexManager)
2. LLM 提取 (文档类型专用 prompt)
3. Wiki 写入 (通过 WikiWriter)
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Callable, Optional

from .entity_index import EntityIndexManager
from .llm_client import LLMClient
from .models import BatchProgress, BatchResult, IngestUnit, TokenUsage
from .prompts import build_system_prompt
from .wiki_writer import WikiWriter

logger = logging.getLogger(__name__)


class WikiBridge:
    """核心模块: LLM 提取 + Entity 冲突管理 + Wiki 写入"""

    def __init__(
        self,
        llm_client: LLMClient,
        wiki_writer: WikiWriter,
        entity_index: EntityIndexManager,
        max_concurrent: int = 3,
    ):
        self.llm = llm_client
        self.wiki = wiki_writer
        self.entity_index = entity_index
        self.max_concurrent = max_concurrent
        self._cancelled = False
        self._index_loaded = False

    def cancel(self):
        """取消当前批量处理"""
        self._cancelled = True

    async def process_unit(self, unit: IngestUnit, dun_id: Optional[str] = None) -> dict:
        """处理单个 IngestUnit，返回统计 dict (供 SSE runner 使用)"""
        progress = BatchProgress(total=1)
        result = BatchResult(progress=progress)

        # 首次调用时确保 Entity 索引已加载
        if not self._index_loaded:
            try:
                await self.entity_index.refresh(dun_id)
            except Exception as e:
                logger.warning("Entity 索引拉取失败: %s", e)
            self._index_loaded = True

        await self._process_unit(unit, dun_id, progress, result)

        return {
            "entities_created": progress.entities_created,
            "entities_updated": progress.entities_updated,
            "claims_created": progress.claims_created,
            "input_tokens": progress.total_tokens.input_tokens,
            "output_tokens": progress.total_tokens.output_tokens,
            "error": result.errors[0]["error"] if result.errors else None,
        }

    async def process_batch(
        self,
        units: list[IngestUnit],
        dun_id: Optional[str] = None,
        on_progress: Optional[Callable[[BatchProgress], None]] = None,
    ) -> BatchResult:
        """
        批量处理主循环:
        1. 拉取 Entity 索引
        2. 对每个 IngestUnit: 匹配相关 Entity → LLM 提取 → 校验 → Wiki 写入
        """
        self._cancelled = False
        start_time = time.perf_counter()

        progress = BatchProgress(total=len(units))
        result = BatchResult(progress=progress)

        # 1. 拉取 Entity 索引
        try:
            await self.entity_index.refresh(dun_id)
        except Exception as e:
            logger.error("Entity 索引拉取失败: %s", e)
            # 继续执行, 只是没有索引匹配

        # 2. 使用 semaphore 控制并发
        semaphore = asyncio.Semaphore(self.max_concurrent)

        async def process_one(unit: IngestUnit):
            async with semaphore:
                if self._cancelled:
                    return
                await self._process_unit(unit, dun_id, progress, result)
                if on_progress:
                    on_progress(progress)

        # 串行处理以保证 Entity 索引缓存一致性
        # (并发会导致缓存更新竞争, 得不偿失)
        for unit in units:
            if self._cancelled:
                break
            await self._process_unit(unit, dun_id, progress, result)
            if on_progress:
                on_progress(progress)
            # 调用间隔
            await asyncio.sleep(0.1)

        result.duration_seconds = time.perf_counter() - start_time

        logger.info(
            "批量处理完成: %d/%d 成功, %d Entity 创建, %d 更新, %d Claim, "
            "%.1f 秒, %d+%d tokens",
            progress.succeeded, progress.total,
            progress.entities_created, progress.entities_updated,
            progress.claims_created, result.duration_seconds,
            progress.total_tokens.input_tokens,
            progress.total_tokens.output_tokens,
        )

        return result

    async def _process_unit(
        self,
        unit: IngestUnit,
        dun_id: Optional[str],
        progress: BatchProgress,
        result: BatchResult,
    ):
        """处理单个 IngestUnit"""
        progress.current_file = ", ".join(
            s.rsplit("\\", 1)[-1] for s in unit.source_documents[:2]
        )
        progress.current_stage = "llm_extract"

        try:
            # a. 找到相关 Entity
            relevant = self.entity_index.find_relevant(unit.content)
            entity_index_text = self.entity_index.format_for_prompt(relevant)

            # b. 构建 prompt
            system_prompt = build_system_prompt(unit.doc_type, entity_index_text)
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": unit.content},
            ]

            # c. 调用 LLM
            raw_response, token_usage = await self.llm.chat(messages)
            progress.total_tokens.input_tokens += token_usage.input_tokens
            progress.total_tokens.output_tokens += token_usage.output_tokens

            # d. 解析 JSON
            payloads = self._parse_llm_output(raw_response)

            if not payloads:
                progress.processed += 1
                progress.skipped += 1
                return

            # e. 对每个 payload: 校验 → 回填 chunk_text → 写入 → 更新缓存
            progress.current_stage = "wiki_write"
            for payload in payloads:
                if payload.get("op") == "noop":
                    continue

                # 二次校验
                payload = self.entity_index.validate_no_duplicate(payload)

                # 自动回填 evidence.chunk_text (从源文本模糊匹配)
                self._backfill_chunk_text(payload.get("claims", []), unit.content)

                # Wiki 写入
                write_result = await self.wiki.write(payload, dun_id)

                # 更新缓存
                self.entity_index.update(payload)

                # 统计
                op = write_result.get("op")
                if op == "create":
                    progress.entities_created += 1
                elif op == "update":
                    progress.entities_updated += 1
                progress.claims_created += write_result.get("claim_count", 0)

            progress.processed += 1
            progress.succeeded += 1

        except Exception as e:
            logger.error("处理失败 [%s]: %s", unit.id, e, exc_info=True)
            progress.processed += 1
            progress.failed += 1
            result.errors.append({
                "unit_id": unit.id,
                "sources": unit.source_documents,
                "error": str(e),
            })

    def _parse_llm_output(self, raw: str) -> list[dict]:
        """
        解析 LLM 输出的 JSON.
        支持: 单个对象, JSON 数组, markdown 代码块包裹.
        """
        # 去掉 markdown 代码块
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```\w*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
            raw = raw.strip()

        if not raw:
            return []

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            # 尝试修复常见问题: 尾部逗号, 单引号
            cleaned = raw.replace("'", '"')
            cleaned = re.sub(r",\s*([}\]])", r"\1", cleaned)
            try:
                parsed = json.loads(cleaned)
            except json.JSONDecodeError:
                logger.warning("LLM 输出 JSON 解析失败: %s...", raw[:200])
                return []

        if isinstance(parsed, list):
            return [p for p in parsed if isinstance(p, dict)]
        elif isinstance(parsed, dict):
            return [parsed]
        else:
            return []

    @staticmethod
    def _backfill_chunk_text(claims: list[dict], source_text: str) -> None:
        """从源文本中模糊匹配, 自动回填 evidence.chunk_text"""
        if not source_text:
            return
        for claim in claims:
            evidence = claim.get("evidence")
            if not isinstance(evidence, dict):
                continue
            if evidence.get("chunk_text"):
                continue
            claim_content = claim.get("content", "")
            if not claim_content or len(claim_content) < 4:
                continue
            # 提取关键短语在源文本中查找
            phrases = re.findall(r"[\u4e00-\u9fff]{4,}", claim_content)
            phrases += re.findall(r"[A-Za-z0-9]{4,}", claim_content)
            phrases += re.findall(r"[\d.]+[%％亿万千百元美][\u4e00-\u9fff]*", claim_content)
            if not phrases:
                continue
            phrases.sort(key=len, reverse=True)
            for phrase in phrases[:5]:
                idx = source_text.find(phrase)
                if idx != -1:
                    start = max(0, idx - 150)
                    end = min(len(source_text), idx + len(phrase) + 150)
                    # 对齐到句子边界
                    if start > 0:
                        boundary = max(
                            source_text.rfind("。", start - 50, idx),
                            source_text.rfind("\n", start - 50, idx),
                        )
                        if boundary > start - 50:
                            start = boundary + 1
                    if end < len(source_text):
                        candidates = [
                            source_text.find(sep, idx + len(phrase), end + 50)
                            for sep in ("。", "\n")
                        ]
                        valid = [c for c in candidates if c != -1]
                        if valid:
                            end = min(valid) + 1
                    chunk = source_text[start:end].strip()
                    if len(chunk) > 20:
                        evidence["chunk_text"] = chunk[:500]
                        break
