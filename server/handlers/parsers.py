"""DunCrew Server - File Upload + Parsers Mixin (18+ formats)"""
from __future__ import annotations

import os
import re
import sys
import json
import base64
import io
import csv as csv_module
import unicodedata
import platform
from pathlib import Path
from datetime import datetime

from server.constants import (
    HAS_PDF, HAS_DOCX, HAS_PPTX, HAS_OCR, HAS_XLSX, HAS_BS4,
    HAS_EPUB, HAS_RTF, HAS_COM, HAS_XLRD, HAS_CHARSET, HAS_YAML,
    MAX_FILE_SIZE,
)

class ParsersMixin:
    """File Upload + Parsers Mixin (18+ formats)"""

    # ============================================
    # 📎 文件上传 + 自动解析
    # ============================================

    UPLOAD_ALLOWED_EXT = {
        # 文档
        '.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.csv',
        '.txt', '.md', '.rtf', '.epub', '.odt',
        # 图像
        '.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp', '.gif', '.svg',
        # 结构化数据
        '.json', '.yaml', '.yml', '.xml', '.toml',
        # 网页
        '.html', '.htm',
        # 代码 (常见)
        '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
        '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.kt', '.scala', '.lua',
        '.sh', '.bat', '.ps1', '.sql', '.r', '.m', '.vue', '.svelte',
        # 配置
        '.ini', '.cfg', '.conf', '.env', '.properties', '.gitignore', '.dockerignore',
        # 日志
        '.log',
    }

    def handle_file_upload_multipart(self):
        """接收 FormData multipart 上传，保存并自动解析
        
        使用手动 multipart boundary 解析，不依赖已废弃的 cgi.FieldStorage
        （cgi 在 Python 3.11+ deprecated，3.13 removed）
        """
        content_type = self.headers.get('Content-Type', '')
        content_length = int(self.headers.get('Content-Length', 0))

        if content_length > MAX_FILE_SIZE:
            # 消耗请求体避免连接异常
            remaining = content_length
            while remaining > 0:
                chunk = min(remaining, 65536)
                self.rfile.read(chunk)
                remaining -= chunk
            self.send_error_json(f'文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)', 413)
            return

        # 从 Content-Type 提取 boundary
        boundary = None
        for part in content_type.split(';'):
            part = part.strip()
            if part.startswith('boundary='):
                boundary = part[len('boundary='):].strip('"')
        if not boundary:
            self.send_error_json('无效的 multipart 请求：缺少 boundary', 400)
            return

        # 读取整个请求体（已验证 content_length <= 10MB，内存安全）
        try:
            raw_body = self.rfile.read(content_length)
        except Exception as e:
            print(f"[ERROR] 读取请求体失败: {e}", file=sys.stderr)
            self.send_error_json('读取上传数据失败', 400)
            return

        # 按 boundary 分割，提取包含 filename 的 part
        boundary_bytes = ('--' + boundary).encode()
        parts = raw_body.split(boundary_bytes)

        file_bytes = None
        file_name = 'unknown'
        for part_data in parts:
            if b'filename=' not in part_data:
                continue
            # headers 和 body 以空行 (\r\n\r\n) 分隔
            header_end = part_data.find(b'\r\n\r\n')
            if header_end == -1:
                continue
            headers_raw_bytes = part_data[:header_end]
            # 尝试 UTF-8（浏览器 FormData），回退到 GBK（Windows curl/工具）
            try:
                headers_raw = headers_raw_bytes.decode('utf-8')
            except UnicodeDecodeError:
                headers_raw = headers_raw_bytes.decode('gbk', errors='replace')
            file_bytes = part_data[header_end + 4:]
            # 去掉尾部的 \r\n（multipart 格式约定）
            if file_bytes.endswith(b'\r\n'):
                file_bytes = file_bytes[:-2]
            # 从 Content-Disposition 提取 filename
            for line in headers_raw.split('\r\n'):
                if 'filename=' in line:
                    # 支持: filename="中文.pptx" 和 filename=file.pdf
                    match = re.search(r'filename="?([^";\r\n]+)"?', line)
                    if match:
                        file_name = match.group(1).strip()
            break  # 只取第一个文件

        if file_bytes is None:
            self.send_error_json('未找到上传文件', 400)
            return

        # 清理文件名（保留中文、字母、数字、点、横线）
        safe_name = re.sub(r'[^\w.\-\u4e00-\u9fff]', '_', file_name)
        # 文件名长度限制（NTFS/ext4 最大 255 字符）
        stem, ext = os.path.splitext(safe_name)
        ext = ext.lower()
        if len(safe_name) > 200:
            safe_name = stem[:200 - len(ext)] + ext

        if ext not in self.UPLOAD_ALLOWED_EXT:
            self.send_error_json(f'不支持的文件类型: {ext}，支持: {", ".join(sorted(self.UPLOAD_ALLOWED_EXT))}', 400)
            return

        if len(file_bytes) > MAX_FILE_SIZE:
            self.send_error_json(f'文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)', 413)
            return

        # 保存到临时目录
        upload_dir = self.clawd_path / 'temp' / 'uploads'
        upload_dir.mkdir(parents=True, exist_ok=True)
        unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
        file_path = upload_dir / unique_name

        try:
            file_path.write_bytes(file_bytes)
        except Exception as e:
            print(f"[ERROR] 文件保存失败: {e}", file=sys.stderr)
            self.send_error_json('文件保存失败', 500)
            return

        # 自动解析
        parsed_text = ''
        try:
            parsed_text = self._tool_parse_file({'filePath': str(file_path)})
        except Exception as e:
            print(f"[ERROR] 文件解析失败: {e}", file=sys.stderr)
            err_msg = str(e)
            if '未安装' in err_msg or 'pip install' in err_msg:
                parsed_text = f'[解析失败: {err_msg}]'
            else:
                parsed_text = f'[解析失败: 请检查文件格式是否正确]'

        file_size = len(file_bytes)
        self.send_json({
            'success': True,
            'filePath': str(file_path),
            'originalName': file_name,
            'fileSize': file_size,
            'parsedText': parsed_text,
            'timestamp': datetime.now().isoformat()
        })

    def handle_file_upload(self, data: dict):
        """接收前端上传的文件（Base64），保存到临时目录并自动解析"""
        file_name = data.get('fileName', '')
        data_base64 = data.get('dataBase64', '')

        if not file_name or not data_base64:
            self.send_error_json('fileName and dataBase64 are required', 400)
            return

        # 清理文件名
        safe_name = re.sub(r'[^\w.\-\u4e00-\u9fff]', '_', file_name)
        ext = os.path.splitext(safe_name)[1].lower()

        if ext not in self.UPLOAD_ALLOWED_EXT:
            self.send_error_json(f'不支持的文件类型: {ext}，支持: {", ".join(sorted(self.UPLOAD_ALLOWED_EXT))}', 400)
            return

        # 解码 Base64 (去掉 data:xxx;base64, 前缀)
        try:
            if ';base64,' in data_base64:
                data_base64 = data_base64.split(';base64,')[1]
            file_bytes = base64.b64decode(data_base64)
        except Exception as e:
            self.send_error_json(f'Base64 解码失败: {str(e)}', 400)
            return

        if len(file_bytes) > MAX_FILE_SIZE:
            self.send_error_json(f'文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)', 413)
            return

        # 保存到临时目录
        upload_dir = self.clawd_path / 'temp' / 'uploads'
        upload_dir.mkdir(parents=True, exist_ok=True)
        unique_name = f"{uuid.uuid4().hex[:8]}_{safe_name}"
        file_path = upload_dir / unique_name

        try:
            file_path.write_bytes(file_bytes)
        except Exception as e:
            self.send_error_json(f'文件保存失败: {str(e)}', 500)
            return

        # 自动解析
        parsed_text = ''
        try:
            parsed_text = self._tool_parse_file({'filePath': str(file_path)})
        except Exception as e:
            parsed_text = f'[解析失败: {str(e)}]'

        self.send_json({
            'success': True,
            'filePath': str(file_path),
            'originalName': file_name,
            'parsedText': parsed_text,
            'timestamp': datetime.now().isoformat()
        })

    def handle_parse_local_file(self, data: dict):
        """直接解析本地文件路径（Electron 粘贴场景，无需上传）"""
        file_path_str = data.get('filePath', '')
        if not file_path_str:
            self.send_error_json('filePath is required', 400)
            return

        file_path = Path(file_path_str)
        if not file_path.exists():
            self.send_error_json(f'文件不存在: {file_path_str}', 404)
            return
        if not file_path.is_file():
            self.send_error_json(f'不是文件: {file_path_str}', 400)
            return
        if file_path.stat().st_size > MAX_FILE_SIZE:
            self.send_error_json(f'文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)', 413)
            return

        parsed_text = ''
        try:
            parsed_text = self._tool_parse_file({'filePath': str(file_path)})
        except Exception as e:
            err_msg = str(e)
            if '未安装' in err_msg or 'pip install' in err_msg:
                parsed_text = f'[解析失败: {err_msg}]'
            else:
                parsed_text = f'[解析失败: 请检查文件格式是否正确]'

        self.send_json({
            'success': True,
            'filePath': str(file_path),
            'originalName': file_path.name,
            'fileSize': file_path.stat().st_size,
            'parsedText': parsed_text,
            'timestamp': datetime.now().isoformat()
        })

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
    
    def _tool_parse_file(self, args: dict) -> str:
        """解析文档/数据/代码/图像文件，返回提取的文本内容（解析器注册表模式）"""
        file_path_str = args.get('filePath') or args.get('path', '')
        if not file_path_str:
            raise ValueError("filePath is required")
        
        # 支持绝对路径和相对路径
        file_path = self._resolve_path(file_path_str, allow_outside=True)
        
        # P0-1: 路径模糊匹配 — 当精确路径不存在时，通过 Unicode 归一化在父目录中查找
        # 解决 LLM 生成路径时将弯引号→直引号、全角→半角等字符归一化导致的路径断裂
        if not file_path.exists():
            fuzzy = self._fuzzy_resolve_for_parse(file_path_str)
            if fuzzy is None:
                raise FileNotFoundError(f"File not found: {file_path_str}")
            file_path = fuzzy
        
        if file_path.stat().st_size > MAX_FILE_SIZE:
            raise ValueError(f"File too large (>{MAX_FILE_SIZE // 1024 // 1024}MB)")
        
        ext = file_path.suffix.lower()
        text = ""
        
        # === 解析器注册表 ===
        # 每个解析器签名: parser_fn(file_path: Path, args: dict) -> str
        FILE_PARSERS = {
            # 文档类
            '.pdf':   self._parse_pdf,
            '.docx':  self._parse_docx,
            '.pptx':  self._parse_pptx,
            '.xlsx':  self._parse_xlsx,
            # 图像类 (OCR)
            '.png':   self._parse_image_ocr,
            '.jpg':   self._parse_image_ocr,
            '.jpeg':  self._parse_image_ocr,
            '.bmp':   self._parse_image_ocr,
            '.tiff':  self._parse_image_ocr,
            '.webp':  self._parse_image_ocr,
            # 结构化数据
            '.json':  self._parse_json,
            '.yaml':  self._parse_yaml,
            '.yml':   self._parse_yaml,
            '.xml':   self._parse_xml,
            '.csv':   self._parse_csv,
            '.toml':  self._parse_toml,
            # 网页
            '.html':  self._parse_html,
            '.htm':   self._parse_html,
            # 电子书
            '.epub':  self._parse_epub,
            # 富文本
            '.rtf':   self._parse_rtf,
        }
        # P1-2: 修复 .xls — openpyxl 不支持旧版 .xls 二进制格式
        if HAS_XLRD:
            FILE_PARSERS['.xls'] = self._parse_xls
        # P1-2: WPS 新版格式 (.et/.dps 基于 OOXML，可复用现有解析器，加异常保护)
        FILE_PARSERS['.et'] = self._parse_et_safe
        FILE_PARSERS['.dps'] = self._parse_dps_safe
        # P1-1: Windows COM 自动化解析旧格式 (.doc/.wps/.ppt)
        if HAS_COM:
            FILE_PARSERS['.wps'] = self._parse_via_com
            FILE_PARSERS['.doc'] = self._parse_via_com
            FILE_PARSERS['.ppt'] = self._parse_via_com
        
        parser = FILE_PARSERS.get(ext)
        if parser:
            text = parser(file_path, args)
        else:
            # 回退：尝试当纯文本读取（代码文件、配置文件、日志等）
            text = self._parse_plain_text(file_path, args)
        
        if not text.strip():
            return f"[文件 {file_path.name} 无可提取的文本内容]"
        
        # 截断到 MAX_OUTPUT_SIZE（安全 UTF-8 边界截断）
        encoded = text.encode('utf-8')
        if len(encoded) > MAX_OUTPUT_SIZE:
            safe_idx = MAX_OUTPUT_SIZE
            # 回退到 UTF-8 字符边界，避免截断多字节字符导致乱码
            while safe_idx > 0 and (encoded[safe_idx] & 0xC0) == 0x80:
                safe_idx -= 1
            text = encoded[:safe_idx].decode('utf-8')
            text += f"\n\n[内容过长，已截断至约 {MAX_OUTPUT_SIZE // 1024}KB]"
        
        return text
    
    # ============================================
    # 📄 文件解析器 (各格式独立实现)
    # ============================================
    
    # ---- 路径模糊匹配工具 ----
    
    @staticmethod
    def _normalize_filename(name: str) -> str:
        """将文件名中的 Unicode 变体字符归一化，用于模糊匹配。
        NFKC 已处理全角→半角（冒号、逗号、括号等），
        仅需额外处理弯引号和中文方括号（NFKC 不覆盖）。
        """
        normalized = unicodedata.normalize('NFKC', name)
        # LLM 常见的字符归一化遗留：弯引号、中文方括号
        curly_replacements = {
            '\u201c': '"', '\u201d': '"',  # "" → ""
            '\u2018': "'", '\u2019': "'",  # '' → ''
            '\u3010': '[', '\u3011': ']',  # 【】 → []
        }
        for old, new in curly_replacements.items():
            normalized = normalized.replace(old, new)
        return normalized
    
    def _fuzzy_resolve_for_parse(self, raw_path: str):
        """仅用于 parseFile 的模糊路径匹配（只读操作）。
        当精确路径不存在时，在父目录中通过 Unicode 归一化匹配文件名。
        返回匹配到的 Path，或 None。
        """
        try:
            target = Path(raw_path)
            if not target.is_absolute():
                target = self.clawd_path / raw_path.lstrip('/')
            parent = target.parent.resolve()
            if not parent.exists():
                return None
            target_normalized = self._normalize_filename(target.name)
            candidates = [
                child for child in parent.iterdir()
                if self._normalize_filename(child.name) == target_normalized
            ]
            if len(candidates) == 1:
                return candidates[0]
        except Exception:
            pass
        return None
    
    # ---- 新增解析器: COM 自动化 (.doc/.wps/.ppt) ----
    
    def _parse_via_com(self, file_path: Path, args: dict) -> str:
        """通过 WPS/Office COM 接口提取文本（仅 Windows）"""
        if not HAS_COM:
            raise RuntimeError("comtypes 未安装或非 Windows 系统，请运行 pip install comtypes")
        ext = file_path.suffix.lower()
        abs_path = str(file_path.resolve())
        if ext in ('.wps', '.doc'):
            return self._parse_word_via_com(abs_path)
        elif ext == '.ppt':
            return self._parse_ppt_via_com(abs_path)
        raise ValueError(f"COM 不支持格式: {ext}")
    
    def _parse_word_via_com(self, abs_path: str) -> str:
        """通过 COM 提取 .doc/.wps 文本（回退链: kwps → wps → Word）"""
        import comtypes.client
        app = None
        doc = None
        try:
            # 尝试不同版本的 WPS/Office ProgID
            for prog_id in ('kwps.Application', 'wps.Application', 'Word.Application'):
                try:
                    app = comtypes.client.CreateObject(prog_id)
                    break
                except Exception:
                    continue
            if app is None:
                raise RuntimeError("未找到可用的 WPS 或 Microsoft Word，请安装 WPS Office 或 Microsoft Office")
            app.Visible = False
            doc = app.Documents.Open(abs_path)
            text = doc.Content.Text
            return text
        finally:
            if doc:
                try: doc.Close(False)
                except Exception: pass
            if app:
                try: app.Quit()
                except Exception: pass
    
    def _parse_ppt_via_com(self, abs_path: str) -> str:
        """通过 COM 提取 .ppt 文本（回退链: kwpp → wpp → PowerPoint）"""
        import comtypes.client
        app = None
        pres = None
        try:
            for prog_id in ('kwpp.Application', 'wpp.Application', 'PowerPoint.Application'):
                try:
                    app = comtypes.client.CreateObject(prog_id)
                    break
                except Exception:
                    continue
            if app is None:
                raise RuntimeError("未找到可用的 WPS 或 Microsoft PowerPoint，请安装 WPS Office 或 Microsoft Office")
            app.Visible = False
            pres = app.Presentations.Open(abs_path, WithWindow=False)
            texts = []
            for slide in pres.Slides:
                for shape in slide.Shapes:
                    if shape.HasTextFrame:
                        texts.append(shape.TextFrame.TextRange.Text)
            return '\n'.join(texts)
        finally:
            if pres:
                try: pres.Close()
                except Exception: pass
            if app:
                try: app.Quit()
                except Exception: pass
    
    # ---- 新增解析器: .xls (xlrd) ----
    
    def _parse_xls(self, file_path: Path, args: dict) -> str:
        """解析旧版 .xls 文件（使用 xlrd）"""
        if not HAS_XLRD:
            raise RuntimeError("xlrd 未安装，请运行 pip install xlrd")
        workbook = xlrd.open_workbook(str(file_path))
        result = []
        for sheet in workbook.sheets():
            result.append(f"--- Sheet: {sheet.name} ---")
            for row_idx in range(min(sheet.nrows, 5000)):
                row_values = [str(sheet.cell_value(row_idx, col)) for col in range(sheet.ncols)]
                if any(v.strip() for v in row_values):
                    result.append(' | '.join(row_values))
        return '\n'.join(result)
    
    # ---- 新增解析器: .et/.dps (WPS OOXML 格式，带回退保护) ----
    
    def _parse_et_safe(self, file_path: Path, args: dict) -> str:
        """解析 WPS 表格 .et — 新版是 OOXML (类似 xlsx)，旧版是二进制"""
        try:
            return self._parse_xlsx(file_path, args)
        except Exception:
            if HAS_COM:
                return self._parse_via_com(file_path, args)
            raise ValueError(
                f"无法解析 .et 文件: {file_path.name}。"
                "新版 .et 需要 openpyxl，旧版 .et 需要 WPS/Office COM 支持"
            )
    
    def _parse_dps_safe(self, file_path: Path, args: dict) -> str:
        """解析 WPS 演示 .dps — 新版是 OOXML (类似 pptx)，旧版是二进制"""
        try:
            return self._parse_pptx(file_path, args)
        except Exception:
            if HAS_COM:
                return self._parse_via_com(file_path, args)
            raise ValueError(
                f"无法解析 .dps 文件: {file_path.name}。"
                "新版 .dps 需要 python-pptx，旧版 .dps 需要 WPS/Office COM 支持"
            )
    
    # ---- 原有解析器 ----
    
    def _parse_pdf(self, file_path: Path, args: dict) -> str:
        if not HAS_PDF:
            raise RuntimeError("pdfplumber 未安装，请运行 pip install pdfplumber")
        with pdfplumber.open(str(file_path)) as pdf:
            pages = []
            for i, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ''
                if page_text.strip():
                    pages.append(f"--- 第{i+1}页 ---\n{page_text}")
            return "\n\n".join(pages)
    
    def _parse_docx(self, file_path: Path, args: dict) -> str:
        if not HAS_DOCX:
            raise RuntimeError("python-docx 未安装，请运行 pip install python-docx")
        doc = DocxDocument(str(file_path))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells]
                paragraphs.append(" | ".join(cells))
        return "\n".join(paragraphs)
    
    def _parse_pptx(self, file_path: Path, args: dict) -> str:
        if not HAS_PPTX:
            raise RuntimeError("python-pptx 未安装，请运行 pip install python-pptx")
        prs = PptxPresentation(str(file_path))
        slides = []
        for i, slide in enumerate(prs.slides):
            parts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        t = para.text.strip()
                        if t:
                            parts.append(t)
            if parts:
                slides.append(f"--- 幻灯片{i+1} ---\n" + "\n".join(parts))
        return "\n\n".join(slides)
    
    def _parse_xlsx(self, file_path: Path, args: dict) -> str:
        if not HAS_XLSX:
            raise RuntimeError("openpyxl 未安装，请运行 pip install openpyxl")
        wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
        sheets = []
        for sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            rows = []
            for row in ws.iter_rows(values_only=True):
                cells = [str(c) if c is not None else '' for c in row]
                if any(c.strip() for c in cells):
                    rows.append(" | ".join(cells))
            if rows:
                sheets.append(f"--- Sheet: {sheet_name} ---\n" + "\n".join(rows))
        wb.close()
        return "\n\n".join(sheets)
    
    def _parse_image_ocr(self, file_path: Path, args: dict) -> str:
        if not HAS_OCR:
            raise RuntimeError("pytesseract/Pillow 未安装，请运行 pip install pytesseract Pillow")
        img = Image.open(str(file_path))
        lang = args.get('language', 'eng+chi_sim')
        return pytesseract.image_to_string(img, lang=lang)
    
    def _parse_json(self, file_path: Path, args: dict) -> str:
        raw = file_path.read_text(encoding='utf-8')
        try:
            data = json.loads(raw)
            return json.dumps(data, ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            return raw
    
    def _parse_yaml(self, file_path: Path, args: dict) -> str:
        if not HAS_YAML:
            # YAML 库不可用时回退纯文本
            return file_path.read_text(encoding='utf-8')
        raw = file_path.read_text(encoding='utf-8')
        try:
            data = yaml.safe_load(raw)
            return yaml.dump(data, allow_unicode=True, default_flow_style=False)
        except Exception:
            return raw
    
    def _parse_xml(self, file_path: Path, args: dict) -> str:
        import xml.etree.ElementTree as ET
        try:
            tree = ET.parse(str(file_path))
            root = tree.getroot()
            texts = []
            for elem in root.iter():
                if elem.text and elem.text.strip():
                    tag = elem.tag.split('}')[-1] if '}' in elem.tag else elem.tag
                    texts.append(f"[{tag}] {elem.text.strip()}")
            return "\n".join(texts) if texts else file_path.read_text(encoding='utf-8')
        except ET.ParseError:
            return file_path.read_text(encoding='utf-8')
    
    def _parse_csv(self, file_path: Path, args: dict) -> str:
        rows = []
        with open(str(file_path), 'r', encoding='utf-8', errors='replace') as f:
            reader = csv_module.reader(f)
            for i, row in enumerate(reader):
                rows.append(" | ".join(row))
                if i >= 5000:
                    rows.append(f"\n[CSV 行数过多，已截取前 5000 行]")
                    break
        return "\n".join(rows)
    
    def _parse_toml(self, file_path: Path, args: dict) -> str:
        # Python 3.11+ 内置 tomllib
        raw = file_path.read_text(encoding='utf-8')
        try:
            import tomllib
            data = tomllib.loads(raw)
            return json.dumps(data, ensure_ascii=False, indent=2)
        except (ImportError, Exception):
            return raw
    
    def _parse_html(self, file_path: Path, args: dict) -> str:
        raw = file_path.read_text(encoding='utf-8', errors='replace')
        if HAS_BS4:
            soup = BeautifulSoup(raw, 'html.parser')
            # 移除 script/style
            for tag in soup(['script', 'style']):
                tag.decompose()
            text = soup.get_text(separator='\n', strip=True)
            return text if text.strip() else raw
        else:
            # 简易 HTML 标签去除
            clean = re.sub(r'<script[^>]*>[\s\S]*?</script>', '', raw, flags=re.IGNORECASE)
            clean = re.sub(r'<style[^>]*>[\s\S]*?</style>', '', clean, flags=re.IGNORECASE)
            clean = re.sub(r'<[^>]+>', '', clean)
            return clean.strip()
    
    def _parse_epub(self, file_path: Path, args: dict) -> str:
        if not HAS_EPUB:
            raise RuntimeError("ebooklib 未安装，请运行 pip install ebooklib")
        book = epub_lib.read_epub(str(file_path))
        chapters = []
        for item in book.get_items():
            if item.get_type() == ebooklib.ITEM_DOCUMENT:
                content = item.get_content().decode('utf-8', errors='replace')
                if HAS_BS4:
                    soup = BeautifulSoup(content, 'html.parser')
                    text = soup.get_text(separator='\n', strip=True)
                else:
                    text = re.sub(r'<[^>]+>', '', content).strip()
                if text:
                    chapters.append(text)
        return "\n\n---\n\n".join(chapters)
    
    def _parse_rtf(self, file_path: Path, args: dict) -> str:
        if not HAS_RTF:
            raise RuntimeError("striprtf 未安装，请运行 pip install striprtf")
        raw = file_path.read_text(encoding='utf-8', errors='replace')
        return rtf_to_text(raw)
    
    def _parse_plain_text(self, file_path: Path, args: dict) -> str:
        """纯文本回退解析器（代码文件、配置文件、日志等）。
        带二进制文件检测和智能编码识别。
        """
        # P0-2: 二进制文件检测 — 防止不支持的二进制格式输出乱码
        with open(file_path, 'rb') as f:
            chunk = f.read(8192)
        null_ratio = chunk.count(b'\x00') / max(len(chunk), 1)
        if null_ratio > 0.05:
            ext = file_path.suffix.lower()
            supported = '.docx, .pdf, .pptx, .xlsx, .txt, .csv, .json, .html, .epub, .rtf'
            if HAS_COM:
                supported += ', .doc, .wps, .ppt'
            raise ValueError(
                f"不支持的二进制文件格式 '{ext}'。"
                f"建议将文件转换为以下支持的格式之一: {supported}"
            )
        
        # P2: 智能编码检测
        with open(file_path, 'rb') as f:
            raw = f.read()
        
        if HAS_CHARSET:
            try:
                result = charset_from_bytes(raw).best()
                if result:
                    return str(result)
            except Exception:
                pass
        
        # 手动回退（按国内常见编码优先级排列，utf-8-sig 处理 Windows BOM 头）
        for encoding in ('utf-8-sig', 'utf-8', 'gbk', 'gb18030', 'big5', 'shift_jis', 'latin-1'):
            try:
                return raw.decode(encoding)
            except (UnicodeDecodeError, LookupError):
                continue
        
        return raw.decode('utf-8', errors='replace')


