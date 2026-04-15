"""DunCrew Server - Constants and Feature Flags"""
from __future__ import annotations

import os
import sys
import platform
from pathlib import Path

# PyYAML (skill-executor/parser.py 已依赖)
try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

# MCP 客户端支持
try:
    from skills.mcp_manager import MCPClientManager
    HAS_MCP = True
except ImportError:
    HAS_MCP = False
    MCPClientManager = None

# 文件解析 (可选依赖，缺失时降级)
try:
    import pdfplumber
    HAS_PDF = True
except ImportError:
    HAS_PDF = False

try:
    from docx import Document as DocxDocument
    HAS_DOCX = True
except ImportError:
    HAS_DOCX = False

try:
    from pptx import Presentation as PptxPresentation
    HAS_PPTX = True
except ImportError:
    HAS_PPTX = False

try:
    import pytesseract
    from PIL import Image
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

# Excel 解析 (可选依赖)
try:
    import openpyxl
    HAS_XLSX = True
except ImportError:
    HAS_XLSX = False

# HTML 解析 (可选依赖)
try:
    from bs4 import BeautifulSoup
    HAS_BS4 = True
except ImportError:
    HAS_BS4 = False

# ePub 解析 (可选依赖)
try:
    import ebooklib
    from ebooklib import epub as epub_lib
    HAS_EPUB = True
except ImportError:
    HAS_EPUB = False

# RTF 解析 (可选依赖)
try:
    from striprtf.striprtf import rtf_to_text
    HAS_RTF = True
except ImportError:
    HAS_RTF = False

# 网页正文提取 (可选依赖，缺失时降级到正则剥离)
try:
    import trafilatura
    HAS_TRAFILATURA = True
except ImportError:
    HAS_TRAFILATURA = False

# Windows COM 自动化 (.doc/.wps/.ppt 解析，仅 Windows)
HAS_COM = False
if platform.system() == 'Windows':
    try:
        import comtypes.client
        HAS_COM = True
    except ImportError:
        pass

# 旧版 .xls 解析 (xlrd，openpyxl 不支持 .xls)
HAS_XLRD = False
try:
    import xlrd
    HAS_XLRD = True
except ImportError:
    pass

# 智能编码检测 (charset-normalizer)
HAS_CHARSET = False
try:
    from charset_normalizer import from_bytes as charset_from_bytes
    HAS_CHARSET = True
except ImportError:
    pass

# 屏幕截图 (可选依赖)
try:
    import mss as mss_lib
    import pygetwindow as gw
    HAS_SCREEN_CAPTURE = True
except ImportError:
    HAS_SCREEN_CAPTURE = False

# V4: 混合搜索引擎 (可选依赖)
try:
    from hybrid_search import (
        HybridSearchEngine, EmbeddingEngine,
        ensure_vector_table, index_memory_vectors,
    )
    HAS_HYBRID_SEARCH = True
except ImportError:
    HAS_HYBRID_SEARCH = False
    print("[Warning] hybrid_search module not available, falling back to FTS5-only search")

VERSION = "0.1.0-beta"

# 应用根目录 (兼容 PyInstaller frozen 模式)
if getattr(sys, 'frozen', False):
    APP_DIR = Path(sys.executable).parent.resolve()
    RESOURCES_DIR = APP_DIR.parent.resolve()
else:
    APP_DIR = Path(__file__).parent.parent.resolve()  # 项目根目录 (server/ 的上级)
    RESOURCES_DIR = APP_DIR

# 安全配置
DANGEROUS_COMMANDS = {'rm -rf', 'del /f /s', 'format', 'mkfs', 'dd if=/dev', 'reg delete hklm'}

DANGEROUS_SHELL_PATTERNS = [
    'rm -rf /',
    'rm -rf ~',
    'del /f /s /q c:',
    'format c:',
    'mkfs',
    'dd if=/dev',
    'reg delete hklm',
    '> /dev/sda',
    'chmod -r 777 /',
]

MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_OUTPUT_SIZE = 512 * 1024      # 512KB
PLUGIN_TIMEOUT = 60               # 插件执行超时(秒)

MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
}
