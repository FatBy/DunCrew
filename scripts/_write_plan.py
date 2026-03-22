# -*- coding: utf-8 -*-
"""Generate NEXUS_PERFORMANCE_UPGRADE_PLAN.md"""

import os

outpath = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'NEXUS_PERFORMANCE_UPGRADE_PLAN.md')

parts = []

parts.append('''# Nexus Performance Upgrade Plan

> 本文档为 Nexus 表现优化的完整执行方案，包含 7 个独立可执行的改进项。
> 按优先级排序，每个改进项々含：背景分析、设计方案、涉纊文件、具体代码变更。

---

## 目录

- [P0-1: 黄金路径提炼及 (Golden Path Distillation)](#p0-1-黄金路径提炼)
- [P0-2: 任务-Phase 适颍及 (Task-Phase Relevance)](#p0-2-任务-phase-适配)
- [P1-1: 上下斁腨胀治理 (Context Budget Management)](#p1-1-上下斁腨胀治理)
- [P1-2: SOP Rewrite 激活 + DAG 语法支持](#p1-2-sop-rewrite-激活--dag-语法支持)
- [P1-3: SOP 编写指南 + Nexus 创建辅助](#p1-3-sop-编写指南--nexus-创建辅助)
- [P2-1: 技能推荐引擎 (Skill Recommendation)](#p2-1-技能推荐引擎)
- [P2-2: SOP 前置环境检查 (Phase 0 Pre-check)](#p2-2-sop-前置环境检查)

''')

print('Writing part 1...')