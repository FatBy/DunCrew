"""文档分组器: 将清洗后文档分组为 IngestUnit, 每个 Unit 是一次 LLM 调用的输入

三级分组策略:
A. 短文档 (< 8000 字) → 整份作为一个 IngestUnit
B. 长文档 (> 8000 字) → 按 Section 拆分, 超长 Section 二次拆分
C. 同目录短文档合并 → 节省 LLM 调用次数
"""

from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from pathlib import Path

from .config import GroupingConfig
from .models import IngestUnit, ParseResult, Section

logger = logging.getLogger(__name__)


class DocumentGrouper:
    """文档分组器"""

    def __init__(self, config: GroupingConfig | None = None):
        self.config = config or GroupingConfig()

    def group(self, documents: list[ParseResult]) -> list[IngestUnit]:
        """将文档列表分组为 IngestUnit 列表"""
        max_chars = self.config.max_chars_per_unit
        min_chars = self.config.min_chars_per_unit

        units: list[IngestUnit] = []
        short_docs_by_dir: dict[str, list[ParseResult]] = defaultdict(list)

        for doc in documents:
            doc_chars = len(doc.content)

            if doc_chars <= max_chars:
                # 策略 A: 短文档
                if self.config.merge_small_docs and doc_chars < 2000:
                    # 归入同目录合并队列
                    dir_key = Path(doc.metadata.source_path).parent.name
                    short_docs_by_dir[dir_key].append(doc)
                else:
                    units.append(self._doc_to_unit(doc))
            else:
                # 策略 B: 长文档按章节拆分
                units.extend(self._split_long_document(doc))

        # 策略 C: 合并同目录短文档
        if self.config.merge_small_docs:
            for dir_name, docs in short_docs_by_dir.items():
                units.extend(self._merge_short_docs(docs))

        logger.info("分组完成: %d 文档 → %d IngestUnit", len(documents), len(units))
        return units

    def _doc_to_unit(self, doc: ParseResult) -> IngestUnit:
        """短文档直接转 IngestUnit"""
        header = self._build_context_header(doc)
        content = f"{header}\n\n{doc.content}"

        return IngestUnit(
            id=str(uuid.uuid4())[:8],
            content=content,
            char_count=len(content),
            source_documents=[doc.metadata.source_path],
            source_sections=[],
            doc_type=doc.doc_type,
            context_header=header,
        )

    def _split_long_document(self, doc: ParseResult) -> list[IngestUnit]:
        """长文档按章节拆分"""
        max_chars = self.config.max_chars_per_unit
        min_chars = self.config.min_chars_per_unit
        header = self._build_context_header(doc)
        units: list[IngestUnit] = []

        if doc.sections:
            # 有章节结构: 按章节分组
            current_sections: list[Section] = []
            current_chars = 0

            for section in doc.sections:
                if section.char_count > max_chars:
                    # 先 flush 已有累积
                    if current_sections:
                        units.append(self._sections_to_unit(
                            current_sections, doc, header,
                        ))
                        current_sections = []
                        current_chars = 0

                    # 超长章节二次拆分
                    units.extend(self._split_oversized_section(section, doc, header))
                elif current_chars + section.char_count > max_chars:
                    # 累积超限, flush 后开新组
                    if current_sections:
                        units.append(self._sections_to_unit(
                            current_sections, doc, header,
                        ))
                    current_sections = [section]
                    current_chars = section.char_count
                else:
                    current_sections.append(section)
                    current_chars += section.char_count

            # 最后一组
            if current_sections:
                units.append(self._sections_to_unit(
                    current_sections, doc, header,
                ))
        else:
            # 无章节结构: 按段落切分
            units.extend(self._split_by_paragraphs(doc.content, doc, header))

        return units

    def _split_oversized_section(
        self, section: Section, doc: ParseResult, doc_header: str
    ) -> list[IngestUnit]:
        """超长章节二次拆分: 按段落边界切分"""
        max_chars = self.config.max_chars_per_unit
        min_chars = self.config.min_chars_per_unit
        section_header = f"> 章节: {section.title}" if section.title else ""
        full_header = f"{doc_header}\n{section_header}".strip()

        paragraphs = section.content.split("\n\n")
        units: list[IngestUnit] = []
        current_parts: list[str] = []
        current_chars = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if current_chars + len(para) > max_chars and current_parts:
                content = f"{full_header}\n\n" + "\n\n".join(current_parts)
                units.append(IngestUnit(
                    id=str(uuid.uuid4())[:8],
                    content=content,
                    char_count=len(content),
                    source_documents=[doc.metadata.source_path],
                    source_sections=[section.title],
                    doc_type=doc.doc_type,
                    context_header=full_header,
                ))
                current_parts = []
                current_chars = 0

            current_parts.append(para)
            current_chars += len(para)

        # 最后一段
        if current_parts:
            # 如果太短, 尝试合并到上一个 unit
            if current_chars < min_chars and units:
                last = units[-1]
                merged = last.content + "\n\n" + "\n\n".join(current_parts)
                units[-1] = IngestUnit(
                    id=last.id,
                    content=merged,
                    char_count=len(merged),
                    source_documents=last.source_documents,
                    source_sections=last.source_sections,
                    doc_type=last.doc_type,
                    context_header=last.context_header,
                )
            else:
                content = f"{full_header}\n\n" + "\n\n".join(current_parts)
                units.append(IngestUnit(
                    id=str(uuid.uuid4())[:8],
                    content=content,
                    char_count=len(content),
                    source_documents=[doc.metadata.source_path],
                    source_sections=[section.title],
                    doc_type=doc.doc_type,
                    context_header=full_header,
                ))

        return units

    def _split_by_paragraphs(
        self, text: str, doc: ParseResult, header: str
    ) -> list[IngestUnit]:
        """无章节结构时按段落切分"""
        max_chars = self.config.max_chars_per_unit
        paragraphs = text.split("\n\n")
        units: list[IngestUnit] = []
        current_parts: list[str] = []
        current_chars = 0

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            if current_chars + len(para) > max_chars and current_parts:
                content = f"{header}\n\n" + "\n\n".join(current_parts)
                units.append(IngestUnit(
                    id=str(uuid.uuid4())[:8],
                    content=content,
                    char_count=len(content),
                    source_documents=[doc.metadata.source_path],
                    source_sections=[],
                    doc_type=doc.doc_type,
                    context_header=header,
                ))
                current_parts = []
                current_chars = 0

            current_parts.append(para)
            current_chars += len(para)

        if current_parts:
            content = f"{header}\n\n" + "\n\n".join(current_parts)
            units.append(IngestUnit(
                id=str(uuid.uuid4())[:8],
                content=content,
                char_count=len(content),
                source_documents=[doc.metadata.source_path],
                source_sections=[],
                doc_type=doc.doc_type,
                context_header=header,
            ))

        return units

    def _sections_to_unit(
        self, sections: list[Section], doc: ParseResult, header: str
    ) -> IngestUnit:
        """将多个章节合并为一个 IngestUnit"""
        parts = []
        for s in sections:
            if s.title:
                parts.append(f"{'#' * s.level} {s.title}\n{s.content}")
            else:
                parts.append(s.content)

        content = f"{header}\n\n" + "\n\n".join(parts)
        return IngestUnit(
            id=str(uuid.uuid4())[:8],
            content=content,
            char_count=len(content),
            source_documents=[doc.metadata.source_path],
            source_sections=[s.title for s in sections if s.title],
            doc_type=doc.doc_type,
            context_header=header,
        )

    def _merge_short_docs(self, docs: list[ParseResult]) -> list[IngestUnit]:
        """策略 C: 同目录短文档合并"""
        max_chars = self.config.max_chars_per_unit
        units: list[IngestUnit] = []
        current_docs: list[ParseResult] = []
        current_chars = 0

        for doc in docs:
            doc_chars = len(doc.content)
            if current_chars + doc_chars > max_chars and current_docs:
                units.append(self._merged_docs_to_unit(current_docs))
                current_docs = []
                current_chars = 0

            current_docs.append(doc)
            current_chars += doc_chars

        if current_docs:
            units.append(self._merged_docs_to_unit(current_docs))

        return units

    def _merged_docs_to_unit(self, docs: list[ParseResult]) -> IngestUnit:
        """多个短文档合并为一个 IngestUnit"""
        parts = []
        doc_type = docs[0].doc_type if docs else "general"

        for doc in docs:
            header = self._build_context_header(doc)
            parts.append(f"{header}\n\n{doc.content}")

        content = "\n\n---\n\n".join(parts)
        return IngestUnit(
            id=str(uuid.uuid4())[:8],
            content=content,
            char_count=len(content),
            source_documents=[d.metadata.source_path for d in docs],
            source_sections=[],
            doc_type=doc_type,
            context_header="",
        )

    @staticmethod
    def _build_context_header(doc: ParseResult) -> str:
        """构建文档上下文头 (附加在每个 IngestUnit 前)"""
        parts = [f"> 文档: {doc.title or doc.metadata.source_name}"]
        if doc.metadata.source_name:
            parts.append(f"> 文件: {doc.metadata.source_name}")
        if doc.metadata.page_count:
            parts.append(f"> 页数: {doc.metadata.page_count}")
        if doc.doc_type != "general":
            parts.append(f"> 类型: {doc.doc_type}")
        if doc.key_data:
            parts.append(f"> 关键数据: {'; '.join(doc.key_data[:5])}")
        return "\n".join(parts)
