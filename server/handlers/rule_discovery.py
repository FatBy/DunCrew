"""DunCrew Server - Rule Discovery Pipeline Mixin

数据驱动的规则自动发现管线。
核心流程：加载 traces → 提取 15 维特征 → Fisher 精确检验 → BH-FDR 校正 → 生成候选规则。
"""
from __future__ import annotations

import json
import time
import math
from pathlib import Path
from typing import Any

# scipy 用于 Fisher 精确检验
from scipy.stats import fisher_exact


# ============================================
# 15 维特征提取（必须与 featureRegistry.ts 完全对齐）
# ============================================

FEATURE_IDS = [
    'stepCount', 'switchRate', 'xeRatio', 'vRatio', 'pRatio', 'eRatio',
    'consecutiveXTail', 'consecutiveETail', 'maxERunLength', 'maxXRunLength',
    'xRatioLast5', 'earlyXRatio', 'pInLateHalf', 'lastPFollowedByV', 'distinctBases',
]


def _extract_trace_features(trace: dict) -> dict | None:
    """从单条 trace 提取 15 维特征。返回 None 表示序列无效。

    与 TypeScript extractFeaturesV2() 完全对齐。
    """
    seq_str = trace.get('baseSequence', '')
    if not seq_str:
        return None

    bases = seq_str.split('-')
    n = len(bases)
    if n == 0:
        return None

    # 单次遍历收集基础计数
    e_count = p_count = v_count = x_count = 0
    switches = 0
    max_e_run = cur_e_run = 0
    max_x_run = cur_x_run = 0
    base_set = set()

    for i, b in enumerate(bases):
        base_set.add(b)

        if b == 'E':
            e_count += 1; cur_e_run += 1; cur_x_run = 0
        elif b == 'X':
            x_count += 1; cur_x_run += 1; cur_e_run = 0
        else:
            if b == 'P':
                p_count += 1
            else:
                v_count += 1
            cur_e_run = 0; cur_x_run = 0

        if cur_e_run > max_e_run:
            max_e_run = cur_e_run
        if cur_x_run > max_x_run:
            max_x_run = cur_x_run

        if i > 0 and bases[i] != bases[i - 1]:
            switches += 1

    # 末尾连续 X
    consecutive_x_tail = 0
    for i in range(n - 1, -1, -1):
        if bases[i] == 'X':
            consecutive_x_tail += 1
        else:
            break

    # 末尾连续 E
    consecutive_e_tail = 0
    for i in range(n - 1, -1, -1):
        if bases[i] == 'E':
            consecutive_e_tail += 1
        else:
            break

    # 最近 5 步 X 占比
    last5 = bases[-min(5, n):]
    x_ratio_last5 = sum(1 for b in last5 if b == 'X') / len(last5)

    # 前 3 步 X 占比
    early = bases[:min(3, n)]
    early_x_ratio = sum(1 for b in early if b == 'X') / len(early)

    # 后半段是否有 P
    half_index = n // 2
    p_in_late_half = any(bases[i] == 'P' for i in range(half_index, n))

    # 最近 P 后是否接 V
    last_p_followed_by_v = False
    for i in range(n - 1, -1, -1):
        if bases[i] == 'P':
            last_p_followed_by_v = (i + 1 < n and bases[i + 1] == 'V')
            break

    return {
        'stepCount': n,
        'switchRate': switches / (n - 1) if n > 1 else 0,
        'xeRatio': x_count / (x_count + e_count) if (x_count + e_count) > 0 else 0,
        'vRatio': v_count / n,
        'pRatio': p_count / n,
        'eRatio': e_count / n,
        'consecutiveXTail': consecutive_x_tail,
        'consecutiveETail': consecutive_e_tail,
        'maxERunLength': max_e_run,
        'maxXRunLength': max_x_run,
        'xRatioLast5': x_ratio_last5,
        'earlyXRatio': early_x_ratio,
        'pInLateHalf': 1 if p_in_late_half else 0,       # 布尔 → 0/1
        'lastPFollowedByV': 1 if last_p_followed_by_v else 0,
        'distinctBases': len(base_set),
    }


# ============================================
# 统计检验核心
# ============================================

def _find_optimal_split(
    values: list[float],
    labels: list[bool],
    direction: str,  # '>' or '<'
    min_group: int = 10,
) -> dict | None:
    """对单特征单方向寻找最优切分点（最大 |effectPP|）。

    返回 { threshold, effectPP, pValue, hitCount, hitSR, noHitSR, table } 或 None。
    """
    if len(values) < min_group * 2:
        return None

    # 生成候选阈值：按 values 排序，取分位数以减少搜索量
    unique_sorted = sorted(set(values))
    if len(unique_sorted) < 2:
        return None

    # 取 20 个分位点作为候选
    n_candidates = min(20, len(unique_sorted) - 1)
    step = max(1, len(unique_sorted) // n_candidates)
    candidates = [unique_sorted[i] for i in range(step, len(unique_sorted), step)]
    if not candidates:
        candidates = unique_sorted[1:]  # fallback: 全量

    best = None
    best_effect = 0

    for thresh in candidates:
        if direction == '>':
            hit_mask = [v > thresh for v in values]
        else:
            hit_mask = [v < thresh for v in values]

        hit_success = sum(1 for m, l in zip(hit_mask, labels) if m and l)
        hit_fail = sum(1 for m, l in zip(hit_mask, labels) if m and not l)
        no_hit_success = sum(1 for m, l in zip(hit_mask, labels) if not m and l)
        no_hit_fail = sum(1 for m, l in zip(hit_mask, labels) if not m and not l)

        hit_total = hit_success + hit_fail
        no_hit_total = no_hit_success + no_hit_fail

        if hit_total < min_group or no_hit_total < min_group:
            continue

        hit_sr = hit_success / hit_total
        no_hit_sr = no_hit_success / no_hit_total
        effect_pp = (hit_sr - no_hit_sr) * 100  # 百分点

        # 只关注负效应（命中 → 成功率更低 → 应该触发警告）
        if effect_pp >= 0:
            continue

        if abs(effect_pp) > abs(best_effect):
            table = [[hit_success, hit_fail], [no_hit_success, no_hit_fail]]
            try:
                _, p_value = fisher_exact(table, alternative='two-sided')
            except Exception:
                continue

            best = {
                'threshold': thresh,
                'effectPP': round(effect_pp, 1),
                'pValue': p_value,
                'hitCount': hit_total,
                'hitSR': round(hit_sr, 4),
                'noHitSR': round(no_hit_sr, 4),
                'table': table,
            }
            best_effect = effect_pp

    return best


def _bh_fdr_correction(p_values: list[float], alpha: float = 0.1) -> list[bool]:
    """Benjamini-Hochberg FDR 校正。返回每个检验是否通过。"""
    m = len(p_values)
    if m == 0:
        return []

    # 按 p-value 排序，记录原始索引
    indexed = sorted(enumerate(p_values), key=lambda x: x[1])
    passed = [False] * m

    for rank, (orig_idx, p) in enumerate(indexed, start=1):
        threshold = alpha * rank / m
        if p <= threshold:
            passed[orig_idx] = True
        else:
            # BH 过程：一旦某个 rank 不通过，后续也不通过
            break

    return passed


def _generate_rule_id(feature: str, op: str, threshold: float) -> str:
    """生成规则 ID"""
    op_str = 'gt' if '>' in op else 'lt'
    # 将阈值转为字符串，小数点替换为 p
    thresh_str = str(round(threshold, 3)).replace('.', 'p').replace('-', 'n')
    return f'disc_{feature}_{op_str}_{thresh_str}'


def _generate_prompt_template(feature: str, op: str) -> str:
    """根据特征和方向生成提示模板"""
    templates = {
        'switchRate': '当前碱基切换频率为 {switchRate_pct}%，频繁切换可能降低执行效率。建议保持当前策略方向稳定。',
        'xeRatio': 'X/(X+E) 比值为 {xeRatio_pct}%，探索比例偏高。建议减少探索、更多执行。',
        'vRatio': 'V 碱基占比 {vRatio_pct}%。当前验证密度可能需要调整。',
        'pRatio': 'P 碱基占比 {pRatio_pct}%。规划密度可能需要调整。',
        'eRatio': 'E 碱基占比 {eRatio_pct}%。执行密度可能需要调整。',
        'consecutiveXTail': '末尾连续 {consecutiveXTail} 次探索，可能陷入循环。建议切换到执行或验证。',
        'consecutiveETail': '末尾连续 {consecutiveETail} 次执行。建议穿插验证确认结果。',
        'maxERunLength': '最长连续执行达 {maxERunLength} 步。过长的连续执行可能缺少反馈校验。',
        'maxXRunLength': '最长连续探索达 {maxXRunLength} 步。建议适时收敛探索方向。',
        'xRatioLast5': '近期 5 步中探索占 {xRatioLast5_pct}%。末段探索过多可能表明未收敛。',
        'earlyXRatio': '开局 3 步中探索占 {earlyXRatio_pct}%。开局过多探索可能浪费资源。',
        'pInLateHalf': '后半段缺少规划步骤。复杂任务中后期规划有助于重新校准方向。',
        'lastPFollowedByV': '最近的规划步骤未跟随验证。P→V 路径有助于确认规划有效。',
        'distinctBases': '碱基种类数为 {distinctBases}。策略多样性可能需要调整。',
        'stepCount': '序列长度 {stepCount} 步。长度与当前阈值不匹配时，效率可能下降。',
    }
    return templates.get(feature, f'特征 {feature} 触发了规则阈值。当前值: {{{feature}}}。')


def run_discovery(
    traces: list[dict],
    existing_rules: list[dict],
    *,
    min_group: int = 10,
    fdr_alpha: float = 0.1,
    min_effect_pp: float = -5.0,
) -> list[dict]:
    """执行完整的规则发现管线。

    Args:
        traces: 原始 trace 列表（含 baseSequence, success 字段）
        existing_rules: 已有规则列表（用于去重）
        min_group: 最小组大小
        fdr_alpha: FDR 校正的 alpha 水平
        min_effect_pp: 最小效应量（百分点，负数表示有害效应）

    Returns:
        新发现的候选规则列表（DiscoveredRule JSON 格式）
    """
    # 1. 提取特征矩阵
    feature_rows: list[dict] = []
    labels: list[bool] = []

    for t in traces:
        features = _extract_trace_features(t)
        if features is None:
            continue
        feature_rows.append(features)
        labels.append(bool(t.get('success', False)))

    if len(feature_rows) < min_group * 2:
        return []

    # 2. 对每个连续特征 × 两个方向搜索最优切分
    # 布尔特征只搜索 > 0.5（即 == 1）和 < 0.5（即 == 0）
    BOOLEAN_FEATURES = {'pInLateHalf', 'lastPFollowedByV'}
    candidates: list[dict] = []

    for fid in FEATURE_IDS:
        values = [row[fid] for row in feature_rows]

        if fid in BOOLEAN_FEATURES:
            # 布尔特征：直接检验 0 vs 1
            hit_mask = [v > 0.5 for v in values]
            hit_s = sum(1 for m, l in zip(hit_mask, labels) if m and l)
            hit_f = sum(1 for m, l in zip(hit_mask, labels) if m and not l)
            no_s = sum(1 for m, l in zip(hit_mask, labels) if not m and l)
            no_f = sum(1 for m, l in zip(hit_mask, labels) if not m and not l)

            hit_total = hit_s + hit_f
            no_total = no_s + no_f

            if hit_total < min_group or no_total < min_group:
                continue

            hit_sr = hit_s / hit_total
            no_hit_sr = no_s / no_total
            effect_pp = (hit_sr - no_hit_sr) * 100

            # 两个方向都检查
            for ep, op, th in [
                (effect_pp, '>', 0.5),
                (-effect_pp, '<', 0.5),
            ]:
                if ep >= 0:  # 只关注负效应
                    continue
                if abs(ep) < abs(min_effect_pp):
                    continue
                table = ([[hit_s, hit_f], [no_s, no_f]] if op == '>'
                         else [[no_s, no_f], [hit_s, hit_f]])
                try:
                    _, pv = fisher_exact(table, alternative='two-sided')
                except Exception:
                    continue
                candidates.append({
                    'feature': fid,
                    'op': op,
                    'threshold': th,
                    'effectPP': round(ep, 1),
                    'pValue': pv,
                    'hitCount': hit_total if op == '>' else no_total,
                    'hitSR': round(hit_sr if op == '>' else no_hit_sr, 4),
                    'noHitSR': round(no_hit_sr if op == '>' else hit_sr, 4),
                })
        else:
            # 连续特征：搜索 > 和 < 两个方向
            for direction in ('>', '<'):
                result = _find_optimal_split(values, labels, direction, min_group)
                if result is None:
                    continue
                if abs(result['effectPP']) < abs(min_effect_pp):
                    continue
                candidates.append({
                    'feature': fid,
                    'op': direction,
                    'threshold': result['threshold'],
                    'effectPP': result['effectPP'],
                    'pValue': result['pValue'],
                    'hitCount': result['hitCount'],
                    'hitSR': result['hitSR'],
                    'noHitSR': result['noHitSR'],
                })

    if not candidates:
        return []

    # 3. BH-FDR 校正
    p_values = [c['pValue'] for c in candidates]
    passed = _bh_fdr_correction(p_values, fdr_alpha)

    significant = [c for c, p in zip(candidates, passed) if p]
    if not significant:
        return []

    # 4. 去重：每个特征只保留最强的规则（最大 |effectPP|）
    best_per_feature: dict[str, dict] = {}
    for c in significant:
        fid = c['feature']
        if fid not in best_per_feature or abs(c['effectPP']) > abs(best_per_feature[fid]['effectPP']):
            best_per_feature[fid] = c

    # 5. 与已有规则去重
    existing_ids = set()
    for r in existing_rules:
        existing_ids.add(r.get('id', ''))
        # 也通过特征去重
        cond = r.get('condition', {})
        for clause in cond.get('clauses', []):
            existing_ids.add(clause.get('feature', ''))

    # 6. 构建 DiscoveredRule JSON
    now_ms = int(time.time() * 1000)
    new_rules: list[dict] = []

    for c in best_per_feature.values():
        fid = c['feature']
        op = c['op']
        threshold = c['threshold']
        rule_id = _generate_rule_id(fid, op, threshold)

        # 跳过已存在的规则（按 ID 或特征）
        if rule_id in existing_ids or fid in existing_ids:
            continue

        rule: dict[str, Any] = {
            'id': rule_id,
            'name': f'{fid} {op} {round(threshold, 3)}',
            'lifecycle': 'candidate',
            'condition': {
                'operator': 'AND',
                'clauses': [{
                    'feature': fid,
                    'op': op,
                    'value': round(threshold, 4),
                }],
            },
            'action': {
                'promptTemplate': _generate_prompt_template(fid, op),
                'severity': 'warning' if abs(c['effectPP']) >= 10 else 'info',
            },
            'stats': {
                'effectSizePP': c['effectPP'],
                'pValue': round(c['pValue'], 6),
                'hitCount': c['hitCount'],
                'hitSuccessRate': c['hitSR'],
                'noHitSuccessRate': c['noHitSR'],
                'sampleSize': len(feature_rows),
                'discoveredAt': now_ms,
                'lastValidatedAt': now_ms,
                'validationCount': 0,
            },
            'adaptationBounds': {
                'feature': fid,
                'min': round(threshold * 0.5, 4),
                'max': round(threshold * 1.5, 4),
                'step': round(threshold * 0.1, 4) if threshold != 0 else 0.01,
            },
            'origin': 'discovered',
        }
        new_rules.append(rule)

    # 按 |effectPP| 降序排列
    new_rules.sort(key=lambda r: abs(r['stats']['effectSizePP']), reverse=True)
    return new_rules


# ============================================
# HTTP Handler Mixin
# ============================================

class RuleDiscoveryMixin:
    """规则发现管线 HTTP 端点"""

    def _get_discovered_rules_path(self) -> Path:
        return self.clawd_path / 'data' / 'discovered_rules.json'

    def _load_discovered_rules(self) -> list[dict]:
        """加载已发现的规则"""
        path = self._get_discovered_rules_path()
        if not path.exists():
            return []
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return []

    def _save_discovered_rules(self, rules: list[dict]) -> None:
        """持久化发现规则"""
        path = self._get_discovered_rules_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(rules, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )

    def handle_rule_discovery_run(self, data: dict):
        """POST /api/rule-discovery/run - 执行规则发现管线

        Request body:
            { days?: number, minGroup?: number, fdrAlpha?: number, minEffectPP?: number }

        Response:
            { newRules: [...], existingRules: [...], stats: { tracesAnalyzed, featuresScanned, ... } }
        """
        days = min(int(data.get('days', 90)), 180)
        min_group = max(int(data.get('minGroup', 10)), 5)
        fdr_alpha = float(data.get('fdrAlpha', 0.1))
        min_effect_pp = float(data.get('minEffectPP', -5.0))

        # 1. 加载 traces
        traces = self._load_all_traces(days=days)
        if not traces:
            self.send_json({
                'newRules': [],
                'existingRules': self._load_discovered_rules(),
                'stats': {'tracesAnalyzed': 0, 'featuresScanned': 0, 'candidatesTested': 0},
            })
            return

        # 2. 加载已有规则
        existing = self._load_discovered_rules()

        # 3. 运行发现管线
        new_rules = run_discovery(
            traces, existing,
            min_group=min_group,
            fdr_alpha=fdr_alpha,
            min_effect_pp=min_effect_pp,
        )

        # 4. 合并新规则到已有规则列表
        if new_rules:
            merged = existing + new_rules
            self._save_discovered_rules(merged)
            existing = merged

        self.send_json({
            'newRules': new_rules,
            'existingRules': existing,
            'stats': {
                'tracesAnalyzed': len(traces),
                'featuresScanned': len(FEATURE_IDS),
                'candidatesTested': len(FEATURE_IDS) * 2,  # 每个特征 2 个方向
                'newRulesFound': len(new_rules),
            },
        })

    def handle_discovered_rules_get(self):
        """GET /api/discovered-rules - 获取所有已发现规则"""
        rules = self._load_discovered_rules()
        self.send_json({'rules': rules})

    def handle_discovered_rules_save(self, data: dict):
        """POST /api/discovered-rules - 保存/更新发现规则（含生命周期操作）

        Request body:
            { rules: [...] }
            或 { action: 'validate' | 'retire', ruleId: string }
        """
        action = data.get('action')

        if action in ('validate', 'retire'):
            # 单规则生命周期操作
            rule_id = data.get('ruleId', '')
            rules = self._load_discovered_rules()
            found = False
            for r in rules:
                if r.get('id') == rule_id:
                    found = True
                    if action == 'validate':
                        r['lifecycle'] = 'validated'
                        r['stats']['lastValidatedAt'] = int(time.time() * 1000)
                        r['stats']['validationCount'] = r['stats'].get('validationCount', 0) + 1
                    elif action == 'retire':
                        r['lifecycle'] = 'retired'
                        r['retiredReason'] = data.get('reason', 'manual')
                    break

            if not found:
                self.send_error_json(f'Rule not found: {rule_id}', 404)
                return

            self._save_discovered_rules(rules)
            self.send_json({'saved': True, 'rules': rules})
        else:
            # 全量保存
            rules = data.get('rules', [])
            self._save_discovered_rules(rules)
            self.send_json({'saved': True, 'count': len(rules)})
