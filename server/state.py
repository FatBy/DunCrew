"""DunCrew Server - Global State (singletons, locks, managers)"""
from __future__ import annotations

import threading
import sqlite3

from server.browser import BrowserManager
from server.embedding import EmbeddingManager

# 全局数据库连接 (线程安全 WAL 模式)
_db_conn: sqlite3.Connection | None = None
_db_lock = threading.Lock()

# V4: 混合搜索引擎全局实例 (懒初始化)
_hybrid_engine = None  # type: HybridSearchEngine | None
_embedding_engine = None  # type: EmbeddingEngine | None

# Dun frontmatter 读-改-写锁 (防止并发 TOCTOU) - 向后兼容别名
# 实际锁定义在 server.utils 中，这里仅做引用
from server.utils import _dun_frontmatter_lock  # noqa: F401

# 全局管理器单例
_browser_manager = BrowserManager()
_embedding_manager = EmbeddingManager()

# 记忆容量管理常量
_CATEGORY_CAPACITY_LIMITS: dict[str, int] = {
    'preference': 100,
    'project': 100,
    'discovery': 200,
    'uncategorized': 50,
}
_MERGE_BATCH_SIZE = 5
_CAPACITY_CHECK_INTERVAL = 86400  # 24 小时
