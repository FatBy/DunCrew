#!/usr/bin/env python3
"""
MCP Manager - 管理多个 MCP 服务器连接

功能:
- 加载 mcp-servers.json 配置
- 管理多个 MCPClient 实例
- 聚合所有 MCP 工具
- 路由工具调用到正确的服务器

用法:
    manager = MCPClientManager(config_path)
    await manager.initialize_all()
    tools = manager.get_all_tools()
    result = manager.call_tool("server_name", "tool_name", args)
"""

import json
import os
import threading
from pathlib import Path
from typing import Any, Optional
from dataclasses import dataclass, field

from .mcp_client import MCPClient, MCPServerConfig, MCPTool, MCPError

@dataclass
class MCPToolInfo:
    """MCP 工具信息 (用于 ToolRegistry)"""
    name: str
    server_name: str
    description: str = ""
    input_schema: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "type": "mcp",
            "server": self.server_name,
            "description": self.description,
            "inputs": self.input_schema.get("properties", {}),
            "dangerLevel": "safe",
            "version": "1.0.0",
        }

class MCPClientManager:
    """
    MCP 客户端管理器 - 管理多个 MCP 服务器连接

    职责:
    - 加载和解析 mcp-servers.json 配置
    - 创建和管理 MCPClient 实例
    - 提供统一的工具发现接口
    - 路由工具调用到正确的服务器
    """

    def __init__(self, config_path: Optional[Path] = None, clawd_path: Optional[Path] = None):
        """
        初始化 MCP 管理器

        Args:
            config_path: mcp-servers.json 配置文件路径
            clawd_path: clawd 数据目录 (用于自动查找配置)
        """
        self.clawd_path = clawd_path
        self.config_path = config_path
        self._clients: dict[str, MCPClient] = {}
        self._tools: dict[str, MCPToolInfo] = {}  # tool_name -> MCPToolInfo
        self._tool_to_server: dict[str, str] = {}  # tool_name -> server_name
        self._lock = threading.RLock()
        self._initialized = False

        # 自动查找配置文件
        if not self.config_path and self.clawd_path:
            self.config_path = self.clawd_path / "mcp-servers.json"

    def load_config(self) -> list[MCPServerConfig]:
        """加载 MCP 服务器配置"""
        if not self.config_path or not self.config_path.exists():
            print(f"[MCPManager] Config not found: {self.config_path}")
            return []

        try:
            content = self.config_path.read_text(encoding='utf-8')
            data = json.loads(content)

            configs = []
            servers = data.get("servers", data.get("mcpServers", {}))

            for name, server_config in servers.items():
                if not server_config.get("enabled", True):
                    print(f"[MCPManager] Skipping disabled server: {name}")
                    continue

                transport_type = server_config.get("transportType", "stdio")
                url = server_config.get("url", "")

                config = MCPServerConfig(
                    name=name,
                    command=server_config.get("command", ""),
                    args=server_config.get("args", []),
                    env=server_config.get("env", {}),
                    enabled=server_config.get("enabled", True),
                    transport_type=transport_type,
                    url=url,
                )

                # stdio 模式需要 command，sse 模式需要 url
                if transport_type == "sse":
                    if config.url:
                        configs.append(config)
                        print(f"[MCPManager] Loaded SSE server: {name} -> {config.url}")
                    else:
                        print(f"[MCPManager] Invalid SSE config for {name}: missing url")
                else:
                    if config.command:
                        configs.append(config)
                    else:
                        print(f"[MCPManager] Invalid stdio config for {name}: missing command")

            print(f"[MCPManager] Loaded {len(configs)} server config(s)")
            return configs

        except json.JSONDecodeError as e:
            print(f"[MCPManager] Invalid JSON in config: {e}")
            return []
        except Exception as e:
            print(f"[MCPManager] Failed to load config: {e}")
            return []

    def initialize_all(self) -> int:
        """
        初始化所有配置的 MCP 服务器

        Returns:
            成功连接的服务器数量
        """
        configs = self.load_config()
        if not configs:
            return 0

        success_count = 0

        for config in configs:
            try:
                client = MCPClient(config)
                if client.connect():
                    with self._lock:
                        self._clients[config.name] = client

                    # 获取工具列表
                    tools = client.list_tools()
                    self._register_tools(config.name, tools)
                    success_count += 1
                else:
                    print(f"[MCPManager] Failed to connect to {config.name}")
            except Exception as e:
                print(f"[MCPManager] Error initializing {config.name}: {e}")

        self._initialized = True
        print(f"[MCPManager] Initialized {success_count}/{len(configs)} server(s), {len(self._tools)} tool(s) available")
        return success_count

    def _register_tools(self, server_name: str, tools: list[MCPTool]):
        """注册服务器提供的工具"""
        with self._lock:
            for tool in tools:
                # 使用 server_name:tool_name 作为唯一标识，避免冲突
                qualified_name = f"mcp_{server_name}_{tool.name}"

                # 检查是否有重名工具
                if tool.name in self._tool_to_server:
                    existing_server = self._tool_to_server[tool.name]
                    print(f"[MCPManager] WARNING: Tool '{tool.name}' conflict - already registered from '{existing_server}', "
                          f"new registration from '{server_name}' will use qualified name '{qualified_name}'")
                    tool_key = qualified_name
                else:
                    # 短名称可用
                    tool_key = tool.name
                    self._tool_to_server[tool.name] = server_name

                self._tools[tool_key] = MCPToolInfo(
                    name=tool_key,
                    server_name=server_name,
                    description=tool.description,
                    input_schema=tool.input_schema
                )

                print(f"[MCPManager] Registered tool: {tool_key} (from {server_name})")

    def get_all_tools(self) -> list[dict]:
        """获取所有 MCP 工具信息 (用于 ToolRegistry)"""
        with self._lock:
            return [info.to_dict() for info in self._tools.values()]

    def get_tool_info(self, tool_name: str) -> Optional[MCPToolInfo]:
        """获取工具信息"""
        with self._lock:
            return self._tools.get(tool_name)

    def is_mcp_tool(self, tool_name: str) -> bool:
        """检查是否为 MCP 工具"""
        with self._lock:
            return tool_name in self._tools

    def call_tool(self, tool_name: str, arguments: dict, timeout: float = 30) -> Any:
        """
        调用 MCP 工具

        Args:
            tool_name: 工具名称 (短名称或 qualified 名称)
            arguments: 工具参数
            timeout: 超时时间

        Returns:
            工具执行结果
        """
        with self._lock:
            tool_info = self._tools.get(tool_name)
            if not tool_info:
                raise ValueError(f"MCP tool not found: {tool_name}")

            server_name = tool_info.server_name
            client = self._clients.get(server_name)

            if not client:
                raise ValueError(f"MCP server not connected: {server_name}")

        # 如果使用的是 qualified name，需要提取原始工具名
        original_tool_name = tool_name
        if tool_name.startswith(f"mcp_{server_name}_"):
            original_tool_name = tool_name[len(f"mcp_{server_name}_"):]

        # 锁外调用（避免死锁），捕获可能的断连异常
        try:
            return client.call_tool(original_tool_name, arguments, timeout=timeout)
        except Exception as e:
            err_msg = str(e).lower()
            if 'not connected' in err_msg or 'closed' in err_msg or 'disconnected' in err_msg:
                raise ValueError(f"MCP server '{server_name}' disconnected during tool call: {e}")
            raise

    def get_server_status(self) -> dict:
        """获取所有服务器状态"""
        status = {}
        with self._lock:
            for name, client in self._clients.items():
                status[name] = {
                    "connected": client.connected,
                    "tools": len([t for t in self._tools.values() if t.server_name == name])
                }
        return status

    def reconnect_server(self, server_name: str) -> bool:
        """重新连接指定服务器"""
        with self._lock:
            client = self._clients.get(server_name)
            if not client:
                return False

            # 断开现有连接
            client.disconnect()

            # 移除该服务器的工具
            tools_to_remove = [
                name for name, info in self._tools.items()
                if info.server_name == server_name
            ]
            for tool_name in tools_to_remove:
                del self._tools[tool_name]
                if tool_name in self._tool_to_server:
                    del self._tool_to_server[tool_name]

        # 重新连接
        if client.connect():
            tools = client.list_tools()
            self._register_tools(server_name, tools)
            return True

        return False

    def shutdown_all(self):
        """关闭所有 MCP 服务器连接"""
        with self._lock:
            for name, client in self._clients.items():
                try:
                    client.disconnect()
                except Exception as e:
                    print(f"[MCPManager] Error disconnecting {name}: {e}")

            self._clients.clear()
            self._tools.clear()
            self._tool_to_server.clear()
            self._initialized = False

        print("[MCPManager] All connections closed")

    def reload_config(self) -> int:
        """重新加载配置并重新初始化"""
        self.shutdown_all()
        return self.initialize_all()

# 单例管理器 (可选)
_global_manager: Optional[MCPClientManager] = None

def get_manager() -> Optional[MCPClientManager]:
    """获取全局 MCP 管理器实例"""
    return _global_manager

def init_global_manager(clawd_path: Path) -> MCPClientManager:
    """初始化全局 MCP 管理器"""
    global _global_manager
    _global_manager = MCPClientManager(clawd_path=clawd_path)
    return _global_manager

# 简单测试
if __name__ == "__main__":
    import sys

    # 测试配置路径
    if len(sys.argv) > 1:
        config_path = Path(sys.argv[1])
    else:
        config_path = Path("mcp-servers.json")

    manager = MCPClientManager(config_path=config_path)
    count = manager.initialize_all()

    print(f"\nConnected to {count} server(s)")
    print(f"Available tools: {[t['name'] for t in manager.get_all_tools()]}")
    print(f"Server status: {manager.get_server_status()}")

    manager.shutdown_all()
