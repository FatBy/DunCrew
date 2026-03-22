"""
DunCrew 混合搜索引擎 (Hybrid Search Engine)

借鉴 QMD 架构，实现 5 步 Pipeline:
1. Query Expansion (LLM 可选)
2. BM25 (FTS5) + Vector (BGE) 双通道检索
3. RRF Fusion (k=60, 原始查询 ×2 权重)
4. BGE Reranker 精排 (可选)
5. Position-Aware Blending

优雅降级: 模型不存在 → 跳过, 导入失败 → FTS5-only
"""

import json
import math
import re
import sqlite3
import threading
import time
from typing import Any, Callable

import numpy as np

# Embedding 延迟导入 (模型可能不存在)
_st_available = False
try:
    from sentence_transformers import SentenceTransformer
    _st_available = True
except ImportError:
    pass


# ============================================
# 配置常量
# ============================================

SEARCH_CONFIG = {
    'RRF_K': 60,
    'TOP_RANK_BONUS_FIRST': 0.05,
    'TOP_RANK_BONUS_TOP3': 0.02,
    'ORIGINAL_QUERY_WEIGHT': 2,
    'BM25_CANDIDATES': 30,
    'VECTOR_CANDIDATES': 30,
    'RRF_TOP_K': 30,
    'BLEND_TOP3_RRF': 0.75,
    'BLEND_TOP10_RRF': 0.60,
    'BLEND_REST_RRF': 0.40,
    'CHUNK_TARGET_TOKENS': 900,
    'CHUNK_OVERLAP_RATIO': 0.15,
    'CHUNK_SEARCH_WINDOW': 200,
    'EXPANSION_COUNT': 2,
}

BREAK_POINT_SCORES = {
    'h1': 100, 'h2': 90, 'h3': 80, 'h4': 70, 'h5': 60, 'h6': 50,
    'code_fence': 80,
    'horizontal_rule': 60,
    'blank_line': 20,
    'list_item': 5,
    'line_break': 1,
}

BGE_QUERY_INSTRUCTION = "为这个句子生成表示以用于检索相关文章："


# ============================================
# EmbeddingEngine - 本地 BGE-large-zh-v1.5
# ============================================

class EmbeddingEngine:
    """懒加载本地 BGE Embedding 模型，线程安全"""

    def __init__(self, model_path: str):
        self._model_path = model_path
        self._model: Any = None
        self._lock = threading.Lock()
        self._available = False
        self._dimension = 1024  # BGE-large-zh default

    @property
    def available(self) -> bool:
        if self._model is not None:
            return self._available
        self._ensure_loaded()
        return self._available

    @property
    def dimension(self) -> int:
        return self._dimension

    def _ensure_loaded(self):
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            if not _st_available:
                print("[EmbeddingEngine] sentence-transformers not installed, disabled")
                self._available = False
                return
            try:
                self._model = SentenceTransformer(self._model_path)
                dim = self._model.get_sentence_embedding_dimension()
                if dim:
                    self._dimension = dim
                self._available = True
                print(f"[EmbeddingEngine] Loaded BGE model ({self._dimension}d) from {self._model_path}")
            except Exception as e:
                print(f"[EmbeddingEngine] Failed to load model: {e}")
                self._available = False

    def encode(self, texts: list[str], batch_size: int = 32) -> np.ndarray:
        """批量编码文本 → 归一化向量"""
        self._ensure_loaded()
        if not self._available or not texts:
            return np.array([])
        with self._lock:
            return self._model.encode(texts, batch_size=batch_size, normalize_embeddings=True)

    def encode_query(self, query: str) -> np.ndarray:
        """编码查询 (加 BGE instruction 前缀)"""
        self._ensure_loaded()
        if not self._available:
            return np.array([])
        with self._lock:
            return self._model.encode(
                [BGE_QUERY_INSTRUCTION + query],
                normalize_embeddings=True,
            )[0]


# ============================================
# Smart Chunking (借鉴 QMD)
# ============================================

def estimate_tokens(text: str) -> int:
    """粗略估算 token 数 (中文 ~1.5 字/token, 英文 ~4 字符/token)"""
    chinese_chars = len(re.findall(r'[\u4e00-\u9fff]', text))
    other_chars = len(text) - chinese_chars
    return int(chinese_chars / 1.5 + other_chars / 4)


def detect_break_points(lines: list[str]) -> list[tuple[int, int]]:
    """
    检测 Markdown 语义断点
    返回 [(行号, 分数)] — 分数越高越适合作为分块边界
    """
    breaks: list[tuple[int, int]] = []
    in_code_block = False

    for i, line in enumerate(lines):
        stripped = line.strip()

        # 代码块边界检测
        if stripped.startswith('```'):
            in_code_block = not in_code_block
            breaks.append((i, BREAK_POINT_SCORES['code_fence']))
            continue

        # 代码块内部不设断点
        if in_code_block:
            continue

        # 标题 H1-H6
        heading_match = re.match(r'^(#{1,6})\s', stripped)
        if heading_match:
            level = len(heading_match.group(1))
            key = f'h{level}'
            breaks.append((i, BREAK_POINT_SCORES.get(key, 30)))
            continue

        # 水平线
        if re.match(r'^[-*_]{3,}\s*$', stripped):
            breaks.append((i, BREAK_POINT_SCORES['horizontal_rule']))
            continue

        # 空行
        if not stripped:
            breaks.append((i, BREAK_POINT_SCORES['blank_line']))
            continue

        # 列表项
        if re.match(r'^[-*+]\s|^\d+\.\s', stripped):
            breaks.append((i, BREAK_POINT_SCORES['list_item']))
            continue

        # 普通行
        breaks.append((i, BREAK_POINT_SCORES['line_break']))

    return breaks


def smart_chunk(
    text: str,
    target_tokens: int = 900,
    overlap_ratio: float = 0.15,
) -> list[dict]:
    """
    按语义边界分块
    短文本 (<= target * 1.2) 不分块
    使用 QMD 距离衰减: finalScore = baseScore × (1 - (distance/window)² × 0.7)
    """
    total_tokens = estimate_tokens(text)
    if total_tokens <= int(target_tokens * 1.2):
        return [{'content': text, 'start_line': 0, 'end_line': 0, 'token_count': total_tokens}]

    lines = text.split('\n')
    breaks = detect_break_points(lines)
    if not breaks:
        return [{'content': text, 'start_line': 0, 'end_line': len(lines) - 1, 'token_count': total_tokens}]

    # 逐行累积 token, 在目标位置窗口内找最佳断点
    window = SEARCH_CONFIG['CHUNK_SEARCH_WINDOW']
    overlap_tokens = int(target_tokens * overlap_ratio)
    chunks: list[dict] = []

    current_start = 0
    accumulated = 0
    line_tokens = [estimate_tokens(line) for line in lines]

    while current_start < len(lines):
        # 从当前起点累积到目标 token 数
        target_line = current_start
        acc = 0
        for j in range(current_start, len(lines)):
            acc += line_tokens[j]
            if acc >= target_tokens:
                target_line = j
                break
        else:
            # 剩余文本不够一个 chunk, 全部归入最后一块
            chunk_text = '\n'.join(lines[current_start:])
            if chunk_text.strip():
                chunks.append({
                    'content': chunk_text,
                    'start_line': current_start,
                    'end_line': len(lines) - 1,
                    'token_count': estimate_tokens(chunk_text),
                })
            break

        # 在 target_line 附近窗口内找最佳断点
        best_line = target_line
        best_score = -1

        for bp_line, bp_score in breaks:
            if bp_line < current_start:
                continue
            distance = abs(bp_line - target_line)
            if distance > window:
                continue
            # QMD 距离衰减公式
            decay = 1 - (distance / window) ** 2 * 0.7
            final_score = bp_score * decay
            if final_score > best_score:
                best_score = final_score
                best_line = bp_line

        # 确保至少前进一行
        end_line = max(best_line, current_start + 1)
        chunk_text = '\n'.join(lines[current_start:end_line])
        if chunk_text.strip():
            chunks.append({
                'content': chunk_text,
                'start_line': current_start,
                'end_line': end_line - 1,
                'token_count': estimate_tokens(chunk_text),
            })

        # 重叠: 回退 overlap_tokens 对应的行数
        overlap_lines = 0
        overlap_acc = 0
        for j in range(end_line - 1, current_start, -1):
            overlap_acc += line_tokens[j]
            overlap_lines += 1
            if overlap_acc >= overlap_tokens:
                break

        current_start = max(end_line - overlap_lines, end_line)
        # 安全保证: 至少前进到 end_line
        if current_start <= chunks[-1]['start_line'] if chunks else 0:
            current_start = end_line

    return chunks


# ============================================
# 向量存储 (SQLite BLOB)
# ============================================

def ensure_vector_table(conn: sqlite3.Connection):
    """创建向量存储表 (如果不存在)"""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_vectors (
            memory_id TEXT NOT NULL,
            chunk_seq INTEGER NOT NULL DEFAULT 0,
            embedding BLOB NOT NULL,
            chunk_content TEXT DEFAULT '',
            start_line INTEGER DEFAULT 0,
            end_line INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (memory_id, chunk_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_mv_memory ON memory_vectors(memory_id);
    """)
    conn.commit()


def index_memory_vectors(
    conn: sqlite3.Connection,
    memory_id: str,
    content: str,
    embedding_engine: EmbeddingEngine,
    db_lock: threading.Lock,
) -> int:
    """
    为一条记忆生成向量索引 (分块 + 编码 + 存储)
    返回分块数量
    """
    if not embedding_engine.available or not content.strip():
        return 0

    chunks = smart_chunk(content)
    chunk_texts = [c['content'] for c in chunks]
    vectors = embedding_engine.encode(chunk_texts)

    if len(vectors) == 0:
        return 0

    now = int(time.time() * 1000)
    with db_lock:
        conn.execute("DELETE FROM memory_vectors WHERE memory_id = ?", (memory_id,))
        for i, (chunk, vec) in enumerate(zip(chunks, vectors)):
            blob = vec.astype(np.float32).tobytes()
            conn.execute(
                "INSERT INTO memory_vectors (memory_id, chunk_seq, embedding, chunk_content, start_line, end_line, created_at) VALUES (?,?,?,?,?,?,?)",
                (memory_id, i, blob, chunk['content'], chunk['start_line'], chunk['end_line'], now),
            )
        conn.commit()
    return len(chunks)


# ============================================
# Query Expansion (LLM 可选)
# ============================================

def expand_query_via_llm(
    query: str,
    llm_call_fn: Callable | None = None,
    expansion_count: int = 2,
) -> list[str]:
    """
    通过 LLM 生成查询扩展变体
    如果 llm_call_fn 为 None, 直接返回 [query]
    """
    if not llm_call_fn:
        return [query]

    prompt = (
        f"请为以下搜索查询生成 {expansion_count} 个语义相近但措辞不同的变体。\n"
        f"要求: 不同词汇和角度, 可包含英文变体, 每个不超过 20 字, 只返回变体每行一个。\n\n"
        f"原始查询: {query}\n\n变体:"
    )

    try:
        response = llm_call_fn(prompt)
        variants = [line.strip().lstrip('0123456789.-) ') for line in response.strip().split('\n') if line.strip()]
        variants = [v for v in variants if v and len(v) <= 40][:expansion_count]
        return [query] + variants
    except Exception as e:
        print(f"[QueryExpansion] LLM expansion failed: {e}")
        return [query]


# ============================================
# HybridSearchEngine - 主引擎
# ============================================

class HybridSearchEngine:
    """混合搜索 Pipeline: Query Expansion → BM25+Vector → RRF Fusion → Blending"""

    def __init__(
        self,
        embedding_engine: EmbeddingEngine,
        reranker_engine: Any = None,  # 保留接口兼容，但不再使用
        llm_call_fn: Callable | None = None,
    ):
        self.embedding = embedding_engine
        self.llm_call_fn = llm_call_fn

    def search(
        self,
        conn: sqlite3.Connection,
        query: str,
        nexus_id: str | None = None,
        limit: int = 10,
        use_expansion: bool = True,
        use_reranker: bool = False,  # 默认关闭，不再使用精排
    ) -> list[dict]:
        """执行混合搜索 Pipeline"""
        if not query.strip():
            return []

        cfg = SEARCH_CONFIG

        # Step 1: Query Expansion
        if use_expansion and self.llm_call_fn:
            queries = expand_query_via_llm(query, self.llm_call_fn, cfg['EXPANSION_COUNT'])
        else:
            queries = [query]

        # Step 2: 双通道检索
        all_bm25: list[list[dict]] = []
        all_vec: list[list[dict]] = []

        for q in queries:
            bm25_results = self._search_bm25(conn, q, nexus_id, cfg['BM25_CANDIDATES'])
            all_bm25.append(bm25_results)

            if self.embedding.available:
                vec_results = self._search_vector(conn, q, nexus_id, cfg['VECTOR_CANDIDATES'])
                all_vec.append(vec_results)
            else:
                all_vec.append([])

        # Step 3: RRF Fusion
        rrf_scores, all_docs = self._rrf_fusion(queries, all_bm25, all_vec, cfg)

        if not rrf_scores:
            return []

        # 按 RRF 分数排序, 取 Top K 候选
        sorted_ids = sorted(rrf_scores.keys(), key=lambda x: rrf_scores[x], reverse=True)
        top_candidates = sorted_ids[:cfg['RRF_TOP_K']]

        # Step 4: 直接用 RRF 分数排序 (精排已移除)
        reranker_scores: dict[str, float] = {}

        # Step 5: Position-Aware Blending
        final_results = self._blend(top_candidates, rrf_scores, reranker_scores, all_docs, cfg)

        # 截取 limit
        final_results = final_results[:limit]

        # 格式化输出
        return [{
            'id': r['id'],
            'content': r.get('content', ''),
            'snippet': r.get('snippet', r.get('content', '')[:200]),
            'source': r.get('source', ''),
            'nexusId': r.get('nexusId', ''),
            'tags': r.get('tags', '[]'),
            'createdAt': r.get('createdAt', 0),
            'score': r['final_score'],
            'searchMeta': {
                'rrfScore': r.get('rrf_score', 0),
                'rerankerScore': r.get('reranker_score'),
                'similarity': r.get('vec_similarity'),
                'queriesUsed': len(queries),
            },
        } for r in final_results]

    # ─── BM25 通道 (FTS5) ───

    def _search_bm25(
        self, conn: sqlite3.Connection, query: str,
        nexus_id: str | None, limit: int,
    ) -> list[dict]:
        """FTS5 关键词检索"""
        fts_sql = """
            SELECT m.*, rank
            FROM memory_fts fts
            JOIN memory m ON m.rowid = fts.rowid
            WHERE memory_fts MATCH ?
        """
        params: list = [query]
        if nexus_id:
            fts_sql += " AND m.nexus_id = ?"
            params.append(nexus_id)
        fts_sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        try:
            rows = conn.execute(fts_sql, params).fetchall()
        except Exception:
            # FTS 语法错误降级 LIKE
            like_sql = "SELECT * FROM memory WHERE content LIKE ?"
            like_params: list = [f"%{query}%"]
            if nexus_id:
                like_sql += " AND nexus_id = ?"
                like_params.append(nexus_id)
            like_sql += " ORDER BY created_at DESC LIMIT ?"
            like_params.append(limit)
            rows = conn.execute(like_sql, like_params).fetchall()

        results = []
        for r in rows:
            results.append({
                'id': r['id'],
                'content': r['content'],
                'source': r['source'],
                'nexusId': r['nexus_id'],
                'tags': r['tags'] or '[]',
                'createdAt': r['created_at'],
                'bm25_rank': abs(r['rank']) if 'rank' in r.keys() else 0,
            })
        return results

    # ─── Vector 通道 (BGE) ───

    def _search_vector(
        self, conn: sqlite3.Connection, query: str,
        nexus_id: str | None, limit: int,
    ) -> list[dict]:
        """向量相似度检索"""
        query_vec = self.embedding.encode_query(query)
        if query_vec.size == 0:
            return []

        # 读取向量表
        vec_sql = "SELECT mv.memory_id, mv.embedding, mv.chunk_content, m.content, m.source, m.nexus_id, m.tags, m.created_at FROM memory_vectors mv JOIN memory m ON m.id = mv.memory_id"
        params: list = []
        if nexus_id:
            vec_sql += " WHERE m.nexus_id = ?"
            params.append(nexus_id)

        try:
            rows = conn.execute(vec_sql, params).fetchall()
        except Exception:
            return []

        if not rows:
            return []

        # 计算相似度, 按 memory_id 去重 (保留最高分)
        scores: dict[str, float] = {}
        docs: dict[str, dict] = {}

        dim = self.embedding.dimension
        for r in rows:
            mid = r['memory_id']
            blob = r['embedding']
            vec = np.frombuffer(blob, dtype=np.float32)
            if vec.shape[0] != dim:
                continue
            sim = float(np.dot(query_vec, vec))  # 已归一化, dot = cosine
            if mid not in scores or sim > scores[mid]:
                scores[mid] = sim
                docs[mid] = {
                    'id': mid,
                    'content': r['content'],
                    'snippet': r['chunk_content'] or r['content'][:200],
                    'source': r['source'],
                    'nexusId': r['nexus_id'],
                    'tags': r['tags'] or '[]',
                    'createdAt': r['created_at'],
                    'vec_similarity': sim,
                }

        # 按相似度排序取 Top
        sorted_ids = sorted(scores.keys(), key=lambda x: scores[x], reverse=True)[:limit]
        return [docs[mid] for mid in sorted_ids]

    # ─── RRF Fusion ───

    def _rrf_fusion(
        self,
        queries: list[str],
        all_bm25: list[list[dict]],
        all_vec: list[list[dict]],
        cfg: dict,
    ) -> tuple[dict[str, float], dict[str, dict]]:
        """Reciprocal Rank Fusion — 多查询多通道融合"""
        k = cfg['RRF_K']
        rrf_scores: dict[str, float] = {}
        all_docs: dict[str, dict] = {}

        for qi, (bm25_list, vec_list) in enumerate(zip(all_bm25, all_vec)):
            weight = cfg['ORIGINAL_QUERY_WEIGHT'] if qi == 0 else 1

            # BM25 通道
            for rank, doc in enumerate(bm25_list):
                mid = doc['id']
                score = weight * 1 / (k + rank + 1)
                # Top-rank bonus (仅原始查询)
                if qi == 0:
                    if rank == 0:
                        score += cfg['TOP_RANK_BONUS_FIRST']
                    elif rank < 3:
                        score += cfg['TOP_RANK_BONUS_TOP3']
                rrf_scores[mid] = rrf_scores.get(mid, 0) + score
                if mid not in all_docs:
                    all_docs[mid] = doc

            # Vector 通道
            for rank, doc in enumerate(vec_list):
                mid = doc['id']
                score = weight * 1 / (k + rank + 1)
                if qi == 0:
                    if rank == 0:
                        score += cfg['TOP_RANK_BONUS_FIRST']
                    elif rank < 3:
                        score += cfg['TOP_RANK_BONUS_TOP3']
                rrf_scores[mid] = rrf_scores.get(mid, 0) + score
                if mid not in all_docs:
                    all_docs[mid] = doc

        return rrf_scores, all_docs

    # ─── Position-Aware Blending ───

    def _blend(
        self,
        candidates: list[str],
        rrf_scores: dict[str, float],
        reranker_scores: dict[str, float],
        all_docs: dict[str, dict],
        cfg: dict,
    ) -> list[dict]:
        """根据 RRF 排名位置, 动态混合 RRF 和 Reranker 分数"""
        # 归一化 RRF 分数到 0-1
        max_rrf = max(rrf_scores.values()) if rrf_scores else 1
        if max_rrf == 0:
            max_rrf = 1

        results: list[dict] = []
        for rank, mid in enumerate(candidates):
            doc = all_docs.get(mid, {})
            rrf_norm = rrf_scores.get(mid, 0) / max_rrf
            reranker_score = reranker_scores.get(mid)

            if reranker_score is not None:
                # Position-Aware 权重
                if rank < 3:
                    rrf_w = cfg['BLEND_TOP3_RRF']
                elif rank < 10:
                    rrf_w = cfg['BLEND_TOP10_RRF']
                else:
                    rrf_w = cfg['BLEND_REST_RRF']
                reranker_w = 1 - rrf_w
                final_score = rrf_w * rrf_norm + reranker_w * reranker_score
            else:
                final_score = rrf_norm

            results.append({
                **doc,
                'rrf_score': rrf_norm,
                'reranker_score': reranker_score,
                'final_score': round(final_score, 4),
            })

        results.sort(key=lambda x: x['final_score'], reverse=True)
        return results
