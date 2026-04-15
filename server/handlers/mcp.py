"""DunCrew Server - MCP Server Management + Registry Search Mixin"""
from __future__ import annotations

import re
import json
import shutil
import subprocess
from pathlib import Path

from server.constants import HAS_MCP

class MCPMixin:
    """MCP Server Management + Registry Search Mixin"""

    def handle_mcp_servers_list(self):
        """GET /mcp/servers - 列出 MCP 服务器状态"""
        if not self.registry.mcp_manager:
            self.send_json({
                'status': 'ok',
                'enabled': False,
                'servers': {},
                'message': 'MCP support not initialized'
            })
            return

        status = self.registry.mcp_manager.get_server_status()
        mcp_tools = [t for t in self.registry.list_all() if t.get('type') == 'mcp']

        self.send_json({
            'status': 'ok',
            'enabled': True,
            'servers': status,
            'toolCount': len(mcp_tools),
            'tools': mcp_tools,
        })

    def handle_mcp_reload(self, data=None):
        """POST /mcp/reload - 重新加载 MCP 服务器"""
        if not HAS_MCP:
            self.send_json({
                'status': 'error',
                'message': 'MCP support not available'
            }, 400)
            return

        # 使用 swap 模式：先备份旧工具表，reload 完成后才清理
        old_mcp_tools = dict(self.registry.mcp_tools)  # 备份
        try:
            if self.registry.mcp_manager:
                self.registry.mcp_manager.shutdown_all()
            self.registry.mcp_tools.clear()
            self.registry.scan_mcp_servers()

            mcp_tools = [t for t in self.registry.list_all() if t.get('type') == 'mcp']
            self.send_json({
                'status': 'ok',
                'message': f'MCP reloaded. {len(mcp_tools)} tool(s) registered.',
                'tools': mcp_tools,
            })
        except Exception as e:
            # 失败时恢复旧工具表
            self.registry.mcp_tools.update(old_mcp_tools)
            self.send_json({'status': 'error', 'message': f'MCP reload failed: {e}'}, 500)

    def handle_mcp_reconnect(self, server_name: str):
        """POST /mcp/servers/{name}/reconnect - 重连 MCP 服务器"""
        if not self.registry.mcp_manager:
            self.send_json({
                'status': 'error',
                'message': 'MCP support not initialized'
            }, 400)
            return

        success = self.registry.mcp_manager.reconnect_server(server_name)

        if success:
            # 更新工具注册：只移除重连服务器的旧工具，不影响其他服务器
            tools_to_remove = [k for k, v in self.registry.mcp_tools.items() 
                               if v.get('server') == server_name]
            for k in tools_to_remove:
                del self.registry.mcp_tools[k]

            # 重新注册该服务器的新工具
            for tool_info in self.registry.mcp_manager.get_all_tools():
                tool_name = tool_info['name']
                tool_server = tool_info.get('server', '')
                if tool_server == server_name:
                    if tool_name not in self.registry.builtin_tools and tool_name not in self.registry.plugin_tools:
                        self.registry.mcp_tools[tool_name] = {
                            'name': tool_name,
                            'server': tool_server,
                            'description': tool_info.get('description', ''),
                            'inputs': tool_info.get('inputs', {}),
                            'dangerLevel': 'safe',
                            'version': '1.0.0',
                        }

            self.send_json({
                'status': 'ok',
                'message': f'Server {server_name} reconnected',
                'server': server_name,
            })
        else:
            self.send_json({
                'status': 'error',
                'message': f'Failed to reconnect server: {server_name}'
            }, 500)

    # ============================================
    # 🔍 Registry 在线搜索 (TF-IDF, 无 LLM)
    # ============================================

    def handle_registry_skills_search(self, query: dict):
        """GET /api/registry/skills?q={query} - 搜索可安装的技能"""
        q = query.get('q', [''])[0].strip().lower()
        
        # 读取 registry 文件
        registry_path = self.clawd_path / 'registry' / 'skills.json'
        if not registry_path.exists():
            self.send_json({'status': 'ok', 'results': [], 'message': 'Registry not found'})
            return
        
        try:
            registry = json.loads(registry_path.read_text(encoding='utf-8'))
            skills = registry.get('skills', [])
        except Exception as e:
            self.send_json({'status': 'error', 'message': f'Failed to read registry: {e}'}, 500)
            return
        
        # 如果没有查询词，返回所有
        if not q:
            self.send_json({
                'status': 'ok',
                'results': skills[:20],
                'total': len(skills)
            })
            return
        
        # TF-IDF 风格的关键词匹配
        tokens = self._tokenize(q)
        scored_results = []
        
        for skill in skills:
            score = self._compute_skill_score(skill, tokens)
            if score > 0:
                scored_results.append({**skill, 'score': score})
        
        # 按分数排序
        scored_results.sort(key=lambda x: x['score'], reverse=True)
        
        self.send_json({
            'status': 'ok',
            'results': scored_results[:10],
            'total': len(scored_results),
            'query': q
        })

    def handle_registry_mcp_search(self, query: dict):
        """GET /api/registry/mcp?q={query} - 搜索可安装的 MCP 服务器"""
        q = query.get('q', [''])[0].strip().lower()
        
        # 读取 registry 文件
        registry_path = self.clawd_path / 'registry' / 'mcp-servers.json'
        if not registry_path.exists():
            self.send_json({'status': 'ok', 'results': [], 'message': 'Registry not found'})
            return
        
        try:
            registry = json.loads(registry_path.read_text(encoding='utf-8'))
            servers = registry.get('servers', [])
        except Exception as e:
            self.send_json({'status': 'error', 'message': f'Failed to read registry: {e}'}, 500)
            return
        
        # 如果没有查询词，返回所有
        if not q:
            self.send_json({
                'status': 'ok',
                'results': servers[:20],
                'total': len(servers)
            })
            return
        
        # TF-IDF 风格的关键词匹配
        tokens = self._tokenize(q)
        scored_results = []
        
        for server in servers:
            score = self._compute_mcp_score(server, tokens)
            if score > 0:
                scored_results.append({**server, 'score': score})
        
        # 按分数排序
        scored_results.sort(key=lambda x: x['score'], reverse=True)
        
        self.send_json({
            'status': 'ok',
            'results': scored_results[:10],
            'total': len(scored_results),
            'query': q
        })

    def _tokenize(self, text: str) -> list:
        """分词：按空格和标点拆分"""
        import re
        tokens = re.split(r'[\s,，.。!！?？、;；:：\-—]+', text.lower())
        return [t for t in tokens if t and len(t) >= 1]

    def _compute_skill_score(self, skill: dict, tokens: list) -> float:
        """计算技能的匹配分数 (TF-IDF 简化版)"""
        score = 0.0
        name = skill.get('name', '').lower()
        desc = skill.get('description', '').lower()
        keywords = [k.lower() for k in skill.get('keywords', [])]
        full_text = f"{name} {desc} {' '.join(keywords)}"
        
        for token in tokens:
            # 词频 (TF)
            tf = full_text.count(token)
            # 长词权重更高 (简化 IDF)
            idf = 1.5 if len(token) > 3 else 1.0
            score += tf * idf
            
            # 精确匹配加权
            if token in name:
                score += 10
            if token in keywords:
                score += 5
        
        return min(score, 100)

    def _compute_mcp_score(self, server: dict, tokens: list) -> float:
        """计算 MCP 服务器的匹配分数"""
        score = 0.0
        name = server.get('name', '').lower()
        desc = server.get('description', '').lower()
        keywords = [k.lower() for k in server.get('keywords', [])]
        full_text = f"{name} {desc} {' '.join(keywords)}"
        
        for token in tokens:
            tf = full_text.count(token)
            idf = 1.5 if len(token) > 3 else 1.0
            score += tf * idf
            
            if token in name:
                score += 10
            if token in keywords:
                score += 5
        
        return min(score, 100)

    def handle_mcp_install(self, data: dict):
        """POST /mcp/install - 安装 MCP 服务器配置"""
        server_id = data.get('id', '')
        server_name = data.get('name', server_id)
        command = data.get('command', '')
        args = data.get('args', [])
        env = data.get('env', {})
        
        if not server_name or not command:
            self.send_error_json('Missing required fields: name, command', 400)
            return
        
        # 安全检查
        if '..' in server_name or '/' in server_name or '\\' in server_name:
            self.send_error_json('Invalid server name', 400)
            return
        
        # 读取现有配置
        config_path = self.clawd_path / 'mcp-servers.json'
        try:
            if config_path.exists():
                config = json.loads(config_path.read_text(encoding='utf-8'))
            else:
                config = {'servers': {}}
        except Exception as e:
            self.send_error_json(f'Failed to read config: {e}', 500)
            return
        
        # 检查是否已存在
        if server_name in config.get('servers', {}):
            self.send_error_json(f'Server already exists: {server_name}', 409)
            return
        
        # 添加新服务器配置
        config['servers'][server_name] = {
            'command': command,
            'args': args,
            'env': env,
            'enabled': False  # 默认禁用，需要用户手动启用
        }
        
        # 写回配置文件
        try:
            config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding='utf-8')
        except Exception as e:
            self.send_error_json(f'Failed to write config: {e}', 500)
            return
        
        self.send_json({
            'status': 'ok',
            'serverName': server_name,
            'message': f'MCP server "{server_name}" added (disabled by default). Enable it in mcp-servers.json to use.',
            'configPath': str(config_path)
        })

    # ============================================
    # 📦 远程技能安装/卸载
    # ============================================


