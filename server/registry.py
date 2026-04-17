"""DunCrew Server - Tool Registry"""
from __future__ import annotations

import os
import re
import json
from pathlib import Path

from server.constants import APP_DIR, HAS_MCP, HAS_YAML
from server.utils import parse_skill_frontmatter, skill_name_to_tool_name

# 条件导入 MCPClientManager
if HAS_MCP:
    from skills.mcp_manager import MCPClientManager
else:
    MCPClientManager = None

class ToolRegistry:
    """动态工具发现与注册 - 支持内置工具 + 插件工具 + 指令型工具 + MCP工具"""

    def __init__(self, clawd_path: Path, project_path: Path = None):
        self.clawd_path = clawd_path
        # 项目目录 (脚本/exe 所在目录)，用于加载内置技能
        self.project_path = project_path or APP_DIR
        self.builtin_tools: dict = {}      # name -> callable
        self.plugin_tools: dict = {}       # name -> ToolSpec dict (有 execute.py)
        self.instruction_tools: dict = {}  # name -> InstructionSpec (纯 SKILL.md)
        self.mcp_tools: dict = {}          # name -> MCPToolSpec dict (MCP 服务器)
        self.mcp_manager: 'MCPClientManager | None' = None

    def register_builtin(self, name: str, handler):
        """注册内置工具"""
        self.builtin_tools[name] = handler

    def _get_skills_dirs(self) -> list[Path]:
        """获取所有技能目录 (用户目录 + 项目目录)"""
        dirs = []
        # 用户数据目录的技能 (优先级高，可覆盖内置)
        user_skills = self.clawd_path / 'skills'
        if user_skills.exists():
            dirs.append(user_skills)
        # 项目目录的内置技能
        project_skills = self.project_path / 'skills'
        if project_skills.exists() and project_skills != user_skills:
            dirs.append(project_skills)
        return dirs

    def scan_plugins(self):
        """递归扫描 skills/ 目录，统一从 SKILL.md frontmatter 注册可执行插件 + 指令型技能"""
        skills_dirs = self._get_skills_dirs()
        if not skills_dirs:
            return

        plugin_count = 0
        instruction_count = 0

        seen_dirs: set = set()
        seen_tools: set = set()  # 防止重复注册同名工具

        for skills_dir in skills_dirs:
            # ── 统一扫描 SKILL.md ──
            for skill_md in skills_dir.rglob('SKILL.md'):
                skill_dir = skill_md.parent
                dir_key = str(skill_dir.resolve())

                if dir_key in seen_dirs:
                    continue
                seen_dirs.add(dir_key)

                try:
                    frontmatter = parse_skill_frontmatter(skill_md)

                    # 跳过被禁用的技能 (enabled: false)
                    if frontmatter.get('enabled') is False:
                        continue

                    original_name = frontmatter.get('name', skill_dir.name)
                    executable = frontmatter.get('executable', '')
                    runtime = frontmatter.get('runtime', 'python')

                    # 当 SKILL.md 无 executable 时，尝试从同目录 manifest.json 补充
                    if not executable:
                        manifest_path = skill_dir / 'manifest.json'
                        if manifest_path.exists():
                            try:
                                manifest_data = json.loads(manifest_path.read_text(encoding='utf-8'))
                                manifest_tools = manifest_data.get('tools', [])
                                if manifest_tools and manifest_tools[0].get('executable'):
                                    executable = manifest_tools[0]['executable']
                                    runtime = manifest_tools[0].get('runtime', manifest_data.get('runtime', runtime))
                                    # 同步 tools 数组（如果 SKILL.md 没有定义）
                                    if not frontmatter.get('tools') and manifest_tools:
                                        frontmatter['tools'] = manifest_tools
                                    print(f"[ToolRegistry] Supplemented executable from manifest.json for '{original_name}': {executable}")
                                elif manifest_data.get('executable'):
                                    executable = manifest_data['executable']
                                    runtime = manifest_data.get('runtime', runtime)
                                    print(f"[ToolRegistry] Supplemented executable from manifest.json for '{original_name}': {executable}")
                            except Exception as e:
                                print(f"[ToolRegistry] Warning: failed to read manifest.json for '{original_name}': {e}")

                    if executable:
                        # ── 可执行技能 (有 executable 字段) ──
                        exe_path = skill_dir / executable
                        if not exe_path.exists():
                            print(f"[ToolRegistry] Warning: {exe_path} not found for skill '{original_name}', skipping")
                            continue

                        tools_list = frontmatter.get('tools', [])
                        if tools_list:
                            # 多工具技能: frontmatter 中有 tools 数组
                            for tool_spec in tools_list:
                                tool_name = tool_spec.get('toolName', '')
                                if not tool_name:
                                    continue
                                if tool_name in seen_tools:
                                    continue
                                if tool_name in self.builtin_tools:
                                    print(f"[ToolRegistry] Warning: plugin '{tool_name}' conflicts with builtin, skipping")
                                    continue

                                self.plugin_tools[tool_name] = {
                                    'name': tool_name,
                                    'exe_path': str(exe_path),
                                    'runtime': tool_spec.get('runtime', runtime),
                                    'inputs': tool_spec.get('inputs', {}),
                                    'outputs': tool_spec.get('outputs', {}),
                                    'description': tool_spec.get('description', ''),
                                    'dangerLevel': tool_spec.get('dangerLevel', frontmatter.get('dangerLevel', 'safe')),
                                    'version': frontmatter.get('version', '1.0.0'),
                                    'skill_dir': str(skill_dir),
                                    'keywords': tool_spec.get('keywords', frontmatter.get('keywords', [])),
                                }
                                seen_tools.add(tool_name)
                                plugin_count += 1
                                print(f"[ToolRegistry] Registered plugin: {tool_name} ({exe_path.name})")
                        else:
                            # 单工具技能: toolName = skill_name_to_tool_name(name)
                            tool_name = skill_name_to_tool_name(original_name)
                            if tool_name in seen_tools:
                                continue
                            if tool_name in self.builtin_tools:
                                print(f"[ToolRegistry] Warning: plugin '{tool_name}' conflicts with builtin, skipping")
                                continue

                            self.plugin_tools[tool_name] = {
                                'name': tool_name,
                                'exe_path': str(exe_path),
                                'runtime': runtime,
                                'inputs': frontmatter.get('inputs', {}),
                                'outputs': {},
                                'description': frontmatter.get('description', ''),
                                'dangerLevel': frontmatter.get('dangerLevel', 'safe'),
                                'version': frontmatter.get('version', '1.0.0'),
                                'skill_dir': str(skill_dir),
                                'keywords': frontmatter.get('tags', frontmatter.get('keywords', [])),
                            }
                            seen_tools.add(tool_name)
                            plugin_count += 1
                            print(f"[ToolRegistry] Registered plugin: {tool_name} ({exe_path.name})")
                    else:
                        # ── 指令型技能 (无 executable) ──
                        tool_name = skill_name_to_tool_name(original_name)

                        if tool_name in self.builtin_tools or tool_name in self.plugin_tools or tool_name in seen_tools:
                            print(f"[ToolRegistry] Warning: instruction skill '{tool_name}' conflicts, skipping")
                            continue

                        self.instruction_tools[tool_name] = {
                            'name': tool_name,
                            'original_name': original_name,
                            'skill_path': str(skill_md),
                            'skill_dir': str(skill_dir),
                            'description': frontmatter.get('description', ''),
                            'inputs': frontmatter.get('inputs', {}),
                            'keywords': frontmatter.get('tags', frontmatter.get('keywords', [])),
                            'dangerLevel': 'safe',
                            'version': frontmatter.get('version', '1.0.0'),
                        }
                        seen_tools.add(tool_name)
                        instruction_count += 1
                        print(f"[ToolRegistry] Registered instruction skill: {tool_name} (from {skills_dir.name})")

                except Exception as e:
                    print(f"[ToolRegistry] Error loading {skill_md}: {e}")

            # ── Deprecated fallback: manifest.json (兼容无 SKILL.md 的第三方技能) ──
            for manifest_path in skills_dir.rglob('manifest.json'):
                skill_dir = manifest_path.parent
                dir_key = str(skill_dir.resolve())
                if dir_key in seen_dirs:
                    continue
                seen_dirs.add(dir_key)

                print(f"[ToolRegistry] [WARN] DEPRECATED: {manifest_path} has no SKILL.md, please migrate to SKILL.md format")

                try:
                    spec = json.loads(manifest_path.read_text(encoding='utf-8'))
                    tools_list = spec.get('tools', [])
                    if not tools_list:
                        tools_list = [spec]

                    for tool_spec in tools_list:
                        tool_name = tool_spec.get('toolName', '')
                        executable = tool_spec.get('executable', spec.get('executable', 'execute.py'))

                        if not tool_name or tool_name in seen_tools:
                            continue

                        exe_path = skill_dir / executable
                        if not exe_path.exists():
                            continue

                        if tool_name in self.builtin_tools:
                            continue

                        self.plugin_tools[tool_name] = {
                            'name': tool_name,
                            'exe_path': str(exe_path),
                            'runtime': tool_spec.get('runtime', spec.get('runtime', 'python')),
                            'inputs': tool_spec.get('inputs', {}),
                            'outputs': tool_spec.get('outputs', {}),
                            'description': tool_spec.get('description', ''),
                            'dangerLevel': tool_spec.get('dangerLevel', spec.get('dangerLevel', 'safe')),
                            'version': tool_spec.get('version', spec.get('version', '1.0.0')),
                            'skill_dir': str(skill_dir),
                            'keywords': tool_spec.get('keywords', spec.get('keywords', [])),
                        }
                        seen_tools.add(tool_name)
                        plugin_count += 1

                except Exception as e:
                    print(f"[ToolRegistry] Error loading deprecated manifest {manifest_path}: {e}")

        total = plugin_count + instruction_count
        if total > 0:
            print(f"[ToolRegistry] {total} tool(s) registered ({plugin_count} plugins, {instruction_count} instruction skills)")

    def scan_mcp_servers(self):
        """扫描并连接 MCP 服务器"""
        if not HAS_MCP:
            print("[ToolRegistry] MCP support not available (missing mcp_manager)")
            return

        self.mcp_manager = MCPClientManager(clawd_path=self.clawd_path)
        count = self.mcp_manager.initialize_all()

        if count > 0:
            # 注册 MCP 工具
            mcp_tool_count = 0
            for tool_info in self.mcp_manager.get_all_tools():
                tool_name = tool_info['name']
                # 冲突检查
                if tool_name in self.builtin_tools or tool_name in self.plugin_tools or tool_name in self.instruction_tools:
                    print(f"[ToolRegistry] Warning: MCP tool '{tool_name}' conflicts with existing tool, skipping")
                    continue

                self.mcp_tools[tool_name] = {
                    'name': tool_name,
                    'server': tool_info.get('server', ''),
                    'description': tool_info.get('description', ''),
                    'inputs': tool_info.get('inputs', {}),
                    'dangerLevel': 'safe',
                    'version': '1.0.0',
                }
                mcp_tool_count += 1

            print(f"[ToolRegistry] {mcp_tool_count} MCP tool(s) registered from {count} server(s)")

    def is_registered(self, name: str) -> bool:
        return name in self.builtin_tools or name in self.plugin_tools or name in self.instruction_tools or name in self.mcp_tools

    def get_plugin(self, name: str) -> dict | None:
        return self.plugin_tools.get(name)

    def get_instruction(self, name: str) -> dict | None:
        return self.instruction_tools.get(name)

    def get_mcp_tool(self, name: str) -> dict | None:
        return self.mcp_tools.get(name)

    def list_all(self) -> list:
        """返回所有已注册工具（内置+插件+指令型+MCP）"""
        # 内置工具元数据 (为有特殊参数的工具提供描述)
        BUILTIN_META = {
            'readFile': {
                'description': '读取指定路径的文件内容',
                'inputs': {
                    'path': {'type': 'string', 'description': '文件路径（绝对或相对路径）', 'required': True},
                },
            },
            'writeFile': {
                'description': '将内容写入指定文件（覆盖已有内容）。当有活跃 Dun 时，相对路径文件会自动存入 duns/{dun-id}/output/',
                'inputs': {
                    'path': {'type': 'string', 'description': '文件路径', 'required': True},
                    'content': {'type': 'string', 'description': '要写入的文本内容', 'required': True},
                },
            },
            'appendFile': {
                'description': '在指定文件末尾追加内容。当有活跃 Dun 时，相对路径文件会自动存入 duns/{dun-id}/output/',
                'inputs': {
                    'path': {'type': 'string', 'description': '文件路径', 'required': True},
                    'content': {'type': 'string', 'description': '要追加的文本内容', 'required': True},
                },
            },
            'listDir': {
                'description': '列出目录下的文件和子目录',
                'inputs': {
                    'path': {'type': 'string', 'description': '目录路径（默认为项目根目录）', 'required': False},
                },
            },
            'runCmd': {
                'description': '在系统 Shell 中执行命令（谨慎使用，高风险操作需用户确认）',
                'inputs': {
                    'command': {'type': 'string', 'description': '要执行的 Shell 命令', 'required': True},
                },
            },
            'weather': {
                'description': '查询指定城市的天气信息',
                'inputs': {
                    'city': {'type': 'string', 'description': '城市名称（如"北京"、"Tokyo"）', 'required': True},
                },
            },
            'webSearch': {
                'description': '搜索网络信息，返回相关网页标题、链接和摘要',
                'inputs': {
                    'query': {'type': 'string', 'description': '搜索关键词', 'required': True},
                },
            },
            'webFetch': {
                'description': '获取指定 URL 的网页内容并提取主要文本',
                'inputs': {
                    'url': {'type': 'string', 'description': '要获取的网页 URL', 'required': True},
                },
            },
            'saveMemory': {
                'description': '保存一条记忆到持久化存储，用于跨会话记住重要信息',
                'inputs': {
                    'key': {'type': 'string', 'description': '记忆标题/关键词', 'required': True},
                    'content': {'type': 'string', 'description': '记忆内容', 'required': True},
                    'type': {'type': 'string', 'description': '记忆类型（general/decision/preference/fact）', 'required': False},
                },
            },
            'searchMemory': {
                'description': '检索历史记忆，查找之前保存的信息',
                'inputs': {
                    'query': {'type': 'string', 'description': '搜索关键词', 'required': True},
                },
            },
            'openInExplorer': {
                'description': '在系统文件管理器中打开指定路径',
                'inputs': {
                    'path': {'type': 'string', 'description': '要打开的文件或目录路径', 'required': True},
                },
            },
            'dunBindSkill': {
                'description': '为当前 Dun 绑定新技能依赖',
                'inputs': {
                    'dunId': {'type': 'string', 'description': 'Dun ID', 'required': True},
                    'skillId': {'type': 'string', 'description': '要绑定的技能 ID', 'required': True},
                },
            },
            'dunUnbindSkill': {
                'description': '从当前 Dun 移除技能依赖',
                'inputs': {
                    'dunId': {'type': 'string', 'description': 'Dun ID', 'required': True},
                    'skillId': {'type': 'string', 'description': '要移除的技能 ID', 'required': True},
                },
            },
            'parseFile': {
                'description': '解析文档/数据/代码/图像文件，返回提取的文本内容。支持 PDF/DOCX/PPTX/XLSX/HTML/JSON/YAML/XML/CSV/EPUB/RTF 及各类代码和纯文本文件，图像支持 OCR 文字识别',
                'inputs': {
                    'filePath': {'type': 'string', 'description': '文件路径（支持常见文档、数据、代码、图像等格式）', 'required': True},
                },
            },
            'generateSkill': {
                'description': '动态生成 Python SKILL 并保存。当现有工具无法完成任务时，用此工具创建新能力',
                'inputs': {
                    'name': {'type': 'string', 'description': '技能名称 (kebab-case，如 ppt-maker)', 'required': True},
                    'description': {'type': 'string', 'description': '技能功能描述', 'required': True},
                    'pythonCode': {'type': 'string', 'description': 'Python 实现代码（必须包含 main() 函数）', 'required': True},
                    'dunId': {'type': 'string', 'description': '关联的 Dun ID（可选，指定后保存到 Dun 目录）', 'required': False},
                    'triggers': {'type': 'array', 'description': '触发关键词列表（可选）', 'required': False},
                },
            },
            'browser_navigate': {
                'description': '使用浏览器导航到指定 URL，返回页面标题和文本内容。支持 JavaScript 渲染的动态页面',
                'inputs': {
                    'url': {'type': 'string', 'description': '要访问的网页 URL', 'required': True},
                    'waitUntil': {'type': 'string', 'description': '等待条件: domcontentloaded(默认) / networkidle / load', 'required': False},
                },
            },
            'browser_click': {
                'description': '点击浏览器当前页面上的元素（需先用 browser_navigate 打开页面）',
                'inputs': {
                    'selector': {'type': 'string', 'description': 'CSS 选择器或文本选择器，如 "button.submit" 或 "text=登录"', 'required': True},
                },
            },
            'browser_fill': {
                'description': '在浏览器当前页面的输入框中填写内容',
                'inputs': {
                    'selector': {'type': 'string', 'description': 'CSS 选择器，如 "input[name=search]" 或 "#username"', 'required': True},
                    'value': {'type': 'string', 'description': '要填写的文本内容', 'required': True},
                },
            },
            'browser_extract': {
                'description': '提取浏览器当前页面的文本内容（支持指定选择器提取局部内容）',
                'inputs': {
                    'selector': {'type': 'string', 'description': 'CSS 选择器（默认 body，提取主要内容区域）', 'required': False},
                },
            },
            'browser_screenshot': {
                'description': '对浏览器当前页面截图',
                'inputs': {
                    'selector': {'type': 'string', 'description': '指定截图区域的 CSS 选择器（可选，默认整个页面）', 'required': False},
                    'fullPage': {'type': 'boolean', 'description': '是否截取完整页面（包括滚动区域）', 'required': False},
                },
            },
            'browser_evaluate': {
                'description': '在浏览器当前页面执行 JavaScript 代码并返回结果',
                'inputs': {
                    'expression': {'type': 'string', 'description': 'JavaScript 表达式（支持 async）', 'required': True},
                },
            },
            'screenCapture': {
                'description': '截取屏幕截图。支持全屏截图、指定区域截图、指定窗口截图，以及列出所有可见窗口。截图保存为 PNG 文件并返回文件路径',
                'inputs': {
                    'mode': {'type': 'string', 'description': '截图模式: fullscreen(全屏) / region(指定区域) / window(指定窗口) / list_windows(列出窗口)', 'required': True},
                    'monitor': {'type': 'number', 'description': '显示器编号，默认 1（主显示器），0 为所有显示器合并。仅 fullscreen 模式', 'required': False},
                    'region': {'type': 'object', 'description': '截图区域 {x, y, width, height}，像素坐标。仅 region 模式', 'required': False},
                    'windowTitle': {'type': 'string', 'description': '窗口标题关键词（模糊匹配）。仅 window 模式', 'required': False},
                },
            },
            'ocrExtract': {
                'description': '智能 OCR 文字提取。从图片中识别文字，支持中英文混排、图像预处理（提升识别率）、表格结构还原。比 parseFile 的 OCR 功能更强大',
                'inputs': {
                    'imagePath': {'type': 'string', 'description': '图片文件路径', 'required': True},
                    'language': {'type': 'string', 'description': 'Tesseract 语言代码，默认 eng+chi_sim（英文+简体中文）', 'required': False},
                    'outputFormat': {'type': 'string', 'description': '输出格式: text(纯文本，默认) / markdown(尝试还原表格为 Markdown 表格)', 'required': False},
                    'preprocess': {'type': 'boolean', 'description': '是否进行图像预处理（灰度化+二值化，提升识别率），默认 true', 'required': False},
                },
            },
            'searchWiki': {
                'description': '搜索知识库（图书馆），查找与查询语义相关的知识实体和断言。用于获取领域知识、事实数据、行业洞察等结构化知识',
                'inputs': {
                    'query': {'type': 'string', 'description': '搜索查询（自然语言描述你需要的知识）', 'required': True},
                    'limit': {'type': 'number', 'description': '返回结果数量，默认 5', 'required': False},
                },
            },
        }
        tools = []
        for name in self.builtin_tools:
            meta = BUILTIN_META.get(name, {})
            tools.append({'name': name, 'type': 'builtin', **meta})
        for name, spec in self.plugin_tools.items():
            tools.append({
                'name': name,
                'type': 'plugin',
                'description': spec.get('description', ''),
                'inputs': spec.get('inputs', {}),
                'dangerLevel': spec.get('dangerLevel', 'safe'),
                'version': spec.get('version', '1.0.0'),
            })
        for name, spec in self.instruction_tools.items():
            desc = spec.get('description', '')
            inputs = spec.get('inputs', {})
            # 没有 inputs 的 instruction skill 自动补充 task 参数
            if not inputs and desc:
                inputs = {
                    'task': {'type': 'string', 'description': '要执行的具体任务描述', 'required': True},
                }
            tools.append({
                'name': name,
                'type': 'instruction',
                'description': desc,
                'inputs': inputs,
                'dangerLevel': 'safe',
                'version': spec.get('version', '1.0.0'),
            })
        for name, spec in self.mcp_tools.items():
            tools.append({
                'name': name,
                'type': 'mcp',
                'server': spec.get('server', ''),
                'description': spec.get('description', ''),
                'inputs': spec.get('inputs', {}),
                'dangerLevel': 'safe',
                'version': '1.0.0',
            })
        return tools


