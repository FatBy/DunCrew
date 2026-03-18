#!/usr/bin/env python3
"""
Semantic search engine using embeddings for code-search skill.
Provides natural language code search using vector similarity.
"""

import os
import json
import hashlib
import sqlite3
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
import re

# Try to import requests for API calls
try:
    import requests
    REQUESTS_AVAILABLE = True
except ImportError:
    REQUESTS_AVAILABLE = False


class SemanticEngine:
    """
    Semantic code search using embeddings.
    
    Uses LLM API's /v1/embeddings endpoint (same as frontend P4).
    Caches embeddings in SQLite database for performance.
    """
    
    # File extensions to index
    INDEXABLE_EXTENSIONS = {
        '.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', 
        '.java', '.c', '.cpp', '.h', '.hpp', '.rb', '.md'
    }
    
    # Directories to skip
    SKIP_DIRS = {
        '.git', 'node_modules', '__pycache__', 'venv', 'dist', 
        'build', '.next', 'target', '.duncrew'
    }
    
    # Chunk size for embedding (approximate tokens)
    CHUNK_SIZE = 500  # characters, roughly 100-150 tokens
    
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.db_path = self.project_root / '.duncrew' / 'semantic_index.db'
        self.config = self._load_config()
        self._ensure_db()
    
    def _load_config(self) -> Dict[str, str]:
        """Load LLM config from localStorage equivalent (config file)."""
        config_path = self.project_root / '.duncrew' / 'llm_config.json'
        
        if config_path.exists():
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception:
                pass
        
        # Try environment variables
        return {
            'api_key': os.environ.get('DDOS_LLM_API_KEY', ''),
            'base_url': os.environ.get('DDOS_LLM_BASE_URL', ''),
            'model': os.environ.get('DDOS_LLM_MODEL', ''),
        }
    
    def _ensure_db(self):
        """Ensure database and tables exist."""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        # Create tables
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL,
                file_hash TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                start_line INTEGER,
                end_line INTEGER,
                UNIQUE(file_path, chunk_index)
            )
        ''')
        
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS embeddings (
                chunk_id INTEGER PRIMARY KEY,
                embedding BLOB NOT NULL,
                FOREIGN KEY (chunk_id) REFERENCES chunks(id)
            )
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_chunks_file 
            ON chunks(file_path)
        ''')
        
        cursor.execute('''
            CREATE INDEX IF NOT EXISTS idx_chunks_hash 
            ON chunks(file_hash)
        ''')
        
        conn.commit()
        conn.close()
    
    def _get_embedding(self, text: str) -> Optional[List[float]]:
        """Get embedding from LLM API."""
        if not REQUESTS_AVAILABLE:
            return None
        
        api_key = self.config.get('api_key', '')
        base_url = self.config.get('base_url', '')
        
        if not api_key or not base_url:
            return None
        
        # Build embedding URL
        url = base_url.rstrip('/')
        if not url.endswith('/embeddings'):
            if not url.endswith('/v1'):
                url += '/v1'
            url += '/embeddings'
        
        try:
            response = requests.post(
                url,
                headers={
                    'Authorization': f'Bearer {api_key}',
                    'Content-Type': 'application/json',
                },
                json={
                    'input': text[:8000],  # Limit input size
                    'model': self.config.get('model', 'text-embedding-3-small'),
                },
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                if 'data' in data and len(data['data']) > 0:
                    return data['data'][0]['embedding']
            
        except Exception as e:
            pass
        
        return None
    
    def _cosine_similarity(self, a: List[float], b: List[float]) -> float:
        """Calculate cosine similarity between two vectors."""
        if not a or not b or len(a) != len(b):
            return 0.0
        
        dot_product = sum(x * y for x, y in zip(a, b))
        norm_a = sum(x * x for x in a) ** 0.5
        norm_b = sum(x * x for x in b) ** 0.5
        
        if norm_a == 0 or norm_b == 0:
            return 0.0
        
        return dot_product / (norm_a * norm_b)
    
    def _file_hash(self, filepath: Path) -> str:
        """Get hash of file content."""
        try:
            content = filepath.read_bytes()
            return hashlib.md5(content).hexdigest()
        except Exception:
            return ''
    
    def _chunk_file(self, filepath: Path) -> List[Dict[str, Any]]:
        """
        Split file into chunks for embedding.
        
        Tries to split at logical boundaries (functions, classes).
        """
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()
        except Exception:
            return []
        
        lines = content.split('\n')
        chunks = []
        current_chunk = []
        current_start = 1
        current_size = 0
        
        for i, line in enumerate(lines, 1):
            current_chunk.append(line)
            current_size += len(line)
            
            # Check if we should start a new chunk
            should_split = False
            
            # Split at function/class definitions
            if current_size >= self.CHUNK_SIZE:
                if re.match(r'^(def |class |function |async function |export )', line.strip()):
                    should_split = True
                elif current_size >= self.CHUNK_SIZE * 2:
                    # Force split if chunk is too large
                    should_split = True
            
            if should_split and len(current_chunk) > 1:
                # Save current chunk (excluding the new definition line)
                chunk_content = '\n'.join(current_chunk[:-1])
                if chunk_content.strip():
                    chunks.append({
                        'content': chunk_content,
                        'start_line': current_start,
                        'end_line': i - 1,
                    })
                
                # Start new chunk with current line
                current_chunk = [line]
                current_start = i
                current_size = len(line)
        
        # Don't forget the last chunk
        if current_chunk:
            chunk_content = '\n'.join(current_chunk)
            if chunk_content.strip():
                chunks.append({
                    'content': chunk_content,
                    'start_line': current_start,
                    'end_line': len(lines),
                })
        
        return chunks
    
    def index_file(self, filepath: Path) -> int:
        """
        Index a single file for semantic search.
        
        Returns number of chunks indexed.
        """
        file_hash = self._file_hash(filepath)
        if not file_hash:
            return 0
        
        try:
            rel_path = str(filepath.relative_to(self.project_root))
        except ValueError:
            rel_path = str(filepath)
        
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        # Check if file is already indexed with same hash
        cursor.execute(
            'SELECT id FROM chunks WHERE file_path = ? AND file_hash = ? LIMIT 1',
            (rel_path, file_hash)
        )
        if cursor.fetchone():
            conn.close()
            return 0  # Already indexed
        
        # Delete old chunks for this file
        cursor.execute('DELETE FROM chunks WHERE file_path = ?', (rel_path,))
        
        # Chunk the file
        chunks = self._chunk_file(filepath)
        indexed_count = 0
        
        for i, chunk in enumerate(chunks):
            # Insert chunk
            cursor.execute(
                '''INSERT INTO chunks (file_path, file_hash, chunk_index, content, start_line, end_line)
                   VALUES (?, ?, ?, ?, ?, ?)''',
                (rel_path, file_hash, i, chunk['content'], chunk['start_line'], chunk['end_line'])
            )
            chunk_id = cursor.lastrowid
            
            # Get embedding
            embedding = self._get_embedding(chunk['content'])
            if embedding:
                # Store as JSON (could use numpy/pickle for efficiency)
                cursor.execute(
                    'INSERT OR REPLACE INTO embeddings (chunk_id, embedding) VALUES (?, ?)',
                    (chunk_id, json.dumps(embedding))
                )
                indexed_count += 1
        
        conn.commit()
        conn.close()
        
        return indexed_count
    
    def index_directory(self, directory: Optional[Path] = None) -> Dict[str, int]:
        """
        Index all files in directory.
        
        Returns stats about indexing.
        """
        search_path = directory or self.project_root
        stats = {'files': 0, 'chunks': 0, 'skipped': 0}
        
        for dirpath, dirnames, filenames in os.walk(search_path):
            # Skip ignored directories
            dirnames[:] = [d for d in dirnames if d not in self.SKIP_DIRS]
            
            for filename in filenames:
                filepath = Path(dirpath) / filename
                
                if filepath.suffix not in self.INDEXABLE_EXTENSIONS:
                    stats['skipped'] += 1
                    continue
                
                chunks_indexed = self.index_file(filepath)
                if chunks_indexed > 0:
                    stats['files'] += 1
                    stats['chunks'] += chunks_indexed
        
        return stats
    
    def search(
        self,
        query: str,
        scope: Optional[str] = None,
        language: Optional[str] = None,
        limit: int = 10
    ) -> List[Dict[str, Any]]:
        """
        Semantic search using embeddings.
        
        Args:
            query: Natural language query
            scope: Directory to search in
            language: Language filter
            limit: Maximum results
            
        Returns:
            List of matching chunks with similarity scores
        """
        # Get query embedding
        query_embedding = self._get_embedding(query)
        if not query_embedding:
            return []
        
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        # Build query
        sql = '''
            SELECT c.file_path, c.content, c.start_line, c.end_line, e.embedding
            FROM chunks c
            JOIN embeddings e ON c.id = e.chunk_id
        '''
        params = []
        
        # Add filters
        conditions = []
        if scope:
            conditions.append('c.file_path LIKE ?')
            params.append(f'{scope}%')
        
        if language:
            # Map language to extensions
            ext_map = {
                'python': '.py', 'typescript': '.ts', 'javascript': '.js',
                'rust': '.rs', 'go': '.go', 'java': '.java'
            }
            if language.lower() in ext_map:
                conditions.append('c.file_path LIKE ?')
                params.append(f'%{ext_map[language.lower()]}')
        
        if conditions:
            sql += ' WHERE ' + ' AND '.join(conditions)
        
        cursor.execute(sql, params)
        rows = cursor.fetchall()
        conn.close()
        
        # Calculate similarities
        results = []
        for row in rows:
            file_path, content, start_line, end_line, embedding_json = row
            
            try:
                embedding = json.loads(embedding_json)
                similarity = self._cosine_similarity(query_embedding, embedding)
                
                # Extract the most relevant line
                lines = content.split('\n')
                match_line = lines[0] if lines else ''
                
                results.append({
                    'file': file_path,
                    'line': start_line,
                    'end_line': end_line,
                    'match': match_line.strip(),
                    'relevance': round(similarity, 4),
                    'chunk_preview': content[:200] + ('...' if len(content) > 200 else ''),
                })
            except Exception:
                continue
        
        # Sort by relevance and limit
        results.sort(key=lambda x: x['relevance'], reverse=True)
        return results[:limit]
    
    def get_stats(self) -> Dict[str, int]:
        """Get index statistics."""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        
        cursor.execute('SELECT COUNT(*) FROM chunks')
        total_chunks = cursor.fetchone()[0]
        
        cursor.execute('SELECT COUNT(DISTINCT file_path) FROM chunks')
        total_files = cursor.fetchone()[0]
        
        cursor.execute('SELECT COUNT(*) FROM embeddings')
        total_embeddings = cursor.fetchone()[0]
        
        conn.close()
        
        return {
            'files': total_files,
            'chunks': total_chunks,
            'embeddings': total_embeddings,
        }


if __name__ == '__main__':
    import sys
    
    engine = SemanticEngine('.')
    
    if len(sys.argv) > 1:
        if sys.argv[1] == 'index':
            # Index the codebase
            stats = engine.index_directory()
            print(json.dumps(stats, indent=2))
        elif sys.argv[1] == 'stats':
            # Show index stats
            stats = engine.get_stats()
            print(json.dumps(stats, indent=2))
        else:
            # Search
            query = ' '.join(sys.argv[1:])
            results = engine.search(query, limit=5)
            print(json.dumps(results, indent=2, ensure_ascii=False))
