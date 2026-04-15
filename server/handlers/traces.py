"""DunCrew Server - Trace/Gene/Capsule/Amendment Mixin"""
from __future__ import annotations

import os
import re
import json
import time
import uuid
import threading
from pathlib import Path
from datetime import datetime, timedelta

from server.state import _db_lock
from server.cleanup import list_files, _trace_to_memory_row

class TracesMixin:
    """Trace/Gene/Capsule/Amendment Mixin"""

    def handle_trace_save(self, data):
        """POST /api/traces/save - 保存执行追踪 (P2: 执行流记忆)"""
        if not data:
            self.send_error_json('Missing trace data', 400)
            return

        traces_dir = self.clawd_path / 'memory' / 'exec_traces'
        traces_dir.mkdir(parents=True, exist_ok=True)

        # 按月分片存储
        month = datetime.now().strftime('%Y-%m')
        trace_file = traces_dir / f'{month}.jsonl'

        # 兜底截断：防止 tools[].result 和 args 中的大字段导致文件膨胀
        RESULT_MAX = 500
        ARG_MAX = 300
        LARGE_ARG_KEYS = {'content', 'code', 'text', 'body', 'data', 'script', 'html', 'markdown', 'prompt'}
        tools = data.get('tools', [])
        if isinstance(tools, list):
            for tool in tools:
                if not isinstance(tool, dict):
                    continue
                result_val = tool.get('result', '')
                if isinstance(result_val, str) and len(result_val) > RESULT_MAX:
                    tool['result'] = result_val[:RESULT_MAX] + f'...[truncated, original {len(result_val)} chars]'
                args_val = tool.get('args', {})
                if isinstance(args_val, dict):
                    for key, val in args_val.items():
                        if isinstance(val, str) and len(val) > ARG_MAX and key.lower() in LARGE_ARG_KEYS:
                            args_val[key] = val[:ARG_MAX] + f'...[truncated, original {len(val)} chars]'

        # 敏感数据脱敏
        trace_json = json.dumps(data, ensure_ascii=False)
        trace_json = re.sub(
            r'(password|token|secret|api_key|apikey|auth)["\s:]*["\']([^"\']{3,})["\']',
            r'\1": "***"',
            trace_json,
            flags=re.IGNORECASE
        )

        try:
            with open(trace_file, 'a', encoding='utf-8') as f:
                f.write(trace_json + '\n')

            # 同步写入 SQLite memory 表（双写，确保 JSONL 和 SQLite 一致）
            try:
                db = self._get_db()
                row = _trace_to_memory_row(data)
                with _db_lock:
                    db.execute(
                        "INSERT OR IGNORE INTO memory (id, source, content, dun_id, tags, metadata, created_at, confidence, category) VALUES (?,?,?,?,?,?,?,?,?)",
                        row
                    )
                    db.commit()
            except Exception as e:
                print(f'[TraceSync] Inline SQLite write failed: {e}')

            self.send_json({
                'status': 'ok',
                'message': f'Trace saved to {month}.jsonl',
            })
        except Exception as e:
            self.send_error_json(f'Failed to save trace: {e}', 500)

    # ============================================
    # 🧬 Gene Pool API
    # ============================================

    def handle_gene_save(self, data):
        """POST /api/genes/save - 保存/更新基因到基因库"""
        if not data:
            self.send_error_json('Missing gene data', 400)
            return

        gene_file = self.clawd_path / 'memory' / 'gene_pool.jsonl'
        gene_file.parent.mkdir(parents=True, exist_ok=True)

        gene_id = data.get('id', '')

        try:
            with self._gene_file_lock:
                # 如果基因已存在 (同 ID)，先读取并替换
                existing_lines = []
                replaced = False
                if gene_file.exists():
                    with open(gene_file, 'r', encoding='utf-8', errors='replace') as f:
                        for line in f:
                            line = line.strip()
                            if not line:
                                continue
                            try:
                                existing = json.loads(line)
                                if existing.get('id') == gene_id:
                                    existing_lines.append(json.dumps(data, ensure_ascii=False))
                                    replaced = True
                                else:
                                    existing_lines.append(line)
                            except (json.JSONDecodeError, UnicodeDecodeError):
                                # 跳过损坏的行，不再保留
                                continue

                if replaced:
                    # 覆写整个文件 (替换已有基因)
                    with open(gene_file, 'w', encoding='utf-8') as f:
                        for line in existing_lines:
                            f.write(line + '\n')
                else:
                    # 追写新基因
                    with open(gene_file, 'a', encoding='utf-8') as f:
                        f.write(json.dumps(data, ensure_ascii=False) + '\n')

            self.send_json({
                'status': 'ok',
                'message': f'Gene {"updated" if replaced else "saved"}: {gene_id}',
            })
        except Exception as e:
            self.send_error_json(f'Failed to save gene: {e}', 500)

    def handle_gene_load(self):
        """GET /api/genes/load - 加载全部基因"""
        gene_file = self.clawd_path / 'memory' / 'gene_pool.jsonl'

        genes = []
        if not gene_file.exists():
            self.send_json(genes)
            return

        try:
            with self._gene_file_lock:
                with open(gene_file, 'r', encoding='utf-8', errors='replace') as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            genes.append(json.loads(line))
                        except (json.JSONDecodeError, UnicodeDecodeError):
                            continue
        except Exception as e:
            self.send_error_json(f'Failed to load genes: {e}', 500)
            return

        self.send_json(genes)

    def handle_capsule_load(self):
        """GET /api/capsules/load - 加载全部胶囊"""
        capsule_file = self.clawd_path / 'memory' / 'capsules.json'

        if not capsule_file.exists():
            self.send_json([])
            return

        try:
            content = capsule_file.read_text(encoding='utf-8')
            capsules = json.loads(content) if content.strip() else []
            self.send_json(capsules)
        except Exception as e:
            self.send_error_json(f'Failed to load capsules: {e}', 500)

    def handle_capsule_save(self, data):
        """POST /api/capsules/save - 批量保存胶囊 (全量覆写)"""
        if not isinstance(data, list):
            self.send_error_json('Expected array of capsules', 400)
            return

        capsule_file = self.clawd_path / 'memory' / 'capsules.json'
        capsule_file.parent.mkdir(parents=True, exist_ok=True)

        try:
            # 只保留最近 100 条
            trimmed = data[-100:] if len(data) > 100 else data
            capsule_file.write_text(json.dumps(trimmed, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_json({
                'status': 'ok',
                'message': f'Saved {len(trimmed)} capsules',
            })
        except Exception as e:
            self.send_error_json(f'Failed to save capsules: {e}', 500)

    def handle_amendment_load(self):
        """GET /api/amendments/load - 加载全部灵魂修正案"""
        amendment_file = self.clawd_path / 'memory' / 'soul_amendments.json'

        if not amendment_file.exists():
            self.send_json([])
            return

        try:
            content = amendment_file.read_text(encoding='utf-8')
            amendments = json.loads(content) if content.strip() else []
            self.send_json(amendments)
        except Exception as e:
            self.send_error_json(f'Failed to load amendments: {e}', 500)

    def handle_amendment_save(self, data):
        """POST /api/amendments/save - 批量保存灵魂修正案 (全量覆写)"""
        if not isinstance(data, list):
            self.send_error_json('Expected array of amendments', 400)
            return

        amendment_file = self.clawd_path / 'memory' / 'soul_amendments.json'
        amendment_file.parent.mkdir(parents=True, exist_ok=True)

        try:
            amendment_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_json({
                'status': 'ok',
                'message': f'Saved {len(data)} amendments',
            })
        except Exception as e:
            self.send_error_json(f'Failed to save amendments: {e}', 500)

    def handle_trace_search(self, query_params):
        """GET /api/traces/search?query=xxx&limit=5 - 检索执行追踪 (P2)"""
        query = query_params.get('query', [''])[0]
        limit = min(int(query_params.get('limit', ['5'])[0]), 20)

        if not query:
            self.send_json([])
            return

        traces_dir = self.clawd_path / 'memory' / 'exec_traces'
        if not traces_dir.exists():
            self.send_json([])
            return

        query_lower = query.lower()
        query_words = [w for w in query_lower.split() if len(w) > 1]
        results = []

        # 从最近的月份文件开始搜索
        for trace_file in sorted(traces_dir.glob('*.jsonl'), reverse=True)[:6]:
            try:
                for line in reversed(trace_file.read_text(encoding='utf-8').strip().split('\n')):
                    if not line.strip():
                        continue
                    try:
                        trace = json.loads(line)
                        task = trace.get('task', '').lower()
                        tags = [t.lower() for t in trace.get('tags', [])]
                        # 关键词匹配: task 描述或 tags
                        matched = any(w in task for w in query_words) or \
                                  any(w in ' '.join(tags) for w in query_words)
                        if matched:
                            results.append(trace)
                            if len(results) >= limit:
                                break
                    except json.JSONDecodeError:
                        continue
            except Exception:
                continue
            if len(results) >= limit:
                break

        self.send_json(results)
    
    def handle_trace_recent(self, query_params):
        """GET /api/traces/recent?days=3&limit=100 - 获取最近N天的执行日志 (供 Observer 分析)"""
        days = min(int(query_params.get('days', ['3'])[0]), 30)
        limit = min(int(query_params.get('limit', ['100'])[0]), 500)
        
        traces_dir = self.clawd_path / 'memory' / 'exec_traces'
        if not traces_dir.exists():
            self.send_json({'traces': [], 'stats': {}})
            return
        
        cutoff_time = datetime.now() - timedelta(days=days)
        cutoff_ts = cutoff_time.timestamp() * 1000  # 毫秒时间戳
        
        traces = []
        tool_freq = {}  # 工具使用频率
        dun_freq = {}  # Dun 使用频率
        total_turns = 0
        total_errors = 0
        
        # 从最近的月份文件开始读取
        for trace_file in sorted(traces_dir.glob('*.jsonl'), reverse=True)[:3]:
            try:
                for line in reversed(trace_file.read_text(encoding='utf-8').strip().split('\n')):
                    if not line.strip():
                        continue
                    try:
                        trace = json.loads(line)
                        ts = trace.get('timestamp', 0)
                        if ts < cutoff_ts:
                            continue  # 超出时间范围
                        
                        traces.append(trace)
                        
                        # 统计工具频率
                        for tool in trace.get('tools', []):
                            tool_name = tool.get('name', 'unknown')
                            tool_freq[tool_name] = tool_freq.get(tool_name, 0) + 1
                        
                        # 统计 Dun 频率
                        dun_id = trace.get('activeDunId') or trace.get('activeNexusId')
                        if dun_id:
                            dun_freq[dun_id] = dun_freq.get(dun_id, 0) + 1
                        
                        # 统计轮次和错误
                        total_turns += trace.get('turnCount', 0)
                        total_errors += trace.get('errorCount', 0)
                        
                        if len(traces) >= limit:
                            break
                    except json.JSONDecodeError:
                        continue
            except Exception:
                continue
            if len(traces) >= limit:
                break
        
        # 按时间倒序排列
        traces.sort(key=lambda t: t.get('timestamp', 0), reverse=True)
        
        self.send_json({
            'traces': traces,
            'stats': {
                'totalExecutions': len(traces),
                'toolFrequency': tool_freq,
                'dunFrequency': dun_freq,
                'avgTurnsPerExecution': total_turns / len(traces) if traces else 0,
                'totalErrors': total_errors,
                'timeRangeDays': days,
            }
        })
    
    def handle_memories(self):
        memories = []
        
        memory_md = self.clawd_path / 'MEMORY.md'
        if memory_md.exists():
            try:
                content = memory_md.read_text(encoding='utf-8')
                memories.extend(parse_memory_md(content))
            except:
                pass
        
        memory_dir = self.clawd_path / 'memory'
        if memory_dir.exists() and memory_dir.is_dir():
            for item in memory_dir.iterdir():
                if item.is_file() and item.suffix == '.md':
                    try:
                        content = item.read_text(encoding='utf-8')
                        memories.append({
                            'id': f'file-{item.stem}',
                            'title': item.stem.replace('-', ' ').replace('_', ' ').title(),
                            'content': content[:500],
                            'type': 'long-term',
                            'timestamp': item.stat().st_mtime,
                            'tags': [],
                        })
                    except:
                        pass
        
        self.send_json(memories)
    
    def handle_all(self):
        data = {
            'soul': None,
            'identity': None,
            'skills': [],
            'memories': [],
            'files': list_files(self.clawd_path),
        }
        
        soul_path = self.clawd_path / 'SOUL.md'
        if soul_path.exists():
            try:
                data['soul'] = soul_path.read_text(encoding='utf-8')
            except:
                pass
        
        identity_path = self.clawd_path / 'IDENTITY.md'
        if identity_path.exists():
            try:
                data['identity'] = identity_path.read_text(encoding='utf-8')
            except:
                pass
        
        skills_dir = self.clawd_path / 'skills'
        if skills_dir.exists():
            for item in skills_dir.iterdir():
                if item.is_dir():
                    data['skills'].append({
                        'name': item.name,
                        'location': 'local',
                        'status': 'active',
                        'enabled': True,
                    })
        
        memory_md = self.clawd_path / 'MEMORY.md'
        if memory_md.exists():
            try:
                content = memory_md.read_text(encoding='utf-8')
                data['memories'] = parse_memory_md(content)
            except:
                pass
        
        self.send_json(data)
