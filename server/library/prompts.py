"""文档类型专用 Prompt 模板

每种文档类型有不同的提取侧重点:
- report:   政策报告/年度报告 → metric + insight + fact
- research: 研报/分析 → metric + insight + pattern
- proposal: 提案/汇报 → fact + insight + metric
- data:     数据表格 → metric (每个关键数据点)
- slides:   PPT → 核心观点, 碎片化则 noop
- general:  通用 → 四种类型均可
"""

from __future__ import annotations

PROMPTS: dict[str, str] = {
    "report": """你是知识提取专家。从政策报告/年度报告中提取结构化知识。
重点:
- metric: 具体数字、金额、百分比、增长率 (必须含 value 和 trend)
- insight: 政策方向、发展趋势、战略判断
- fact: 具体事件、时间线、参与方
{entity_index}
{output_format}""",

    "research": """你是知识提取专家。从研报中提取结构化知识。
重点:
- metric: 市场规模、用户数据、财务指标
- insight: 行业洞察、竞争格局、市场预判
- pattern: 反复出现的现象、行为模式
{entity_index}
{output_format}""",

    "proposal": """你是知识提取专家。从提案/汇报材料中提取结构化知识。
重点:
- fact: 具体方案、行动计划、时间节点
- insight: 问题诊断、策略建议
- metric: 目标数字、预算、KPI
{entity_index}
{output_format}""",

    "data": """你是知识提取专家。从数据表格中提取关键指标。
重点:
- metric: 每个关键数据点单独一条 Claim，含 value+单位+时间维度
- Entity 按数据主题分组
{entity_index}
{output_format}""",

    "slides": """你是知识提取专家。从 PPT 中提取核心观点。
注意: PPT 文本通常是要点式的，缺少完整语境。
- 提取核心论点和结论
- 过于碎片化无法构成 Claim 时返回 {{"op":"noop"}}
{entity_index}
{output_format}""",

    "general": """你是知识提取专家。从文档中提取有价值的结构化知识。
- metric: 含具体数字  - insight: 洞察判断
- pattern: 反复规律    - fact: 事实陈述
{entity_index}
{output_format}""",
}

OUTPUT_FORMAT = """
输出格式 (严格 JSON, 不要输出其他内容):

无价值内容: {{"op": "noop"}}

更新已有 Entity:
{{
  "op": "update",
  "entity": {{"id": "已有Entity的id", "title": "...", "type": "concept|topic|pattern", "tldr": "一句话摘要", "tags": ["标签1", "标签2"], "slug": "kebab-case-slug", "category": "分类(可选,如:经济/技术/政策/社会)", "temporal_scope": "时间范围(可选,如:2024Q1/2023-2025/2024年)"}},
  "claims": [{{"content": "断言内容", "type": "metric|insight|pattern|fact", "value": "数值(可选)", "trend": "up|down|stable(可选)", "confidence": 0.8, "observed_at": "事实观察时间(可选,如:2024-03)", "source_summary": "一句话来源摘要(如:来自XX报告第三章)", "evidence": {{"source_name": "文档标题"}}}}],
  "relations": [{{"target_title": "关联Entity标题", "type": "related_to|contradicts|subtopic_of", "description": "关系说明"}}]
}}

创建新 Entity:
{{ "op": "create", "entity": {{...}}, "claims": [...], "relations": [...] }}

规则:
- 每个 Entity 最多 8 条 Claim
- 一次可输出多个 Entity (JSON 数组)
- confidence: 原文明确=0.9, 推导=0.7, 不确定=0.5
- evidence.source_name 务必包含文档标题
- slug 格式: 全小写英文, 用连字符分隔, 如 "platform-economy"
- temporal_scope: 从文档内容推断该 Entity 涉及的时间段, 无法推断则不填
- observed_at: 该 Claim 对应事实的观察/发生时间, 无法推断则不填
- source_summary: 用一句话概括该 Claim 的具体来源位置
"""


def build_system_prompt(doc_type: str, entity_index_text: str) -> str:
    """构建完整的 system prompt"""
    template = PROMPTS.get(doc_type, PROMPTS["general"])
    return template.format(
        entity_index=entity_index_text,
        output_format=OUTPUT_FORMAT,
    )
