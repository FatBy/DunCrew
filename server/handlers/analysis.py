"""DunCrew Server - Base Analysis Engine Mixin"""
from __future__ import annotations

import json
import time
import re
import base64
from pathlib import Path
from datetime import datetime, timedelta

from server.state import _db_lock

class AnalysisMixin:
    """Base Analysis Engine Mixin"""

    def _load_all_traces(self, days: int = 90, limit: int = 1000) -> list:
        """加载最近 N 天的 traces（公用加载器，避免重复代码）"""
        traces_dir = self.clawd_path / 'memory' / 'exec_traces'
        if not traces_dir.exists():
            return []

        cutoff_ts = (datetime.now() - timedelta(days=days)).timestamp() * 1000
        traces = []

        for trace_file in sorted(traces_dir.glob('*.jsonl'), reverse=True)[:6]:
            try:
                for line in trace_file.read_text(encoding='utf-8').strip().split('\n'):
                    if not line.strip():
                        continue
                    try:
                        trace = json.loads(line)
                        if trace.get('timestamp', 0) >= cutoff_ts:
                            traces.append(trace)
                            if len(traces) >= limit:
                                break
                    except json.JSONDecodeError:
                        continue
            except Exception:
                continue
            if len(traces) >= limit:
                break

        return traces

    def handle_base_analysis(self, query_params):
        """GET /api/base-analysis?days=90&model=xxx - 碱基序列综合分析"""
        days = min(int(query_params.get('days', ['90'])[0]), 180)
        model_filter = query_params.get('model', [''])[0].strip()
        traces = self._load_all_traces(days=days)

        # V5: 按模型过滤 (空字符串 / 'all' 表示不过滤)
        if model_filter and model_filter != 'all':
            traces = [t for t in traces if t.get('llmModel', '') == model_filter]

        if not traces:
            self.send_json({
                'traceCount': 0,
                'baseStats': {},
                'ngramPatterns': [],
                'injectionQuality': {},
                'skillAnalysis': {},
                'rules': [],
                'suggestions': [],
                'tokenAnalysis': {},
            })
            return

        # --- 1. 碱基分布统计 ---
        base_counts = {'E': 0, 'P': 0, 'V': 0, 'X': 0}
        success_count = 0
        total_count = len(traces)
        seq_lengths = []
        token_totals = []  # 每条 trace 的总 token 消耗
        tokens_on_success = []
        tokens_on_fail = []
        trace_token_map = {}  # trace 索引 -> trace_tokens（供 ngram 关联用）

        for t_idx, t in enumerate(traces):
            dist = t.get('baseDistribution', {})
            for b in ('E', 'P', 'V', 'X'):
                base_counts[b] += dist.get(b, 0)
            if t.get('success'):
                success_count += 1
            seq = t.get('baseSequence', '')
            if seq:
                seq_lengths.append(len(seq.split('-')))
            # 从 tools[].tokenCost 累加本条 trace 的 token 总量
            trace_tokens = 0
            for tool in t.get('tools', []):
                tc = tool.get('tokenCost')
                if tc and isinstance(tc, dict):
                    trace_tokens += (tc.get('prompt', 0) or 0) + (tc.get('completion', 0) or 0)
            if trace_tokens > 0:
                token_totals.append(trace_tokens)
                trace_token_map[t_idx] = trace_tokens
                if t.get('success'):
                    tokens_on_success.append(trace_tokens)
                else:
                    tokens_on_fail.append(trace_tokens)

        total_bases = sum(base_counts.values()) or 1
        avg_tokens = round(sum(token_totals) / len(token_totals)) if token_totals else 0
        sorted_tokens = sorted(token_totals) if token_totals else []
        median_tokens = sorted_tokens[len(sorted_tokens) // 2] if sorted_tokens else 0
        base_stats = {
            'distribution': {b: round(c / total_bases, 4) for b, c in base_counts.items()},
            'totalBases': total_bases,
            'successRate': round(success_count / total_count, 4) if total_count else 0,
            'avgSeqLength': round(sum(seq_lengths) / len(seq_lengths), 1) if seq_lengths else 0,
            'traceCount': total_count,
            'avgTokens': avg_tokens,
            'avgTokensOnSuccess': round(sum(tokens_on_success) / len(tokens_on_success)) if tokens_on_success else 0,
            'avgTokensOnFailure': round(sum(tokens_on_fail) / len(tokens_on_fail)) if tokens_on_fail else 0,
            'maxTokens': max(token_totals) if token_totals else 0,
            'minTokens': min(token_totals) if token_totals else 0,
            'medianTokens': median_tokens,
        }

        # --- 2. N-gram 模式分析 ---
        ngram_stats = {}  # pattern -> { total, success }
        ngram_token_map = {}  # pattern -> [trace_tokens]（去重后）
        for t_idx, t in enumerate(traces):
            seq = t.get('baseSequence', '')
            if not seq:
                continue
            bases = seq.split('-')
            is_success = t.get('success', False)
            t_tokens = trace_token_map.get(t_idx, 0)
            seen_patterns = set()  # 本条 trace 的 pattern 去重
            # 2-gram
            for i in range(len(bases) - 1):
                gram = f"{bases[i]}-{bases[i+1]}"
                entry = ngram_stats.setdefault(gram, {'total': 0, 'success': 0})
                entry['total'] += 1
                if is_success:
                    entry['success'] += 1
                if gram not in seen_patterns and t_tokens > 0:
                    ngram_token_map.setdefault(gram, []).append(t_tokens)
                    seen_patterns.add(gram)
            # 3-gram
            for i in range(len(bases) - 2):
                gram = f"{bases[i]}-{bases[i+1]}-{bases[i+2]}"
                entry = ngram_stats.setdefault(gram, {'total': 0, 'success': 0})
                entry['total'] += 1
                if is_success:
                    entry['success'] += 1
                if gram not in seen_patterns and t_tokens > 0:
                    ngram_token_map.setdefault(gram, []).append(t_tokens)
                    seen_patterns.add(gram)

        ngram_patterns = []
        for pattern, stats in ngram_stats.items():
            if stats['total'] >= 5:  # 至少 5 次出现才有统计意义
                rate = stats['success'] / stats['total'] if stats['total'] else 0
                tok_list = ngram_token_map.get(pattern, [])
                ngram_patterns.append({
                    'pattern': pattern,
                    'count': stats['total'],
                    'successRate': round(rate, 4),
                    'gram': pattern.count('-') + 1,
                    'avgTokens': round(sum(tok_list) / len(tok_list)) if tok_list else 0,
                })
        ngram_patterns.sort(key=lambda x: x['count'], reverse=True)

        # --- 3. 记忆注入质量分析 ---
        injection_quality = self._analyze_injection_quality(traces)

        # --- 4. 技能分析 ---
        skill_analysis = self._analyze_skills(traces)

        # --- 5. Governor 干预效果聚合 (从 governorInterventions 提取) ---
        active_rules = self._aggregate_governor_interventions(traces, base_stats.get('successRate', 0))

        # --- 6. 自动生成规则建议 ---
        suggestions = self._generate_suggestions(
            base_stats, ngram_patterns, injection_quality, skill_analysis, traces
        )

        # --- 7. 加载已保存的规则 ---
        rules = self._load_rules()

        # 如果没有用户自定义规则，使用 Governor 7 条内置规则作为初始数据
        if not rules:
            rules = self._get_default_governor_rules(active_rules)

        # --- 7.5 为已采纳规则重新计算命中率 ---
        rules = self._enrich_adopted_rules(rules, ngram_patterns, base_stats, traces)

        # --- 8. Token 消耗与碱基模式关联分析 ---
        patterns_with_tokens = [p for p in ngram_patterns if p.get('avgTokens', 0) > 0]
        top_token_patterns = sorted(patterns_with_tokens, key=lambda x: x['avgTokens'], reverse=True)[:5]
        efficient_patterns = sorted(
            patterns_with_tokens,
            key=lambda x: (x['successRate'] / x['avgTokens']) if x['avgTokens'] > 0 else 0,
            reverse=True
        )[:5]
        token_analysis = {
            'avgTokensOnSuccess': base_stats.get('avgTokensOnSuccess', 0),
            'avgTokensOnFailure': base_stats.get('avgTokensOnFailure', 0),
            'maxTokens': base_stats.get('maxTokens', 0),
            'minTokens': base_stats.get('minTokens', 0),
            'medianTokens': base_stats.get('medianTokens', 0),
            'topTokenPatterns': top_token_patterns,
            'efficientPatterns': efficient_patterns,
        }

        self.send_json({
            'traceCount': total_count,
            'baseStats': base_stats,
            'ngramPatterns': ngram_patterns[:50],  # 最多返回 50 个模式
            'injectionQuality': injection_quality,
            'skillAnalysis': skill_analysis,
            'activeRules': active_rules,
            'rules': rules,
            'suggestions': suggestions,
            'tokenAnalysis': token_analysis,
            'discoveredRules': self._load_discovered_rules_for_display(),
        })

    def handle_base_analysis_models(self, query_params):
        """GET /api/base-analysis/models?days=90 - 返回所有出现过的 model+provider 组合"""
        days = min(int(query_params.get('days', ['90'])[0]), 180)
        traces = self._load_all_traces(days=days)

        model_map = {}  # model -> { provider, count }
        for t in traces:
            model = t.get('llmModel', '')
            if not model or model == 'unknown':
                continue
            provider = t.get('llmProvider', 'unknown')
            if model not in model_map:
                model_map[model] = {'provider': provider, 'count': 0}
            model_map[model]['count'] += 1

        models = [
            {'model': m, 'provider': info['provider'], 'count': info['count']}
            for m, info in model_map.items()
        ]
        models.sort(key=lambda x: x['count'], reverse=True)

        self.send_json({'models': models})

    def _aggregate_governor_interventions(self, traces: list, overall_sr: float) -> list:
        """聚合 governorInterventions 字段，计算每条规则的命中次数和效果(pp)"""
        # rule_name -> { hit_count, hit_success, no_hit_count, no_hit_success }
        rule_stats = {}
        # 硬编码旧规则（向后兼容）+ 动态扫描 trace 中出现的新规则
        legacy_rule_names = [
            'consecutive_x_brake', 'step_length_fuse', 'switch_rate_warning',
            'diversity_collapse', 'late_planning_warning', 'missing_verification',
            'explore_dominance',
        ]
        legacy_rule_names_set = set(legacy_rule_names)
        all_rule_names_set = set(legacy_rule_names)

        # 先扫描全部 trace 收集所有出现过的规则名
        for t in traces:
            for iv in t.get('governorInterventions', []):
                rule = iv.get('rule', '')
                if rule:
                    all_rule_names_set.add(rule)

        all_rule_names = sorted(all_rule_names_set)
        for name in all_rule_names:
            rule_stats[name] = {
                'hitCount': 0, 'hitSuccess': 0,
                'noHitCount': 0, 'noHitSuccess': 0,
            }

        for t in traces:
            interventions = t.get('governorInterventions', [])
            is_success = t.get('success', False)
            hit_rules = set()
            for iv in interventions:
                rule = iv.get('rule', '')
                if rule in rule_stats:
                    hit_rules.add(rule)

            for name in all_rule_names:
                if name in hit_rules:
                    rule_stats[name]['hitCount'] += 1
                    if is_success:
                        rule_stats[name]['hitSuccess'] += 1
                else:
                    rule_stats[name]['noHitCount'] += 1
                    if is_success:
                        rule_stats[name]['noHitSuccess'] += 1

        # 构建活跃规则列表
        result = []
        rule_descriptions = {
            'consecutive_x_brake': '连续探索刹车',
            'step_length_fuse': '序列长度熔断（已禁用）',
            'switch_rate_warning': '切换频率过高',
            'diversity_collapse': '碱基多样性崩溃',
            'late_planning_warning': '后期规划警告',
            'missing_verification': '验证缺失提醒',
            'explore_dominance': '探索过度',
        }

        for name in all_rule_names:
            s = rule_stats[name]
            hit_sr = round(s['hitSuccess'] / s['hitCount'], 4) if s['hitCount'] > 0 else None
            no_hit_sr = round(s['noHitSuccess'] / s['noHitCount'], 4) if s['noHitCount'] > 0 else None
            effect_pp = None
            if hit_sr is not None and no_hit_sr is not None:
                effect_pp = round((hit_sr - no_hit_sr) * 100, 1)  # pp

            # V6: 旧硬编码规则的默认禁用集合
            DEFAULT_DISABLED = {
                'step_length_fuse',        # V4 禁用：长序列=差的假设完全反了
                'consecutive_x_brake',     # V6 禁用：effectPP=+7.5，反向干预
                'diversity_collapse',      # V6 禁用：effectPP=+7.9，反向干预
                'missing_verification',    # V6 禁用：effectPP=-0.5，无区分力
                'explore_dominance',       # V6 禁用：effectPP=-1.3，无区分力
                'late_planning_warning',   # 从未触发（0 命中）
            }
            # 读取用户偏好覆盖默认
            DISABLED_RULES = self._load_governor_rule_prefs(DEFAULT_DISABLED)

            # 动态发现规则默认为 active
            is_legacy = name in legacy_rule_names_set
            status = 'disabled' if (is_legacy and name in DISABLED_RULES) else 'active'

            result.append({
                'rule': name,
                'label': rule_descriptions.get(name, name),
                'hitCount': s['hitCount'],
                'hitSuccessRate': hit_sr,
                'noHitSuccessRate': no_hit_sr,
                'effectPP': effect_pp,
                'status': status,
                'origin': 'legacy' if is_legacy else 'discovered',
            })

        return result

    def _get_default_governor_rules(self, active_rules: list) -> list:
        """将 Governor 7 条内置规则作为初始规则注册数据"""
        rules = []
        for ar in active_rules:
            rules.append({
                'id': f'governor_{ar["rule"]}',
                'name': ar['label'],
                'rule': ar['rule'],
                'origin': 'governor',
                'status': ar['status'],
                'hitCount': ar['hitCount'],
                'effectPP': ar['effectPP'],
                'description': f'Governor 内置规则: {ar["label"]}',
            })
        return rules

    def _analyze_injection_quality(self, traces: list) -> dict:
        """分析记忆注入质量 — 从 contextInjectionMeta 提取统计"""
        meta_traces = [t for t in traces if t.get('contextInjectionMeta')]
        if not meta_traces:
            return {'hasData': False, 'traceCount': 0}

        # 按成功/失败分组分析
        success_scores = []
        fail_scores = []
        budget_utils = []  # memory budget utilization
        l0_counts = []
        skill_inject_counts = []
        skill_semantic_scores = []

        for t in meta_traces:
            meta = t['contextInjectionMeta']
            mem = meta.get('memory', {})
            skills = meta.get('skills', {})
            is_success = t.get('success', False)

            avg_score = mem.get('l0AvgScore', 0)
            if avg_score > 0:
                if is_success:
                    success_scores.append(avg_score)
                else:
                    fail_scores.append(avg_score)

            cap = mem.get('budgetCap', 1)
            if cap > 0:
                budget_utils.append(mem.get('budgetUsed', 0) / cap)

            l0_counts.append(mem.get('l0Count', 0))
            skill_inject_counts.append(skills.get('injectedCount', 0))

            avg_sem = skills.get('avgSemanticScore', 0)
            if avg_sem > 0:
                skill_semantic_scores.append(avg_sem)

        def safe_avg(arr):
            return round(sum(arr) / len(arr), 4) if arr else 0

        return {
            'hasData': True,
            'traceCount': len(meta_traces),
            'memory': {
                'avgScoreOnSuccess': safe_avg(success_scores),
                'avgScoreOnFailure': safe_avg(fail_scores),
                'scoreDelta': round(safe_avg(success_scores) - safe_avg(fail_scores), 4),
                'avgBudgetUtilization': safe_avg(budget_utils),
                'avgL0Count': safe_avg(l0_counts),
            },
            'skills': {
                'avgInjectedCount': safe_avg(skill_inject_counts),
                'avgSemanticScore': safe_avg(skill_semantic_scores),
            },
        }

    def _analyze_skills(self, traces: list) -> dict:
        """技能触发率和效果分析"""
        # skill -> { triggered: int, success: int, total_appearances: int }
        skill_stats = {}

        for t in traces:
            injected_ids = t.get('skillIds', [])
            is_success = t.get('success', False)
            tools_used = {tool.get('name') for tool in t.get('tools', [])}

            for sid in injected_ids:
                entry = skill_stats.setdefault(sid, {
                    'injected': 0, 'triggered': 0, 'success_when_injected': 0
                })
                entry['injected'] += 1
                if is_success:
                    entry['success_when_injected'] += 1
                # 简单触发判断：skill name 出现在工具名中（模糊匹配）
                sid_lower = sid.lower().replace('-', '_')
                if any(sid_lower in tn.lower().replace('-', '_') for tn in tools_used):
                    entry['triggered'] += 1

        skill_analysis = []
        for sid, stats in skill_stats.items():
            if stats['injected'] < 3:
                continue  # 样本太少，不分析
            skill_analysis.append({
                'skillId': sid,
                'injectedCount': stats['injected'],
                'triggeredCount': stats['triggered'],
                'triggerRate': round(stats['triggered'] / stats['injected'], 4),
                'successRate': round(stats['success_when_injected'] / stats['injected'], 4),
            })

        skill_analysis.sort(key=lambda x: x['injectedCount'], reverse=True)

        return {
            'totalSkillsTracked': len(skill_analysis),
            'skills': skill_analysis[:30],  # 最多返回 30 个
        }

    def _generate_suggestions(self, base_stats, ngram_patterns, injection_quality, skill_analysis, traces) -> list:
        """基于统计数据自动生成规则建议"""
        suggestions = []
        dist = base_stats.get('distribution', {})
        overall_sr = base_stats.get('successRate', 0)

        # 规则 1: V 碱基不足
        v_ratio = dist.get('V', 0)
        if v_ratio < 0.05 and len(traces) >= 20:
            suggestions.append({
                'id': 'auto_low_v_ratio',
                'type': 'rule_candidate',
                'severity': 'warning',
                'title': 'V 碱基（验证）比例过低',
                'description': f'V 碱基占比仅 {v_ratio:.1%}，建议在关键操作后增加验证步骤',
                'metric': {'vRatio': v_ratio},
                'origin': 'auto',
            })

        # 规则 2: X 碱基过多
        x_ratio = dist.get('X', 0)
        if x_ratio > 0.35 and len(traces) >= 20:
            suggestions.append({
                'id': 'auto_high_x_ratio',
                'type': 'rule_candidate',
                'severity': 'warning',
                'title': 'X 碱基（探索）比例过高',
                'description': f'X 碱基占比 {x_ratio:.1%}，可能存在过度探索',
                'metric': {'xRatio': x_ratio},
                'origin': 'auto',
            })

        # 规则 3: 低成功率 n-gram 模式
        # V4: 阈值 0.15→0.08，原阈值太严 (76.1%)，P-X-P=81.1% 被过滤
        for ng in ngram_patterns:
            if ng['count'] >= 10 and ng['successRate'] < overall_sr - 0.08:
                suggestions.append({
                    'id': f'auto_bad_ngram_{ng["pattern"].replace("-", "_")}',
                    'type': 'pattern_warning',
                    'severity': 'info',
                    'title': f'低效模式: {ng["pattern"]}',
                    'description': f'该模式出现 {ng["count"]} 次，成功率 {ng["successRate"]:.1%}，'
                                   f'低于整体 {overall_sr:.1%}',
                    'metric': {
                        'pattern': ng['pattern'],
                        'count': ng['count'],
                        'successRate': ng['successRate'],
                        'overallRate': overall_sr,
                    },
                    'origin': 'auto',
                })

        # 规则 4: 记忆注入质量差
        if injection_quality.get('hasData'):
            mem = injection_quality.get('memory', {})
            delta = mem.get('scoreDelta', 0)
            if delta < 0.05 and mem.get('avgScoreOnSuccess', 0) > 0:
                suggestions.append({
                    'id': 'auto_memory_low_impact',
                    'type': 'injection_warning',
                    'severity': 'info',
                    'title': '记忆注入对成功率影响微弱',
                    'description': f'成功/失败时 L0 平均 score 差异仅 {delta:.3f}，'
                                   f'记忆匹配质量可能需要改善',
                    'metric': mem,
                    'origin': 'auto',
                })

        # 规则 5: 僵尸技能
        for s in skill_analysis.get('skills', []):
            if s['injectedCount'] >= 10 and s['triggerRate'] < 0.05:
                suggestions.append({
                    'id': f'auto_zombie_skill_{s["skillId"]}',
                    'type': 'skill_warning',
                    'severity': 'info',
                    'title': f'僵尸技能: {s["skillId"]}',
                    'description': f'该技能被注入 {s["injectedCount"]} 次但触发率仅 {s["triggerRate"]:.1%}，'
                                   f'考虑禁用或优化其描述',
                    'metric': s,
                    'origin': 'auto',
                })

        return suggestions

    def _enrich_adopted_rules(self, rules, ngram_patterns, base_stats, traces):
        """为已采纳的数据驱动规则重新计算 hitSuccessRate / noHitSuccessRate"""
        overall_sr = base_stats.get('successRate', 0)
        ngram_map = {p['pattern']: p for p in ngram_patterns}

        for rule in rules:
            if rule.get('origin') != 'auto':
                continue

            rule_id = rule.get('id', '')

            # ---- pattern_warning 类规则：从当前 ngram 数据中查找对应模式 ----
            if rule_id.startswith('auto_bad_ngram_'):
                pattern = rule_id.replace('auto_bad_ngram_', '').replace('_', '-')
                ng = ngram_map.get(pattern)
                if ng:
                    rule['hitSuccessRate'] = ng['successRate']
                    rule['noHitSuccessRate'] = overall_sr
                    rule['hitCount'] = ng['count']
                    rule['effectPP'] = round((ng['successRate'] - overall_sr) * 100, 1)
                continue

            # ---- rule_candidate 类规则：按 trace 逐条判定命中/未命中 ----
            hit_success = 0
            hit_total = 0
            no_hit_success = 0
            no_hit_total = 0

            for t in traces:
                dist = t.get('baseDistribution', {})
                total_bases = sum(dist.values()) or 1
                is_success = t.get('success', False)

                hit = False
                if rule_id == 'auto_low_v_ratio':
                    v_ratio = dist.get('V', 0) / total_bases
                    hit = v_ratio < 0.05
                elif rule_id == 'auto_high_x_ratio':
                    x_ratio = dist.get('X', 0) / total_bases
                    hit = x_ratio > 0.35

                if hit:
                    hit_total += 1
                    if is_success:
                        hit_success += 1
                else:
                    no_hit_total += 1
                    if is_success:
                        no_hit_success += 1

            hit_sr = round(hit_success / hit_total, 4) if hit_total > 0 else None
            no_hit_sr = round(no_hit_success / no_hit_total, 4) if no_hit_total > 0 else None
            effect_pp = round((hit_sr - no_hit_sr) * 100, 1) if hit_sr is not None and no_hit_sr is not None else None

            rule['hitSuccessRate'] = hit_sr
            rule['noHitSuccessRate'] = no_hit_sr
            rule['hitCount'] = hit_total
            rule['effectPP'] = effect_pp

        return rules

    def _load_rules(self) -> list:
        """加载已保存的数据驱动规则"""
        rules_file = self.clawd_path / 'data' / 'base_analysis_rules.json'
        if not rules_file.exists():
            return []
        try:
            return json.loads(rules_file.read_text(encoding='utf-8'))
        except Exception:
            return []

    def handle_base_analysis_rules_save(self, data: dict):
        """POST /api/base-analysis/rules - 保存/更新规则"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        rules_file = data_dir / 'base_analysis_rules.json'
        rules = data.get('rules', [])
        try:
            rules_file.write_text(
                json.dumps(rules, ensure_ascii=False, indent=2),
                encoding='utf-8'
            )
            self.send_json({'saved': True, 'count': len(rules)})
        except Exception as e:
            self.send_error_json(f'Failed to save rules: {str(e)}', 500)

    def handle_rule_tips_get(self):
        """GET /api/rule-tips - 读取已缓存的规则通俗解释"""
        tips_file = self.clawd_path / 'data' / 'rule_tips.json'
        if not tips_file.exists():
            self.send_json({})
            return
        try:
            tips = json.loads(tips_file.read_text(encoding='utf-8'))
            self.send_json(tips)
        except Exception:
            self.send_json({})

    def handle_rule_tips_save(self, data: dict):
        """POST /api/rule-tips - 保存规则通俗解释（增量合并）"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        tips_file = data_dir / 'rule_tips.json'
        # 加载已有 tips，增量合并新 tips
        existing = {}
        if tips_file.exists():
            try:
                existing = json.loads(tips_file.read_text(encoding='utf-8'))
            except Exception:
                pass
        new_tips = data.get('tips', {})
        existing.update(new_tips)
        try:
            tips_file.write_text(
                json.dumps(existing, ensure_ascii=False, indent=2),
                encoding='utf-8'
            )
            self.send_json({'saved': True, 'count': len(existing)})
        except Exception as e:
            self.send_error_json(f'Failed to save rule tips: {str(e)}', 500)

    def handle_dismissed_items_get(self):
        """GET /api/dismissed-items - 读取已处理/忽略的项目 ID"""
        items_file = self.clawd_path / 'data' / 'dismissed_items.json'
        if not items_file.exists():
            self.send_json({'skills': [], 'suggestions': []})
            return
        try:
            data = json.loads(items_file.read_text(encoding='utf-8'))
            self.send_json(data)
        except Exception:
            self.send_json({'skills': [], 'suggestions': []})

    def handle_read_file_base64(self, query: dict):
        """GET /api/files/read-base64?path=xxx - 读取图片文件并返回 base64 Data URI"""
        file_path_str = query.get('path', [''])[0] if isinstance(query.get('path'), list) else query.get('path', '')
        if not file_path_str:
            self.send_error_json('path parameter is required', 400)
            return
        try:
            file_path = self._resolve_path(file_path_str, allow_outside=True)
        except Exception as e:
            self.send_error_json(f'路径解析失败: {str(e)}', 400)
            return
        if not file_path.exists():
            self.send_error_json(f'文件不存在: {file_path_str}', 404)
            return
        if not file_path.is_file():
            self.send_error_json(f'不是文件: {file_path_str}', 400)
            return
        # 安全约束: 仅允许图片格式
        ALLOWED_IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.webp', '.gif'}
        ext = file_path.suffix.lower()
        if ext not in ALLOWED_IMAGE_EXT:
            self.send_error_json(f'仅支持图片格式 ({", ".join(ALLOWED_IMAGE_EXT)})，当前: {ext}', 400)
            return
        if file_path.stat().st_size > MAX_FILE_SIZE:
            self.send_error_json(f'文件过大 (>{MAX_FILE_SIZE // 1024 // 1024}MB)', 413)
            return
        MIME_MAP = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.webp': 'image/webp', '.gif': 'image/gif',
        }
        mime_type = MIME_MAP.get(ext, 'application/octet-stream')
        file_bytes = file_path.read_bytes()
        b64_data = base64.b64encode(file_bytes).decode('ascii')
        self.send_json({
            'base64': f'data:{mime_type};base64,{b64_data}',
            'mimeType': mime_type,
            'size': len(file_bytes),
        })

    def handle_dismissed_items_save(self, data: dict):
        """POST /api/dismissed-items - 增量保存已处理/忽略的项目 ID"""
        data_dir = self.clawd_path / 'data'
        data_dir.mkdir(exist_ok=True)
        items_file = data_dir / 'dismissed_items.json'
        # 加载已有数据，增量合并
        existing = {'skills': [], 'suggestions': []}
        if items_file.exists():
            try:
                existing = json.loads(items_file.read_text(encoding='utf-8'))
            except Exception:
                pass
        # 合并去重
        new_skills = data.get('skills', [])
        new_suggestions = data.get('suggestions', [])
        existing_skills = set(existing.get('skills', []))
        existing_suggestions = set(existing.get('suggestions', []))
        existing_skills.update(new_skills)
        existing_suggestions.update(new_suggestions)
        merged = {
            'skills': list(existing_skills),
            'suggestions': list(existing_suggestions),
        }
        try:
            items_file.write_text(
                json.dumps(merged, ensure_ascii=False, indent=2),
                encoding='utf-8'
            )
            self.send_json({'saved': True, 'skills': len(merged['skills']), 'suggestions': len(merged['suggestions'])})
        except Exception as e:
            self.send_error_json(f'Failed to save dismissed items: {str(e)}', 500)

    def _load_discovered_rules_for_display(self) -> list:
        """加载 discovered_rules.json 供 base-analysis 响应展示"""
        path = self.clawd_path / 'data' / 'discovered_rules.json'
        if not path.exists():
            return []
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return []

    def _load_governor_rule_prefs(self, default_disabled: set) -> set:
        """读取用户的守护规则开关偏好，与默认禁用集合合并"""
        path = self.clawd_path / 'data' / 'governor_rule_prefs.json'
        if not path.exists():
            return default_disabled
        try:
            prefs = json.loads(path.read_text(encoding='utf-8'))
            # prefs 格式: {"rule_name": true/false}  true=启用, false=禁用
            result = set(default_disabled)
            for rule_name, enabled in prefs.items():
                if enabled:
                    result.discard(rule_name)
                else:
                    result.add(rule_name)
            return result
        except Exception:
            return default_disabled

    def handle_governor_rule_toggle(self, data: dict):
        """POST /api/governor/rule-toggle - 切换守护规则启用/禁用"""
        rule_name = data.get('rule')
        enabled = data.get('enabled')
        if not rule_name or enabled is None:
            self.send_error_json('Missing rule or enabled field', 400)
            return

        path = self.clawd_path / 'data' / 'governor_rule_prefs.json'
        prefs = {}
        if path.exists():
            try:
                prefs = json.loads(path.read_text(encoding='utf-8'))
            except Exception:
                pass

        prefs[rule_name] = bool(enabled)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(prefs, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_json({'ok': True, 'rule': rule_name, 'enabled': bool(enabled)})
        except Exception as e:
            self.send_error_json(f'Failed to save prefs: {str(e)}', 500)
