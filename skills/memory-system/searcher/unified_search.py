#!/usr/bin/env python3
"""
Unified memory search across all sources.
Searches daily logs, persistent memory, SOP patterns, and execution traces.
"""

import os
import json
import re
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional


class UnifiedSearch:
    """Search across all memory sources."""
    
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.memory_dir = self.project_root / 'memory'
        self.db_path = self.project_root / '.duncrew' / 'memory_index.db'
        self._ensure_dirs()
    
    def _ensure_dirs(self):
        """Ensure necessary directories exist."""
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
    
    def search(
        self,
        query: str,
        sources: Optional[List[str]] = None,
        tags: Optional[List[str]] = None,
        limit: int = 10,
        days: int = 7
    ) -> List[Dict[str, Any]]:
        """
        Search across all memory sources.
        
        Args:
            query: Search query
            sources: List of sources to search (daily, persistent, sop, trace)
            tags: Filter by tags
            limit: Maximum results
            days: Days to search back for daily logs
            
        Returns:
            List of search results sorted by relevance
        """
        if sources is None:
            sources = ['daily', 'persistent', 'sop', 'trace']
        
        results = []
        
        # Search each source
        if 'daily' in sources:
            results.extend(self._search_daily(query, days, limit))
        
        if 'persistent' in sources:
            results.extend(self._search_persistent(query, limit))
        
        if 'sop' in sources:
            results.extend(self._search_sop(query, limit))
        
        if 'trace' in sources:
            results.extend(self._search_traces(query, limit))
        
        # Filter by tags if specified
        if tags:
            results = [r for r in results if self._matches_tags(r, tags)]
        
        # Calculate relevance scores
        for r in results:
            r['relevance'] = self._calculate_relevance(query, r)
        
        # Sort by relevance and limit
        results.sort(key=lambda x: x['relevance'], reverse=True)
        return results[:limit]
    
    def _search_daily(self, query: str, days: int, limit: int) -> List[Dict[str, Any]]:
        """Search daily log files."""
        results = []
        query_lower = query.lower()
        
        # Get date range
        today = datetime.now()
        
        for i in range(days):
            date = today - timedelta(days=i)
            date_str = date.strftime('%Y-%m-%d')
            log_file = self.memory_dir / f'{date_str}.md'
            
            if not log_file.exists():
                continue
            
            try:
                content = log_file.read_text(encoding='utf-8')
                lines = content.split('\n')
                
                for j, line in enumerate(lines):
                    if query_lower in line.lower():
                        # Extract context
                        start = max(0, j - 1)
                        end = min(len(lines), j + 2)
                        context = '\n'.join(lines[start:end])
                        
                        results.append({
                            'source': 'daily',
                            'date': date_str,
                            'line': j + 1,
                            'content': line.strip(),
                            'context': context.strip(),
                            'file': str(log_file.relative_to(self.project_root)),
                            'tags': self._extract_tags(line),
                        })
                        
                        if len(results) >= limit * 2:
                            break
                            
            except Exception:
                continue
        
        return results
    
    def _search_persistent(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search MEMORY.md persistent memory."""
        results = []
        query_lower = query.lower()
        
        memory_file = self.project_root / 'MEMORY.md'
        if not memory_file.exists():
            return results
        
        try:
            content = memory_file.read_text(encoding='utf-8')
            
            # Split into entries (lines starting with -)
            entries = []
            current_entry = []
            
            for line in content.split('\n'):
                if line.strip().startswith('- '):
                    if current_entry:
                        entries.append('\n'.join(current_entry))
                    current_entry = [line]
                elif current_entry:
                    current_entry.append(line)
            
            if current_entry:
                entries.append('\n'.join(current_entry))
            
            # Search entries
            for i, entry in enumerate(entries):
                if query_lower in entry.lower():
                    # Extract timestamp if present
                    timestamp_match = re.search(r'\((\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2})', entry)
                    timestamp = timestamp_match.group(1) if timestamp_match else None
                    
                    results.append({
                        'source': 'persistent',
                        'id': f'persistent-{i}',
                        'content': entry.strip(),
                        'timestamp': timestamp,
                        'tags': self._extract_tags(entry),
                        'file': 'MEMORY.md',
                    })
                    
                    if len(results) >= limit:
                        break
                        
        except Exception:
            pass
        
        return results
    
    def _search_sop(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search SOP (Standard Operating Procedure) patterns."""
        results = []
        query_lower = query.lower()
        
        # SOP entries are marked with #SOP in MEMORY.md
        memory_file = self.project_root / 'MEMORY.md'
        if not memory_file.exists():
            return results
        
        try:
            content = memory_file.read_text(encoding='utf-8')
            
            # Find #SOP entries
            sop_pattern = re.compile(r'#SOP\s+任务:\s*"([^"]+)".*?步骤:\s*(.+?)(?=\n\n|\n-|\Z)', re.DOTALL)
            
            for match in sop_pattern.finditer(content):
                task = match.group(1)
                steps = match.group(2).strip()
                
                if query_lower in task.lower() or query_lower in steps.lower():
                    results.append({
                        'source': 'sop',
                        'task': task,
                        'steps': steps,
                        'content': f'任务: {task}\n步骤: {steps}',
                        'tags': ['#SOP'],
                    })
                    
                    if len(results) >= limit:
                        break
                        
        except Exception:
            pass
        
        return results
    
    def _search_traces(self, query: str, limit: int) -> List[Dict[str, Any]]:
        """Search execution traces."""
        results = []
        query_lower = query.lower()
        
        traces_dir = self.memory_dir / 'exec_traces'
        if not traces_dir.exists():
            return results
        
        # Get recent trace files (last 6 months)
        trace_files = sorted(traces_dir.glob('*.jsonl'), reverse=True)[:6]
        
        for trace_file in trace_files:
            try:
                with open(trace_file, 'r', encoding='utf-8') as f:
                    for line in f:
                        if not line.strip():
                            continue
                        
                        try:
                            trace = json.loads(line)
                            task = trace.get('task', '')
                            tags = trace.get('tags', [])
                            
                            # Check if query matches task or tags
                            if query_lower in task.lower() or any(query_lower in t.lower() for t in tags):
                                # Format tools sequence
                                tools = trace.get('tools', [])
                                tool_seq = ' → '.join([t.get('name', '') for t in tools])
                                
                                results.append({
                                    'source': 'trace',
                                    'task': task,
                                    'tools': tool_seq,
                                    'success': trace.get('success', False),
                                    'duration': trace.get('duration', 0),
                                    'timestamp': trace.get('timestamp'),
                                    'content': f'任务: {task}\n工具序列: {tool_seq}',
                                    'tags': tags,
                                })
                                
                                if len(results) >= limit:
                                    break
                                    
                        except json.JSONDecodeError:
                            continue
                            
            except Exception:
                continue
            
            if len(results) >= limit:
                break
        
        return results
    
    def _extract_tags(self, text: str) -> List[str]:
        """Extract tags from text (format: [tag1, tag2] or #tag)."""
        tags = []
        
        # Extract [tag1, tag2] format
        bracket_match = re.search(r'\[([^\]]+)\]', text)
        if bracket_match:
            tags.extend([t.strip() for t in bracket_match.group(1).split(',')])
        
        # Extract #tag format
        hashtags = re.findall(r'#(\w+)', text)
        tags.extend(hashtags)
        
        return list(set(tags))
    
    def _matches_tags(self, result: Dict[str, Any], tags: List[str]) -> bool:
        """Check if result matches any of the specified tags."""
        result_tags = result.get('tags', [])
        return any(t.lower() in [rt.lower() for rt in result_tags] for t in tags)
    
    def _calculate_relevance(self, query: str, result: Dict[str, Any]) -> float:
        """Calculate relevance score for a result."""
        score = 0.5  # Base score
        
        query_lower = query.lower()
        content = result.get('content', '').lower()
        
        # Exact match bonus
        if query_lower in content:
            score += 0.3
        
        # Word overlap bonus
        query_words = set(query_lower.split())
        content_words = set(content.split())
        overlap = len(query_words & content_words)
        score += overlap * 0.05
        
        # Source priority
        source_weights = {
            'sop': 0.15,      # SOP patterns are highly valuable
            'persistent': 0.1,
            'trace': 0.05,
            'daily': 0.0,
        }
        score += source_weights.get(result.get('source', ''), 0)
        
        # Recency bonus for traces
        if result.get('source') == 'trace' and result.get('success'):
            score += 0.1  # Successful traces are more valuable
        
        return min(1.0, score)


if __name__ == '__main__':
    import sys
    
    searcher = UnifiedSearch('.')
    
    if len(sys.argv) > 1:
        query = ' '.join(sys.argv[1:])
        results = searcher.search(query, limit=5)
        print(json.dumps(results, indent=2, ensure_ascii=False))
