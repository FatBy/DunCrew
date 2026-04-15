"""IngestPipeline: 串联所有模块 + CLI 入口

用法:
  python -m server.library.pipeline scan "D:\\工作" --stats
  python -m server.library.pipeline preview "D:\\工作\\报告.pdf"
  python -m server.library.pipeline ingest "D:\\工作" --model qwen-turbo --api-key sk-xxx
  python -m server.library.pipeline ingest "D:\\工作" --dry-run
  python -m server.library.pipeline status --db "D:\\DunCrew-Data\\duncrew.db"
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import time
from pathlib import Path
from typing import Optional

from .cleaner import DocumentCleaner
from .config import LibraryConfig, load_config
from .deduplicator import DocumentDeduplicator
from .entity_index import EntityIndexManager
from .grouper import DocumentGrouper
from .llm_client import LLMClient
from .models import BatchProgress, FileInfo, ParseResult
from .parsers import parse_file
from .scanner import FileScanner
from .tracker import Tracker
from .wiki_bridge import WikiBridge
from .wiki_writer import WikiWriter

logger = logging.getLogger(__name__)


class IngestPipeline:
    """摄入管线: 串联 Scanner → Parser → Cleaner → Dedup → Grouper → WikiBridge"""

    def __init__(self, config: LibraryConfig):
        self.config = config
        self.scanner = FileScanner(
            max_file_size_mb=config.parsing.max_file_size_mb,
        )
        self.cleaner = DocumentCleaner(config.cleaning)
        self.deduplicator = DocumentDeduplicator(config.dedup)
        self.grouper = DocumentGrouper(config.grouping)
        self.tracker = Tracker(config.db_path) if config.db_path else None

    def scan(self, paths: list[str]) -> list[FileInfo]:
        """扫描文件"""
        files = self.scanner.scan(paths)
        if self.tracker:
            for p in paths:
                self.tracker.save_scan_records(files, p)
        return files

    def parse_and_clean(self, files: list[FileInfo]) -> list[ParseResult]:
        """解析 + 清洗"""
        results: list[ParseResult] = []
        total = len(files)

        for i, f in enumerate(files, 1):
            try:
                _print_progress(f"解析+清洗", i, total, f.name)
                result = parse_file(f.path)
                result.metadata.content_hash = f.content_hash

                # 清洗
                result = self.cleaner.clean(result)

                if not result.content.strip():
                    logger.debug("空内容, 跳过: %s", f.name)
                    continue

                # PPTX 文本过少跳过
                if (f.extension == ".pptx"
                    and len(result.content) < self.config.parsing.skip_pptx_under_chars):
                    logger.debug("PPTX 文本过少, 跳过: %s", f.name)
                    continue

                results.append(result)

                if self.tracker:
                    self.tracker.save_document(f, result)

            except Exception as e:
                logger.warning("解析失败 %s: %s", f.name, e)
                if self.tracker:
                    self.tracker.save_document(f)
                    self.tracker.mark_error(f.content_hash, str(e))

        return results

    def deduplicate(self, docs: list[ParseResult]):
        """去重"""
        result = self.deduplicator.deduplicate(docs)

        # 记录重复关系
        if self.tracker:
            for group in result.duplicates:
                for dropped in group.dropped:
                    self.tracker.mark_duplicate(
                        dropped.metadata.content_hash,
                        group.kept.metadata.content_hash,
                    )

        return result

    async def ingest(
        self,
        paths: list[str],
        dun_id: Optional[str] = None,
        dry_run: bool = False,
        force: bool = False,
    ) -> dict:
        """
        全流程摄入.
        dry_run=True: 只运行 scan→parse→clean→dedup→group, 不调 LLM.
        """
        start = time.perf_counter()

        # 1. 扫描
        print(f"\n[1/6] 扫描文件...")
        files = self.scanner.scan(paths)
        print(f"  扫描到 {len(files)} 个文件")

        if not files:
            print("  没有找到可处理的文件")
            return {"status": "empty"}

        # 增量检测 (非 force 模式) — 在保存扫描记录之前做
        if not force and self.tracker:
            for p in paths:
                prev = self.tracker.get_previous_scan(p)
                if prev:
                    diff = self.scanner.diff(files, prev)
                    changed = len(diff.added) + len(diff.modified)
                    if changed < len(files):
                        print(f"  增量检测: {changed} 个新增/修改, {len(diff.deleted)} 个删除")
                        files = diff.added + diff.modified

        # 保存本次扫描记录 (增量检测之后)
        if self.tracker:
            for p in paths:
                self.tracker.save_scan_records(files, p)

        # 2. 解析 + 清洗
        print(f"\n[2/6] 解析 + 清洗...")
        parsed = self.parse_and_clean(files)
        print(f"  成功解析 {len(parsed)} 个文档")

        # 3. 去重
        print(f"\n[3/6] 去重...")
        dedup_result = self.deduplicate(parsed)
        unique_docs = dedup_result.unique
        stats = dedup_result.stats
        print(f"  {stats.total_input} → {stats.unique_output} "
              f"(哈希重复 -{stats.hash_duplicates}, "
              f"相似重复 -{stats.similarity_duplicates}, "
              f"跨格式 -{stats.cross_format_duplicates})")

        # 4. 分组
        print(f"\n[4/6] 分组...")
        units = self.grouper.group(unique_docs)
        print(f"  {len(unique_docs)} 文档 → {len(units)} 个 IngestUnit")

        total_chars = sum(u.char_count for u in units)
        est_tokens = int(total_chars * 1.5)  # 粗估
        print(f"  总字符: {total_chars:,}, 预估输入 token: ~{est_tokens:,}")

        if dry_run:
            print(f"\n[DRY RUN] 到此为止, 不调用 LLM")
            elapsed = time.perf_counter() - start
            return {
                "status": "dry_run",
                "files_scanned": len(files),
                "files_parsed": len(parsed),
                "files_unique": len(unique_docs),
                "ingest_units": len(units),
                "total_chars": total_chars,
                "estimated_tokens": est_tokens,
                "elapsed_seconds": elapsed,
            }

        # 5. LLM 提取 + Wiki 写入
        if not self.config.llm.api_key:
            print("\n[ERROR] LLM API Key 未配置. 使用 --api-key 或环境变量 LIBRARY_LLM_API_KEY")
            return {"status": "error", "message": "missing api_key"}

        print(f"\n[5/6] LLM 提取 + Wiki 写入 (模型: {self.config.llm.model})...")

        llm_client = LLMClient(self.config.llm)
        wiki_writer = WikiWriter(db_path=self.config.db_path)
        entity_index = EntityIndexManager(db_path=self.config.db_path)
        bridge = WikiBridge(
            llm_client=llm_client,
            wiki_writer=wiki_writer,
            entity_index=entity_index,
            max_concurrent=self.config.llm.max_concurrent,
        )

        def on_progress(p: BatchProgress):
            _print_progress(
                "LLM提取+写入",
                p.processed, p.total,
                p.current_file,
                extra=f"Entity:{p.entities_created}+{p.entities_updated} "
                      f"Claim:{p.claims_created} "
                      f"Token:{p.total_tokens.input_tokens + p.total_tokens.output_tokens}",
            )

        try:
            result = await bridge.process_batch(units, dun_id, on_progress)
        finally:
            await llm_client.close()

        # 6. 汇总
        print(f"\n\n[6/6] 完成!")
        p = result.progress
        elapsed = time.perf_counter() - start
        print(f"  文件: {len(files)} 扫描, {len(parsed)} 解析, {len(unique_docs)} 去重后")
        print(f"  IngestUnit: {len(units)}")
        print(f"  Entity: {p.entities_created} 创建, {p.entities_updated} 更新")
        print(f"  Claim: {p.claims_created} 条")
        print(f"  Token: {p.total_tokens.input_tokens:,} 输入 + "
              f"{p.total_tokens.output_tokens:,} 输出")
        print(f"  耗时: {elapsed:.1f} 秒 ({elapsed / 60:.1f} 分钟)")
        if result.errors:
            print(f"  错误: {len(result.errors)} 个")
            for err in result.errors[:5]:
                print(f"    - {err['sources']}: {err['error'][:100]}")

        # 记录日志
        if self.tracker:
            self.tracker.log(
                action="ingest_batch",
                target=", ".join(paths),
                status="success" if not result.errors else "partial",
                message=f"{p.succeeded}/{p.total} units, "
                        f"{p.entities_created}+{p.entities_updated} entities, "
                        f"{p.claims_created} claims",
                llm_input_tokens=p.total_tokens.input_tokens,
                llm_output_tokens=p.total_tokens.output_tokens,
                duration_ms=int(elapsed * 1000),
            )

        return {
            "status": "success",
            "files_scanned": len(files),
            "files_parsed": len(parsed),
            "files_unique": len(unique_docs),
            "ingest_units": len(units),
            "entities_created": p.entities_created,
            "entities_updated": p.entities_updated,
            "claims_created": p.claims_created,
            "errors": len(result.errors),
            "elapsed_seconds": elapsed,
        }


def _print_progress(
    stage: str, current: int, total: int, name: str, extra: str = ""
):
    """打印进度 (同行覆盖)"""
    pct = current / total * 100 if total else 0
    line = f"\r  [{stage}] {current}/{total} ({pct:.0f}%) {name[:40]}"
    if extra:
        line += f" | {extra}"
    print(line.ljust(120), end="", flush=True)


# ══════════════════════════════════════════════
# CLI 入口
# ══════════════════════════════════════════════

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        prog="python -m server.library.pipeline",
        description="DunCrew Library - 本地文件 → Wiki 知识图谱",
    )
    sub = parser.add_subparsers(dest="command")

    # scan
    scan_p = sub.add_parser("scan", help="扫描文件夹, 列出待处理文件")
    scan_p.add_argument("paths", nargs="+", help="扫描路径")
    scan_p.add_argument("--stats", action="store_true", help="显示统计信息")

    # preview
    preview_p = sub.add_parser("preview", help="预览单文件解析+清洗效果")
    preview_p.add_argument("file", help="文件路径")

    # ingest
    ingest_p = sub.add_parser("ingest", help="全量/增量摄入")
    ingest_p.add_argument("paths", nargs="+", help="扫描路径")
    ingest_p.add_argument("--model", help="LLM 模型名")
    ingest_p.add_argument("--api-key", help="LLM API Key")
    ingest_p.add_argument("--base-url", help="LLM API Base URL")
    ingest_p.add_argument("--db", help="duncrew.db 路径")
    ingest_p.add_argument("--dun-id", help="绑定 Dun ID")
    ingest_p.add_argument("--dry-run", action="store_true", help="只运行前4步, 不调 LLM")
    ingest_p.add_argument("--force", action="store_true", help="忽略增量检测, 全量重新处理")
    ingest_p.add_argument("--max-concurrent", type=int, help="LLM 并发数")

    # status
    status_p = sub.add_parser("status", help="查看处理状态")
    status_p.add_argument("--db", help="duncrew.db 路径")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # 加载配置
    cli_overrides = {}
    if hasattr(args, "api_key") and args.api_key:
        cli_overrides["api_key"] = args.api_key
    if hasattr(args, "base_url") and args.base_url:
        cli_overrides["base_url"] = args.base_url
    if hasattr(args, "model") and args.model:
        cli_overrides["model"] = args.model
    if hasattr(args, "db") and args.db:
        cli_overrides["db"] = args.db
    if hasattr(args, "max_concurrent") and args.max_concurrent:
        cli_overrides["max_concurrent"] = args.max_concurrent

    config = load_config(cli_overrides=cli_overrides)

    # 自动检测 db_path
    if not config.db_path:
        # 尝试常见位置
        candidates = [
            Path.home() / "DunCrew-Data" / "duncrew.db",
            Path("D:/编程/DunCrew-Data/duncrew.db"),
        ]
        for c in candidates:
            if c.exists():
                config.db_path = str(c)
                break

    # ── 执行命令 ──

    if args.command == "scan":
        _cmd_scan(config, args.paths, args.stats)

    elif args.command == "preview":
        _cmd_preview(config, args.file)

    elif args.command == "ingest":
        asyncio.run(_cmd_ingest(config, args))

    elif args.command == "status":
        _cmd_status(config)


def _cmd_scan(config: LibraryConfig, paths: list[str], show_stats: bool):
    pipeline = IngestPipeline(config)
    files = pipeline.scan(paths)

    if show_stats:
        from collections import Counter
        ext_counts = Counter(f.extension for f in files)
        total_size = sum(f.size_bytes for f in files)

        print(f"\n扫描结果: {len(files)} 个文件, {total_size / 1024 / 1024:.1f} MB")
        print(f"\n按扩展名:")
        for ext, count in ext_counts.most_common():
            print(f"  {ext:8s} {count:5d}")
    else:
        for f in files[:50]:
            print(f"  {f.extension:6s} {f.size_bytes:>10,} B  {f.relative_path}")
        if len(files) > 50:
            print(f"  ... 共 {len(files)} 个文件")


def _cmd_preview(config: LibraryConfig, file_path: str):
    cleaner = DocumentCleaner(config.cleaning)

    print(f"解析: {file_path}")
    result = parse_file(file_path)
    print(f"  标题: {result.title}")
    print(f"  解析器: {result.parser_name}")
    print(f"  原始长度: {len(result.content)} 字符")
    print(f"  章节数: {len(result.sections)}")

    cleaned = cleaner.clean(result)
    print(f"  清洗后长度: {len(cleaned.content)} 字符 "
          f"(减少 {(1 - len(cleaned.content) / max(len(result.content), 1)) * 100:.1f}%)")

    if cleaned.key_data:
        print(f"  关键数据 ({len(cleaned.key_data)} 条):")
        for kd in cleaned.key_data[:10]:
            print(f"    - {kd}")

    print(f"\n--- 清洗后内容 (前 2000 字) ---")
    print(cleaned.content[:2000])


async def _cmd_ingest(config: LibraryConfig, args):
    pipeline = IngestPipeline(config)
    result = await pipeline.ingest(
        paths=args.paths,
        dun_id=getattr(args, "dun_id", None),
        dry_run=args.dry_run,
        force=args.force,
    )

    if result.get("status") == "dry_run":
        print(f"\n--- Dry Run 结果 ---")
        for k, v in result.items():
            print(f"  {k}: {v}")


def _cmd_status(config: LibraryConfig):
    if not config.db_path:
        print("ERROR: 未找到 duncrew.db, 使用 --db 指定路径")
        sys.exit(1)

    tracker = Tracker(config.db_path)
    stats = tracker.get_stats()

    print(f"\nLibrary 处理状态:")
    print(f"  总文档: {stats['total_documents']}")
    print(f"\n  按状态:")
    for status, count in stats["by_status"].items():
        print(f"    {status:12s} {count:5d}")
    print(f"\n  按类型:")
    for doc_type, count in stats["by_type"].items():
        print(f"    {doc_type:12s} {count:5d}")
    print(f"\n  按扩展名:")
    for ext, count in stats["by_extension"].items():
        print(f"    {ext:8s} {count:5d}")
    print(f"\n  LLM Token 用量:")
    print(f"    输入: {stats['total_input_tokens']:,}")
    print(f"    输出: {stats['total_output_tokens']:,}")


if __name__ == "__main__":
    main()
