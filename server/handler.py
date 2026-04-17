"""DunCrew Server - HTTP Request Handler (Base + Routing)"""
from __future__ import annotations

import os
import json
import time
import sqlite3
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler
from urllib.parse import unquote, urlparse, parse_qs
from datetime import datetime

from server.constants import APP_DIR, RESOURCES_DIR, VERSION, MIME_TYPES
from server.state import _db_lock, _embedding_manager
from server.db import init_sqlite_db
from server.cleanup import list_files, sync_traces_to_sqlite

# Import all handler mixins
from server.handlers.session import SessionMixin
from server.handlers.memory import MemoryMixin
from server.handlers.data import DataMixin
from server.handlers.analysis import AnalysisMixin
from server.handlers.tools import ToolsMixin
from server.handlers.parsers import ParsersMixin
from server.handlers.web import WebMixin
from server.handlers.skills import SkillsMixin
from server.handlers.duns import DunsMixin
from server.handlers.mcp import MCPMixin
from server.handlers.clawhub import ClawHubMixin
from server.handlers.traces import TracesMixin
from server.handlers.proxy import ProxyMixin
from server.handlers.browser_tools import BrowserToolsMixin
from server.handlers.dun_tools import DunToolsMixin
from server.handlers.rule_discovery import RuleDiscoveryMixin
from server.handlers.wiki import WikiMixin


class ClawdDataHandler(
    SessionMixin, MemoryMixin, DataMixin, AnalysisMixin,
    ToolsMixin, ParsersMixin, WebMixin, SkillsMixin,
    DunsMixin, MCPMixin, ClawHubMixin, TracesMixin,
    ProxyMixin, BrowserToolsMixin, DunToolsMixin,
    RuleDiscoveryMixin, WikiMixin,
    BaseHTTPRequestHandler
):
    clawd_path = None
    project_path = None  # 项目目录，用于加载内置技能
    registry = None  # type: ToolRegistry
    subagent_manager = None  # type: SubagentManager
    tasks = {}
    tasks_lock = threading.Lock()
    _gene_file_lock = threading.Lock()  # 基因文件读写锁，防止并发写入损坏
    
    def log_message(self, format, *args):
        timestamp = datetime.now().strftime('%H:%M:%S')
        print(f"[{timestamp}] {format % args}")
    
    def send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    
    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_cors_headers()
        self.end_headers()
        try:
            self.wfile.write(json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # 客户端已断开，静默忽略
    
    def send_text(self, text, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(text.encode('utf-8'))
    
    def send_error_json(self, message, status=404):
        self.send_json({'error': message, 'status': 'error'}, status)
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_cors_headers()
        self.end_headers()
    
    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        
        routes = {
            '/status': self.handle_status,
            '/files': self.handle_files,
            '/skills': self.handle_skills,
            '/duns': self.handle_duns,
            '/memories': self.handle_memories,
            '/tools': self.handle_tools_list,
            '/all': self.handle_all,
            '/': self.handle_index,
            '': self.handle_index,
        }
        
        if path in routes:
            routes[path]()
        elif path.startswith('/file/'):
            self.handle_file(path[6:])
        # Global Knowledge API (must be before /duns/ routes)
        elif path == '/knowledge':
            self.handle_global_knowledge_list()
        elif path.startswith('/knowledge/') and path != '/knowledge/':
            filename = path[11:]  # strip '/knowledge/'
            self.handle_global_knowledge_read(filename)
        elif path.startswith('/duns/') and '/experience' not in path:
            dun_name = path[6:]  # strip '/duns/'
            if dun_name == 'health':
                self.handle_duns_health()
            elif dun_name.endswith('/fitness'):
                self.handle_dun_fitness_get(dun_name[:-8])  # strip '/fitness'
            elif dun_name.endswith('/sop-content'):
                self.handle_dun_sop_content_get(dun_name[:-12])  # strip '/sop-content'
            elif dun_name.endswith('/sop-history'):
                self.handle_dun_sop_history_get(dun_name[:-12])  # strip '/sop-history'
            elif '/output-file/' in dun_name:
                # GET /duns/{name}/output-file/{filename}
                parts = dun_name.split('/output-file/', 1)
                self.handle_output_file_read(parts[0], parts[1])
            elif dun_name.endswith('/output-files'):
                # GET /duns/{name}/output-files
                self.handle_output_files_list(dun_name[:-13])  # strip '/output-files'
            elif '/knowledge/' in dun_name:
                # GET /duns/{name}/knowledge/{filename}
                parts = dun_name.split('/knowledge/', 1)
                self.handle_knowledge_read(parts[0], parts[1])
            elif dun_name.endswith('/knowledge'):
                # GET /duns/{name}/knowledge
                self.handle_knowledge_list(dun_name[:-10])  # strip '/knowledge'
            else:
                self.handle_dun_detail(dun_name)
        elif path.startswith('/task/status/'):
            task_id = path[13:]
            offset = int(query.get('offset', ['0'])[0])
            self.handle_task_status(task_id, offset)
        elif path == '/api/traces/search':
            self.handle_trace_search(query)
        elif path == '/api/traces/recent':
            self.handle_trace_recent(query)
        elif path == '/api/genes/load':
            self.handle_gene_load()
        elif path == '/api/capsules/load':
            self.handle_capsule_load()
        elif path == '/api/amendments/load':
            self.handle_amendment_load()
        elif path == '/api/registry/skills':
            self.handle_registry_skills_search(query)
        elif path == '/api/registry/mcp':
            self.handle_registry_mcp_search(query)
        elif path == '/api/embedding/status':
            self.send_json(_embedding_manager.get_status())
        elif path.startswith('/skills/') and path.endswith('/raw'):
            skill_name = path[8:-4]  # strip '/skills/' and '/raw'
            self.handle_skill_raw(skill_name)
        elif path == '/mcp/servers':
            self.handle_mcp_servers_list()
        # V2: Session API
        elif path == '/api/sessions':
            self.handle_sessions_list(query)
        elif path == '/api/sessions/search':
            self.handle_session_search(query)
        elif path.startswith('/api/sessions/') and path.endswith('/messages'):
            session_id = path[14:-9]  # strip '/api/sessions/' and '/messages'
            self.handle_session_messages_get(session_id, query)
        elif path.startswith('/api/sessions/') and path.endswith('/checkpoint'):
            session_id = path[14:-11]  # strip '/api/sessions/' and '/checkpoint'
            self.handle_session_checkpoint_get(session_id)
        elif path.startswith('/api/sessions/') and not path.endswith('/messages') and not path.endswith('/checkpoint'):
            session_id = path[14:]
            self.handle_session_get(session_id)
        # V2: Memory API
        elif path == '/api/memory/search':
            self.handle_memory_search(query)
        elif path == '/api/memory/stats':
            self.handle_memory_stats()
        elif path == '/api/memory/compilable-duns':
            self.handle_compilable_duns()
        elif path.startswith('/api/memory/dun/'):
            dun_id = path[16:]
            limit = int(query.get('limit', ['20'])[0])
            self.handle_memory_by_dun(dun_id, limit)
        # V2: Scoring API
        elif path.startswith('/api/dun/') and path.endswith('/scoring'):
            dun_id = path[9:-8]  # strip '/api/dun/' and '/scoring'
            self.handle_scoring_get(dun_id)
        # ClawHub OAuth 认证
        elif path == '/auth/clawhub/token':
            state = query.get('state', [''])[0]
            self.handle_clawhub_token_poll(state)
        elif path == '/auth/clawhub/callback':
            self.handle_clawhub_oauth_callback(query)
        # ClawHub API 代理 (解决浏览器 CORS/代理问题)
        elif path.startswith('/clawhub/proxy/'):
            self.handle_clawhub_proxy('GET', path, query)
        # Confidence Tracker API
        elif path == '/api/confidence/entries':
            self.handle_confidence_entries_get()
        # Governor 统计数据 API
        elif path == '/api/governor/stats':
            self.handle_governor_stats_get()
        # V4: 碱基分析引擎 API
        elif path == '/api/base-analysis':
            self.handle_base_analysis(query)
        elif path == '/api/base-analysis/models':
            self.handle_base_analysis_models(query)
        elif path == '/api/rule-tips':
            self.handle_rule_tips_get()
        elif path == '/api/dismissed-items':
            self.handle_dismissed_items_get()
        # V7: 规则发现管线 API
        elif path == '/api/discovered-rules':
            self.handle_discovered_rules_get()
        # V8: Wiki Knowledge Graph API (GET)
        elif path == '/api/wiki/entities':
            self.handle_wiki_entities_list(query)
        elif path == '/api/wiki/entity-index':
            self.handle_wiki_entity_index(query)
        elif path == '/api/wiki/search':
            self.handle_wiki_search(query)
        elif path == '/api/wiki/search-render':
            self.handle_wiki_search_render(query)
        elif path == '/api/wiki/stats':
            self.handle_wiki_stats(query)
        elif path == '/api/wiki/render-text':
            self.handle_wiki_render_all_text(query)
        elif path.startswith('/api/wiki/entity/') and path.endswith('/claims'):
            entity_id = path[17:-7]  # strip '/api/wiki/entity/' and '/claims'
            self.handle_wiki_entity_claims(entity_id)
        elif path.startswith('/api/wiki/entity/') and path.endswith('/text'):
            entity_id = path[17:-5]  # strip '/api/wiki/entity/' and '/text'
            self.handle_wiki_entity_render_text(entity_id)
        elif path.startswith('/api/wiki/entity/'):
            entity_id = path[17:]  # strip '/api/wiki/entity/'
            self.handle_wiki_entity_detail(entity_id)
        elif path == '/api/files/read-base64':
            self.handle_read_file_base64(query)
        elif path.startswith('/data/'):
            # 前端数据读取 API
            key = path[6:]  # strip '/data/'
            self.handle_data_get(key)
        elif path == '/data':
            # 列出所有数据键
            self.handle_data_list()
        else:
            # 静态文件服务 (托管 dist/ 目录)
            self.serve_static_file(path)
    
    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        content_type = self.headers.get('Content-Type', '')
        
        # 文件上传：multipart/form-data 单独处理（避免大文件 JSON 编码 OOM）
        if path == '/api/files/upload' and 'multipart/form-data' in content_type:
            self.handle_file_upload_multipart()
            return
        
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
        
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error_json('Invalid JSON', 400)
            return
        
        # 本地 Embedding 端点 (OpenAI 兼容)
        if path == '/v1/embeddings':
            self.handle_embeddings(data)
        # 🌟 新增：工具执行接口
        elif path == '/api/tools/execute':
            self.handle_tool_execution(data)
        elif path == '/api/files/upload':
            self.handle_file_upload(data)
        elif path == '/api/files/parse-local':
            self.handle_parse_local_file(data)
        elif path == '/tools/reload':
            self.handle_tools_reload(data)
        elif path == '/api/traces/save':
            self.handle_trace_save(data)
        elif path == '/api/traces/sync-to-db':
            threading.Thread(
                target=sync_traces_to_sqlite,
                args=(self._get_db(), self.clawd_path),
                name='trace-sync-manual',
                daemon=True,
            ).start()
            self.send_json({'status': 'ok', 'message': 'Trace sync started in background'})
        elif path == '/api/confidence/migrate':
            self.handle_confidence_migrate(data)
        elif path == '/api/governor/stats':
            self.handle_governor_stats_save(data)
        elif path == '/api/governor/rule-toggle':
            self.handle_governor_rule_toggle(data)
        # V4: 碱基分析规则保存
        elif path == '/api/base-analysis/rules':
            self.handle_base_analysis_rules_save(data)
        elif path == '/api/rule-tips':
            self.handle_rule_tips_save(data)
        elif path == '/api/dismissed-items':
            self.handle_dismissed_items_save(data)
        # V7: 规则发现管线 API
        elif path == '/api/rule-discovery/run':
            self.handle_rule_discovery_run(data)
        elif path == '/api/discovered-rules':
            self.handle_discovered_rules_save(data)
        # V8: Wiki Knowledge Graph API (POST)
        elif path == '/api/wiki/ingest':
            self.handle_wiki_ingest(data)
        elif path == '/api/wiki/claim/conflict':
            self.handle_wiki_claim_conflict(data)
        elif path == '/api/wiki/reindex':
            self.handle_wiki_reindex(data)
        elif path == '/api/wiki/batch':
            self.handle_wiki_batch(data)
        elif path == '/api/wiki/librarian':
            self.handle_wiki_librarian(data)
        elif path == '/api/wiki/librarian/execute':
            self.handle_wiki_librarian_execute(data)
        elif path == '/api/genes/save':
            self.handle_gene_save(data)
        elif path == '/api/capsules/save':
            self.handle_capsule_save(data)
        elif path == '/api/amendments/save':
            self.handle_amendment_save(data)
        elif path == '/mcp/reload':
            self.handle_mcp_reload(data)
        elif path.startswith('/mcp/servers/') and path.endswith('/reconnect'):
            server_name = path[13:-10]  # Extract server name
            self.handle_mcp_reconnect(server_name)
        elif path == '/mcp/install':
            self.handle_mcp_install(data)
        elif path == '/skills/install':
            self.handle_skill_install(data)
        elif path == '/skills/install-local':
            self.handle_skill_install_local(data)
        elif path == '/skills/uninstall':
            self.handle_skill_uninstall(data)
        elif path == '/skills/create':
            self.handle_skill_create(data)
        elif path == '/skills/toggle':
            self.handle_skill_toggle(data)
        elif path == '/skills/edit':
            self.handle_skill_edit(data)
        elif path == '/skills/optimize':
            self.handle_skill_optimize(data)
        elif path == '/skills/validate':
            self.handle_skill_validate(data)
        # ClawHub API 代理 (解决浏览器 CORS/代理问题)
        elif path.startswith('/clawhub/proxy/'):
            self.handle_clawhub_proxy('POST', path, query, data)
        elif path == '/clawhub/install':
            self.handle_clawhub_install(data)
        elif path == '/clawhub/publish':
            self.handle_clawhub_publish(data)
        elif path.startswith('/duns/') and path.endswith('/skills'):
            dun_name = path[6:-7]  # strip '/duns/' and '/skills'
            self.handle_dun_update_skills(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/experience'):
            dun_name = path[6:-11]  # strip '/duns/' and '/experience'
            self.handle_add_experience(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/meta'):
            dun_name = path[6:-5]  # strip '/duns/' and '/meta'
            self.handle_dun_update_meta(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/fitness'):
            dun_name = path[6:-8]  # strip '/duns/' and '/fitness'
            self.handle_dun_fitness_save(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/sop-content'):
            dun_name = path[6:-12]  # strip '/duns/' and '/sop-content'
            self.handle_dun_sop_content_save(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/sop-history'):
            dun_name = path[6:-12]  # strip '/duns/' and '/sop-history'
            self.handle_dun_sop_history_save(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/knowledge/log'):
            dun_name = path[6:-14]  # strip '/duns/' and '/knowledge/log'
            self.handle_knowledge_log_append(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/knowledge/index'):
            dun_name = path[6:-16]  # strip '/duns/' and '/knowledge/index'
            self.handle_knowledge_index_update(dun_name, data)
        elif path.startswith('/duns/') and path.endswith('/knowledge'):
            dun_name = path[6:-10]  # strip '/duns/' and '/knowledge'
            self.handle_knowledge_write(dun_name, data)
        # Global Knowledge API (POST)
        elif path == '/knowledge/log':
            self.handle_global_knowledge_log_append(data)
        elif path == '/knowledge/index':
            self.handle_global_knowledge_index_update(data)
        elif path == '/knowledge':
            self.handle_global_knowledge_write(data)
        elif path == '/task/execute':
            self.handle_task_execute(data)
        # V2: Session API (POST)
        elif path == '/api/sessions':
            self.handle_session_create(data)
        elif path.startswith('/api/sessions/') and path.endswith('/messages/batch'):
            session_id = path[14:-15]  # strip '/api/sessions/' and '/messages/batch'
            self.handle_session_messages_batch(session_id, data)
        elif path.startswith('/api/sessions/') and path.endswith('/messages'):
            session_id = path[14:-9]
            self.handle_session_message_append(session_id, data)
        elif path.startswith('/api/sessions/') and path.endswith('/checkpoint'):
            session_id = path[14:-11]
            self.handle_session_checkpoint_save(session_id, data)
        elif path.startswith('/api/sessions/') and path.endswith('/meta'):
            session_id = path[14:-5]
            self.handle_session_meta_update(session_id, data)
        # V2: Memory API (POST)
        elif path == '/api/memory/write':
            self.handle_memory_write(data)
        elif path == '/api/memory/write-batch':
            self.handle_memory_write_batch(data)
        elif path == '/api/memory/search-grouped':
            self.handle_memory_search_grouped(data)
        elif path == '/api/memory/prune':
            self.handle_memory_prune(data)
        elif path == '/api/memory/decay':
            self.handle_memory_decay(data)
        elif path.startswith('/data/'):
            # 前端数据写入 API
            key = path[6:]  # strip '/data/'
            self.handle_data_set(key, data)
        # 🤖 子代理 API (Quest 模式支持)
        elif path == '/api/subagent/spawn':
            self.handle_subagent_spawn(data)
        elif path == '/api/subagent/collect':
            self.handle_subagent_collect(data)
        elif path.startswith('/api/subagent/') and path.endswith('/status'):
            agent_id = path[14:-7]  # strip '/api/subagent/' and '/status'
            self.handle_subagent_status(agent_id)
        # 🌐 LLM API 代理 (解决 CORS 问题: Moonshot 等 API 的 preflight 不返回 CORS 头)
        elif path == '/api/llm/proxy':
            self.handle_llm_proxy(data)
        else:
            self.send_error_json(f'Unknown endpoint: {path}', 404)
    
    def do_PUT(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8') if content_length > 0 else '{}'
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error_json('Invalid JSON', 400)
            return
        
        if path.startswith('/api/dun/') and path.endswith('/scoring'):
            dun_id = path[9:-8]
            self.handle_scoring_put(dun_id, data)
        else:
            self.send_error_json(f'Unknown PUT endpoint: {path}', 404)
    
    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        
        if path.startswith('/api/memory/') and not path.endswith('/checkpoint'):
            # DELETE /api/memory/{id} - 软删除记忆
            mem_id = path[12:]  # strip '/api/memory/'
            if mem_id and not mem_id.startswith('search') and not mem_id.startswith('stats'):
                self.handle_memory_soft_delete(mem_id)
                return
        if path.startswith('/duns/') and len(path) > 6:
            # DELETE /duns/{id} - 归档 Dun 目录（重命名，防止文件扫描再次加载）
            dun_name = unquote(path[6:])
            self.handle_dun_archive(dun_name)
        elif path.startswith('/api/sessions/') and path.endswith('/checkpoint'):
            session_id = path[14:-11]
            self.handle_session_checkpoint_delete(session_id)
        elif path.startswith('/api/sessions/'):
            session_id = path[14:]
            self.handle_session_delete(session_id)
        else:
            self.send_error_json(f'Unknown DELETE endpoint: {path}', 404)
    

    # ============================================
    # V2: SQLite API Handlers
    # ============================================

    def _get_db(self) -> sqlite3.Connection:
        import server.state as _state
        if _state._db_conn is None:
            db_path = self.clawd_path / 'duncrew.db'
            _state._db_conn = init_sqlite_db(db_path)
        return _state._db_conn

    # ---- Sessions ----


    def serve_static_file(self, path: str):
        """托管 dist/ 目录的前端构建产物，支持 SPA 路由"""
        # 静态文件目录 (与服务器脚本/exe 同级的 dist/)
        static_dir = APP_DIR / 'dist'
        
        if not static_dir.exists():
            # dist/ 不存在时返回提示
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(b'''<!DOCTYPE html>
<html>
<head><title>DunCrew Server</title></head>
<body style="font-family: system-ui; padding: 40px; background: #1a1a2e; color: #eee;">
<h1>DunCrew Native Server</h1>
<p>Frontend not built. Run <code>npm run build</code> to generate dist/</p>
<p>Or access dev server at <a href="http://localhost:5173">http://localhost:5173</a></p>
<hr>
<p>API Endpoints:</p>
<ul>
<li>GET /status - Server status</li>
<li>GET /skills - List skills</li>
<li>POST /api/tools/execute - Execute tool</li>
</ul>
</body>
</html>''')
            return
        
        # 确定文件路径
        if path == '/' or path == '':
            file_path = static_dir / 'index.html'
        else:
            # 去掉开头的 /
            clean_path = path.lstrip('/')
            file_path = static_dir / clean_path
        
        # SPA 路由支持：如果不是文件（没有扩展名），返回 index.html
        if not file_path.exists():
            if '.' not in file_path.name:
                file_path = static_dir / 'index.html'
        
        if not file_path.exists():
            self.send_error_json(f'File not found: {path}', 404)
            return
        
        # 安全检查：确保路径在 static_dir 内
        try:
            file_path.resolve().relative_to(static_dir.resolve())
        except ValueError:
            self.send_error_json('Access denied', 403)
            return
        
        # 获取 MIME 类型
        suffix = file_path.suffix.lower()
        content_type = MIME_TYPES.get(suffix, 'application/octet-stream')
        
        try:
            with open(file_path, 'rb') as f:
                content = f.read()
            
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(content)))
            # 缓存控制：静态资源长期缓存
            if '/assets/' in str(file_path):
                self.send_header('Cache-Control', 'public, max-age=31536000')
            self.send_cors_headers()
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_error_json(f'Failed to read file: {str(e)}', 500)
    

    # ============================================
    # 原有处理器 (保持兼容)
    # ============================================
    
    def handle_index(self):
        # 优先托管前端 dist/index.html (便携式分发模式)
        index_file = APP_DIR / 'dist' / 'index.html'
        if index_file.exists():
            self.serve_static_file('/')
            return

        # dist 不存在时显示 API 文档页
        html = f"""<!DOCTYPE html>
<html>
<head><title>DunCrew Native Server</title></head>
<body style="font-family: monospace; background: #0f172a; color: #e2e8f0; padding: 30px;">
<h1>DunCrew Native Server v{VERSION}</h1>
<p style="color: #94a3b8;">独立运行的本地 AI 操作系统后端</p>
<p>Clawd Path: <code style="color: #22d3ee;">{self.clawd_path}</code></p>

<h2>📡 API Endpoints</h2>
<div style="background: #1e293b; padding: 15px; border-radius: 8px;">
<h3 style="color: #f59e0b;">数据读取</h3>
<ul>
<li><a href="/status" style="color: #60a5fa;">/status</a> - 服务状态</li>
<li><a href="/files" style="color: #60a5fa;">/files</a> - 文件列表</li>
<li><a href="/file/SOUL.md" style="color: #60a5fa;">/file/SOUL.md</a> - 读取 SOUL</li>
<li><a href="/skills" style="color: #60a5fa;">/skills</a> - 技能列表</li>
<li><a href="/all" style="color: #60a5fa;">/all</a> - 所有数据</li>
</ul>

<h3 style="color: #10b981;">🛠️ 工具执行 (POST)</h3>
<ul>
<li><code>/api/tools/execute</code> - 执行工具</li>
<li>支持: readFile, writeFile, listDir, runCmd, appendFile</li>
</ul>
</div>

<h2>🧪 测试</h2>
<pre style="background: #1e293b; padding: 15px; border-radius: 8px; overflow-x: auto;">
curl -X POST http://localhost:3001/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{{"name": "listDir", "args": {{"path": "."}}}}'
</pre>
</body>
</html>"""
        
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_cors_headers()
        self.end_headers()
        self.wfile.write(html.encode('utf-8'))
    
    def handle_status(self):
        files = list_files(self.clawd_path)
        skill_count = len(self.registry.instruction_tools) + len(self.registry.plugin_tools) + len(self.registry.builtin_tools)
        
        self.send_json({
            'status': 'ok',
            'version': VERSION,
            'mode': 'native',
            'clawdPath': str(self.clawd_path),
            'fileCount': len(files),
            'skillCount': skill_count,
            'tools': [t['name'] for t in self.registry.list_all()],
            'toolCount': len(self.registry.list_all()),
            'embedding': _embedding_manager.get_status(),
            'timestamp': datetime.now().isoformat()
        })
    
    def handle_files(self):
        files = list_files(self.clawd_path)
        self.send_json(files)
    
    def handle_file(self, filename):
        filepath = self.clawd_path / filename
        allowed_root = self.clawd_path.resolve()
        
        # 回退: 若用户目录没有该文件，尝试项目目录
        if not filepath.exists() and self.project_path:
            project_filepath = self.project_path / filename
            if project_filepath.exists() and project_filepath.is_file():
                filepath = project_filepath
                allowed_root = self.project_path.resolve()
        
        if not filepath.exists():
            self.send_error_json(f'File not found: {filename}', 404)
            return
        
        if not filepath.is_file():
            self.send_error_json(f'Not a file: {filename}', 400)
            return
        
        try:
            filepath.resolve().relative_to(allowed_root)
        except ValueError:
            self.send_error_json('Access denied', 403)
            return
        
        try:
            content = filepath.read_text(encoding='utf-8')
            self.send_text(content)
        except Exception as e:
            self.send_error_json(f'Read error: {str(e)}', 500)
        except Exception as e:
            self.send_error_json(f'Read error: {str(e)}', 500)
    