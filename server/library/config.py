"""配置管理: 读 config.yaml / 环境变量 / CLI 参数"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import yaml


@dataclass
class LLMConfig:
    api_key: str = ""
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model: str = "qwen-turbo"
    temperature: float = 0.3
    max_tokens: int = 2000
    max_concurrent: int = 3
    retry_limit: int = 2
    timeout: int = 60


@dataclass
class ParsingConfig:
    pdf_strategy: str = "pymupdf"       # pymupdf | mineru
    max_file_size_mb: int = 100
    skip_pptx_under_chars: int = 100


@dataclass
class CleaningConfig:
    fix_broken_lines: bool = True
    remove_headers_footers: bool = True
    remove_watermarks: bool = True
    normalize_fullwidth: bool = True
    extract_key_data: bool = True


@dataclass
class DedupConfig:
    similarity_threshold: float = 0.80
    keep_strategy: str = "newest"       # newest | largest
    cross_format_dedup: bool = True


@dataclass
class GroupingConfig:
    max_chars_per_unit: int = 8000
    min_chars_per_unit: int = 500
    merge_small_docs: bool = True


@dataclass
class LibraryConfig:
    llm: LLMConfig = field(default_factory=LLMConfig)
    parsing: ParsingConfig = field(default_factory=ParsingConfig)
    cleaning: CleaningConfig = field(default_factory=CleaningConfig)
    dedup: DedupConfig = field(default_factory=DedupConfig)
    grouping: GroupingConfig = field(default_factory=GroupingConfig)
    db_path: str = ""                   # duncrew.db 路径, 运行时填充


def _deep_update(base: dict, override: dict) -> dict:
    """递归合并字典"""
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v
    return base


def load_config(
    config_path: Optional[str] = None,
    cli_overrides: Optional[dict] = None,
) -> LibraryConfig:
    """
    加载配置, 优先级: CLI 参数 > 环境变量 > config.yaml > 默认值
    """
    cfg = LibraryConfig()

    # 1. 从 config.yaml 加载
    if config_path is None:
        config_path = str(Path(__file__).parent / "config.yaml")
    if os.path.isfile(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            yaml_data = yaml.safe_load(f) or {}
        _apply_yaml(cfg, yaml_data)

    # 2. 环境变量覆盖 LLM 配置
    if v := os.environ.get("LIBRARY_LLM_API_KEY"):
        cfg.llm.api_key = v
    if v := os.environ.get("LIBRARY_LLM_BASE_URL"):
        cfg.llm.base_url = v
    if v := os.environ.get("LIBRARY_LLM_MODEL"):
        cfg.llm.model = v

    # 3. CLI 参数覆盖
    if cli_overrides:
        if v := cli_overrides.get("api_key"):
            cfg.llm.api_key = v
        if v := cli_overrides.get("base_url"):
            cfg.llm.base_url = v
        if v := cli_overrides.get("model"):
            cfg.llm.model = v
        if v := cli_overrides.get("db"):
            cfg.db_path = v
        if v := cli_overrides.get("max_concurrent"):
            cfg.llm.max_concurrent = int(v)

    return cfg


def _apply_yaml(cfg: LibraryConfig, data: dict):
    """将 yaml 数据应用到 config dataclass"""
    if llm := data.get("llm"):
        for k, v in llm.items():
            if hasattr(cfg.llm, k):
                setattr(cfg.llm, k, v)
    if parsing := data.get("parsing"):
        for k, v in parsing.items():
            if hasattr(cfg.parsing, k):
                setattr(cfg.parsing, k, v)
    if cleaning := data.get("cleaning"):
        for k, v in cleaning.items():
            if hasattr(cfg.cleaning, k):
                setattr(cfg.cleaning, k, v)
    if dedup := data.get("dedup"):
        for k, v in dedup.items():
            if hasattr(cfg.dedup, k):
                setattr(cfg.dedup, k, v)
    if grouping := data.get("grouping"):
        for k, v in grouping.items():
            if hasattr(cfg.grouping, k):
                setattr(cfg.grouping, k, v)
