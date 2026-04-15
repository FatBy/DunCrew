"""文档清洗器: 去噪音 — 省 token 的核心环节

清洗管线:
1. 去页码
2. 去页眉页脚 (频率检测)
3. 去水印声明
4. 修复 PDF 断行
5. 表格规范化
6. 格式统一 (全角→半角, 多余空行, 首尾空白)
7. 提取 key_data (含数字+单位的关键数据点)
"""

from __future__ import annotations

import re
import logging
from collections import Counter
from typing import Optional

from .config import CleaningConfig
from .models import ParseResult

logger = logging.getLogger(__name__)

# ── 页码模式 ──
_PAGE_PATTERNS = [
    re.compile(r"^[-—]\s*\d+\s*[-—]$"),                     # - 1 - 或 — 1 —
    re.compile(r"^\d+\s*/\s*\d+$"),                          # 1 / 23
    re.compile(r"^第\s*\d+\s*页"),                            # 第1页
    re.compile(r"^[Pp]age\s+\d+(\s+of\s+\d+)?$"),           # Page 1 of 23
    re.compile(r"^---\s*第?\d+页?\s*---$"),                   # --- 第1页 ---
    re.compile(r"^\d+$"),                                     # 单独数字行
]

# ── 水印/声明模式 ──
_WATERMARK_PATTERNS = [
    re.compile(r"本报告仅供.{0,20}参考", re.IGNORECASE),
    re.compile(r"未经.{0,10}许可.{0,10}不得", re.IGNORECASE),
    re.compile(r"版权所有.{0,10}侵权必究"),
    re.compile(r"内部资料.{0,10}请勿外传"),
    re.compile(r"CONFIDENTIAL", re.IGNORECASE),
    re.compile(r"DRAFT|草稿", re.IGNORECASE),
    re.compile(r"仅供内部使用"),
    re.compile(r"All [Rr]ights [Rr]eserved"),
]

# ── key_data 提取模式 ──
_KEY_DATA_RE = re.compile(
    r"[^。\n]*?"                             # 前缀文本
    r"[\d,]+\.?\d*\s*"                       # 数字
    r"[%％万亿元美元美金人民币吨千克公斤件台套人次户家]"  # 单位
    r"[^。\n]*",                              # 后缀文本
)

_TREND_RE = re.compile(
    r"[^。\n]*?"
    r"(?:同比|环比|增长|下降|上升|增加|减少|提升)"
    r"[^。\n]*?"
    r"[\d,]+\.?\d*\s*[%％]"
    r"[^。\n]*",
)

# ── 全角→半角映射 ──
_FULLWIDTH_MAP = str.maketrans(
    "０１２３４５６７８９ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ（）【】",
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz()[]",
)


class DocumentCleaner:
    """文档清洗器"""

    def __init__(self, config: Optional[CleaningConfig] = None):
        self.config = config or CleaningConfig()

    def clean(self, result: ParseResult) -> ParseResult:
        """清洗 ParseResult, 返回新的 ParseResult (不修改原对象)"""
        text = result.content

        if self.config.remove_headers_footers:
            text = self._remove_headers_footers(text)

        if self.config.remove_watermarks:
            text = self._remove_watermarks(text)

        text = self._remove_page_numbers(text)

        if self.config.fix_broken_lines:
            text = self._fix_broken_lines(text)

        if self.config.normalize_fullwidth:
            text = self._normalize_fullwidth(text)

        text = self._collapse_blank_lines(text)
        text = text.strip()

        key_data = result.key_data
        if self.config.extract_key_data:
            key_data = self._extract_key_data(text)

        # 重新计算 sections 的 char_count
        sections = []
        for s in result.sections:
            cleaned_content = s.content
            if self.config.fix_broken_lines:
                cleaned_content = self._fix_broken_lines(cleaned_content)
            if self.config.normalize_fullwidth:
                cleaned_content = self._normalize_fullwidth(cleaned_content)
            cleaned_content = self._collapse_blank_lines(cleaned_content).strip()
            sections.append(s.__class__(
                title=s.title,
                content=cleaned_content,
                level=s.level,
                char_count=len(cleaned_content),
                page_range=s.page_range,
                has_tables=s.has_tables,
                has_data=s.has_data,
            ))

        return ParseResult(
            title=result.title,
            content=text,
            summary=text[:500],
            sections=sections,
            key_data=key_data,
            metadata=result.metadata,
            doc_type=result.doc_type,
            parse_time_ms=result.parse_time_ms,
            parser_name=result.parser_name,
        )

    # ── 清洗步骤 ──

    def _remove_page_numbers(self, text: str) -> str:
        """去页码行"""
        lines = text.split("\n")
        cleaned = []
        for line in lines:
            stripped = line.strip()
            if stripped and any(p.match(stripped) for p in _PAGE_PATTERNS):
                continue
            cleaned.append(line)
        return "\n".join(cleaned)

    def _remove_headers_footers(self, text: str) -> str:
        """
        频率检测去页眉页脚:
        将文本按双换行分成 "页", 统计每页首尾行的出现频率.
        频率 > 50% 且长度 < 100 字 → 页眉页脚.
        """
        pages = re.split(r"\n{3,}", text)
        if len(pages) < 4:
            return text

        # 统计每页首行和尾行
        first_lines: list[str] = []
        last_lines: list[str] = []
        for page in pages:
            lines = [l.strip() for l in page.strip().split("\n") if l.strip()]
            if lines:
                first_lines.append(lines[0])
            if len(lines) > 1:
                last_lines.append(lines[-1])

        threshold = len(pages) * 0.5
        header_candidates = {
            line for line, count in Counter(first_lines).items()
            if count >= threshold and len(line) < 100
        }
        footer_candidates = {
            line for line, count in Counter(last_lines).items()
            if count >= threshold and len(line) < 100
        }

        if not header_candidates and not footer_candidates:
            return text

        to_remove = header_candidates | footer_candidates
        lines = text.split("\n")
        return "\n".join(l for l in lines if l.strip() not in to_remove)

    def _remove_watermarks(self, text: str) -> str:
        """去水印声明行"""
        lines = text.split("\n")
        cleaned = []
        for line in lines:
            stripped = line.strip()
            if stripped and any(p.search(stripped) for p in _WATERMARK_PATTERNS):
                continue
            cleaned.append(line)
        return "\n".join(cleaned)

    def _fix_broken_lines(self, text: str) -> str:
        """
        修复 PDF 提取时的断行问题:
        中文字符间的异常换行合并, 保留段落分隔 (空行).
        """
        # 中文字符之间的单换行 → 合并
        # 保留: 空行(段落), 列表项(- / * / 数字.), 标题(#)
        lines = text.split("\n")
        result: list[str] = []

        for i, line in enumerate(lines):
            if not line.strip():
                result.append(line)
                continue

            # 如果下一行存在, 且当前行以中文字符结尾, 下一行以中文字符开头
            if (i + 1 < len(lines)
                and line.strip()
                and not lines[i + 1].strip().startswith(("#", "-", "*", ">", "|"))
                and re.search(r"[\u4e00-\u9fff，、；：]$", line.rstrip())
                and i + 1 < len(lines)
                and re.match(r"^[\u4e00-\u9fff（(]", lines[i + 1].strip())):
                result.append(line.rstrip())
            else:
                result.append(line)

        # 合并: 如果一行以中文结尾且下一行以中文开头 (无空行间隔), 合并
        merged: list[str] = []
        for line in result:
            if (merged
                and not line.startswith((" ", "\t", "#", "-", "*", ">", "|"))
                and merged[-1]
                and re.search(r"[\u4e00-\u9fff，、；：]$", merged[-1])
                and re.match(r"[\u4e00-\u9fff（(]", line.lstrip())):
                merged[-1] = merged[-1] + line.lstrip()
            else:
                merged.append(line)

        return "\n".join(merged)

    def _normalize_fullwidth(self, text: str) -> str:
        """全角数字/字母/括号 → 半角"""
        return text.translate(_FULLWIDTH_MAP)

    def _collapse_blank_lines(self, text: str) -> str:
        """连续多个空行 → 最多两个"""
        return re.sub(r"\n{3,}", "\n\n", text)

    def _extract_key_data(self, text: str) -> list[str]:
        """提取含数字+单位的关键数据点"""
        results: list[str] = []
        seen: set[str] = set()

        for pattern in [_KEY_DATA_RE, _TREND_RE]:
            for m in pattern.finditer(text):
                data = m.group().strip()
                if len(data) > 10 and data not in seen:
                    seen.add(data)
                    results.append(data)
                    if len(results) >= 50:  # 单文档最多 50 条
                        return results

        return results
