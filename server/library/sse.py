"""SSE (Server-Sent Events) helper for Library ingest streaming.

提供 SSE 响应头设置、事件发送、以及 IngestSSERunner 用于
在 pipeline 各阶段向前端推送实时进度。
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import time
from typing import Optional

from .config import load_config, LibraryConfig
from .pipeline import IngestPipeline
from .models import FileInfo, ParseResult

logger = logging.getLogger(__name__)


def start_sse_response(handler):
    """设置 SSE 响应头并开始流式输出"""
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("Connection", "keep-alive")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_cors_headers()
    handler.end_headers()


def send_sse_event(handler, event: str, data: dict):
    """发送一条 SSE 事件"""
    try:
        payload = json.dumps(data, ensure_ascii=False)
        chunk = f"event: {event}\ndata: {payload}\n\n"
        handler.wfile.write(chunk.encode("utf-8"))
        handler.wfile.flush()
    except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
        raise  # 让调用者知道连接已断


class IngestSSERunner:
    """运行 IngestPipeline 并通过 SSE 推送各阶段进度"""

    def __init__(self, handler, config: LibraryConfig):
        self.handler = handler
        self.config = config
        self.pipeline = IngestPipeline(config)
        self._cancelled = False

    def _emit(self, event: str, data: dict):
        send_sse_event(self.handler, event, data)

    def _log(self, level: str, message: str):
        self._emit("log", {"level": level, "message": message})

    def _db_retry(self, fn, label: str = "db_op", max_retries: int = 2):
        """执行数据库操作，遇到 database is locked 时短暂重试"""
        for attempt in range(max_retries):
            try:
                return fn()
            except sqlite3.OperationalError as e:
                if "locked" in str(e) and attempt < max_retries - 1:
                    logger.warning("DB locked on %s, retry %d/%d",
                                   label, attempt + 1, max_retries)
                    time.sleep(1)
                else:
                    raise

    def _db_safe(self, fn, label: str = "db_op"):
        """执行数据库操作, 失败时仅写 server log 而不中断 pipeline (不发 SSE)"""
        try:
            return self._db_retry(fn, label)
        except Exception as e:
            logger.warning("DB op '%s' failed (non-fatal): %s", label, e)
            return None

    def run(self, paths: list[str], dry_run: bool = False, force: bool = False):
        """运行全流程, 发送 SSE 事件"""
        start = time.perf_counter()

        try:
            # 1. 扫描
            self._log("info", "开始扫描文件...")
            files = self.pipeline.scanner.scan(paths)
            self._emit("scan", {"files_found": len(files)})
            self._log("info", f"扫描到 {len(files)} 个文件")

            if not files:
                self._emit("complete", {
                    "status": "empty",
                    "message": "没有找到可处理的文件",
                    "entities_total": 0,
                    "claims_total": 0,
                })
                return

            # 增量检测 (非阻断)
            if not force and self.pipeline.tracker:
                self._log("info", "正在进行增量检测...")
                try:
                    for p in paths:
                        prev = self._db_retry(
                            lambda _p=p: self.pipeline.tracker.get_previous_scan(_p),
                            "get_previous_scan",
                        )
                        if prev:
                            diff = self.pipeline.scanner.diff(files, prev)
                            changed = len(diff.added) + len(diff.modified)
                            if changed < len(files):
                                self._log("info", f"增量检测: {changed} 个新增/修改, {len(diff.deleted)} 个删除")
                                files = diff.added + diff.modified
                except Exception as e:
                    self._log("warn", f"增量检测跳过: {e}")

            # 保存扫描记录 (非阻断, 失败不影响后续流程)
            if self.pipeline.tracker:
                self._log("info", f"保存扫描记录 ({len(files)} 条)...")
                for p in paths:
                    self._db_safe(
                        lambda _p=p: self.pipeline.tracker.save_scan_records(files, _p),
                        "save_scan_records",
                    )

            # 2. 解析 + 清洗
            self._log("info", "开始解析 + 清洗...")
            parsed: list[ParseResult] = []
            total = len(files)
            db_fail_count = 0
            parse_fail_count = 0
            # 控制 SSE 发送频率: 文件少则每文件发, 文件多则按比例间隔发
            emit_interval = max(1, total // 50)  # 最多发 ~50 条 progress 事件

            for i, f in enumerate(files, 1):
                if self._cancelled:
                    self._emit("error", {"message": "用户取消"})
                    return
                try:
                    from .parsers import parse_file
                    result = parse_file(f.path)
                    result.metadata.content_hash = f.content_hash
                    result = self.pipeline.cleaner.clean(result)

                    if not result.content.strip():
                        continue
                    if (f.extension == ".pptx"
                            and len(result.content) < self.config.parsing.skip_pptx_under_chars):
                        continue

                    parsed.append(result)
                    if self.pipeline.tracker:
                        ok = self._db_safe(
                            lambda _f=f, _r=result: self.pipeline.tracker.save_document(_f, _r),
                            "save_document",
                        )
                        if ok is None:
                            db_fail_count += 1

                except Exception as e:
                    parse_fail_count += 1
                    logger.warning("解析失败 %s: %s", f.name, e)
                    if self.pipeline.tracker:
                        self._db_safe(
                            lambda _f=f: self.pipeline.tracker.save_document(_f),
                            "save_document(err)",
                        )
                        self._db_safe(
                            lambda _f=f, _e=str(e): self.pipeline.tracker.mark_error(_f.content_hash, _e),
                            "mark_error",
                        )

                # 按间隔发送 progress, 或在最后一个文件时发送
                if i % emit_interval == 0 or i == total:
                    self._emit("parse_progress", {
                        "current": i, "total": total,
                        "file": f.name,
                        "percent": round(i / total * 50, 1),
                    })

            # 汇总日志 (只发 1-3 条)
            self._log("info", f"成功解析 {len(parsed)} 个文档")
            if parse_fail_count > 0:
                self._log("warn", f"{parse_fail_count} 个文件解析失败")
            if db_fail_count > 0:
                self._log("warn", f"{db_fail_count} 次数据库写入跳过 (不影响结果)")

            # 3. 去重
            self._log("info", "开始去重...")
            dedup_result = self.pipeline.deduplicate(parsed)
            unique_docs = dedup_result.unique
            stats = dedup_result.stats
            self._emit("dedup", {
                "input": stats.total_input,
                "unique": stats.unique_output,
                "duplicates": stats.total_input - stats.unique_output,
            })

            # 4. 分组
            self._log("info", "开始分组...")
            units = self.pipeline.grouper.group(unique_docs)
            total_chars = sum(u.char_count for u in units)
            est_tokens = int(total_chars * 1.5)
            self._emit("group", {
                "units": len(units),
                "total_chars": total_chars,
                "estimated_tokens": est_tokens,
            })

            # dry-run 到此结束
            dry_run_data = {
                "files_scanned": len(files),
                "files_parsed": len(parsed),
                "files_unique": len(unique_docs),
                "ingest_units": len(units),
                "total_chars": total_chars,
                "estimated_tokens": est_tokens,
            }

            if dry_run:
                elapsed = time.perf_counter() - start
                dry_run_data["elapsed_seconds"] = round(elapsed, 2)
                self._emit("dry_run_complete", dry_run_data)
                return

            # 5. LLM 提取 + Wiki 写入
            if not self.config.llm.api_key:
                self._emit("error", {"message": "LLM API Key 未配置，请在 LinkStation 中配置模型后重试"})
                return

            self._log("info", f"开始 LLM 提取 (模型: {self.config.llm.model})...")

            from .llm_client import LLMClient
            from .wiki_writer import WikiWriter
            from .entity_index import EntityIndexManager
            from .wiki_bridge import WikiBridge

            llm_client = LLMClient(self.config.llm)
            wiki_writer = WikiWriter(db_path=self.config.db_path)
            entity_index = EntityIndexManager(db_path=self.config.db_path)
            bridge = WikiBridge(
                llm_client=llm_client,
                wiki_writer=wiki_writer,
                entity_index=entity_index,
            )

            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            entities_total = 0
            claims_total = 0

            try:
                for i, unit in enumerate(units, 1):
                    if self._cancelled:
                        self._emit("error", {"message": "用户取消"})
                        return

                    try:
                        result = loop.run_until_complete(
                            bridge.process_unit(unit)
                        )
                        e_count = result.get("entities_created", 0)
                        c_count = result.get("claims_created", 0)
                        entities_total += e_count
                        claims_total += c_count

                        self._emit("llm_progress", {
                            "current": i, "total": len(units),
                            "unit_id": unit.id,
                            "entities_created": e_count,
                            "claims_created": c_count,
                            "percent": round(50 + i / len(units) * 50, 1),
                        })
                        self._log("info", f"[{i}/{len(units)}] +{e_count}E +{c_count}C")

                        if result.get("error"):
                            self._log("warn", f"unit {unit.id}: {result['error']}")

                    except Exception as e:
                        self._log("error", f"LLM 处理失败 unit {unit.id}: {e}")
            finally:
                # 确保关闭 LLM client 和 event loop
                try:
                    loop.run_until_complete(llm_client.close())
                except Exception:
                    pass
                loop.close()

            elapsed = time.perf_counter() - start
            self._emit("complete", {
                "status": "ok",
                "entities_total": entities_total,
                "claims_total": claims_total,
                "elapsed_seconds": round(elapsed, 2),
                **dry_run_data,
            })
            self._log("info", f"摄入完成: {entities_total} Entity, {claims_total} Claim, 耗时 {elapsed:.1f}s")

        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            logger.info("SSE 客户端已断开")
        except Exception as e:
            logger.error("SSE ingest 失败: %s", e, exc_info=True)
            try:
                self._emit("error", {"message": str(e)})
            except Exception:
                pass

    def cancel(self):
        self._cancelled = True
