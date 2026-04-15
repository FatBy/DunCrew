"""文件扫描器: 递归扫描文件夹, 生成待处理队列, 支持增量检测"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
from fnmatch import fnmatch
from pathlib import Path
from typing import Optional

from .models import FileInfo, ScanDiff

logger = logging.getLogger(__name__)

# 支持的文件扩展名
SUPPORTED_EXTENSIONS: set[str] = {
    ".pdf", ".docx", ".doc",
    ".xlsx", ".xls",
    ".pptx", ".ppt",
    ".md", ".markdown",
    ".txt", ".text", ".csv", ".tsv",
    ".html", ".htm",
    ".epub",
    ".rtf",
    ".json", ".xml",
}

# 默认排除模式
DEFAULT_EXCLUDES: list[str] = [
    ".*",               # 隐藏文件/目录
    "__pycache__",
    "node_modules",
    "dist",
    "build",
    ".git",
    "~$*",              # Office 临时文件
    "*.tmp",
    "*.bak",
    "*.swp",
    "Thumbs.db",
    ".DS_Store",
]


class FileScanner:
    """递归扫描文件夹, 生成 FileInfo 列表"""

    def __init__(
        self,
        include_patterns: Optional[list[str]] = None,
        exclude_patterns: Optional[list[str]] = None,
        max_file_size_mb: int = 100,
    ):
        self.include_patterns = include_patterns
        self.exclude_patterns = (exclude_patterns or []) + DEFAULT_EXCLUDES
        self.max_file_size_bytes = max_file_size_mb * 1024 * 1024

    def scan(self, paths: list[str]) -> list[FileInfo]:
        """
        扫描给定路径列表 (可混合文件和目录).
        返回去重后的 FileInfo 列表, 按路径排序.
        """
        results: dict[str, FileInfo] = {}  # path -> FileInfo, 用于去重

        for p in paths:
            p = os.path.abspath(p)
            if os.path.isfile(p):
                info = self._process_file(p, os.path.dirname(p))
                if info:
                    results[info.path] = info
            elif os.path.isdir(p):
                self._scan_dir(p, p, results)
            else:
                logger.warning("路径不存在: %s", p)

        sorted_results = sorted(results.values(), key=lambda x: x.path)
        logger.info("扫描完成: %d 个文件", len(sorted_results))
        return sorted_results

    def diff(self, current: list[FileInfo], previous: dict[str, str]) -> ScanDiff:
        """
        增量检测: 对比当前扫描结果与上次记录.
        previous: {file_path: content_hash} 从 library_scan_records 加载.
        """
        current_map = {f.path: f for f in current}
        prev_paths = set(previous.keys())
        curr_paths = set(current_map.keys())

        added = [current_map[p] for p in (curr_paths - prev_paths)]
        deleted = list(prev_paths - curr_paths)
        modified = [
            current_map[p]
            for p in (curr_paths & prev_paths)
            if current_map[p].content_hash != previous[p]
        ]

        return ScanDiff(added=added, modified=modified, deleted=deleted)

    def _scan_dir(self, root: str, scan_root: str, results: dict[str, FileInfo]):
        """递归扫描目录"""
        try:
            entries = os.scandir(root)
        except PermissionError:
            logger.warning("无权限访问: %s", root)
            return

        for entry in entries:
            name = entry.name

            # 排除检查
            if self._should_exclude(name):
                continue

            if entry.is_dir(follow_symlinks=False):
                self._scan_dir(entry.path, scan_root, results)
            elif entry.is_file(follow_symlinks=False):
                info = self._process_file(entry.path, scan_root)
                if info:
                    results[info.path] = info

    def _process_file(self, file_path: str, scan_root: str) -> Optional[FileInfo]:
        """处理单个文件, 返回 FileInfo 或 None (不符合条件时)"""
        try:
            ext = Path(file_path).suffix.lower()

            # 扩展名过滤
            if ext not in SUPPORTED_EXTENSIONS:
                return None

            # include 模式过滤
            if self.include_patterns:
                name = os.path.basename(file_path)
                if not any(fnmatch(name, p) for p in self.include_patterns):
                    return None

            stat = os.stat(file_path)

            # 大小过滤
            if stat.st_size > self.max_file_size_bytes:
                logger.debug("文件过大, 跳过: %s (%d MB)", file_path, stat.st_size // (1024 * 1024))
                return None
            if stat.st_size == 0:
                return None

            content_hash = self._hash_file(file_path)
            mime_type = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
            rel_path = os.path.relpath(file_path, scan_root)

            return FileInfo(
                path=os.path.abspath(file_path),
                relative_path=rel_path,
                name=os.path.basename(file_path),
                extension=ext,
                size_bytes=stat.st_size,
                modified_at=stat.st_mtime,
                content_hash=content_hash,
                mime_type=mime_type,
                parent_dir=os.path.basename(os.path.dirname(file_path)),
            )
        except (OSError, PermissionError) as e:
            logger.warning("无法处理文件 %s: %s", file_path, e)
            return None

    def _should_exclude(self, name: str) -> bool:
        """检查文件/目录名是否匹配排除模式"""
        for pattern in self.exclude_patterns:
            if fnmatch(name, pattern):
                return True
        return False

    @staticmethod
    def _hash_file(file_path: str, chunk_size: int = 65536) -> str:
        """计算文件 SHA-256"""
        h = hashlib.sha256()
        with open(file_path, "rb") as f:
            while chunk := f.read(chunk_size):
                h.update(chunk)
        return h.hexdigest()
