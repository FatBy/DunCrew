"""Library API 路由 (LibraryMixin)

路由前缀: /api/library/
挂载到 server/handler.py 的 ClawdDataHandler
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from typing import Optional

logger = logging.getLogger(__name__)

# 后台任务状态
_bg_task: Optional[dict] = None
_bg_lock = threading.Lock()


class LibraryMixin:
    """Library API 路由, 混入 ClawdDataHandler"""

    def handle_library_request(self, path: str, method: str, body: dict):
        """路由分发: /api/library/*"""

        if path == "/api/library/ingest/stream" and method == "GET":
            self._handle_library_ingest_stream(body)
        elif path == "/api/library/ingest" and method == "POST":
            self._handle_library_ingest(body)
        elif path == "/api/library/ingest/status" and method == "GET":
            self._handle_library_ingest_status()
        elif path == "/api/library/ingest/cancel" and method == "POST":
            self._handle_library_ingest_cancel()
        elif path == "/api/library/documents" and method == "GET":
            self._handle_library_documents(body)
        elif path == "/api/library/stats" and method == "GET":
            self._handle_library_stats()
        else:
            self.send_error_json(f"Unknown library route: {path}", 404)

    def _handle_library_ingest_stream(self, query: dict):
        """GET /api/library/ingest/stream — SSE 流式摄入"""
        import os
        from .config import load_config
        from .sse import start_sse_response, IngestSSERunner

        # parse_qs 返回 {key: [val, ...]} 格式，取第一个值
        def _qs_first(key: str, default: str = "") -> str:
            v = query.get(key, default)
            if isinstance(v, list):
                return v[0] if v else default
            return str(v)

        raw_paths = _qs_first("paths", "")
        dry_run = _qs_first("dry_run", "false").lower() in ("true", "1")
        force = _qs_first("force", "false").lower() in ("true", "1")

        # 解析 paths: 支持 JSON 数组或逗号分隔
        if raw_paths.startswith("["):
            try:
                paths = json.loads(raw_paths)
            except json.JSONDecodeError:
                self.send_error_json("paths JSON 格式错误", 400)
                return
        else:
            paths = [p.strip() for p in raw_paths.split(",") if p.strip()]

        if not paths:
            self.send_error_json("paths 不能为空", 400)
            return

        config = load_config()
        if hasattr(self, "clawd_path") and self.clawd_path:
            config.db_path = os.path.join(str(self.clawd_path), "duncrew.db")

        # 前端传入的 LLM 配置覆盖 config.yaml 中的空值
        if v := _qs_first("llm_api_key"):
            config.llm.api_key = v
        if v := _qs_first("llm_base_url"):
            config.llm.base_url = v
        if v := _qs_first("llm_model"):
            config.llm.model = v

        # 提交全局连接中可能未提交的写事务, 释放写锁
        try:
            import server.state as _state
            if _state._db_conn:
                with _state._db_lock:
                    _state._db_conn.commit()
        except Exception:
            pass

        start_sse_response(self)
        runner = IngestSSERunner(self, config)
        runner.run(paths, dry_run=dry_run, force=force)

    def _handle_library_ingest(self, body: dict):
        """POST /api/library/ingest — 触发增量摄入 (后台线程)"""
        global _bg_task

        with _bg_lock:
            if _bg_task and _bg_task.get("status") == "running":
                self.send_error_json("已有摄入任务在运行中", 409)
                return

        paths = body.get("paths", [])
        if not paths:
            self.send_error_json("paths 不能为空", 400)
            return

        dun_id = body.get("dun_id") or body.get("dunId")
        force = body.get("force", False)
        dry_run = body.get("dry_run", False)

        # 在后台线程中运行
        with _bg_lock:
            _bg_task = {
                "status": "running",
                "progress": None,
                "result": None,
            }

        thread = threading.Thread(
            target=self._run_ingest_background,
            args=(paths, dun_id, force, dry_run),
            daemon=True,
        )
        thread.start()

        self.send_json({"status": "started", "message": "摄入任务已启动"})

    def _run_ingest_background(
        self, paths: list[str], dun_id: Optional[str],
        force: bool, dry_run: bool,
    ):
        """后台线程执行摄入"""
        global _bg_task
        try:
            from .config import load_config
            from .pipeline import IngestPipeline

            config = load_config()
            # 从 handler 获取 db_path
            if hasattr(self, "clawd_path") and self.clawd_path:
                import os
                db_path = os.path.join(str(self.clawd_path), "duncrew.db")
                config.db_path = db_path

            pipeline = IngestPipeline(config)

            def on_progress(p):
                with _bg_lock:
                    if _bg_task:
                        _bg_task["progress"] = {
                            "total": p.total,
                            "processed": p.processed,
                            "succeeded": p.succeeded,
                            "failed": p.failed,
                            "entities_created": p.entities_created,
                            "entities_updated": p.entities_updated,
                            "claims_created": p.claims_created,
                            "current_file": p.current_file,
                            "current_stage": p.current_stage,
                            "progress_percent": p.progress_percent,
                        }

            loop = asyncio.new_event_loop()
            result = loop.run_until_complete(
                pipeline.ingest(
                    paths=paths,
                    dun_id=dun_id,
                    dry_run=dry_run,
                    force=force,
                )
            )
            loop.close()

            with _bg_lock:
                if _bg_task:
                    _bg_task["status"] = "completed"
                    _bg_task["result"] = result

        except Exception as e:
            logger.error("Library ingest 失败: %s", e, exc_info=True)
            with _bg_lock:
                if _bg_task:
                    _bg_task["status"] = "error"
                    _bg_task["result"] = {"error": str(e)}

    def _handle_library_ingest_status(self):
        """GET /api/library/ingest/status"""
        with _bg_lock:
            if not _bg_task:
                self.send_json({"status": "idle"})
                return
            self.send_json({
                "status": _bg_task["status"],
                "progress": _bg_task.get("progress"),
                "result": _bg_task.get("result"),
            })

    def _handle_library_ingest_cancel(self):
        """POST /api/library/ingest/cancel"""
        with _bg_lock:
            if _bg_task and _bg_task.get("status") == "running":
                _bg_task["status"] = "cancelling"
                self.send_json({"status": "cancelling"})
            else:
                self.send_json({"status": "no_task"})

    def _handle_library_documents(self, query: dict):
        """GET /api/library/documents"""
        from .tracker import Tracker
        import os

        # parse_qs 返回 {key: [val, ...]}，取第一个值
        def _qs(key: str, default=None):
            v = query.get(key, default)
            if isinstance(v, list):
                return v[0] if v else default
            return v

        db_path = ""
        if hasattr(self, "clawd_path") and self.clawd_path:
            db_path = os.path.join(str(self.clawd_path), "duncrew.db")

        if not db_path:
            self.send_error_json("db_path not configured", 500)
            return

        tracker = Tracker(db_path)
        docs = tracker.get_documents(
            status=_qs("status"),
            extension=_qs("extension"),
            limit=int(_qs("limit", 100)),
            offset=int(_qs("offset", 0)),
        )
        self.send_json(docs)

    def _handle_library_stats(self):
        """GET /api/library/stats"""
        from .tracker import Tracker
        import os

        db_path = ""
        if hasattr(self, "clawd_path") and self.clawd_path:
            db_path = os.path.join(str(self.clawd_path), "duncrew.db")

        if not db_path:
            self.send_error_json("db_path not configured", 500)
            return

        tracker = Tracker(db_path)
        stats = tracker.get_stats()
        self.send_json(stats)
