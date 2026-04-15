"""DunCrew Server - Main Entry Point"""
from __future__ import annotations


def main():
    # 环境初始化 (必须在其他导入之前)
    from server.startup import _load_dotenv, _setup_proxy
    _load_dotenv()
    _setup_proxy()

    import os
    import sys
    import argparse
    import threading
    import shutil
    from pathlib import Path
    from http.server import ThreadingHTTPServer
    from datetime import datetime

    from server.constants import APP_DIR, RESOURCES_DIR, VERSION
    from server.state import _browser_manager, _embedding_manager
    from server.db import init_sqlite_db
    from server.registry import ToolRegistry
    from server.subagent import SubagentManager
    from server.handler import ClawdDataHandler
    from server.cleanup import (
        cleanup_old_logs, cleanup_old_traces, cleanup_temp_uploads, sync_traces_to_sqlite,
    )
    from server.utils import parse_dun_frontmatter, update_dun_frontmatter
    import server.state as _state

    parser = argparse.ArgumentParser(description='DunCrew Native Server')
    parser.add_argument('--port', type=int, default=3001, help='Server port (default: 3001)')
    # 支持环境变量覆盖默认路径
    default_path = os.getenv('DUNCREW_DATA_PATH', os.getenv('DDOS_DATA_PATH',
        str(Path.home() / 'DunCrew-Data')))
    parser.add_argument('--path', type=str, default=default_path, help='Data directory path (default: ~/DunCrew-Data)')
    parser.add_argument('--host', type=str, default='0.0.0.0', help='Server host (default: 0.0.0.0)')
    args = parser.parse_args()
    
    clawd_path = Path(args.path).expanduser().resolve()
    
    if not clawd_path.exists():
        print(f"Creating data directory: {clawd_path}")
    clawd_path.mkdir(parents=True, exist_ok=True)
    
    # 确保 SOUL.md 存在: 优先从项目目录复制，否则创建默认版本
    soul_file = clawd_path / 'SOUL.md'
    if not soul_file.exists():
        project_soul = RESOURCES_DIR / 'SOUL.md'
        if project_soul.exists():
            # 从项目目录复制完整 SOUL.md
            import shutil
            shutil.copy2(str(project_soul), str(soul_file))
            print(f"Copied SOUL.md from project directory: {project_soul}")
        else:
            # 创建默认 SOUL.md
            soul_file.write_text("""# DunCrew Native Soul

You are DunCrew, a local AI operating system running directly on the user's computer.

## Core Truths

**Be the user's co-pilot.** You work alongside the user, not above or below them. Every action you take should empower the user to achieve their goals faster and better.

**Earn trust through transparency.** Always explain what you're doing and why. If you're unsure, say so. Never pretend to know something you don't.

**Be technically precise.** When executing tasks, prioritize correctness over speed. Double-check your work, validate outputs, and handle errors gracefully.

## Boundaries
- Never delete or modify files without explicit user confirmation for destructive operations
- Never expose API keys, passwords, or sensitive data in outputs
- Never execute commands that could harm the system without user approval
- Always respect the user's preferences and working style
- Keep execution logs for accountability and debugging

## Vibe
Concise, thorough, and technically precise. Not a sycophant - honest feedback is more valuable than false agreement. Good at breaking down complex problems into actionable steps.

## Continuity
You maintain state across conversations through the memory system. Use memories to build a deeper understanding of the user's projects, preferences, and working patterns over time.
""", encoding='utf-8')
            print(f"Created default SOUL.md")
    
    logs_dir = clawd_path / 'logs'
    logs_dir.mkdir(exist_ok=True)
    
    memory_dir = clawd_path / 'memory'
    memory_dir.mkdir(exist_ok=True)
    
    skills_dir = clawd_path / 'skills'
    skills_dir.mkdir(exist_ok=True)
    
    # 自动部署预装 Duns（仅复制不存在的，不覆盖用户修改）
    # 同时同步 initial_scoring: 若 bundled DUN.md 含 initial_scoring 但目标没有，则补写
    duns_dir = clawd_path / 'duns'
    duns_dir.mkdir(exist_ok=True)
    bundled_duns = RESOURCES_DIR / 'duns'
    if bundled_duns.exists():
        import shutil
        for dun_src in bundled_duns.iterdir():
            if dun_src.is_dir() and (dun_src / 'DUN.md').exists():
                dun_dst = duns_dir / dun_src.name
                if not dun_dst.exists():
                    shutil.copytree(str(dun_src), str(dun_dst))
                    print(f"[SETUP] Installed bundled dun: {dun_src.name}")
                else:
                    # 补写 initial_scoring（旧版本 DUN.md 可能缺少此字段）
                    src_fm = parse_dun_frontmatter(dun_src / 'DUN.md')
                    if 'initial_scoring' in src_fm:
                        dst_fm = parse_dun_frontmatter(dun_dst / 'DUN.md')
                        if 'initial_scoring' not in dst_fm:
                            update_dun_frontmatter(dun_dst / 'DUN.md', {'initial_scoring': src_fm['initial_scoring']})
                            print(f"[SETUP] Patched initial_scoring for: {dun_src.name}")
    
    cleanup_old_logs(clawd_path)
    
    # 🔌 初始化工具注册表
    registry = ToolRegistry(clawd_path)
    # 注册内置工具
    builtin_names = [
        'readFile', 'writeFile', 'appendFile', 'listDir', 'runCmd',
        'weather', 'webSearch', 'webFetch', 'saveMemory', 'searchMemory',
        'dunBindSkill', 'dunUnbindSkill', 'openInExplorer', 'parseFile',
        'generateSkill',
        'screenCapture', 'ocrExtract',
    ]
    for name in builtin_names:
        registry.register_builtin(name, name)  # handler resolved at dispatch time
    # 扫描插件工具
    registry.scan_plugins()
    # 扫描 MCP 服务器
    registry.scan_mcp_servers()

    # 清理过期执行追踪 (P2: 保留最近6个月)
    cleanup_old_traces(clawd_path)
    cleanup_temp_uploads(clawd_path)

    # V2: 初始化 SQLite 数据库（含 ddos_v2.db → duncrew.db 迁移）
    new_db = clawd_path / 'duncrew.db'
    old_db = clawd_path / 'ddos_v2.db'
    if not new_db.exists() and old_db.exists():
        try:
            old_db.rename(new_db)
            for suffix in ['-wal', '-shm']:
                old_journal = old_db.with_name(old_db.name + suffix)
                if old_journal.exists():
                    old_journal.rename(new_db.with_name(new_db.name + suffix))
            print(f'[Migration] Renamed ddos_v2.db → duncrew.db')
        except OSError as e:
            print(f'[Migration] Rename failed ({e}), falling back to ddos_v2.db')
            new_db = old_db
    db_path = new_db
    _state._db_conn = init_sqlite_db(db_path)

    # 项目目录: 开发模式为项目根，打包模式为 resources/ (skills/等资源所在)
    project_path = RESOURCES_DIR
    
    ClawdDataHandler.clawd_path = clawd_path
    ClawdDataHandler.project_path = project_path
    ClawdDataHandler.registry = registry
    ClawdDataHandler.subagent_manager = SubagentManager(registry)

    # 解耦: 将 clawd_path 注入 EmbeddingManager
    _embedding_manager.set_clawd_path(clawd_path)
    
    server = ThreadingHTTPServer((args.host, args.port), ClawdDataHandler)
    
    tool_names = [t['name'] for t in registry.list_all()]
    plugin_count = len(registry.plugin_tools)
    mcp_count = len(registry.mcp_tools)
    print(f"""
+==================================================================+
|              DunCrew Native Server v{VERSION}                         |
+==================================================================+
|  Mode:    NATIVE (standalone, no OpenClaw needed)                |
|  Server:  http://{args.host}:{args.port}                                    |
|  Data:    {str(clawd_path)[:50]:<50} |
+------------------------------------------------------------------+
|  Tools:   {len(tool_names)} registered ({len(builtin_names)} builtin + {plugin_count} plugins + {mcp_count} mcp)    |
|  API:     /api/tools/execute (POST)  |  /tools (GET)            |
+==================================================================+
    """)
    
    print(f"Press Ctrl+C to stop\n")
    
    # 后台预热 Embedding 模型，避免首次请求时冷启动
    _embedding_manager.preheat()
    
    # 后台同步 JSONL exec_traces → SQLite memory 表
    threading.Thread(
        target=sync_traces_to_sqlite,
        args=(_state._db_conn, clawd_path),
        name='trace-sync',
        daemon=True,
    ).start()
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        _browser_manager.shutdown()
        _embedding_manager.shutdown()
        server.shutdown()


if __name__ == '__main__':
    main()


