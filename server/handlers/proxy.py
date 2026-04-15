"""DunCrew Server - Subagent API + LLM Proxy Mixin"""
from __future__ import annotations

import json
import sys
import time
import uuid
import threading
from pathlib import Path
from datetime import datetime

from server.cleanup import run_task_in_background, read_log_chunk

class ProxyMixin:
    """Subagent API + LLM Proxy Mixin"""

    def handle_task_execute(self, data):
        """兼容旧的任务执行接口"""
        prompt = data.get('prompt', '').strip()
        if not prompt:
            self.send_error_json('Missing prompt', 400)
            return
        
        task_id = str(uuid.uuid4())[:8]
        
        thread = threading.Thread(
            target=run_task_in_background,
            args=(task_id, prompt, self.clawd_path),
            daemon=True,
        )
        thread.start()
        
        self.send_json({
            'taskId': task_id,
            'status': 'running',
        })
    
    # ============================================
    # 🤖 子代理 API 处理器 (Quest 模式支持)
    # ============================================
    
    def handle_subagent_spawn(self, data):
        """启动子代理"""
        if not self.subagent_manager:
            self.send_error_json('SubagentManager not initialized', 500)
            return
        
        agent_type = data.get('type', 'explore')
        task = data.get('task', '')
        tools = data.get('tools', [])
        context = data.get('context', '')
        
        if not task:
            self.send_error_json('Missing task', 400)
            return
        
        try:
            agent_id = self.subagent_manager.spawn(agent_type, task, tools, context)
            self.send_json({
                'status': 'success',
                'agentId': agent_id,
                'message': f'Spawned {agent_type} agent'
            })
        except Exception as e:
            self.send_error_json(f'Failed to spawn agent: {e}', 500)
    
    def handle_subagent_status(self, agent_id):
        """获取子代理状态"""
        if not self.subagent_manager:
            self.send_error_json('SubagentManager not initialized', 500)
            return
        
        status = self.subagent_manager.get_status(agent_id)
        if status:
            self.send_json({'status': 'success', 'agent': status})
        else:
            self.send_error_json(f'Agent not found: {agent_id}', 404)
    
    def handle_subagent_collect(self, data):
        """收集多个子代理的结果"""
        if not self.subagent_manager:
            self.send_error_json('SubagentManager not initialized', 500)
            return
        
        agent_ids = data.get('agentIds', [])
        timeout = data.get('timeout', 60.0)
        
        if not agent_ids:
            # 返回所有代理状态
            all_status = self.subagent_manager.get_all_status()
            self.send_json({'status': 'success', 'agents': all_status})
            return
        
        try:
            results = self.subagent_manager.collect_results(agent_ids, timeout)
            self.send_json({'status': 'success', 'results': results})
        except Exception as e:
            self.send_error_json(f'Failed to collect results: {e}', 500)
    
    def handle_llm_proxy(self, data: dict):
        """代理转发 LLM API 请求（解决 CORS 问题）
        
        前端请求: POST /api/llm/proxy
        Body: { "url": "https://api.moonshot.cn/v1/chat/completions", "apiKey": "sk-...", "body": {...}, "stream": true }
        
        对于 stream=true，使用分块传输将 SSE 事件流式转发给前端。
        """
        target_url = data.get('url')
        api_key = data.get('apiKey')
        request_body = data.get('body')
        is_stream = data.get('stream', False)
        custom_headers = data.get('headers')  # 前端可传入完整 headers（Anthropic 等非 Bearer 认证）
        
        if not target_url or not request_body:
            self.send_error_json('Missing url or body', 400)
            return
        
        # 若前端未提供 apiKey 也未提供 headers，报错
        if not api_key and not custom_headers:
            self.send_error_json('Missing apiKey or headers', 400)
            return
        
        try:
            import requests as req_lib
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        except ImportError as e:
            self.send_error_json(f'LLM proxy requires "requests" package: pip install requests', 500)
            return
        
        print(f'[LLM Proxy] -> {target_url} (stream={is_stream})', file=sys.stderr)
        
        # 创建独立 Session，尊重环境变量代理设置
        session = req_lib.Session()
        # trust_env=True (默认值) 让 requests 自动读取 HTTP_PROXY/HTTPS_PROXY
        
        try:
            # 构建请求头: 优先使用前端传入的 custom_headers，否则回退到 Bearer token
            if custom_headers and isinstance(custom_headers, dict):
                req_headers = {'Content-Type': 'application/json'}
                req_headers.update(custom_headers)
            else:
                req_headers = {
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {api_key}',
                }
            
            resp = session.post(
                target_url,
                json=request_body,
                headers=req_headers,
                stream=is_stream,
                timeout=(10, 300),  # connect 10s, read 300s (长任务可能很久)
                verify=False,
            )
            
            if is_stream:
                # 流式转发: 使用 chunked transfer encoding
                self.send_response(resp.status_code)
                self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                
                try:
                    for chunk in resp.iter_content(chunk_size=None):
                        if chunk:
                            # HTTP chunked encoding: size\r\ndata\r\n
                            chunk_data = chunk
                            self.wfile.write(f'{len(chunk_data):x}\r\n'.encode())
                            self.wfile.write(chunk_data)
                            self.wfile.write(b'\r\n')
                            self.wfile.flush()
                    # 终止 chunk
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass  # 客户端断开
                finally:
                    resp.close()
            else:
                # 非流式: 直接转发响应
                if resp.ok:
                    try:
                        self.send_json(resp.json())
                    except Exception:
                        self.send_response(resp.status_code)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Access-Control-Allow-Origin', '*')
                        self.end_headers()
                        self.wfile.write(resp.content)
                else:
                    error_text = resp.text[:500]
                    print(f'[LLM Proxy] HTTP error: {resp.status_code} - {error_text}', file=sys.stderr)
                    self.send_error_json(f'LLM API error ({resp.status_code}): {error_text}', resp.status_code)
        
        except req_lib.exceptions.ConnectTimeout:
            self.send_error_json('LLM API connect timeout', 504)
        except req_lib.exceptions.ReadTimeout:
            self.send_error_json('LLM API read timeout', 504)
        except req_lib.exceptions.ConnectionError as e:
            self.send_error_json(f'Failed to connect to LLM API: {str(e)[:200]}', 502)
        except Exception as e:
            print(f'[LLM Proxy] Error: {type(e).__name__}: {e}', file=sys.stderr)
            self.send_error_json(f'LLM proxy error: {type(e).__name__}: {str(e)[:200]}', 500)
        finally:
            session.close()

    def handle_task_status(self, task_id, offset=0):
        with self.tasks_lock:
            task = self.tasks.get(task_id)
        
        if not task:
            self.send_error_json(f'Task not found: {task_id}', 404)
            return
        
        log_path = task.get('logPath')
        content = ''
        new_offset = offset
        has_more = False
        file_size = task.get('fileSize', 0)
        
        if log_path:
            content, new_offset, has_more = read_log_chunk(log_path, offset)
            try:
                file_size = Path(log_path).stat().st_size
            except:
                pass
        
        self.send_json({
            'taskId': task_id,
            'status': task['status'],
            'content': content,
            'offset': new_offset,
            'hasMore': has_more,
            'fileSize': file_size,
        })


# ============================================
# 辅助函数
# ============================================


