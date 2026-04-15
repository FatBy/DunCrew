"""DunCrew Server - Tool Execution Engine + Builtin Tools Mixin"""
from __future__ import annotations

import os
import re
import json
import time
import shlex
import shutil
import subprocess
import threading
from pathlib import Path
from datetime import datetime

from server.constants import (
    DANGEROUS_COMMANDS, DANGEROUS_SHELL_PATTERNS,
    MAX_FILE_SIZE, MAX_OUTPUT_SIZE, PLUGIN_TIMEOUT,
)
from server.state import _db_lock
from server.utils import safe_utf8_truncate

class ToolsMixin:
    """Tool Execution Engine + Builtin Tools Mixin"""

    # ============================================
    # 🛠️ 工具执行 (核心新功能)
    # ============================================
    
    # ---- Layer 1: 前置检查 ----
    
    def _precheck_tool_args(self, tool_name: str, args: dict) -> tuple:
        """Layer 1: 执行前参数校验，返回 (is_valid, error_message)"""
        
        if tool_name in ('writeFile', 'appendFile'):
            path = args.get('path', '')
            content = args.get('content', '')
            if not path:
                return False, f"{tool_name} 缺少 path 参数"
            if not content and content != '':
                return False, f"{tool_name} 缺少 content 参数"
        
        elif tool_name == 'readFile':
            path = args.get('path', '')
            if not path:
                return False, "readFile 缺少 path 参数"
            try:
                # 读操作默认允许绝对路径（安全的只读操作）
                file_path = self._resolve_path(path, allow_outside=True)
                if not file_path.exists():
                    return False, f"文件不存在: {path}。建议: 先用 listDir 确认路径"
                if not file_path.is_file():
                    return False, f"路径不是文件: {path}。建议: 使用 listDir 查看目录内容"
                if file_path.stat().st_size > MAX_FILE_SIZE:
                    return False, f"文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB): {path}"
            except PermissionError:
                return False, f"路径越权: {path}。只允许访问工作目录内的文件"
            except ValueError as e:
                return False, str(e)
        
        elif tool_name == 'runCmd':
            command = args.get('command', '')
            if not command:
                return False, "runCmd 缺少 command 参数"
        
        elif tool_name == 'listDir':
            # listDir 允许空 path (默认 .)，无需校验
            pass
        
        elif tool_name == 'generateSkill':
            name = args.get('name', '')
            python_code = args.get('pythonCode', '')
            if not name:
                return False, "generateSkill 缺少 name 参数"
            if not python_code:
                return False, "generateSkill 缺少 pythonCode 参数"
            if 'def main(' not in python_code and 'async def main(' not in python_code:
                return False, "pythonCode 必须包含 main() 函数入口"
        
        elif tool_name == 'parseFile':
            fp = args.get('filePath') or args.get('path', '')
            if not fp:
                return False, "parseFile 缺少 filePath 参数"
        
        return True, ''
    
    # ---- Layer 2: 错误分类 ----
    
    def _classify_error(self, exception: Exception) -> str:
        """Layer 2: 错误类型分类"""
        if isinstance(exception, (UnicodeDecodeError, UnicodeEncodeError)):
            return 'encoding'
        if isinstance(exception, subprocess.TimeoutExpired):
            return 'timeout'
        if isinstance(exception, PermissionError):
            return 'permission'
        if isinstance(exception, (FileNotFoundError, NotADirectoryError)):
            return 'path'
        error_msg = str(exception).lower()
        if 'codec' in error_msg or 'encode' in error_msg or 'decode' in error_msg:
            return 'encoding'
        if 'timeout' in error_msg or 'timed out' in error_msg:
            return 'timeout'
        if 'permission' in error_msg or 'denied' in error_msg:
            return 'permission'
        if 'not found' in error_msg or 'no such file' in error_msg:
            return 'path'
        return 'unknown'
    
    _ERROR_SUGGESTIONS = {
        'encoding': '建议: 检查文件编码是否为 UTF-8，或命令输出是否包含特殊字符',
        'timeout': '建议: 增加 timeout 参数值，或简化命令/操作',
        'permission': '建议: 检查路径权限，避免访问系统目录',
        'path': '建议: 先用 listDir 确认路径存在，检查拼写是否正确',
    }
    
    # ---- Layer 3: 结果验证 ----
    
    def _verify_tool_result(self, tool_name: str, args: dict, result: str, status: str) -> dict:
        """Layer 3: 工具结果的代码验证"""
        if status == 'error':
            return {'verified': False, 'checks': [], 'confidence': 0.0}
        
        checks = []
        
        if tool_name == 'writeFile':
            path = args.get('path', '')
            content = args.get('content', '')
            try:
                file_path = self._resolve_path(path, allow_outside=True)
                # Check 1: 文件存在性
                exists = file_path.exists()
                checks.append({
                    'name': '文件存在性',
                    'passed': exists,
                    'details': f'{file_path.name} {"存在" if exists else "不存在"}'
                })
                if exists:
                    # Check 2: 大小匹配
                    actual_size = file_path.stat().st_size
                    expected_size = len(content.encode('utf-8'))
                    size_match = abs(actual_size - expected_size) <= 10  # 允许微小差异
                    checks.append({
                        'name': '大小匹配',
                        'passed': size_match,
                        'details': f'实际 {actual_size}B vs 预期 {expected_size}B'
                    })
            except Exception:
                checks.append({'name': '验证异常', 'passed': False, 'details': '验证过程出错'})
        
        elif tool_name == 'generateSkill':
            name = args.get('name', '')
            dun_id = args.get('dunId') or args.get('nexusId', '')
            safe_name = re.sub(r'[^\w-]', '-', name.lower()).strip('-')
            safe_name = re.sub(r'-+', '-', safe_name)
            
            if dun_id:
                skill_dir = self.clawd_path / 'nexuses' / dun_id / 'skills' / safe_name
            else:
                skill_dir = self.clawd_path / 'skills' / safe_name
            
            # Check 1: SKILL.md 存在
            skill_md = skill_dir / 'SKILL.md'
            checks.append({
                'name': 'SKILL.md 存在',
                'passed': skill_md.exists(),
                'details': f'{skill_md.name} {"已创建" if skill_md.exists() else "未找到"}'
            })
            # Check 2: Python 文件存在
            py_file = skill_dir / f'{safe_name}.py'
            checks.append({
                'name': 'Python 文件存在',
                'passed': py_file.exists(),
                'details': f'{py_file.name} {"已创建" if py_file.exists() else "未找到"}'
            })
        
        elif tool_name == 'runCmd':
            # Check: 输出中是否有替代字符 (编码问题指标)
            replace_count = result.count('\ufffd')
            total_chars = max(len(result), 1)
            replace_ratio = replace_count / total_chars
            encoding_ok = replace_ratio < 0.05
            checks.append({
                'name': '输出编码质量',
                'passed': encoding_ok,
                'details': f'替代字符占比 {replace_ratio:.1%}' if not encoding_ok else '编码正常'
            })
        
        elif tool_name == 'readFile':
            # Check: 返回内容非空
            has_content = bool(result and result.strip())
            checks.append({
                'name': '内容非空',
                'passed': has_content,
                'details': f'{len(result)} 字符' if has_content else '文件内容为空'
            })
        
        elif tool_name == 'appendFile':
            path = args.get('path', '')
            try:
                file_path = self._resolve_path(path, allow_outside=True)
                exists = file_path.exists()
                checks.append({
                    'name': '文件存在性',
                    'passed': exists,
                    'details': f'{file_path.name} {"存在" if exists else "不存在"}'
                })
            except Exception:
                checks.append({'name': '验证异常', 'passed': False, 'details': '验证过程出错'})
        
        # 计算 confidence
        if not checks:
            return {'verified': True, 'checks': [], 'confidence': 0.95}
        
        passed_count = sum(1 for c in checks if c['passed'])
        confidence = passed_count / len(checks)
        
        return {
            'verified': all(c['passed'] for c in checks),
            'checks': checks,
            'confidence': round(confidence, 2)
        }
    
    # ---- 工具执行主入口 ----
    
    def handle_tool_execution(self, data):
        """处理工具调用请求 - 支持内置工具、插件工具、指令型工具和MCP工具"""
        tool_name = data.get('name', '')
        args = data.get('args', {})

        if not self.registry.is_registered(tool_name):
            all_tools = [t['name'] for t in self.registry.list_all()]
            self.send_json({
                'tool': tool_name,
                'status': 'error',
                'result': f'Tool not registered: {tool_name}. Available: {", ".join(all_tools)}'
            }, 403)
            return

        # Layer 1: 前置检查
        is_valid, precheck_error = self._precheck_tool_args(tool_name, args)
        if not is_valid:
            self.send_json({
                'tool': tool_name,
                'status': 'error',
                'result': f'[前置检查失败] {precheck_error}',
                'error_type': 'precheck_failure',
                'timestamp': datetime.now().isoformat()
            })
            return

        result = ""
        status = "success"
        error_type = None
        start_time = time.time()

        try:
            # 1. 指令型工具 -> 路由到 skill-executor
            instruction_spec = self.registry.get_instruction(tool_name)
            if instruction_spec:
                result = self._execute_instruction_tool(instruction_spec, tool_name, args)
            # 2. 插件工具 -> subprocess 执行
            elif self.registry.get_plugin(tool_name):
                plugin_spec = self.registry.get_plugin(tool_name)
                result = self._execute_plugin_tool(plugin_spec, tool_name, args)
            # 3. MCP 工具 -> 通过 MCPManager 调用
            elif self.registry.get_mcp_tool(tool_name):
                result = self._execute_mcp_tool(tool_name, args)
            # 4. 内置工具 -> 直接调度
            else:
                builtin_handlers = {
                    'readFile': self._tool_read_file,
                    'writeFile': self._tool_write_file,
                    'appendFile': self._tool_append_file,
                    'listDir': self._tool_list_dir,
                    'runCmd': self._tool_run_cmd,
                    'weather': self._tool_weather,
                    'webSearch': self._tool_web_search,
                    'webFetch': self._tool_web_fetch,
                    'saveMemory': self._tool_save_memory,
                    'searchMemory': self._tool_search_memory,
                    'dunBindSkill': self._tool_dun_bind_skill,
                    'dunUnbindSkill': self._tool_dun_unbind_skill,
                    'openInExplorer': self._tool_open_in_explorer,
                    'parseFile': self._tool_parse_file,
                    'generateSkill': self._tool_generate_skill,
                    'browser_navigate': self._tool_browser_navigate,
                    'browser_click': self._tool_browser_click,
                    'browser_fill': self._tool_browser_fill,
                    'browser_extract': self._tool_browser_extract,
                    'browser_screenshot': self._tool_browser_screenshot,
                    'browser_evaluate': self._tool_browser_evaluate,
                    'screenCapture': self._tool_screen_capture,
                    'ocrExtract': self._tool_ocr_extract,
                }
                handler = builtin_handlers.get(tool_name)
                if handler:
                    result = handler(args)
                else:
                    raise ValueError(f"No handler for builtin tool: {tool_name}")

        except Exception as e:
            status = "error"
            # Layer 2: 错误分类 + 增强信息
            error_type = self._classify_error(e)
            result = f"Tool execution failed: {str(e)}"
            suggestion = self._ERROR_SUGGESTIONS.get(error_type)
            if suggestion:
                result += f'\n{suggestion}'

        execution_time_ms = int((time.time() - start_time) * 1000)

        # Layer 3: 结果验证
        verification = self._verify_tool_result(tool_name, args, result, status)

        response = {
            'tool': tool_name,
            'status': status,
            'result': result,
            'timestamp': datetime.now().isoformat(),
            'verification': verification,
            'execution_time_ms': execution_time_ms,
        }
        if error_type:
            response['error_type'] = error_type

        self.send_json(response)


    def _execute_plugin_tool(self, spec: dict, tool_name: str, args: dict) -> str:
        """执行插件工具 - subprocess 隔离执行"""
        exe_path = spec['exe_path']
        runtime = spec.get('runtime', 'python')

        # 确定运行时命令
        if runtime == 'python':
            cmd = [sys.executable, exe_path]
        elif runtime == 'node':
            cmd = ['node', exe_path]
        else:
            raise ValueError(f"Unsupported runtime: {runtime}")

        # 构建输入：包含工具名和参数（支持多工具 manifest）
        input_data = json.dumps({
            'tool': tool_name,
            'args': args
        }, ensure_ascii=False)

        try:
            process = subprocess.run(
                cmd,
                input=input_data,
                capture_output=True,
                text=True,
                timeout=PLUGIN_TIMEOUT,
                cwd=spec.get('skill_dir', str(self.clawd_path)),
            )

            if process.returncode != 0:
                stderr = process.stderr[:MAX_OUTPUT_SIZE] if process.stderr else ''
                raise RuntimeError(f"Plugin exited with code {process.returncode}: {stderr}")

            return process.stdout[:MAX_OUTPUT_SIZE] if process.stdout else ''

        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Plugin timed out after {PLUGIN_TIMEOUT}s")

    def _execute_instruction_tool(self, spec: dict, tool_name: str, args: dict) -> str:
        """执行指令型工具 - 通过 skill-executor 解析 SKILL.md 并返回指令"""
        skill_executor = self.clawd_path / 'skills' / 'skill-executor' / 'execute.py'

        if not skill_executor.exists():
            raise RuntimeError(f"skill-executor not found at {skill_executor}")

        # 使用 original_name (kebab-case) 让 SkillDiscovery 能找到目录
        original_name = spec.get('original_name', tool_name)

        input_data = json.dumps({
            'tool': 'run_skill',
            'args': {
                'skill_name': original_name,
                'args': args,
                'project_root': str(self.clawd_path),
            }
        }, ensure_ascii=False)

        try:
            process = subprocess.run(
                [sys.executable, str(skill_executor)],
                input=input_data,
                capture_output=True,
                text=True,
                timeout=PLUGIN_TIMEOUT,
                cwd=str(skill_executor.parent),
            )

            if process.returncode != 0:
                stderr = process.stderr[:MAX_OUTPUT_SIZE] if process.stderr else ''
                raise RuntimeError(f"Instruction skill error: {stderr}")

            result = json.loads(process.stdout)
            if not result.get('success'):
                raise RuntimeError(result.get('error', 'Unknown error'))

            return result.get('instructions', result.get('output', ''))

        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Instruction skill timed out after {PLUGIN_TIMEOUT}s")
        except json.JSONDecodeError:
            # skill-executor 返回非 JSON 时，直接返回原文
            return process.stdout[:MAX_OUTPUT_SIZE] if process.stdout else ''

    def _execute_mcp_tool(self, tool_name: str, args: dict) -> str:
        """执行 MCP 工具 - 通过 MCPManager 调用远程 MCP 服务器"""
        if not self.registry.mcp_manager:
            raise RuntimeError("MCP manager not initialized")

        try:
            result = self.registry.mcp_manager.call_tool(tool_name, args, timeout=PLUGIN_TIMEOUT)
            if result is None:
                return json.dumps({"status": "error", "error": f"MCP tool '{tool_name}' returned no result (possible silent failure)"})
            return str(result)
        except Exception as e:
            raise RuntimeError(f"MCP tool execution failed: {e}")
    
    def _resolve_path(self, relative_path: str, allow_outside: bool = False) -> Path:
        """解析并验证路径安全性"""
        if not relative_path:
            raise ValueError("Path cannot be empty")
        
        # 移除开头的斜杠
        clean_path = relative_path.lstrip('/')
        
        # 默认在 clawd 目录下操作
        if allow_outside and os.path.isabs(relative_path):
            file_path = Path(relative_path)
        else:
            file_path = self.clawd_path / clean_path
        
        # 安全检查：防止路径遍历
        try:
            resolved = file_path.resolve()
            if not allow_outside:
                resolved.relative_to(self.clawd_path.resolve())
        except ValueError:
            raise PermissionError(f"Access denied: path outside allowed directory")
        
        return resolved
    
    def _tool_read_file(self, args: dict) -> str:
        """读取文件内容"""
        path = args.get('path', '')
        
        # 读操作默认允许绝对路径（安全的只读操作）
        file_path = self._resolve_path(path, allow_outside=True)
        
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        if not file_path.is_file():
            raise ValueError(f"Not a file: {path}")
        if file_path.stat().st_size > MAX_FILE_SIZE:
            raise ValueError(f"File too large (>{MAX_FILE_SIZE} bytes)")
        
        try:
            return file_path.read_text(encoding='utf-8')
        except UnicodeDecodeError:
            content = file_path.read_text(encoding='utf-8', errors='replace')
            return f"[注意: 文件包含非UTF-8字符，已用替代字符显示]\n{content}"
    

    def _tool_write_file(self, args: dict) -> str:
        """写入文件"""
        path = args.get('path', '')
        content = args.get('content', '')
        dun_id = args.get('dunId') or args.get('nexusId', '')
        
        # Dun 产出物自动路由：
        # 如果有活跃 dunId，且 path 不是绝对路径，且不在 duns/ 或 nexuses/ 目录下，
        # 则自动路由到 duns/{dun-id}/output/{原始路径}
        if dun_id and not os.path.isabs(path):
            normalized = path.replace('\\', '/')
            if not normalized.startswith('duns/') and not normalized.startswith('nexuses/'):
                path = f'duns/{dun_id}/output/{path}'
        
        file_path = self._resolve_path(path, allow_outside=True)
        
        # === Dun 涌现去重网关 ===
        _is_dun_def = (('duns/' in path or 'nexuses/' in path)
                       and (path.endswith('DUN.md') or path.endswith('NEXUS.md')))
        if _is_dun_def:
            # 仅在文件不存在时（即新建操作）进行去重检查
            if not file_path.exists():
                duplicate_id = self._check_dun_duplication(content)
                if duplicate_id:
                    return (f"【系统拦截】创建失败！\n"
                            f"检测到高度相似的 Dun 节点已存在 (节点 ID: {duplicate_id})。\n"
                            f"为避免知识图谱碎片化，请不要创建新目录，请直接使用 'readFile' 和 'writeFile' "
                            f"读取并更新原有的 duns/{duplicate_id}/DUN.md，或者向其追加 experience。")
        
        # === Dun 格式引导 ===
        # 检测写入 duns/ 或 nexuses/ 目录但不是 DUN.md/NEXUS.md 的情况，提供格式纠正提示
        # 白名单：SOP Evolution 系统文件允许直接写入
        DUN_SYSTEM_FILES = {
            'sop-fitness.json', 'golden-path.json', 'golden-path-summary.json',
            'xp.json', 'sop-history.json',
        }
        _in_dun_dir = 'duns/' in path or 'nexuses/' in path
        _is_dun_md = path.endswith('DUN.md') or path.endswith('NEXUS.md')
        if _in_dun_dir and not _is_dun_md:
            file_basename = os.path.basename(path)
            # 系统文件 或 experience/skills 子目录下的文件，跳过格式引导
            if file_basename not in DUN_SYSTEM_FILES and '/experience/' not in path and '/skills/' not in path:
                # 提取可能的 dun id
                import re
                dun_match = re.search(r'(?:duns|nexuses)/([^/]+)', path)
                dun_id = dun_match.group(1) if dun_match else 'your-dun-id'
                
                # 如果是写入 .json 或其他配置文件，返回警告并引导正确格式
                if path.endswith('.json') or (path.endswith('.md') and 'DUN.md' not in path and 'NEXUS.md' not in path):
                    return (f"【格式提示】检测到你正在向 duns/ 目录写入非标准文件。\n\n"
                            f"⚠️ Dun 只能通过 DUN.md 文件定义，系统不会识别 .json 或其他 .md 文件！\n\n"
                            f"📝 正确做法：请创建 duns/{dun_id}/DUN.md 文件，格式如下：\n"
                            f"```markdown\n"
                            f"---\n"
                            f"name: Dun名称\n"
                            f"description: 功能描述\n"
                            f"version: 1.0.0\n"
                            f"skill_dependencies:\n"
                            f"  - 技能ID\n"
                            f"tags:\n"
                            f"  - 标签\n"
                            f"triggers:\n"
                            f"  - 触发词\n"
                            f"objective: 核心目标\n"
                            f"metrics:\n"
                            f"  - 质量指标\n"
                            f"strategy: 执行策略\n"
                            f"---\n\n"
                            f"# Dun名称 SOP\n\n"
                            f"（详细的标准作业程序）\n"
                            f"```\n\n"
                            f"请使用正确格式重新创建 duns/{dun_id}/DUN.md")
        
        # 确保父目录存在
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        file_path.write_text(content, encoding='utf-8')
        
        # 返回结构化数据，包含完整路径以便前端快速访问
        return json.dumps({
            'action': 'file_created',
            'message': f'已成功写入 {len(content)} 字节',
            'fileName': file_path.name,
            'filePath': str(file_path.resolve()),
            'fileSize': len(content),
        }, ensure_ascii=False)
    
    def _tool_open_in_explorer(self, args: dict) -> str:
        """在文件管理器中打开指定路径并高亮文件"""
        path = args.get('path', '')
        if not path:
            raise ValueError("路径参数不能为空")
        
        mode = args.get('mode', 'reveal')  # 'reveal' = 高亮文件, 'open' = 用默认应用打开
        file_path = Path(path)
        if not file_path.exists():
            raise FileNotFoundError(f"文件不存在: {path}")
        
        import platform
        import subprocess
        system = platform.system()
        
        try:
            if mode == 'open':
                # 用默认应用打开文件
                if system == 'Windows':
                    os.startfile(str(file_path.resolve()))
                elif system == 'Darwin':
                    subprocess.run(['open', str(file_path.resolve())], check=True)
                else:
                    subprocess.run(['xdg-open', str(file_path.resolve())], check=True)
                return f"已打开文件: {file_path.name}"
            else:
                # reveal: 在文件管理器中高亮文件
                if system == 'Windows':
                    subprocess.run(['explorer', '/select,', str(file_path.resolve())], check=False)
                elif system == 'Darwin':
                    subprocess.run(['open', '-R', str(file_path.resolve())], check=True)
                else:
                    subprocess.run(['xdg-open', str(file_path.parent.resolve())], check=True)
                return f"已在文件管理器中打开: {file_path.name}"
        except Exception as e:
            raise RuntimeError(f"无法打开文件管理器: {str(e)}")
    
    def _check_dun_duplication(self, new_content: str) -> str | None:
        """检查新建的 Dun 是否与现存 Dun 重复，返回重复的 Dun ID"""
        # 1. 提取新 Dun 的 frontmatter
        match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', new_content, re.DOTALL)
        if not match:
            return None
        
        new_meta = {}
        if HAS_YAML:
            try:
                new_meta = yaml.safe_load(match.group(1)) or {}
            except Exception:
                pass
        else:
            for line in match.group(1).split('\n'):
                m = re.match(r'^(\w+)\s*:\s*(.+)$', line.strip())
                if m:
                    new_meta[m.group(1)] = m.group(2).strip()
        
        new_name = str(new_meta.get('name', ''))
        new_desc = str(new_meta.get('description', ''))
        if not new_name and not new_desc:
            return None
        
        new_text = f"{new_name} {new_desc}"
        
        # 2. 遍历现有 Dun 进行对比
        nexuses_dir = self.clawd_path / 'nexuses'
        if not nexuses_dir.exists():
            return None
        
        best_match = None
        highest_score = 0.0
        
        for dun_md in nexuses_dir.rglob('NEXUS.md'):
            existing_meta = parse_dun_frontmatter(dun_md)
            ext_name = str(existing_meta.get('name', ''))
            ext_desc = str(existing_meta.get('description', ''))
            
            ext_text = f"{ext_name} {ext_desc}"
            score = calculate_text_similarity(new_text, ext_text)
            
            if score > highest_score:
                highest_score = score
                best_match = dun_md.parent.name
        
        # 阈值：超过 55% 的特征重合即判定为重复
        if highest_score >= 0.55:
            return best_match
        
        return None
    
    def _tool_append_file(self, args: dict) -> str:
        """追加内容到文件"""
        path = args.get('path', '')
        content = args.get('content', '')
        dun_id = args.get('dunId') or args.get('nexusId', '')
        
        # Dun 产出物自动路由
        if dun_id and not os.path.isabs(path):
            normalized = path.replace('\\', '/')
            if not normalized.startswith('duns/') and not normalized.startswith('nexuses/'):
                path = f'duns/{dun_id}/output/{path}'
        
        file_path = self._resolve_path(path, allow_outside=True)
        file_path.parent.mkdir(parents=True, exist_ok=True)
        
        with open(file_path, 'a', encoding='utf-8') as f:
            f.write(content)
        
        return f"Appended {len(content)} bytes to {file_path.name}"
    
    def _tool_list_dir(self, args: dict) -> str:
        """列出目录内容"""
        path = args.get('path', '.')
        # 目录列出也是只读操作，允许绝对路径
        dir_path = self._resolve_path(path, allow_outside=True)
        
        if not dir_path.exists():
            raise FileNotFoundError(f"Directory not found: {path}")
        if not dir_path.is_dir():
            raise ValueError(f"Not a directory: {path}")
        
        items = []
        for item in sorted(dir_path.iterdir()):
            item_type = 'dir' if item.is_dir() else 'file'
            size = item.stat().st_size if item.is_file() else 0
            items.append({
                'name': item.name,
                'type': item_type,
                'size': size
            })
        
        return json.dumps(items, ensure_ascii=False)
    
    def _tool_run_cmd(self, args: dict) -> str:
        """执行 Shell 命令 (⚠️ 高危操作)"""
        command = args.get('command', '')
        cwd = args.get('cwd', str(self.clawd_path))
        timeout = min(args.get('timeout', 60), 300)  # 最大 5 分钟
        
        if not command:
            raise ValueError("Command cannot be empty")
        
        # 安全检查
        cmd_lower = command.lower().strip()
        for dangerous in DANGEROUS_COMMANDS:
            if dangerous in cmd_lower:
                raise PermissionError(f"Dangerous command blocked: {command}")
        
        # 检查危险 shell 模式（防止通过 shell 元字符绕过黑名单）
        for pattern in DANGEROUS_SHELL_PATTERNS:
            if pattern in cmd_lower:
                raise PermissionError(f"Dangerous shell pattern blocked: {command}")
        
        try:
            process = subprocess.run(
                command,
                shell=True,
                cwd=cwd,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=timeout
            )
            
            stdout = safe_utf8_truncate(process.stdout, MAX_OUTPUT_SIZE) if process.stdout else ''
            stderr = safe_utf8_truncate(process.stderr, MAX_OUTPUT_SIZE) if process.stderr else ''
            
            result_parts = []
            if stdout:
                result_parts.append(f"STDOUT:\n{stdout}")
            if stderr:
                result_parts.append(f"STDERR:\n{stderr}")
            
            rc = process.returncode
            if rc == 0:
                result_parts.append(f"Exit Code: 0 (成功)")
            else:
                # 提供常见 exit code 的可读解释
                code_hints = {
                    1: "通用错误",
                    2: "参数错误或命令误用",
                    3: "URL 格式错误 (curl)",
                    6: "无法解析主机名 (DNS 失败)",
                    7: "无法连接到服务器",
                    28: "操作超时",
                    35: "SSL/TLS 连接错误",
                    56: "网络数据接收失败",
                    60: "SSL 证书验证失败",
                    127: "命令未找到",
                    128: "无效的退出参数",
                }
                hint = code_hints.get(rc, "未知错误")
                result_parts.append(f"Exit Code: {rc} ({hint})")
                # 当没有任何输出时，补充提示帮助 LLM 理解错误
                if not stdout and not stderr:
                    result_parts.append(f"注意: 命令 '{command[:80]}' 执行失败且无输出。建议换用其他工具或方式完成任务。")
            
            return '\n'.join(result_parts)
        
        except subprocess.TimeoutExpired:
            return f"Command timed out after {timeout}s"
    
    def _tool_weather(self, args: dict) -> str:
        """查询天气 (基于 OpenClaw weather skill)"""
        import urllib.request
        import urllib.parse
        
        location = args.get('location', args.get('city', ''))
        if not location:
            raise ValueError("Location/city is required")
        
        # 使用 wttr.in API (无需 API Key)
        encoded_location = urllib.parse.quote(location)
        
        try:
            # 获取详细天气信息
            url = f"https://wttr.in/{encoded_location}?format=j1"
            req = urllib.request.Request(url, headers={'User-Agent': 'curl/7.68.0'})
            
            with urllib.request.urlopen(req, timeout=10) as response:
                data = json.loads(response.read().decode('utf-8'))
            
            current = data.get('current_condition', [{}])[0]
            area = data.get('nearest_area', [{}])[0]
            
            # 格式化输出
            city_name = area.get('areaName', [{}])[0].get('value', location)
            country = area.get('country', [{}])[0].get('value', '')
            
            result = f"""天气查询结果 - {city_name}, {country}

当前温度: {current.get('temp_C', 'N/A')}°C (体感: {current.get('FeelsLikeC', 'N/A')}°C)
天气状况: {current.get('weatherDesc', [{}])[0].get('value', 'N/A')}
湿度: {current.get('humidity', 'N/A')}%
风速: {current.get('windspeedKmph', 'N/A')} km/h ({current.get('winddir16Point', '')})
能见度: {current.get('visibility', 'N/A')} km
紫外线指数: {current.get('uvIndex', 'N/A')}
"""
            return result
            
        except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, json.JSONDecodeError, OSError) as e:
            # 降级方案：使用简单格式
            try:
                simple_url = f"https://wttr.in/{encoded_location}?format=%l:+%c+%t+(%f)+%h+%w"
                req = urllib.request.Request(simple_url, headers={'User-Agent': 'curl/7.68.0'})
                with urllib.request.urlopen(req, timeout=10) as response:
                    return response.read().decode('utf-8')
            except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, OSError):
                return f"无法查询 {location} 的天气: {str(e)}"
    

