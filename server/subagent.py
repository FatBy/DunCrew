"""DunCrew Server - Subagent Manager"""
from __future__ import annotations

import re
import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, Future

from server.registry import ToolRegistry

class SubagentManager:
    """
    子代理管理器 - 支持并行探索任务
    用于 Quest 模式的探索阶段，可同时运行多个轻量级代理
    """
    MAX_CONCURRENT = 5  # 最大并发数
    AGENT_TIMEOUT = 30  # 单个代理超时(秒)
    
    def __init__(self, tool_registry: ToolRegistry):
        self.registry = tool_registry
        self.agents: dict[str, dict] = {}  # agent_id -> agent_info
        self.executor = ThreadPoolExecutor(max_workers=self.MAX_CONCURRENT)
        self.futures: dict[str, Future] = {}  # agent_id -> Future
        self.lock = threading.Lock()
    
    def spawn(self, agent_type: str, task: str, tools: list[str], context: str = '') -> str:
        """
        启动一个子代理
        
        Args:
            agent_type: 代理类型 ('explore', 'plan', 'execute')
            task: 任务描述
            tools: 可用工具列表
            context: 上下文信息
        
        Returns:
            agent_id: 代理 ID
        """
        agent_id = f"subagent-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}"
        
        agent_info = {
            'id': agent_id,
            'type': agent_type,
            'task': task,
            'tools': tools,
            'context': context,
            'status': 'pending',
            'result': None,
            'error': None,
            'started_at': time.time(),
            'completed_at': None,
        }
        
        with self.lock:
            # 检查并发限制
            running_count = sum(1 for a in self.agents.values() if a['status'] == 'running')
            if running_count >= self.MAX_CONCURRENT:
                agent_info['status'] = 'queued'
                agent_info['error'] = f'Queue full, max {self.MAX_CONCURRENT} concurrent agents'
                self.agents[agent_id] = agent_info
                return agent_id
            
            self.agents[agent_id] = agent_info
        
        # 异步执行
        future = self.executor.submit(self._run_agent, agent_id, task, tools, context)
        self.futures[agent_id] = future
        
        with self.lock:
            self.agents[agent_id]['status'] = 'running'
        
        print(f"[SubagentManager] Spawned {agent_type} agent: {agent_id}")
        return agent_id
    
    def _run_agent(self, agent_id: str, task: str, tools: list[str], context: str) -> str:
        """
        执行子代理任务 (简化版 - 单工具调用)
        
        对于探索阶段，每个子代理通常只需要调用一个工具
        """
        try:
            result_parts = []
            
            # 根据任务类型选择工具
            for tool_name in tools:
                if not self.registry.is_registered(tool_name):
                    continue
                
                # 构建工具参数
                args = self._build_tool_args(tool_name, task, context)
                
                # 执行工具
                tool_result = self._execute_tool(tool_name, args)
                
                if tool_result.get('status') == 'success':
                    result_parts.append(f"[{tool_name}] {tool_result.get('result', '')[:1000]}")
                else:
                    result_parts.append(f"[{tool_name}] Error: {tool_result.get('result', 'Unknown error')[:200]}")
            
            final_result = '\n\n'.join(result_parts) if result_parts else 'No tools executed'
            
            with self.lock:
                if agent_id in self.agents:
                    self.agents[agent_id]['status'] = 'completed'
                    self.agents[agent_id]['result'] = final_result
                    self.agents[agent_id]['completed_at'] = time.time()
            
            return final_result
            
        except Exception as e:
            error_msg = str(e)
            with self.lock:
                if agent_id in self.agents:
                    self.agents[agent_id]['status'] = 'failed'
                    self.agents[agent_id]['error'] = error_msg
                    self.agents[agent_id]['completed_at'] = time.time()
            return f"Error: {error_msg}"
    
    def _build_tool_args(self, tool_name: str, task: str, context: str) -> dict:
        """根据工具类型构建参数"""
        # MCP quest 工具的特殊处理
        if tool_name == 'mcp__quest__search_codebase':
            # 提取关键词
            keywords = self._extract_keywords(task)
            return {
                'query': task,
                'key_words': ','.join(keywords[:3]),
                'explanation': f'Exploring: {task[:50]}'
            }
        elif tool_name == 'mcp__quest__search_symbol':
            # 从任务中提取符号名
            symbols = self._extract_symbols(task)
            return {
                'queries': [{'symbol': s, 'relation': 'all'} for s in symbols[:2]],
                'explanation': f'Symbol search for: {task[:50]}'
            }
        elif tool_name == 'readFile':
            # 从上下文中提取文件路径
            paths = self._extract_file_paths(context)
            return {'path': paths[0] if paths else ''}
        elif tool_name == 'listDir':
            return {'path': '.', 'recursive': False}
        else:
            return {'query': task}
    
    def _extract_keywords(self, text: str) -> list[str]:
        """从文本中提取关键词"""
        # 简单实现：提取英文单词和中文词组
        words = re.findall(r'[a-zA-Z_][a-zA-Z0-9_]*|[\u4e00-\u9fff]+', text)
        # 过滤常见词
        stopwords = {'the', 'a', 'an', 'is', 'are', 'to', 'for', 'of', 'in', 'on', 'with', '的', '是', '在', '和', '了'}
        return [w for w in words if w.lower() not in stopwords and len(w) > 1][:5]
    
    def _extract_symbols(self, text: str) -> list[str]:
        """从文本中提取可能的符号名（函数名、类名等）"""
        # 匹配驼峰命名和下划线命名
        symbols = re.findall(r'\b([A-Z][a-zA-Z0-9]*|[a-z][a-zA-Z0-9]*(?:_[a-zA-Z0-9]+)+)\b', text)
        return list(set(symbols))[:3]
    
    def _extract_file_paths(self, text: str) -> list[str]:
        """从文本中提取文件路径"""
        paths = re.findall(r'[a-zA-Z0-9_./\\-]+\.[a-zA-Z]+', text)
        return paths[:3]
    
    def _execute_tool(self, tool_name: str, args: dict) -> dict:
        """执行单个工具"""
        # 检查 MCP 工具
        if tool_name.startswith('mcp__') and self.registry.mcp_manager:
            try:
                result = self.registry.mcp_manager.call_tool(tool_name, args)
                return {'status': 'success', 'result': str(result)[:2000]}
            except Exception as e:
                return {'status': 'error', 'result': str(e)}
        
        # 内置工具需要通过 handler 执行，这里返回占位
        return {'status': 'error', 'result': f'Tool {tool_name} not directly executable in subagent'}
    
    def get_status(self, agent_id: str) -> dict | None:
        """获取子代理状态"""
        with self.lock:
            return self.agents.get(agent_id)
    
    def get_all_status(self) -> list[dict]:
        """获取所有子代理状态"""
        with self.lock:
            return list(self.agents.values())
    
    def collect_results(self, agent_ids: list[str], timeout: float = 60.0) -> list[dict]:
        """
        收集多个子代理的结果
        
        Args:
            agent_ids: 要收集的代理 ID 列表
            timeout: 等待超时时间(秒)
        
        Returns:
            结果列表
        """
        results = []
        deadline = time.time() + timeout
        
        for agent_id in agent_ids:
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            
            future = self.futures.get(agent_id)
            if future:
                try:
                    future.result(timeout=remaining)
                except Exception:
                    pass
            
            with self.lock:
                agent = self.agents.get(agent_id)
                if agent:
                    results.append({
                        'id': agent_id,
                        'type': agent['type'],
                        'task': agent['task'],
                        'status': agent['status'],
                        'result': agent.get('result'),
                        'error': agent.get('error'),
                    })
        
        return results
    
    def cleanup_old_agents(self, max_age: float = 300.0):
        """清理超过指定时间的旧代理记录"""
        cutoff = time.time() - max_age
        with self.lock:
            to_remove = [
                aid for aid, agent in self.agents.items()
                if agent.get('completed_at', 0) < cutoff and agent['status'] in ('completed', 'failed')
            ]
            for aid in to_remove:
                del self.agents[aid]
                self.futures.pop(aid, None)
        
        if to_remove:
            print(f"[SubagentManager] Cleaned up {len(to_remove)} old agents")


# ============================================
# 🌐 浏览器自动化管理器 (Playwright)
# ============================================


