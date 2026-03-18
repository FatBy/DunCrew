#!/usr/bin/env python3
"""
MCP Client - Model Context Protocol 客户端实现

实现 JSON-RPC 2.0 over stdio 与 MCP 服务器通信。
支持 tools/list, tools/call 等核心方法。

协议参考: https://modelcontextprotocol.io/specification
"""

import json
import os
import subprocess
import threading
import queue
import time
from typing import Any, Optional
from dataclasses import dataclass, field


# MCP 协议版本
MCP_PROTOCOL_VERSION = "2024-11-05"

# 超时配置
DEFAULT_TIMEOUT = 30  # 默认请求超时(秒)
CONNECT_TIMEOUT = 15  # 连接超时(秒)


@dataclass
class MCPTool:
    """MCP 工具定义"""
    name: str
    description: str = ""
    input_schema: dict = field(default_factory=dict)
    server_name: str = ""  # 来源服务器


@dataclass
class MCPServerConfig:
    """MCP 服务器配置"""
    name: str
    command: str
    args: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    enabled: bool = True


class MCPError(Exception):
    """MCP 协议错误"""
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"MCP Error {code}: {message}")


class MCPClient:
    """
    MCP 客户端 - 与单个 MCP 服务器通信
    
    使用 stdio 传输层，通过子进程与 MCP 服务器交互。
    支持 JSON-RPC 2.0 协议。
    """
    
    def __init__(self, config: MCPServerConfig):
        self.config = config
        self.name = config.name
        self._process: Optional[subprocess.Popen] = None
        self._request_id = 0
        self._lock = threading.Lock()
        self._response_queue: dict[int, queue.Queue] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._running = False
        self._connected = False
        self._tools: list[MCPTool] = []
        self._server_info: dict = {}
        
    @property
    def connected(self) -> bool:
        return self._connected and self._process is not None and self._process.poll() is None
    
    def connect(self) -> bool:
        """启动 MCP 服务器进程并完成初始化握手"""
        if self.connected:
            return True
            
        try:
            # 构建环境变量
            env = os.environ.copy()
            for key, value in self.config.env.items():
                # 支持 ${VAR} 语法从环境变量读取
                if isinstance(value, str) and value.startswith('${') and value.endswith('}'):
                    env_key = value[2:-1]
                    env[key] = os.environ.get(env_key, '')
                else:
                    env[key] = str(value)
            
            # 启动子进程
            cmd = [self.config.command] + self.config.args
            print(f"[MCPClient:{self.name}] Starting: {' '.join(cmd)}")
            
            self._process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                bufsize=0,  # 无缓冲
            )
            
            # 启动读取线程
            self._running = True
            self._reader_thread = threading.Thread(
                target=self._read_responses,
                daemon=True,
                name=f"mcp-reader-{self.name}"
            )
            self._reader_thread.start()
            
            # 发送 initialize 请求
            init_result = self._send_request("initialize", {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {
                    "roots": {"listChanged": True},
                },
                "clientInfo": {
                    "name": "DunCrew",
                    "version": "4.0.0"
                }
            }, timeout=CONNECT_TIMEOUT)
            
            if init_result:
                self._server_info = init_result
                # 发送 initialized 通知
                self._send_notification("notifications/initialized", {})
                self._connected = True
                print(f"[MCPClient:{self.name}] Connected to {init_result.get('serverInfo', {}).get('name', 'unknown')}")
                return True
            else:
                self.disconnect()
                return False
                
        except Exception as e:
            print(f"[MCPClient:{self.name}] Connection failed: {e}")
            self.disconnect()
            return False
    
    def disconnect(self):
        """关闭与 MCP 服务器的连接"""
        self._running = False
        self._connected = False
        
        if self._process:
            try:
                self._process.terminate()
                self._process.wait(timeout=5)
            except:
                try:
                    self._process.kill()
                except:
                    pass
            self._process = None
        
        self._tools.clear()
        print(f"[MCPClient:{self.name}] Disconnected")
    
    def list_tools(self) -> list[MCPTool]:
        """获取服务器提供的工具列表"""
        if not self.connected:
            if not self.connect():
                return []
        
        try:
            result = self._send_request("tools/list", {})
            if result and "tools" in result:
                self._tools = []
                for tool_data in result["tools"]:
                    tool = MCPTool(
                        name=tool_data.get("name", ""),
                        description=tool_data.get("description", ""),
                        input_schema=tool_data.get("inputSchema", {}),
                        server_name=self.name
                    )
                    self._tools.append(tool)
                return self._tools
        except MCPError as e:
            print(f"[MCPClient:{self.name}] list_tools error: {e}")
        except Exception as e:
            print(f"[MCPClient:{self.name}] list_tools failed: {e}")
        
        return []
    
    def call_tool(self, tool_name: str, arguments: dict, timeout: float = DEFAULT_TIMEOUT) -> Any:
        """
        调用 MCP 工具
        
        Args:
            tool_name: 工具名称
            arguments: 工具参数
            timeout: 超时时间(秒)
            
        Returns:
            工具执行结果
            
        Raises:
            MCPError: MCP 协议错误
            TimeoutError: 请求超时
        """
        if not self.connected:
            if not self.connect():
                raise MCPError(-1, "Not connected to MCP server")
        
        result = self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments
        }, timeout=timeout)
        
        # MCP tools/call 返回格式: { content: [...], isError?: boolean }
        if result:
            if result.get("isError"):
                error_content = result.get("content", [])
                error_text = ""
                for item in error_content:
                    if item.get("type") == "text":
                        error_text += item.get("text", "")
                raise MCPError(-2, f"Tool execution error: {error_text}")
            
            # 提取内容
            content = result.get("content", [])
            output_parts = []
            for item in content:
                if item.get("type") == "text":
                    output_parts.append(item.get("text", ""))
                elif item.get("type") == "image":
                    output_parts.append(f"[Image: {item.get('mimeType', 'image/*')}]")
                elif item.get("type") == "resource":
                    output_parts.append(f"[Resource: {item.get('uri', '')}]")
            
            return "\n".join(output_parts)
        
        return None
    
    def _next_id(self) -> int:
        """生成下一个请求 ID"""
        with self._lock:
            self._request_id += 1
            return self._request_id
    
    def _send_request(self, method: str, params: dict, timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
        """
        发送 JSON-RPC 请求并等待响应
        
        Args:
            method: RPC 方法名
            params: 参数字典
            timeout: 超时时间(秒)
            
        Returns:
            响应结果
        """
        if not self._process or self._process.poll() is not None:
            raise MCPError(-1, "Process not running")
        
        request_id = self._next_id()
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        }
        
        # 创建响应队列
        response_queue: queue.Queue = queue.Queue()
        self._response_queue[request_id] = response_queue
        
        try:
            # 发送请求
            request_json = json.dumps(request) + "\n"
            self._process.stdin.write(request_json.encode('utf-8'))
            self._process.stdin.flush()
            
            # 等待响应
            try:
                response = response_queue.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"Request {method} timed out after {timeout}s")
            
            # 处理响应
            if "error" in response:
                error = response["error"]
                raise MCPError(
                    error.get("code", -1),
                    error.get("message", "Unknown error"),
                    error.get("data")
                )
            
            return response.get("result")
            
        finally:
            # 清理响应队列
            del self._response_queue[request_id]
    
    def _send_notification(self, method: str, params: dict):
        """发送 JSON-RPC 通知 (不等待响应)"""
        if not self._process or self._process.poll() is not None:
            return
        
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }
        
        try:
            notification_json = json.dumps(notification) + "\n"
            self._process.stdin.write(notification_json.encode('utf-8'))
            self._process.stdin.flush()
        except:
            pass
    
    def _read_responses(self):
        """后台线程: 持续读取服务器响应"""
        while self._running and self._process and self._process.poll() is None:
            try:
                line = self._process.stdout.readline()
                if not line:
                    time.sleep(0.01)
                    continue
                
                line = line.decode('utf-8').strip()
                if not line:
                    continue
                
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    print(f"[MCPClient:{self.name}] Invalid JSON: {line[:100]}")
                    continue
                
                # 处理响应 (有 id 字段)
                if "id" in message:
                    request_id = message["id"]
                    if request_id in self._response_queue:
                        self._response_queue[request_id].put(message)
                
                # 处理通知 (无 id 字段, 有 method 字段)
                elif "method" in message:
                    self._handle_notification(message)
                    
            except Exception as e:
                if self._running:
                    print(f"[MCPClient:{self.name}] Reader error: {e}")
                break
        
        # 进程结束，标记为未连接
        self._connected = False
    
    def _handle_notification(self, message: dict):
        """处理服务器发来的通知"""
        method = message.get("method", "")
        params = message.get("params", {})
        
        # 常见通知类型
        if method == "notifications/tools/list_changed":
            # 工具列表变更，重新获取
            print(f"[MCPClient:{self.name}] Tools list changed, refreshing...")
            threading.Thread(target=self.list_tools, daemon=True).start()
        elif method == "notifications/progress":
            # 进度通知
            progress = params.get("progress", 0)
            total = params.get("total", 100)
            print(f"[MCPClient:{self.name}] Progress: {progress}/{total}")
        else:
            # 其他通知
            print(f"[MCPClient:{self.name}] Notification: {method}")


def expand_env_vars(value: str) -> str:
    """展开环境变量 ${VAR} 格式"""
    if not isinstance(value, str):
        return value
    
    import re
    def replacer(match):
        var_name = match.group(1)
        return os.environ.get(var_name, '')
    
    return re.sub(r'\$\{(\w+)\}', replacer, value)


# 简单测试
if __name__ == "__main__":
    # 测试配置
    config = MCPServerConfig(
        name="test-filesystem",
        command="npx",
        args=["-y", "@anthropic/mcp-filesystem-server", "."],
        enabled=True
    )
    
    client = MCPClient(config)
    
    if client.connect():
        print("Connected!")
        tools = client.list_tools()
        print(f"Available tools: {[t.name for t in tools]}")
        
        # 尝试调用工具
        if tools:
            try:
                result = client.call_tool("list_directory", {"path": "."})
                print(f"Result: {result[:200]}...")
            except Exception as e:
                print(f"Tool call failed: {e}")
        
        client.disconnect()
    else:
        print("Connection failed")
