"""DunCrew Server - Skill Management Mixin (List/CRUD/Install)"""
from __future__ import annotations

import os
import re
import json
import time
import shutil
import threading
import subprocess
from pathlib import Path
from datetime import datetime

from server.constants import APP_DIR, RESOURCES_DIR, HAS_YAML, PLUGIN_TIMEOUT
from server.utils import parse_skill_frontmatter, skill_name_to_tool_name
from server.state import _embedding_manager

class SkillsMixin:
    """Skill Management Mixin (List/CRUD/Install)"""

    def handle_skills(self):
        """GET /skills - 统一从 SKILL.md frontmatter 扫描所有技能，支持用户目录 + 项目目录"""
        skills = []
        seen = set()
        seen_ids = set()  # 防止重复技能 (用户目录优先)
        
        # 获取技能目录列表：用户目录优先，项目目录作为后备
        skills_dirs = []
        user_skills_dir = self.clawd_path / 'skills'
        if user_skills_dir.exists() and user_skills_dir.is_dir():
            skills_dirs.append(('user', user_skills_dir))
        
        project_path = self.project_path or APP_DIR
        project_skills_dir = project_path / 'skills'
        if project_skills_dir.exists() and project_skills_dir.is_dir() and project_skills_dir != user_skills_dir:
            skills_dirs.append(('bundled', project_skills_dir))
        
        if not skills_dirs:
            self.send_json([])
            return

        for source, skills_dir in skills_dirs:
            # ── 统一扫描 SKILL.md ──
            for skill_md in skills_dir.rglob('SKILL.md'):
                skill_dir = skill_md.parent
                dir_key = str(skill_dir.resolve())
                skill_id = skill_dir.name
                
                if dir_key in seen or skill_id in seen_ids:
                    continue
                seen.add(dir_key)
                seen_ids.add(skill_id)

                frontmatter = parse_skill_frontmatter(skill_md)

                is_enabled = frontmatter.get('enabled', True)
                # enabled 可能是字符串 'false'（YAML 解析差异），统一处理
                if isinstance(is_enabled, str):
                    is_enabled = is_enabled.lower() not in ('false', '0', 'no')

                skill_data = {
                    'id': skill_id,
                    'name': frontmatter.get('name', skill_dir.name),
                    'description': frontmatter.get('description', ''),
                    'location': source,  # 'user' 或 'bundled'
                    'path': str(skill_dir),
                    'status': 'active' if is_enabled else 'inactive',
                    'enabled': is_enabled,
                    'keywords': frontmatter.get('tags', frontmatter.get('keywords', [])),
                }

                # whenToUse 字段（供 LLM 判断何时使用该技能）
                if frontmatter.get('whenToUse') or frontmatter.get('when_to_use'):
                    skill_data['whenToUse'] = frontmatter.get('whenToUse') or frontmatter.get('when_to_use')

                # OpenClaw 生态字段
                if frontmatter.get('emoji'):
                    skill_data['emoji'] = frontmatter['emoji']
                if frontmatter.get('author'):
                    skill_data['author'] = frontmatter['author']
                if frontmatter.get('primaryEnv'):
                    skill_data['primaryEnv'] = frontmatter['primaryEnv']
                if frontmatter.get('requires'):
                    skill_data['requires'] = frontmatter['requires']
                if frontmatter.get('install'):
                    skill_data['install'] = frontmatter['install']
                if frontmatter.get('tags'):
                    skill_data['tags'] = frontmatter['tags']
                if frontmatter.get('version'):
                    skill_data['version'] = frontmatter['version']
                if frontmatter.get('dangerLevel'):
                    skill_data['dangerLevel'] = frontmatter['dangerLevel']

                # 无 frontmatter description 时提取正文首段
                if not skill_data['description']:
                    try:
                        content = skill_md.read_text(encoding='utf-8')
                        for line in content.split('\n'):
                            line = line.strip()
                            if line and not line.startswith('#') and not line.startswith('---'):
                                skill_data['description'] = line[:200]
                                break
                    except Exception:
                        pass

                # ── 从 frontmatter 提取工具信息 (替代 _enrich_skill_from_manifest) ──
                executable = frontmatter.get('executable', '')
                if executable and (skill_dir / executable).exists():
                    # 可执行技能
                    skill_data['executable'] = True
                    tools_list = frontmatter.get('tools', [])
                    if tools_list:
                        # 多工具: 从 tools 数组提取 toolNames
                        tool_names = [t.get('toolName') for t in tools_list if t.get('toolName')]
                        skill_data['toolNames'] = tool_names
                        skill_data['toolName'] = tool_names[0] if tool_names else skill_name_to_tool_name(skill_data['name'])
                        # 合并所有工具的 keywords
                        all_keywords = list(skill_data.get('keywords', []))
                        all_inputs = {}
                        for t in tools_list:
                            all_keywords.extend(t.get('keywords', []))
                            all_inputs.update(t.get('inputs', {}))
                        skill_data['keywords'] = list(set(all_keywords))
                        if all_inputs:
                            skill_data['inputs'] = all_inputs
                    else:
                        # 单工具
                        tool_name = skill_name_to_tool_name(skill_data['name'])
                        skill_data['toolName'] = tool_name
                        skill_data['toolNames'] = [tool_name]
                        if frontmatter.get('inputs'):
                            skill_data['inputs'] = frontmatter['inputs']
                else:
                    # 指令型技能
                    skill_data['toolType'] = 'instruction'
                    tool_name = skill_name_to_tool_name(skill_data['name'])
                    skill_data['toolName'] = tool_name
                    skill_data['toolNames'] = [tool_name]
                    if frontmatter.get('inputs'):
                        skill_data['inputs'] = frontmatter['inputs']

                skills.append(skill_data)

            # ── Deprecated fallback: manifest.json (兼容无 SKILL.md 的第三方技能) ──
            for manifest_path in skills_dir.rglob('manifest.json'):
                skill_dir = manifest_path.parent
                dir_key = str(skill_dir.resolve())
                skill_id = skill_dir.name
                
                if dir_key in seen or skill_id in seen_ids:
                    continue
                seen.add(dir_key)
                seen_ids.add(skill_id)

                try:
                    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                except Exception:
                    continue

                skill_data = {
                    'id': skill_id,
                    'name': manifest.get('name', skill_dir.name),
                    'description': manifest.get('description', ''),
                    'location': source,
                    'path': str(skill_dir),
                    'status': 'active',
                    'enabled': True,
                    'keywords': manifest.get('keywords', []),
                }

                # 从 manifest 提取工具信息
                tools_list = manifest.get('tools', [])
                if not tools_list:
                    tools_list = [manifest]
                tool_names = [t.get('toolName') for t in tools_list if t.get('toolName')]
                if tool_names:
                    skill_data['toolNames'] = tool_names
                    skill_data['toolName'] = tool_names[0]
                    skill_data['executable'] = True
                skill_data['dangerLevel'] = manifest.get('dangerLevel', 'safe')
                skill_data['version'] = manifest.get('version', '1.0.0')

                skills.append(skill_data)

        self.send_json(skills)

    # ============================================
    # 🌌 Dun 管理
    # ============================================


    def handle_tools_list(self):
        """GET /tools - 列出所有已注册的工具"""
        self.send_json(self.registry.list_all())

    def handle_tools_reload(self, data=None):
        """POST /tools/reload - 热重载插件工具"""
        self.registry.plugin_tools.clear()
        self.registry.instruction_tools.clear()
        self.registry.scan_plugins()
        tools = self.registry.list_all()
        self.send_json({
            'status': 'ok',
            'message': f'Reloaded. {len(tools)} tools registered.',
            'tools': tools,
        })

    # ============================================
    # 🔌 MCP 服务器管理
    # ============================================


    def handle_skill_install_local(self, data):
        """POST /skills/install-local - 从本地 zip/skill 压缩包安装技能
        
        请求体: { "filename": "xxx.skill", "data": "<base64 encoded zip>" }
        """
        import base64
        import zipfile
        import io

        filename = data.get('filename', '')
        file_data = data.get('data', '')

        if not file_data:
            self.send_error_json('Missing data parameter (base64 encoded zip)', 400)
            return

        if not filename:
            filename = 'uploaded.skill'

        try:
            zip_bytes = base64.b64decode(file_data)
        except Exception:
            self.send_error_json('Invalid base64 data', 400)
            return

        try:
            zip_buffer = io.BytesIO(zip_bytes)
            if not zipfile.is_zipfile(zip_buffer):
                self.send_error_json('Uploaded file is not a valid zip archive', 400)
                return

            zip_buffer.seek(0)
            with zipfile.ZipFile(zip_buffer, 'r') as zf:
                # 安全检查: 禁止路径遍历
                for member in zf.namelist():
                    if member.startswith('/') or '..' in member:
                        self.send_error_json(f'Unsafe path in archive: {member}', 400)
                        return

                # 分析 zip 结构，找到 SKILL.md 所在的目录层级
                skill_md_paths = [n for n in zf.namelist() if n.endswith('SKILL.md')]
                if not skill_md_paths:
                    self.send_error_json('Invalid skill package: no SKILL.md found in archive', 400)
                    return

                # 取最浅层的 SKILL.md 来确定技能根目录
                skill_md_paths.sort(key=lambda p: p.count('/'))
                shallowest = skill_md_paths[0]
                parts = shallowest.split('/')

                if len(parts) >= 2:
                    # 标准结构: skill-name/SKILL.md → 顶层目录就是技能名
                    skill_dir_name = parts[0]
                    strip_prefix = ''
                elif len(parts) == 1:
                    # SKILL.md 在 zip 根目录 → 用文件名作为技能名
                    base = Path(filename).stem
                    skill_dir_name = re.sub(r'[^\w\-.]', '_', base)
                    strip_prefix = None  # 需要创建包裹目录
                else:
                    self.send_error_json('Cannot determine skill name from archive', 400)
                    return

                # 安全化名称
                skill_dir_name = re.sub(r'[^\w\-.]', '_', skill_dir_name)
                skills_root = self.clawd_path / 'skills'
                skills_root.mkdir(parents=True, exist_ok=True)
                target = skills_root / skill_dir_name

                if target.exists():
                    self.send_error_json(f'Skill already exists: {skill_dir_name}. Uninstall first.', 409)
                    return

                if strip_prefix is None:
                    # SKILL.md 在根目录: 创建包裹目录后解压所有文件到其中
                    target.mkdir(parents=True, exist_ok=True)
                    for member in zf.namelist():
                        if member.endswith('/'):
                            (target / member).mkdir(parents=True, exist_ok=True)
                        else:
                            dest = target / member
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            with zf.open(member) as src, open(dest, 'wb') as dst:
                                dst.write(src.read())
                else:
                    # 标准结构: 直接解压到 skills/ 目录
                    zf.extractall(str(skills_root))

            # 验证解压结果
            if not target.exists() or not (target / 'SKILL.md').exists():
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                self.send_error_json('Extraction failed: SKILL.md not found after extraction', 500)
                return

            # 重新扫描注册
            self.registry.plugin_tools.clear()
            self.registry.instruction_tools.clear()
            self.registry.scan_plugins()

            self.send_json({
                'status': 'ok',
                'name': skill_dir_name,
                'path': str(target),
                'message': f'Skill installed from local file: {skill_dir_name}',
                'toolCount': len(self.registry.list_all()),
            })

        except zipfile.BadZipFile:
            self.send_error_json('Corrupted zip file', 400)
        except Exception as e:
            # 清理失败的安装
            target_path = self.clawd_path / 'skills' / skill_dir_name
            if target_path.exists():
                shutil.rmtree(target_path, ignore_errors=True)
            self.send_error_json(f'Installation failed: {str(e)}', 500)

    def handle_skill_install(self, data):
        """POST /skills/install - 从 Git URL 安装技能"""
        source = data.get('source', '')
        name = data.get('name', '')

        if not source:
            self.send_error_json('Missing source parameter', 400)
            return

        if not source.startswith(('http://', 'https://', 'git@')):
            self.send_error_json('Unsupported source format. Use a Git URL (https://... or git@...)', 400)
            return

        try:
            # 从 URL 提取仓库名
            match = re.search(r'/([^/]+?)(?:\.git)?$', source)
            repo_name = name or (match.group(1) if match else 'downloaded-skill')
            # 安全化名称
            repo_name = re.sub(r'[^\w\-.]', '_', repo_name)

            target = self.clawd_path / 'skills' / repo_name
            if target.exists():
                self.send_error_json(f'Skill already exists: {repo_name}. Use /skills/uninstall first.', 409)
                return

            # 确保 skills/ 目录存在
            (self.clawd_path / 'skills').mkdir(parents=True, exist_ok=True)

            # Git clone (shallow, 限制深度)
            process = subprocess.run(
                ['git', 'clone', '--depth', '1', source, str(target)],
                capture_output=True,
                text=True,
                timeout=120,
            )

            if process.returncode != 0:
                # 清理失败的 clone
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
                stderr = process.stderr[:500] if process.stderr else 'Unknown error'
                raise RuntimeError(f"git clone failed: {stderr}")

            # 验证: 必须有 SKILL.md (manifest.json 已 deprecated)
            has_skill_md = (target / 'SKILL.md').exists() or any(target.rglob('SKILL.md'))
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
                'name': repo_name,
                'path': str(target),
                'message': f'Skill installed: {repo_name}',
                'toolCount': len(self.registry.list_all()),
            })

        except subprocess.TimeoutExpired:
            if target.exists():
                shutil.rmtree(target, ignore_errors=True)
            self.send_error_json('Git clone timed out (120s limit)', 500)
        except RuntimeError as e:
            self.send_error_json(str(e), 500)
        except Exception as e:
            self.send_error_json(f'Installation failed: {str(e)}', 500)

    def handle_skill_uninstall(self, data):
        """POST /skills/uninstall - 卸载技能"""
        name = data.get('name', '')

        if not name:
            self.send_error_json('Missing name parameter', 400)
            return

        # 安全检查: 不允许路径遍历
        if '..' in name or '/' in name or '\\' in name:
            self.send_error_json('Invalid skill name', 400)
            return

        target = self.clawd_path / 'skills' / name

        if not target.exists():
            self.send_error_json(f'Skill not found: {name}', 404)
            return

        if not target.is_dir():
            self.send_error_json(f'Not a directory: {name}', 400)
            return

        try:
            shutil.rmtree(target)

            # 重新扫描
            self.registry.plugin_tools.clear()
            self.registry.instruction_tools.clear()
            self.registry.scan_plugins()

            self.send_json({
                'status': 'ok',
                'name': name,
                'message': f'Skill uninstalled: {name}',
                'toolCount': len(self.registry.list_all()),
            })

        except Exception as e:
            self.send_error_json(f'Uninstall failed: {str(e)}', 500)

    # ============================================
    # 本地 Embedding 端点 (OpenAI 兼容)
    # ============================================

    def handle_embeddings(self, data: dict):
        """处理 POST /v1/embeddings 请求 (OpenAI 兼容格式)"""
        if not _embedding_manager.is_available():
            self.send_response(501)
            self.send_header('Content-Type', 'application/json')
            self.send_cors_headers()
            self.end_headers()
            import json as _json
            self.wfile.write(_json.dumps({
                'error': {
                    'message': 'Local embedding model requires onnxruntime and tokenizers. '
                               'Install with: pip install onnxruntime tokenizers numpy',
                    'type': 'not_installed',
                }
            }).encode('utf-8'))
            return

        if _embedding_manager._loading:
            # 模型加载/下载中，排队等待而非直接返回 503
            if not _embedding_manager.wait_until_ready():
                self.send_response(503)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Retry-After', '10')
                self.send_cors_headers()
                self.end_headers()
                import json as _json
                self.wfile.write(_json.dumps({
                    'error': {
                        'message': 'Embedding model loading timed out, please retry later',
                        'type': 'loading_timeout',
                    }
                }).encode('utf-8'))
                return
            # 等待完成但模型仍未就绪（加载失败）
            if _embedding_manager._session is None:
                self.send_error_json('Embedding model failed to load', 500)
                return

        raw_input = data.get('input', '')
        if isinstance(raw_input, str):
            texts = [raw_input]
        elif isinstance(raw_input, list):
            texts = [str(t) for t in raw_input]
        else:
            self.send_error_json('input must be a string or array of strings', 400)
            return

        if not texts or all(not t.strip() for t in texts):
            self.send_error_json('input is empty', 400)
            return

        try:
            vectors = _embedding_manager.encode(texts)
        except RuntimeError as e:
            self.send_error_json(f'Embedding failed: {str(e)[:200]}', 500)
            return
        except Exception as e:
            self.send_error_json(f'Embedding error: {str(e)[:200]}', 500)
            return

        # 估算 token 数 (粗略: 中文约1字=1token, 英文约4字符=1token)
        total_chars = sum(len(t) for t in texts)
        est_tokens = max(1, total_chars // 2)

        result_data = []
        for i, vec in enumerate(vectors):
            result_data.append({
                'object': 'embedding',
                'index': i,
                'embedding': vec,
            })

        self.send_json({
            'object': 'list',
            'data': result_data,
            'model': _embedding_manager.MODEL_DIR_NAME,
            'usage': {
                'prompt_tokens': est_tokens,
                'total_tokens': est_tokens,
            }
        })


    def handle_skill_raw(self, skill_name: str):
        """GET /skills/<name>/raw - 获取技能原始文件列表和内容"""
        if '..' in skill_name or '/' in skill_name or '\\' in skill_name:
            self.send_error_json('Invalid skill name', 400)
            return

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
            exclude_patterns = {'__pycache__', 'node_modules', '.git', '.env'}
            files = []
            for item in skill_dir.rglob('*'):
                parts = item.relative_to(skill_dir).parts
                if any(p in exclude_patterns for p in parts):
                    continue
                if item.is_file():
                    rel_path = str(item.relative_to(skill_dir))
                    try:
                        content = item.read_text(encoding='utf-8')
                    except Exception:
                        content = f'[binary file, {item.stat().st_size} bytes]'
                    files.append({
                        'path': rel_path,
                        'size': item.stat().st_size,
                        'content': content[:10000],  # 限制内容大小
                    })

            self.send_json({
                'name': skill_name,
                'path': str(skill_dir),
                'files': files,
            })

        except Exception as e:
            self.send_error_json(f'Failed to read skill: {str(e)}', 500)

    def handle_skill_create(self, data):
        """POST /skills/create - 创建新的空白技能骨架"""
        name = data.get('name', '').strip()
        if not name:
            self.send_error_json('Missing skill name', 400)
            return

        # 标准化名称: 保留字母数字和连字符，转小写
        safe_name = re.sub(r'[^a-zA-Z0-9_\-]', '-', name).strip('-').lower()
        # 清理连续连字符
        safe_name = re.sub(r'-{2,}', '-', safe_name).strip('-')
        if not safe_name:
            self.send_error_json('Invalid skill name: name must contain at least one alphanumeric character', 400)
            return

        skills_dir = self.clawd_path / 'skills' / safe_name
        if skills_dir.exists():
            self.send_error_json(f'Skill "{safe_name}" already exists', 409)
            return

        description = data.get('description', '')
        skill_type = data.get('type', 'instruction')  # instruction | executable
        tags = data.get('tags', [])
        keywords = data.get('keywords', [])
        danger_level = data.get('dangerLevel', 'safe')
        requires_env = data.get('requiresEnv', [])
        requires_bins = data.get('requiresBins', [])
        inputs_schema = data.get('inputs', {})

        try:
            skills_dir.mkdir(parents=True, exist_ok=True)
            tags_yaml = ', '.join(tags) if tags else ''
            keywords_yaml = ', '.join(keywords) if keywords else ''

            # 构建 SKILL.md frontmatter
            fm_lines = [
                '---',
                f'name: {safe_name}',
                f'description: {description}',
                'version: 1.0.0',
                f'dangerLevel: {danger_level}',
            ]
            if tags_yaml:
                fm_lines.append(f'tags: [{tags_yaml}]')
            if keywords_yaml:
                fm_lines.append(f'keywords: [{keywords_yaml}]')
            if requires_env or requires_bins:
                fm_lines.append('requires:')
                if requires_env:
                    env_yaml = ', '.join(requires_env)
                    fm_lines.append(f'  env: [{env_yaml}]')
                if requires_bins:
                    bins_yaml = ', '.join(requires_bins)
                    fm_lines.append(f'  bins: [{bins_yaml}]')
            if inputs_schema:
                fm_lines.append('inputs:')
                for key, val in inputs_schema.items():
                    if isinstance(val, dict):
                        fm_lines.append(f'  {key}:')
                        for k, v in val.items():
                            fm_lines.append(f'    {k}: {v}')
                    else:
                        fm_lines.append(f'  {key}: {val}')

            if skill_type == 'executable':
                fm_lines.append('executable: execute.py')
                fm_lines.append('runtime: python')
                fm_lines.append('metadata:')
                fm_lines.append('  openclaw:')
                fm_lines.append('    primaryEnv: python')
            else:
                fm_lines.append('metadata:')
                fm_lines.append('  openclaw:')
                fm_lines.append('    primaryEnv: shell')

            fm_lines.append('---')
            fm_lines.append('')
            fm_lines.append(f'# {safe_name}')
            fm_lines.append('')
            fm_lines.append(description if description else '在此编写技能说明...')
            fm_lines.append('')
            fm_lines.append('## Instructions')
            fm_lines.append('')
            fm_lines.append('在此编写技能的使用说明和工作流程。')
            fm_lines.append('')

            (skills_dir / 'SKILL.md').write_text('\n'.join(fm_lines), encoding='utf-8')

            # 可执行类型: 生成 execute.py 骨架
            if skill_type == 'executable':
                execute_code = (
                    '#!/usr/bin/env python3\n'
                    '"""Auto-generated skill executor"""\n'
                    'import json\n'
                    'import sys\n'
                    '\n'
                    '\n'
                    'def main():\n'
                    '    input_data = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}\n'
                    f'    result = {{"status": "success", "message": "Hello from {safe_name}"}}\n'
                    '    print(json.dumps(result))\n'
                    '\n'
                    '\n'
                    'if __name__ == "__main__":\n'
                    '    main()\n'
                )
                (skills_dir / 'execute.py').write_text(execute_code, encoding='utf-8')

            # 热重载工具注册表
            if self.registry:
                self.registry.plugin_tools.clear()
                self.registry.instruction_tools.clear()
                self.registry.scan_plugins()

            self.send_json({
                'status': 'success',
                'name': safe_name,
                'path': str(skills_dir),
                'message': f'技能 {safe_name} 创建成功',
            })

        except Exception as e:
            # 清理失败的目录
            if skills_dir.exists():
                shutil.rmtree(skills_dir, ignore_errors=True)
            self.send_error_json(f'Failed to create skill: {e}', 500)

    def handle_skill_toggle(self, data):
        """POST /skills/toggle - 启用/禁用技能 (修改 SKILL.md frontmatter 中的 enabled 字段)"""
        name = data.get('name', '').strip()
        enabled = data.get('enabled', True)

        if not name:
            self.send_error_json('Missing skill name', 400)
            return

        # 在所有技能目录中查找匹配的 SKILL.md
        skill_md_path = None
        search_dirs = []
        user_skills = self.clawd_path / 'skills'
        if user_skills.exists():
            search_dirs.append(user_skills)
        project_path = self.project_path or APP_DIR
        project_skills = project_path / 'skills'
        if project_skills.exists() and project_skills != user_skills:
            search_dirs.append(project_skills)

        for skills_dir in search_dirs:
            for candidate in skills_dir.rglob('SKILL.md'):
                fm = parse_skill_frontmatter(candidate)
                skill_name = fm.get('name', candidate.parent.name)
                if skill_name == name or skill_name_to_tool_name(skill_name) == skill_name_to_tool_name(name):
                    skill_md_path = candidate
                    break
            if skill_md_path:
                break

        if not skill_md_path:
            self.send_error_json(f'Skill "{name}" not found', 404)
            return

        try:
            content = skill_md_path.read_text(encoding='utf-8')
            match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', content, re.DOTALL)

            if match:
                fm_text = match.group(1)
                body = content[match.end():]

                # 更新或添加 enabled 字段
                if re.search(r'^enabled\s*:', fm_text, re.MULTILINE):
                    fm_text = re.sub(
                        r'^enabled\s*:.*$',
                        f'enabled: {str(enabled).lower()}',
                        fm_text,
                        flags=re.MULTILINE,
                    )
                else:
                    fm_text += f'\nenabled: {str(enabled).lower()}'

                new_content = f'---\n{fm_text}\n---\n{body}'
            else:
                # 无 frontmatter，创建一个
                new_content = f'---\nenabled: {str(enabled).lower()}\n---\n{content}'

            skill_md_path.write_text(new_content, encoding='utf-8')

            # 热重载: 重新扫描以反映 enabled 状态变化
            if self.registry:
                self.registry.plugin_tools.clear()
                self.registry.instruction_tools.clear()
                self.registry.scan_plugins()

            self.send_json({
                'status': 'success',
                'name': name,
                'enabled': enabled,
                'message': f'技能 {name} 已{"启用" if enabled else "禁用"}',
            })

        except Exception as e:
            self.send_error_json(f'Failed to toggle skill: {e}', 500)

    def _find_skill_md(self, name: str):
        """在所有技能目录中查找指定名称的 SKILL.md 路径"""
        search_dirs = []
        user_skills = self.clawd_path / 'skills'
        if user_skills.exists():
            search_dirs.append(user_skills)
        project_path = self.project_path or APP_DIR
        project_skills = project_path / 'skills'
        if project_skills.exists() and project_skills != user_skills:
            search_dirs.append(project_skills)

        for skills_dir in search_dirs:
            for candidate in skills_dir.rglob('SKILL.md'):
                fm = parse_skill_frontmatter(candidate)
                skill_name = fm.get('name', candidate.parent.name)
                if skill_name == name or skill_name_to_tool_name(skill_name) == skill_name_to_tool_name(name):
                    return candidate
        return None

    def _validate_skill_content(self, content: str) -> tuple:
        """对 SKILL.md 内容进行结构校验，返回 (诊断项列表, 综合分)"""
        diags = []

        # 解析 frontmatter
        fm = {}
        match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', content, re.DOTALL)
        body = content
        if match:
            if HAS_YAML:
                try:
                    fm = yaml.safe_load(match.group(1)) or {}
                except Exception:
                    fm = {}
            else:
                # 简单正则提取
                for line in match.group(1).split('\n'):
                    m2 = re.match(r'^(\w+)\s*:\s*(.+)$', line.strip())
                    if m2:
                        key, val = m2.group(1), m2.group(2).strip()
                        if val.startswith('[') and val.endswith(']'):
                            val = [v.strip().strip('"\'') for v in val[1:-1].split(',') if v.strip()]
                        fm[key] = val
            body = content[match.end():]

        desc = fm.get('description', '')
        diags.append({
            'field': 'description',
            'passed': bool(desc and len(str(desc)) > 20),
            'suggestion': '缺少 description 或描述过短（建议 > 20 字）' if not (desc and len(str(desc)) > 20) else 'OK',
            'weight': 0.25,
        })
        diags.append({
            'field': 'tags',
            'passed': bool(fm.get('tags')),
            'suggestion': '缺少 tags 分类标签' if not fm.get('tags') else 'OK',
            'weight': 0.10,
        })
        diags.append({
            'field': 'keywords',
            'passed': bool(fm.get('keywords') or fm.get('tags')),
            'suggestion': '缺少 keywords 语义触发关键词' if not (fm.get('keywords') or fm.get('tags')) else 'OK',
            'weight': 0.10,
        })
        diags.append({
            'field': 'version',
            'passed': bool(fm.get('version')),
            'suggestion': '缺少 version 字段' if not fm.get('version') else 'OK',
            'weight': 0.05,
        })
        diags.append({
            'field': 'dangerLevel',
            'passed': bool(fm.get('dangerLevel')),
            'suggestion': '缺少 dangerLevel 声明（safe/high/critical）' if not fm.get('dangerLevel') else 'OK',
            'weight': 0.05,
        })

        # requires.env 一致性: 内容提到 API/token 但没声明
        full_text = (str(desc) + ' ' + body).lower()
        mentions_api = bool(re.search(r'\bapi[_\s-]?key\b|\btoken\b|\bsecret\b', full_text))
        has_env = bool(fm.get('requires', {}).get('env') if isinstance(fm.get('requires'), dict) else False)
        diags.append({
            'field': 'requires.env',
            'passed': not mentions_api or has_env,
            'suggestion': '内容提到 API/token 依赖但未在 requires.env 中声明' if (mentions_api and not has_env) else 'OK',
            'weight': 0.10,
        })

        diags.append({
            'field': 'inputs',
            'passed': bool(fm.get('inputs')),
            'suggestion': '缺少 inputs 参数定义' if not fm.get('inputs') else 'OK',
            'weight': 0.15,
        })

        # 计算综合分
        base = 0.20
        for d in diags:
            if d['passed']:
                base += d['weight']
        score = min(int(base * 100), 100)

        return diags, score

    def handle_skill_validate(self, data):
        """POST /skills/validate - 结构校验技能"""
        name = data.get('name', '').strip()
        if not name:
            self.send_error_json('Missing skill name', 400)
            return

        skill_md_path = self._find_skill_md(name)
        if not skill_md_path:
            self.send_error_json(f'Skill "{name}" not found', 404)
            return

        try:
            content = skill_md_path.read_text(encoding='utf-8')
            diags, score = self._validate_skill_content(content)
            failed_items = [d for d in diags if not d['passed']]

            self.send_json({
                'status': 'success',
                'name': name,
                'score': score,
                'diagnostics': diags,
                'failedCount': len(failed_items),
                'suggestions': [d['suggestion'] for d in failed_items],
            })
        except Exception as e:
            self.send_error_json(f'Validation failed: {e}', 500)

    def handle_skill_edit(self, data):
        """POST /skills/edit - 保存编辑后的 SKILL.md 内容（前端负责 LLM 调用）"""
        name = data.get('name', '').strip()
        new_content = data.get('content', '').strip()

        if not name:
            self.send_error_json('Missing skill name', 400)
            return
        if not new_content:
            self.send_error_json('Missing content', 400)
            return

        skill_md_path = self._find_skill_md(name)
        if not skill_md_path:
            self.send_error_json(f'Skill "{name}" not found', 404)
            return

        try:
            # 读取旧内容计算旧分
            old_content = skill_md_path.read_text(encoding='utf-8')
            _, score_before = self._validate_skill_content(old_content)

            # 校验新内容
            diags_after, score_after = self._validate_skill_content(new_content)
            failed_items = [d for d in diags_after if not d['passed']]

            # 写入新内容
            skill_md_path.write_text(new_content, encoding='utf-8')

            # 热重载
            if self.registry:
                self.registry.plugin_tools.clear()
                self.registry.instruction_tools.clear()
                self.registry.scan_plugins()

            self.send_json({
                'status': 'success',
                'name': name,
                'message': f'技能 {name} 已更新',
                'scoreBefore': score_before,
                'scoreAfter': score_after,
                'diagnostics': diags_after,
                'remainingIssues': len(failed_items),
            })
        except Exception as e:
            self.send_error_json(f'Edit failed: {e}', 500)

    def handle_skill_optimize(self, data):
        """POST /skills/optimize - 返回当前 SKILL.md 内容 + 诊断 + 优化提示词（前端调 LLM 后回传 /skills/edit）"""
        name = data.get('name', '').strip()

        if not name:
            self.send_error_json('Missing skill name', 400)
            return

        skill_md_path = self._find_skill_md(name)
        if not skill_md_path:
            self.send_error_json(f'Skill "{name}" not found', 404)
            return

        try:
            content = skill_md_path.read_text(encoding='utf-8')
            diags, score = self._validate_skill_content(content)
            failed_items = [d for d in diags if not d['passed']]

            if not failed_items:
                self.send_json({
                    'status': 'success',
                    'name': name,
                    'score': score,
                    'alreadyOptimal': True,
                    'message': '技能质量已达标，无需优化',
                })
                return

            # 构建优化提示词
            fix_instructions = []
            for d in failed_items:
                fix_instructions.append(f'- {d["field"]}: {d["suggestion"]}')

            optimize_prompt = (
                '你是一个技能文件（SKILL.md）优化专家。请根据以下诊断结果修复 SKILL.md 的内容。\n\n'
                '## 诊断结果（需要修复的问题）:\n'
                + '\n'.join(fix_instructions) + '\n\n'
                '## 修复规则:\n'
                '1. 只修复上述诊断列出的问题，不要改变技能的核心逻辑和指令内容\n'
                '2. 保持 YAML frontmatter 格式正确\n'
                '3. 如果需要添加 requires.env，从内容中推断需要的环境变量名\n'
                '4. 如果需要添加 tags/keywords，从描述和内容中推断合适的标签\n'
                '5. 如果 description 过短，基于现有内容扩写，包含使用场景\n'
                '6. 直接返回完整的修改后的 SKILL.md 内容，不要包含任何解释\n\n'
                '## 当前 SKILL.md 内容:\n'
                '```\n' + content + '\n```\n\n'
                '请直接返回修复后的完整 SKILL.md 内容（不要用 markdown 代码块包裹）:'
            )

            self.send_json({
                'status': 'success',
                'name': name,
                'score': score,
                'alreadyOptimal': False,
                'content': content,
                'diagnostics': diags,
                'failedCount': len(failed_items),
                'optimizePrompt': optimize_prompt,
            })
        except Exception as e:
            self.send_error_json(f'Optimize analysis failed: {e}', 500)


