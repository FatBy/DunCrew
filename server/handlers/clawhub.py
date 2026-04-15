"""DunCrew Server - ClawHub OAuth/Proxy/Publish Mixin"""
from __future__ import annotations

import json
import time
import uuid
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlencode

class ClawHubMixin:
    """ClawHub OAuth/Proxy/Publish Mixin"""

    # ============================================
    # ClawHub OAuth 认证
    # ============================================

    _clawhub_pending_tokens: dict = {}  # state -> token

    def handle_clawhub_token_poll(self, state: str):
        """前端轮询获取 OAuth token"""
        if not state:
            self.send_error_json('Missing state parameter', 400)
            return
        token = self.__class__._clawhub_pending_tokens.get(state)
        if token:
            # Token 已到达，返回并清理
            del self.__class__._clawhub_pending_tokens[state]
            self.send_json({'token': token})
        else:
            self.send_json({'token': None, 'status': 'pending'})

    def handle_clawhub_oauth_callback(self, query: dict):
        """ClawHub OAuth 回调端点，接收 state + token"""
        state = query.get('state', [''])[0]
        token = query.get('token', [''])[0]
        if not state or not token:
            self.send_response(400)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<html><body><h2>Missing state or token</h2></body></html>')
            return
        self.__class__._clawhub_pending_tokens[state] = token
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<html><body><h2>Authorization successful! You can close this window.</h2></body></html>')

    # ============================================
    # ClawHub API 透明代理 (解决浏览器 CORS/代理问题)
    # ============================================

    CLAWHUB_UPSTREAM = 'https://clawhub.ai'

    def handle_clawhub_proxy(self, method: str, path: str, query: dict, data: dict = None):
        """透明代理 ClawHub API 请求
        
        前端请求: GET/POST /clawhub/proxy/api/v1/...
        后端转发: GET/POST https://clawhub.ai/api/v1/...
        """
        # 1. 提取上游路径
        upstream_path = path[len('/clawhub/proxy'):]
        
        # 2. 安全校验：只允许 /api/v1/ 前缀，防止 SSRF
        if not upstream_path.startswith('/api/v1/'):
            self.send_error_json('Invalid ClawHub API path', 400)
            return
        
        # 3. 重建 query string
        from urllib.parse import urlencode as _urlencode
        params = {k: v[0] for k, v in query.items()} if query else {}
        qs = f'?{_urlencode(params)}' if params else ''
        upstream_url = f'{self.CLAWHUB_UPSTREAM}{upstream_path}{qs}'
        
        # 4. 转发请求头
        req_headers = {'Accept': 'application/json'}
        auth = self.headers.get('Authorization')
        if auth:
            req_headers['Authorization'] = auth
        
        print(f'[ClawHub Proxy] {method} {upstream_url}', file=sys.stderr)
        
        try:
            import requests as req_lib
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        except ImportError:
            self.send_error_json('ClawHub proxy requires "requests" package: pip install requests', 500)
            return
        
        try:
            session = req_lib.Session()
            
            if method == 'GET':
                resp = session.get(upstream_url, headers=req_headers, timeout=(10, 30), verify=False)
            else:
                req_headers['Content-Type'] = 'application/json'
                resp = session.post(upstream_url, json=data, headers=req_headers, timeout=(10, 30), verify=False)
            
            if resp.ok:
                try:
                    self.send_json(resp.json())
                except Exception:
                    # 非 JSON 响应（如 download 返回二进制）
                    self.send_response(resp.status_code)
                    ct = resp.headers.get('Content-Type', 'application/octet-stream')
                    self.send_header('Content-Type', ct)
                    self.send_header('Access-Control-Allow-Origin', '*')
                    self.end_headers()
                    self.wfile.write(resp.content)
            else:
                error_text = resp.text[:300]
                print(f'[ClawHub Proxy] HTTP error: {resp.status_code} - {error_text}', file=sys.stderr)
                self.send_error_json(f'ClawHub API error ({resp.status_code}): {error_text}', resp.status_code)
        
        except req_lib.exceptions.ConnectTimeout:
            self.send_error_json('ClawHub API connect timeout', 504)
        except req_lib.exceptions.ReadTimeout:
            self.send_error_json('ClawHub API read timeout', 504)
        except req_lib.exceptions.ConnectionError as e:
            self.send_error_json(f'Failed to connect to ClawHub: {str(e)[:200]}', 502)
        except Exception as e:
            self.send_error_json(f'ClawHub proxy error: {str(e)[:200]}', 500)

    def handle_clawhub_install(self, data):
        """POST /clawhub/install - 从 ClawHub 下载并安装技能"""
        slug = data.get('slug', '')
        archive_url = data.get('archive_url', '')
        skill_name = data.get('name', '')

        if not archive_url:
            self.send_error_json('Missing archive_url parameter', 400)
            return

        # 从 slug 提取技能名
        if not skill_name:
            skill_name = slug.split('/')[-1] if '/' in slug else slug
        skill_name = re.sub(r'[^\w\-.]', '_', skill_name)

        if not skill_name:
            self.send_error_json('Cannot determine skill name', 400)
            return

        target = self.clawd_path / 'skills' / skill_name

        if target.exists():
            self.send_error_json(f'Skill already exists: {skill_name}. Use /skills/uninstall first.', 409)
            return

        try:
            import tempfile
            import tarfile
            import io

            # 确保 skills/ 目录存在
            (self.clawd_path / 'skills').mkdir(parents=True, exist_ok=True)

            # 下载归档
            req = _urllib_req.Request(archive_url, headers={'User-Agent': 'DunCrew/3.0'})
            with _urllib_req.urlopen(req, timeout=60) as resp:
                archive_data = resp.read()

            # 解压 tar.gz
            with tarfile.open(fileobj=io.BytesIO(archive_data), mode='r:gz') as tar:
                # 安全检查: 确保没有路径遍历
                for member in tar.getmembers():
                    if member.name.startswith('/') or '..' in member.name:
                        raise RuntimeError(f'Unsafe path in archive: {member.name}')

                # 创建目标目录
                target.mkdir(parents=True, exist_ok=True)

                # 解压时去掉顶层目录 (如果存在)
                members = tar.getmembers()
                top_dirs = set()
                for m in members:
                    parts = m.name.split('/')
                    if parts[0]:
                        top_dirs.add(parts[0])

                strip_prefix = ''
                if len(top_dirs) == 1:
                    strip_prefix = top_dirs.pop() + '/'

                for member in members:
                    if strip_prefix and member.name.startswith(strip_prefix):
                        member.name = member.name[len(strip_prefix):]
                    if not member.name or member.name == '.':
                        continue
                    tar.extract(member, target)

            # 验证
            has_skill_md = (target / 'SKILL.md').exists()
            has_manifest = (target / 'manifest.json').exists()
            if not has_skill_md:
                if has_manifest:
                    print(f"[SkillInstall] ⚠️ DEPRECATED: {target.name} only has manifest.json, please add SKILL.md")
                else:
                    shutil.rmtree(target, ignore_errors=True)
                    self.send_error_json('Invalid skill: no SKILL.md found', 400)
                    return

            # 重新扫描注册
            self.registry.plugin_tools.clear()
            self.registry.instruction_tools.clear()
            self.registry.scan_plugins()

            self.send_json({
                'status': 'ok',
                'name': skill_name,
                'slug': slug,
                'path': str(target),
                'message': f'Skill installed from ClawHub: {skill_name}',
                'toolCount': len(self.registry.list_all()),
            })

        except Exception as e:
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            self.send_error_json(f'ClawHub install failed: {str(e)}', 500)

    def handle_clawhub_publish(self, data):
        """POST /clawhub/publish - 打包本地技能供发布到 ClawHub"""
        skill_name = data.get('skill_name', '')

        if not skill_name:
            self.send_error_json('Missing skill_name parameter', 400)
            return

        if '..' in skill_name or '/' in skill_name or '\\' in skill_name:
            self.send_error_json('Invalid skill name', 400)
            return

        # 搜索技能目录
        skill_dir = None
        for skills_parent in [self.clawd_path / 'skills', (self.project_path or APP_DIR) / 'skills']:
            candidate = skills_parent / skill_name
            if candidate.exists() and candidate.is_dir():
                skill_dir = candidate
                break

        if not skill_dir:
            self.send_error_json(f'Skill not found: {skill_name}', 404)
            return

        try:
            import tarfile
            import io
            import base64

            # 读取 frontmatter 元数据
            skill_md = skill_dir / 'SKILL.md'
            frontmatter = parse_skill_frontmatter(skill_md) if skill_md.exists() else {}

            # 打包为 tar.gz (排除 __pycache__, node_modules, .git)
            buffer = io.BytesIO()
            exclude_patterns = {'__pycache__', 'node_modules', '.git', '.env', '.DS_Store'}

            with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
                for item in skill_dir.rglob('*'):
                    # 排除不需要的文件/目录
                    parts = item.relative_to(skill_dir).parts
                    if any(p in exclude_patterns for p in parts):
                        continue
                    if item.is_file():
                        arcname = str(item.relative_to(skill_dir))
                        tar.add(str(item), arcname=arcname)

            archive_b64 = base64.b64encode(buffer.getvalue()).decode('ascii')

            # 收集文件列表
            file_list = []
            for item in skill_dir.rglob('*'):
                parts = item.relative_to(skill_dir).parts
                if any(p in exclude_patterns for p in parts):
                    continue
                if item.is_file():
                    file_list.append(str(item.relative_to(skill_dir)))

            self.send_json({
                'status': 'ok',
                'name': frontmatter.get('name', skill_name),
                'description': frontmatter.get('description', ''),
                'version': frontmatter.get('version', '1.0.0'),
                'tags': frontmatter.get('tags', []),
                'archive_base64': archive_b64,
                'file_list': file_list,
                'archive_size': len(buffer.getvalue()),
            })

        except Exception as e:
            self.send_error_json(f'Publish packaging failed: {str(e)}', 500)


