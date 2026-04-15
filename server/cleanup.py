"""DunCrew Server - Cleanup and Background Tasks"""
from __future__ import annotations

import os
import json
import time
import uuid
import subprocess
import threading
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta

from server.state import _db_lock

def list_files(clawd_path):
    files = []
    try:
        for item in clawd_path.iterdir():
            if item.is_file():
                files.append(item.name)
    except:
        pass
    return sorted(files)


def parse_memory_md(content):
    memories = []
    sections = content.split('## ')
    
    for i, section in enumerate(sections[1:], 1):
        lines = section.strip().split('\n')
        if not lines:
            continue
        
        title = lines[0].strip()
        body = '\n'.join(lines[1:]).strip()
        
        if title:
            memories.append({
                'id': f'memory-{i}',
                'title': title,
                'content': body[:500] if body else title,
                'type': 'long-term',
                'timestamp': None,
                'tags': [],
            })
    
    return memories


def read_log_chunk(log_path, offset=0, max_bytes=51200):
    path = Path(log_path)
    if not path.exists():
        return ('', offset, False)
    
    try:
        file_size = path.stat().st_size
    except:
        return ('', offset, False)
    
    if offset >= file_size:
        return ('', offset, False)
    
    try:
        with open(path, 'rb') as f:
            f.seek(offset)
            raw = f.read(max_bytes)
        
        content = raw.decode('utf-8', errors='replace')
        new_offset = offset + len(raw)
        has_more = new_offset < file_size
        return (content, new_offset, has_more)
    except Exception as e:
        return (f'[日志读取错误: {e}]', offset, False)


def run_task_in_background(task_id, prompt, clawd_path):
    from server.handler import ClawdDataHandler  # 延迟导入，避免循环依赖
    logs_dir = clawd_path / 'logs'
    logs_dir.mkdir(exist_ok=True)
    log_file = logs_dir / f"{task_id}.log"
    
    with ClawdDataHandler.tasks_lock:
        ClawdDataHandler.tasks[task_id] = {
            'taskId': task_id,
            'status': 'running',
            'logPath': str(log_file),
            'fileSize': 0,
        }
    
    try:
        with open(log_file, 'w', encoding='utf-8') as f:
            f.write(f"Task: {prompt}\n")
            f.write(f"Started: {datetime.now().isoformat()}\n")
            f.write("-" * 50 + "\n\n")
        
        # 尝试运行 clawdbot，如果不存在则模拟
        try:
            with open(log_file, 'ab') as f:
                process = subprocess.Popen(
                    ['clawdbot', 'agent', '--agent', 'main', '--message', prompt],
                    cwd=str(clawd_path),
                    stdout=f,
                    stderr=subprocess.STDOUT,
                )
                
                start_time = time.time()
                timeout = 300
                
                while process.poll() is None:
                    time.sleep(0.5)
                    try:
                        with ClawdDataHandler.tasks_lock:
                            ClawdDataHandler.tasks[task_id]['fileSize'] = log_file.stat().st_size
                    except:
                        pass
                    
                    if time.time() - start_time > timeout:
                        process.kill()
                        process.wait()
                        with ClawdDataHandler.tasks_lock:
                            ClawdDataHandler.tasks[task_id]['status'] = 'error'
                            ClawdDataHandler.tasks[task_id]['fileSize'] = log_file.stat().st_size
                        with open(log_file, 'a', encoding='utf-8') as ef:
                            ef.write(f'\n\n[错误] 任务执行超时 ({timeout}s)\n')
                        return
                
                process.wait()
            
            with ClawdDataHandler.tasks_lock:
                ClawdDataHandler.tasks[task_id]['status'] = 'done' if process.returncode == 0 else 'error'
                ClawdDataHandler.tasks[task_id]['fileSize'] = log_file.stat().st_size
        
        except FileNotFoundError:
            # clawdbot 不存在，使用 Native 模式提示
            with open(log_file, 'a', encoding='utf-8') as f:
                f.write("\n[DunCrew Native] clawdbot 未安装。\n")
                f.write("在 Native 模式下，请使用 /api/tools/execute 接口直接执行工具。\n")
                f.write("\n任务已记录，等待 AI 引擎处理。\n")
            
            with ClawdDataHandler.tasks_lock:
                ClawdDataHandler.tasks[task_id]['status'] = 'done'
                ClawdDataHandler.tasks[task_id]['fileSize'] = log_file.stat().st_size
    
    except Exception as e:
        with open(log_file, 'a', encoding='utf-8') as ef:
            ef.write(f'\n\n[错误] {str(e)}\n')
        with ClawdDataHandler.tasks_lock:
            ClawdDataHandler.tasks[task_id]['status'] = 'error'
            ClawdDataHandler.tasks[task_id]['fileSize'] = log_file.stat().st_size


def cleanup_old_logs(clawd_path, max_age_hours=24):
    logs_dir = clawd_path / 'logs'
    if not logs_dir.exists():
        return
    
    now = time.time()
    count = 0
    for f in logs_dir.glob('*.log'):
        try:
            age = now - f.stat().st_mtime
            if age > max_age_hours * 3600:
                f.unlink()
                count += 1
        except:
            pass
    
    if count > 0:
        print(f"[Cleanup] Removed {count} old log files")


def cleanup_old_traces(clawd_path, max_months=6):
    """清理过期的执行追踪文件 (P2: 保留最近N个月)"""
    traces_dir = clawd_path / 'memory' / 'exec_traces'
    if not traces_dir.exists():
        return

    files = sorted(traces_dir.glob('*.jsonl'))
    if len(files) <= max_months:
        return

    old_files = files[:-max_months]
    for f in old_files:
        try:
            f.unlink()
            print(f"[Cleanup] Removed old trace: {f.name}")
        except:
            pass


def cleanup_temp_uploads(clawd_path, max_age_hours=1):
    """清理超过指定时间的临时上传文件和截图"""
    temp_dirs = [
        clawd_path / 'temp' / 'uploads',
        clawd_path / 'temp' / 'screenshots',
    ]
    
    now = time.time()
    count = 0
    for temp_dir in temp_dirs:
        if not temp_dir.exists():
            continue
        for f in temp_dir.iterdir():
            try:
                if f.is_file() and (now - f.stat().st_mtime) > max_age_hours * 3600:
                    f.unlink()
                    count += 1
            except:
                pass
    
    if count > 0:
        print(f"[Cleanup] Removed {count} old temp files")


# ============================================
# JSONL → SQLite Trace 同步
# ============================================

_trace_sync_lock = threading.Lock()
_trace_sync_running = False


def _trace_to_memory_row(trace: dict) -> tuple:
    """将 JSONL trace 对象转换为 memory 表行"""
    trace_id = trace.get('id') or f"{str(trace.get('task', ''))[:50]}_{trace.get('timestamp', 0)}"
    mem_id = f"mem-{uuid.uuid4().hex[:12]}"

    # 格式化 content
    task = str(trace.get('task', ''))[:200]
    tools = trace.get('tools', [])
    tool_parts = []
    for t in tools:
        if isinstance(t, dict):
            name = t.get('name', '?')
            status = 'ok' if t.get('status') == 'success' else 'fail'
            tool_parts.append(f"{name}({status})")
    tools_str = ', '.join(tool_parts) if tool_parts else 'none'
    duration = trace.get('duration', 0)
    success = trace.get('success', False)
    content = f"Task: {task}\nTools: {tools_str}\nDuration: {duration}ms\nSuccess: {success}"
    if len(content) > 1000:
        content = content[:1000]

    dun_id = trace.get('activeDunId') or trace.get('activeNexusId')
    tags = json.dumps(trace.get('tags', []), ensure_ascii=False)
    metadata = json.dumps({
        'traceId': trace_id,
        'turnCount': trace.get('turnCount', 0),
        'toolCount': len(tools),
        'success': success,
    }, ensure_ascii=False)
    created_at = trace.get('timestamp') or int(time.time() * 1000)

    return (mem_id, 'exec_trace', content, dun_id, tags, metadata, created_at, 0.5, 'uncategorized')


def sync_traces_to_sqlite(db: sqlite3.Connection, clawd_path):
    """将 JSONL exec_trace 文件同步到 SQLite memory 表（后台执行）"""
    global _trace_sync_running
    with _trace_sync_lock:
        if _trace_sync_running:
            print('[TraceSync] Already running, skipping')
            return
        _trace_sync_running = True

    try:
        traces_dir = clawd_path / 'memory' / 'exec_traces'
        if not traces_dir.exists():
            print('[TraceSync] No exec_traces directory, skipping')
            return

        # 1. 查询已有 traceId 集合（包括已删除的，防止重复插入被删记录）
        existing_ids = set()
        try:
            with _db_lock:
                rows = db.execute(
                    "SELECT metadata FROM memory WHERE source = 'exec_trace'"
                ).fetchall()
            for row in rows:
                try:
                    meta = json.loads(row[0]) if row[0] else {}
                    tid = meta.get('traceId')
                    if tid:
                        existing_ids.add(tid)
                except (json.JSONDecodeError, TypeError):
                    pass
        except Exception as e:
            print(f'[TraceSync] Failed to query existing IDs: {e}')
            return

        # 2. 扫描 JSONL 文件，收集新 trace
        batch = []
        skipped = 0
        errors = 0

        for trace_file in sorted(traces_dir.glob('*.jsonl')):
            try:
                for line in trace_file.read_text(encoding='utf-8').strip().split('\n'):
                    if not line.strip():
                        continue
                    try:
                        trace = json.loads(line)
                    except json.JSONDecodeError:
                        errors += 1
                        continue

                    trace_id = trace.get('id') or f"{str(trace.get('task', ''))[:50]}_{trace.get('timestamp', 0)}"
                    if trace_id in existing_ids:
                        skipped += 1
                        continue

                    existing_ids.add(trace_id)  # 防止同文件内重复
                    batch.append(_trace_to_memory_row(trace))

                    # 每 100 条批量写入
                    if len(batch) >= 100:
                        with _db_lock:
                            db.executemany(
                                "INSERT OR IGNORE INTO memory (id, source, content, dun_id, tags, metadata, created_at, confidence, category) VALUES (?,?,?,?,?,?,?,?,?)",
                                batch
                            )
                            db.commit()
                        batch.clear()
            except Exception as e:
                print(f'[TraceSync] Error reading {trace_file.name}: {e}')
                continue

        # 写入剩余
        if batch:
            with _db_lock:
                db.executemany(
                    "INSERT OR IGNORE INTO memory (id, source, content, dun_id, tags, metadata, created_at, confidence, category) VALUES (?,?,?,?,?,?,?,?,?)",
                    batch
                )
                db.commit()

        synced = len(existing_ids) - skipped
        total_in_db = 0

        # 恢复被容量管理误删的 exec_trace 记录
        restored = 0
        try:
            with _db_lock:
                cursor = db.execute(
                    "UPDATE memory SET deleted_at = NULL WHERE source = 'exec_trace' AND deleted_at IS NOT NULL"
                )
                restored = cursor.rowcount
                if restored > 0:
                    db.commit()
                    print(f'[TraceSync] Restored {restored} previously deleted exec_trace records')
        except Exception as e:
            print(f'[TraceSync] Failed to restore deleted records: {e}')

        try:
            with _db_lock:
                total_in_db = db.execute("SELECT COUNT(*) FROM memory WHERE source = 'exec_trace' AND deleted_at IS NULL").fetchone()[0]
        except Exception:
            pass

        print(f'[TraceSync] Done: synced {synced} new traces, {skipped} already existed, {errors} parse errors, {restored} restored, {total_in_db} total in DB')
    except Exception as e:
        print(f'[TraceSync] Unexpected error: {e}')
    finally:
        with _trace_sync_lock:
            _trace_sync_running = False


