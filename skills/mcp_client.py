#!/usr/bin/env python3
"""
MCP Client - Model Context Protocol 客户端实现

实现 JSON-RPC 2.0 over stdio/SSE 与 MCP 服务器通信。
支持 tools/list, tools/call 等核心方法。

传输层:
- stdio: 通过子进程标准输入/输出与本地 MCP 服务器通信
- sse: 通过 HTTP Server-Sent Events 与远程 MCP 服务器通信

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
from urllib.parse import urlparse

# 尝试导入 SSE 传输依赖（可选）
try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False

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
    command: str = ""
    args: list = field(default_factory=list)
    env: dict = field(default_factory=dict)
    enabled: bool = True
    transport_type: str = "stdio"  # "stdio" 或 "sse"
    url: str = ""  # SSE 模式的服务器 URL

class MCPError(Exception):
    """MCP 协议错误"""
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"MCP Error {code}: {message}")


# ============================================
# Streamable HTTP 传输客户端
# ============================================

class MCPStreamableHTTPClient:
    """
    MCP Streamable HTTP 传输客户端

    适用于钉钉等使用较新 MCP 传输协议的服务器。
    协议流程:
    1. 客户端通过 POST {url} 发送 JSON-RPC 消息 (带 Accept: application/json, text/event-stream)
    2. 服务器直接返回 JSON 响应，或通过 SSE 流返回
    """

    def __init__(self, url: str, name: str = "streamable-http"):
        self.url = url
        self.name = name
        self._connected_event = threading.Event()
        self._request_id = 0
        self._lock = threading.Lock()
        self._session_id: Optional[str] = None

    @property
    def connected(self) -> bool:
        return self._connected_event.is_set()

    def connect(self) -> bool:
        """验证服务器可达（Streamable HTTP 无需持久连接）"""
        if not HAS_HTTPX:
            print(f"[MCPStreamableHTTP:{self.name}] Requires 'httpx'. Install: pip install httpx")
            return False
        self._connected_event.set()
        return True

    def disconnect(self):
        """断开连接"""
        self._connected_event.clear()
        self._session_id = None
        print(f"[MCPStreamableHTTP:{self.name}] Disconnected")

    def send_request(self, method: str, params: dict, timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
        """发送 JSON-RPC 请求，支持 JSON 和 SSE 两种响应格式"""
        with self._lock:
            self._request_id += 1
            request_id = self._request_id

        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        }

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id

        try:
            with httpx.Client(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
                response = client.post(self.url, json=request, headers=headers)

            if response.status_code not in (200, 202, 204):
                raise MCPError(-1, f"HTTP {response.status_code}: {response.text[:200]}")

            # 保存 session id
            session_id = response.headers.get("mcp-session-id")
            if session_id:
                self._session_id = session_id

            # 204 No Content
            if response.status_code == 204 or not response.text.strip():
                return None

            content_type = response.headers.get("content-type", "")

            # JSON 响应
            if "application/json" in content_type:
                result = response.json()
                if "error" in result:
                    error = result["error"]
                    raise MCPError(
                        error.get("code", -1),
                        error.get("message", "Unknown error"),
                        error.get("data")
                    )
                return result.get("result")

            # SSE 响应：解析 event stream 提取最终结果
            if "text/event-stream" in content_type:
                return self._parse_sse_response(response.text, request_id)

            # 尝试直接解析 JSON
            try:
                result = response.json()
                if "error" in result:
                    error = result["error"]
                    raise MCPError(
                        error.get("code", -1),
                        error.get("message", "Unknown error"),
                        error.get("data")
                    )
                return result.get("result")
            except Exception:
                raise MCPError(-1, f"Unexpected content-type: {content_type}")

        except (MCPError, TimeoutError):
            raise
        except httpx.TimeoutException:
            raise TimeoutError(f"Request {method} timed out after {timeout}s")
        except Exception as e:
            raise MCPError(-1, f"Streamable HTTP request failed: {e}")

    def send_notification(self, method: str, params: dict):
        """发送 JSON-RPC 通知（不等待响应）"""
        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }

        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id

        try:
            with httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
                client.post(self.url, json=notification, headers=headers)
        except Exception as e:
            print(f"[MCPStreamableHTTP:{self.name}] Notification failed: {e}")

    def _parse_sse_response(self, text: str, request_id: int) -> Optional[dict]:
        """从 SSE 响应文本中提取 JSON-RPC 结果"""
        last_result = None
        event_data_lines: list[str] = []

        for line in text.splitlines():
            if line.startswith("data:"):
                event_data_lines.append(line[5:].strip())
            elif line == "" and event_data_lines:
                data_str = "\n".join(event_data_lines)
                event_data_lines = []
                try:
                    message = json.loads(data_str)
                    if message.get("id") == request_id:
                        if "error" in message:
                            error = message["error"]
                            raise MCPError(
                                error.get("code", -1),
                                error.get("message", "Unknown error"),
                                error.get("data")
                            )
                        last_result = message.get("result")
                except json.JSONDecodeError:
                    continue

        return last_result


# ============================================
# SSE 传输客户端
# ============================================

class MCPSSEClient:
    """
    MCP SSE 传输客户端

    MCP SSE 协议流程:
    1. GET {url} 建立 SSE 连接，服务器发送 'endpoint' 事件，包含 POST 消息的 URL
    2. 客户端通过 POST {endpoint} 发送 JSON-RPC 消息
    3. 服务器通过 SSE 流返回 JSON-RPC 响应（'message' 事件）
    """

    def __init__(self, url: str, name: str = "sse"):
        self.url = url.rstrip('/')
        self.name = name
        self._endpoint: Optional[str] = None
        self._sse_thread: Optional[threading.Thread] = None
        self._running = False
        self._connected_event = threading.Event()
        self._request_id = 0
        self._lock = threading.Lock()
        self._response_queues: dict[int, queue.Queue] = {}
        self._endpoint_ready = threading.Event()

    @property
    def connected(self) -> bool:
        return self._connected_event.is_set() and self._endpoint is not None

    def connect(self) -> bool:
        """建立 SSE 连接并获取消息 endpoint"""
        if not HAS_HTTPX:
            print(f"[MCPSSEClient:{self.name}] SSE transport requires 'httpx'. Install: pip install httpx")
            return False

        try:
            self._running = True
            self._endpoint_ready.clear()

            # 启动 SSE 监听线程
            self._sse_thread = threading.Thread(
                target=self._sse_listener,
                daemon=True,
                name=f"mcp-sse-{self.name}"
            )
            self._sse_thread.start()

            # 等待 endpoint 事件
            if not self._endpoint_ready.wait(timeout=CONNECT_TIMEOUT):
                print(f"[MCPSSEClient:{self.name}] Timeout waiting for endpoint event")
                self.disconnect()
                return False

            self._connected_event.set()
            print(f"[MCPSSEClient:{self.name}] Connected, endpoint: {self._endpoint}")
            return True

        except Exception as e:
            print(f"[MCPSSEClient:{self.name}] Connect failed: {e}")
            self.disconnect()
            return False

    def disconnect(self):
        """关闭 SSE 连接"""
        self._running = False
        self._connected_event.clear()
        self._endpoint = None
        print(f"[MCPSSEClient:{self.name}] Disconnected")

    def send_request(self, method: str, params: dict, timeout: float = DEFAULT_TIMEOUT) -> Optional[dict]:
        """发送 JSON-RPC 请求并等待响应"""
        if not self._endpoint:
            raise MCPError(-1, "SSE not connected: no endpoint")

        with self._lock:
            self._request_id += 1
            request_id = self._request_id

        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params
        }

        # 创建响应队列
        response_queue: queue.Queue = queue.Queue()
        self._response_queues[request_id] = response_queue

        try:
            # POST 请求到 endpoint
            with httpx.Client(timeout=httpx.Timeout(timeout, connect=15.0)) as client:
                http_response = client.post(
                    self._endpoint,
                    json=request,
                    headers={"Content-Type": "application/json"}
                )

            if http_response.status_code not in (200, 202, 204):
                raise MCPError(-1, f"HTTP {http_response.status_code}: {http_response.text[:200]}")

            # 等待 SSE 流中的响应
            try:
                result = response_queue.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"Request {method} timed out after {timeout}s")

            if "error" in result:
                error = result["error"]
                raise MCPError(
                    error.get("code", -1),
                    error.get("message", "Unknown error"),
                    error.get("data")
                )

            return result.get("result")

        finally:
            self._response_queues.pop(request_id, None)

    def send_notification(self, method: str, params: dict):
        """发送 JSON-RPC 通知（不等待响应）"""
        if not self._endpoint:
            return

        notification = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }

        try:
            with httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
                client.post(
                    self._endpoint,
                    json=notification,
                    headers={"Content-Type": "application/json"}
                )
        except Exception as e:
            print(f"[MCPSSEClient:{self.name}] Notification failed: {e}")

    def _sse_listener(self):
        """后台线程：监听 SSE 事件流"""
        try:
            with httpx.Client(timeout=httpx.Timeout(None, connect=15.0)) as stream_client:
                with stream_client.stream("GET", self.url, headers={"Accept": "text/event-stream"}) as response:
                    if response.status_code != 200:
                        print(f"[MCPSSEClient:{self.name}] SSE connection failed: HTTP {response.status_code}")
                        return

                    event_type = ""
                    event_data_lines: list[str] = []

                    for line in response.iter_lines():
                        if not self._running:
                            break

                        if line.startswith("event:"):
                            event_type = line[6:].strip()
                        elif line.startswith("data:"):
                            event_data_lines.append(line[5:].strip())
                        elif line == "":
                            # 空行表示事件结束
                            if event_type and event_data_lines:
                                event_data = "\n".join(event_data_lines)
                                self._handle_sse_event(event_type, event_data)
                            event_type = ""
                            event_data_lines = []

        except Exception as e:
            if self._running:
                print(f"[MCPSSEClient:{self.name}] SSE listener error: {e}")
        finally:
            self._connected_event.clear()

    def _handle_sse_event(self, event_type: str, data: str):
        """处理 SSE 事件"""
        if event_type == "endpoint":
            # 服务器告知消息 POST 的 endpoint URL
            endpoint = data.strip()
            # 如果是相对路径，拼接基础 URL
            if endpoint.startswith("/"):
                parsed = urlparse(self.url)
                endpoint = f"{parsed.scheme}://{parsed.netloc}{endpoint}"
            self._endpoint = endpoint
            self._endpoint_ready.set()
            print(f"[MCPSSEClient:{self.name}] Got endpoint: {endpoint}")

        elif event_type == "message":
            # JSON-RPC 响应消息
            try:
                message = json.loads(data)
                if "id" in message and message["id"] in self._response_queues:
                    self._response_queues[message["id"]].put(message)
                elif "method" in message:
                    print(f"[MCPSSEClient:{self.name}] Server notification: {message.get('method')}")
            except json.JSONDecodeError:
                print(f"[MCPSSEClient:{self.name}] Invalid JSON in SSE message: {data[:100]}")


# ============================================
# MCP 客户端（支持 stdio 和 SSE 两种传输）
# ============================================

class MCPClient:
    """
    MCP 客户端 - 与单个 MCP 服务器通信

    支持三种传输层:
    - stdio: 通过子进程与本地 MCP 服务器交互
    - sse: 通过 HTTP SSE 与远程 MCP 服务器交互
    - streamable-http: 通过 HTTP POST 与远程 MCP 服务器交互（SSE 失败时自动回退）
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
        self._connected_event = threading.Event()
        self._tools: list[MCPTool] = []
        self._server_info: dict = {}
        # SSE / Streamable HTTP 模式专用
        self._sse_client: Optional[MCPSSEClient] = None
        self._streamable_client: Optional[MCPStreamableHTTPClient] = None

    @property
    def connected(self) -> bool:
        if self._streamable_client:
            return self._connected_event.is_set() and self._streamable_client.connected
        if self.config.transport_type == "sse":
            return self._connected_event.is_set() and self._sse_client is not None and self._sse_client.connected
        return self._connected_event.is_set() and self._process is not None and self._process.poll() is None

    def connect(self) -> bool:
        """连接到 MCP 服务器（根据传输类型自动选择）"""
        if self.connected:
            return True
        if self.config.transport_type == "sse":
            return self._connect_sse()
        return self._connect_stdio()

    def _connect_sse(self) -> bool:
        """通过 SSE 或 Streamable HTTP 传输连接远程 MCP 服务器（SSE 失败自动回退）"""
        if not HAS_HTTPX:
            print(f"[MCPClient:{self.name}] SSE/HTTP transport requires 'httpx'. Install: pip install httpx")
            return False

        if not self.config.url:
            print(f"[MCPClient:{self.name}] SSE/HTTP transport requires a URL")
            return False

        # 尝试 1: 标准 SSE 传输
        try:
            self._sse_client = MCPSSEClient(self.config.url, self.name)
            if self._sse_client.connect():
                init_result = self._sse_client.send_request("initialize", {
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
                    self._sse_client.send_notification("notifications/initialized", {})
                    self._connected_event.set()
                    server_name = init_result.get('serverInfo', {}).get('name', 'unknown')
                    print(f"[MCPClient:{self.name}] Connected via SSE to {server_name}")
                    return True
        except Exception as e:
            print(f"[MCPClient:{self.name}] SSE attempt failed: {e}")

        # 清理 SSE 客户端
        if self._sse_client:
            self._sse_client.disconnect()
            self._sse_client = None

        # 尝试 2: Streamable HTTP 传输（自动回退）
        print(f"[MCPClient:{self.name}] SSE failed, trying Streamable HTTP...")
        return self._connect_streamable_http()

    def _connect_streamable_http(self) -> bool:
        """通过 Streamable HTTP 传输连接远程 MCP 服务器"""
        try:
            self._streamable_client = MCPStreamableHTTPClient(self.config.url, self.name)
            if not self._streamable_client.connect():
                self._streamable_client = None
                return False

            init_result = self._streamable_client.send_request("initialize", {
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
                self._streamable_client.send_notification("notifications/initialized", {})
                self._connected_event.set()
                server_name = init_result.get('serverInfo', {}).get('name', 'unknown')
                print(f"[MCPClient:{self.name}] Connected via Streamable HTTP to {server_name}")
                return True

            print(f"[MCPClient:{self.name}] Streamable HTTP initialize returned None")
            self._streamable_client.disconnect()
            self._streamable_client = None
            return False

        except Exception as e:
            print(f"[MCPClient:{self.name}] Streamable HTTP connection failed: {e}")
            if self._streamable_client:
                self._streamable_client.disconnect()
                self._streamable_client = None
            return False

    def _connect_stdio(self) -> bool:
        """通过 stdio 传输连接本地 MCP 服务器"""
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
                self._connected_event.set()
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
        self._connected_event.clear()

        # Streamable HTTP 模式清理
        if self._streamable_client:
            self._streamable_client.disconnect()
            self._streamable_client = None

        # SSE 模式清理
        if self._sse_client:
            self._sse_client.disconnect()
            self._sse_client = None

        # stdio 模式清理
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
            if self._streamable_client:
                result = self._streamable_client.send_request("tools/list", {})
            elif self.config.transport_type == "sse" and self._sse_client:
                result = self._sse_client.send_request("tools/list", {})
            else:
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

        if self._streamable_client:
            result = self._streamable_client.send_request("tools/call", {
                "name": tool_name,
                "arguments": arguments
            }, timeout=timeout)
        elif self.config.transport_type == "sse" and self._sse_client:
            result = self._sse_client.send_request("tools/call", {
                "name": tool_name,
                "arguments": arguments
            }, timeout=timeout)
        else:
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
        发送 JSON-RPC 请求并等待响应（stdio 模式）

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
        """发送 JSON-RPC 通知 (不等待响应, stdio 模式)"""
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
        """后台线程: 持续读取服务器响应 (stdio 模式)"""
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
        self._connected_event.clear()

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
