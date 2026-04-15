"""DunCrew Server - Dun/Nexus Management Mixin"""
from __future__ import annotations

import os
import re
import json
import time
import shutil
from pathlib import Path
from datetime import datetime

from server.constants import HAS_YAML, RESOURCES_DIR
from server.state import _db_lock
from server.utils import (
    parse_dun_frontmatter, extract_dun_body, update_dun_frontmatter,
    count_experience_entries, parse_skill_frontmatter,
)

class DunsMixin:
    """Dun/Nexus Management Mixin"""

    def handle_duns(self):
        """GET /duns - 扫描 duns/ 目录，返回所有 Dun 列表（附带 SQLite scoring）"""
        duns = []
        duns_dir = self.clawd_path / 'duns'

        if not duns_dir.exists():
            duns_dir.mkdir(parents=True, exist_ok=True)
            self.send_json([])
            return

        # 预加载所有 dun_scoring 数据 (一次查询，避免 N+1)
        scoring_map: dict[str, dict] = {}
        try:
            db = self._get_db()
            rows = db.execute("SELECT dun_id, scoring_data FROM dun_scoring").fetchall()
            for row in rows:
                try:
                    scoring_map[row['dun_id']] = json.loads(row['scoring_data'])
                except (json.JSONDecodeError, TypeError):
                    pass
        except Exception:
            pass  # scoring 加载失败不影响元数据返回

        seen = set()

        # 扫描 DUN.md 和旧版 NEXUS.md（只扫描直接子目录，避免 nexuses/ 嵌套导致重复）
        for dun_md in list(duns_dir.glob('*/DUN.md')) + list(duns_dir.glob('*/NEXUS.md')):
            dun_dir = dun_md.parent
            # 跳过归档目录
            if dun_dir.name.startswith('_archived_'):
                continue
            dir_key = str(dun_dir.resolve())
            if dir_key in seen:
                continue
            seen.add(dir_key)

            frontmatter = parse_dun_frontmatter(dun_md)
            if not frontmatter or not frontmatter.get('name'):
                continue

            sop_content = extract_dun_body(dun_md)
            exp_dir = dun_dir / 'experience'
            xp = count_experience_entries(exp_dir) if exp_dir.exists() else 0

            visual_dna = frontmatter.get('visual_dna', {})
            dun_id = dun_dir.name  # 始终用目录名做 id，与前端 dunId 一致
            dun_label = frontmatter.get('name', dun_dir.name)  # 显示名称

            dun_data = {
                'id': dun_id,
                'label': dun_label,
                'name': dun_label,
                'description': frontmatter.get('description', ''),
                'archetype': frontmatter.get('archetype', 'REACTOR'),
                'version': frontmatter.get('version', '1.0.0'),
                'skillDependencies': frontmatter.get('skill_dependencies', []),
                'tags': frontmatter.get('tags', []),
                'triggers': frontmatter.get('triggers', []),
                'visualDNA': visual_dna,
                'sopContent': sop_content,
                'xp': xp,
                'location': 'local',
                'path': str(dun_dir),
                'projectPath': frontmatter.get('project_path', ''),
                'status': 'active',
                # 目标函数驱动字段 (Objective-Driven Execution)
                'objective': frontmatter.get('objective', ''),
                'metrics': frontmatter.get('metrics', []),
                'strategy': frontmatter.get('strategy', ''),
                'skillsConfirmed': frontmatter.get('skills_confirmed', False),
            }

            # 附带 SQLite 中持久化的 scoring 数据
            # 优先用 dun_id (目录名) 查找，回退到 dun_label (frontmatter name)
            if dun_id in scoring_map:
                dun_data['scoring'] = scoring_map[dun_id]
            elif dun_label in scoring_map:
                dun_data['scoring'] = scoring_map[dun_label]
            elif 'initial_scoring' in frontmatter:
                # Fallback: 使用 DUN.md 中预设的初始分数（首次安装时）
                init_s = frontmatter['initial_scoring']
                dun_data['scoring'] = {
                    'score': init_s.get('score', 0),
                    'streak': 0,
                    'totalRuns': init_s.get('totalRuns', 0),
                    'successCount': init_s.get('successCount', 0),
                    'failureCount': init_s.get('failureCount', 0),
                    'successRate': init_s.get('successRate', 0),
                    'dimensions': {},
                    'recentRuns': [],
                    'lastUpdated': 0,
                }

            duns.append(dun_data)

        # ── 影子目录自愈 ──
        # 扫描 duns/ 下没有 DUN.md / NEXUS.md 的子目录，
        # 为它们自动补建 DUN.md 并加入返回列表
        for child in duns_dir.iterdir():
            if not child.is_dir():
                continue
            dir_key = str(child.resolve())
            if dir_key in seen:
                continue
            # 跳过归档目录和隐藏目录
            if child.name.startswith('.') or child.name.startswith('_archived_'):
                continue
            # 这是一个影子目录 — 自动补建 DUN.md
            seen.add(dir_key)
            dun_id = child.name
            minimal_md = f"---\nname: {dun_id}\ndescription: Auto-healed shadow Dun\nversion: 1.0.0\nskill_dependencies: []\n---\n"
            try:
                (child / 'DUN.md').write_text(minimal_md, encoding='utf-8')
                print(f'[Dun] Auto-healed shadow directory in scan: {dun_id}', file=sys.stderr)
            except Exception as e:
                print(f'[Dun] Failed to auto-heal {dun_id}: {e}', file=sys.stderr)
                continue
            exp_dir = child / 'experience'
            xp = count_experience_entries(exp_dir) if exp_dir.exists() else 0
            shadow_data = {
                'id': dun_id,
                'label': dun_id,
                'name': dun_id,
                'description': 'Auto-healed shadow Dun',
                'archetype': 'REACTOR',
                'version': '1.0.0',
                'skillDependencies': [],
                'tags': [],
                'triggers': [],
                'visualDNA': {},
                'sopContent': '',
                'xp': xp,
                'location': 'local',
                'path': str(child),
                'projectPath': '',
                'status': 'active',
                'objective': '',
                'metrics': [],
                'strategy': '',
                'skillsConfirmed': False,
            }
            if dun_id in scoring_map:
                shadow_data['scoring'] = scoring_map[dun_id]
            duns.append(shadow_data)

        self.send_json(duns)

    def handle_dun_archive(self, dun_name: str):
        """DELETE /duns/{name} - 归档 Dun 目录，防止文件扫描再次加载"""
        duns_dir = self.clawd_path / 'duns'
        if not duns_dir.exists():
            self.send_json({'ok': True, 'archived': False, 'reason': 'duns directory not found'})
            return

        # 查找匹配的 Dun 目录（精确匹配目录名或 frontmatter name）
        target_dir = None
        safe_name = dun_name.replace('/', '_').replace('\\', '_')

        # 1. 精确目录名匹配
        candidate = duns_dir / safe_name
        if candidate.is_dir() and (candidate / 'DUN.md').exists():
            target_dir = candidate
        elif candidate.is_dir() and (candidate / 'NEXUS.md').exists():
            target_dir = candidate

        # 2. 扫描 frontmatter name 匹配
        if not target_dir:
            for dun_md in list(duns_dir.glob('*/DUN.md')) + list(duns_dir.glob('*/NEXUS.md')):
                fm = parse_dun_frontmatter(dun_md)
                if fm and fm.get('name') == dun_name:
                    target_dir = dun_md.parent
                    break

        if not target_dir:
            self.send_json({'ok': True, 'archived': False, 'reason': 'Dun directory not found on filesystem'})
            return

        # 归档：重命名目录为 _archived_{dirname}，这样 glob('*/DUN.md') 扫描不会再匹配有效 Dun
        archived_name = f"_archived_{target_dir.name}"
        archived_path = duns_dir / archived_name
        try:
            # 如果已有同名归档目录，加时间戳后缀
            if archived_path.exists():
                import time as _time
                archived_name = f"_archived_{target_dir.name}_{int(_time.time())}"
                archived_path = duns_dir / archived_name
            target_dir.rename(archived_path)
            print(f"[DunCrew] Archived Dun directory: {target_dir.name} → {archived_name}")
            self.send_json({'ok': True, 'archived': True, 'archivedPath': str(archived_path)})
        except Exception as e:
            print(f"[DunCrew] Failed to archive Dun directory: {e}")
            self.send_json({'ok': True, 'archived': False, 'reason': str(e)})

    def handle_duns_health(self):
        """GET /duns/health - 检查 duns 目录的配置健康状况"""
        duns_dir = self.clawd_path / 'duns'
        issues = []
        suggestions = []
        stats = {
            'valid_duns': 0,
            'orphan_files': 0,
            'missing_dun_md': 0,
            'invalid_frontmatter': 0,
        }

        if not duns_dir.exists():
            self.send_json({
                'healthy': True,
                'issues': [],
                'suggestions': ['duns 目录为空，可以开始创建 Dun'],
                'stats': stats
            })
            return

        # 收集所有有效的 Dun 目录
        valid_dirs = set()
        for dun_md in list(duns_dir.glob('*/DUN.md')) + list(duns_dir.glob('*/NEXUS.md')):
            dun_dir = dun_md.parent
            dir_key = str(dun_dir.resolve())
            if dir_key in valid_dirs:
                continue
            frontmatter = parse_dun_frontmatter(dun_md)
            if frontmatter and frontmatter.get('name'):
                valid_dirs.add(dir_key)
                stats['valid_duns'] += 1
            else:
                stats['invalid_frontmatter'] += 1
                issues.append({
                    'type': 'invalid_frontmatter',
                    'path': str(dun_md),
                    'message': f"DUN.md 缺少必要的 'name' 字段",
                })

        # 检查孤立文件（有 .json 但没有 DUN.md）
        for item in duns_dir.iterdir():
            if item.is_file() and item.suffix == '.json':
                # 检查是否有对应的 DUN.md 目录
                stem = item.stem.replace('.json', '')
                potential_dir = duns_dir / stem
                if not (potential_dir / 'DUN.md').exists():
                    stats['orphan_files'] += 1
                    issues.append({
                        'type': 'orphan_json',
                        'path': str(item),
                        'message': f"发现孤立的 JSON 文件，没有对应的 DUN.md",
                        'suggestion': f"创建 {stem}/DUN.md 或删除此文件",
                    })
                    suggestions.append(
                        f"文件 '{item.name}' 可能是 AI 生成的配置，需要转换为 DUN.md 格式才能被系统识别"
                    )

            # 检查目录但没有 DUN.md
            if item.is_dir() and not (item / 'DUN.md').exists():
                # 检查目录内是否有其他文件
                files = list(item.iterdir())
                if files:
                    stats['missing_dun_md'] += 1
                    issues.append({
                        'type': 'missing_dun_md',
                        'path': str(item),
                        'message': f"目录 '{item.name}' 缺少 DUN.md 文件",
                        'files': [f.name for f in files[:5]],
                    })

        healthy = len(issues) == 0
        self.send_json({
            'healthy': healthy,
            'issues': issues,
            'suggestions': suggestions,
            'stats': stats,
            'tip': '运行 /duns 查看所有有效的 Dun' if healthy else '请修复上述问题后重新检查',
        })

    def handle_dun_detail(self, dun_name: str):
        """GET /duns/{name} - 获取单个 Dun 完整信息"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return
        dun_md = self._find_dun_md(dun_dir)
        if not dun_md:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        frontmatter = parse_dun_frontmatter(dun_md)
        sop_content = extract_dun_body(dun_md)
        exp_dir = dun_dir / 'experience'
        xp = count_experience_entries(exp_dir) if exp_dir.exists() else 0

        # 加载最近经验条目
        recent_experiences = []
        for exp_file in ['successes.md', 'failures.md']:
            exp_path = exp_dir / exp_file
            if not exp_path.exists():
                continue
            try:
                content = exp_path.read_text(encoding='utf-8')
                outcome = 'success' if 'success' in exp_file else 'failure'
                entries = content.split('\n### ')
                for entry in entries[1:]:  # skip header
                    entry = entry.strip()
                    if not entry:
                        continue
                    lines = entry.split('\n')
                    title = lines[0].strip() if lines else ''
                    recent_experiences.append({
                        'title': title,
                        'outcome': outcome,
                        'content': '\n'.join(lines[1:]).strip(),
                    })
            except Exception:
                pass

        # 按时间倒序（标题通常包含日期）
        recent_experiences = recent_experiences[-10:][::-1]

        visual_dna = frontmatter.get('visual_dna', {})

        response = {
            'id': frontmatter.get('name', dun_name),
            'name': frontmatter.get('name', dun_name),
            'description': frontmatter.get('description', ''),
            'archetype': frontmatter.get('archetype', 'REACTOR'),
            'version': frontmatter.get('version', '1.0.0'),
            'skillDependencies': frontmatter.get('skill_dependencies', []),
            'tags': frontmatter.get('tags', []),
            'triggers': frontmatter.get('triggers', []),
            'visualDNA': visual_dna,
            'sopContent': sop_content,
            'xp': xp,
            'recentExperiences': recent_experiences,
            'location': 'local',
            'path': str(dun_dir),
            'projectPath': frontmatter.get('project_path', ''),
            'status': 'active',
            # 目标函数驱动字段 (Objective-Driven Execution)
            'objective': frontmatter.get('objective', ''),
            'metrics': frontmatter.get('metrics', []),
            'strategy': frontmatter.get('strategy', ''),
        }
        self.send_json(response)

    @staticmethod
    def _find_dun_md(dun_dir: Path) -> 'Path | None':
        """查找 Dun 定义文件，兼容 DUN.md 和旧版 NEXUS.md"""
        dun_md = dun_dir / 'DUN.md'
        if dun_md.exists():
            return dun_md
        nexus_md = dun_dir / 'NEXUS.md'
        if nexus_md.exists():
            return nexus_md
        return None

    def _resolve_dun_dir(self, dun_name: str, auto_create: bool = False) -> Path | None:
        """根据 dun id/name 找到实际目录（优先精确匹配目录名，其次匹配 frontmatter name）
        
        auto_create: 如果为 True 且找不到已有目录，则自动创建最小 Dun 目录结构
                     （支持 Observer 自动创建的 Dun，它们没有 DUN.md 文件）
        """
        duns_dir = self.clawd_path / 'duns'
        if not duns_dir.exists():
            if auto_create:
                duns_dir.mkdir(parents=True, exist_ok=True)
            else:
                return None
        # 1) 精确匹配目录名 (兼容 DUN.md 和旧版 NEXUS.md)
        direct = duns_dir / dun_name
        if (direct / 'DUN.md').exists() or (direct / 'NEXUS.md').exists():
            return direct
        # 1.5) 目录存在但没有 DUN.md（影子目录，由前端写入数据时创建）
        #      自动补建 DUN.md 并返回
        if direct.is_dir():
            minimal_md = f"---\nname: {dun_name}\ndescription: Auto-healed shadow Dun\nversion: 1.0.0\nskill_dependencies: []\n---\n"
            (direct / 'DUN.md').write_text(minimal_md, encoding='utf-8')
            print(f'[Dun] Auto-healed shadow directory (no DUN.md): {dun_name}', file=sys.stderr)
            return direct
        # 2) 扫描直接子目录的 DUN.md / NEXUS.md，匹配 frontmatter 中的 name
        for dun_md in list(duns_dir.glob('*/DUN.md')) + list(duns_dir.glob('*/NEXUS.md')):
            fm = parse_dun_frontmatter(dun_md)
            if fm.get('name') == dun_name:
                return dun_md.parent
        # 3) 自动创建最小目录结构 (Observer 创建的 Dun)
        if auto_create:
            # 将 dun id 中不安全的路径字符替换
            safe_name = re.sub(r'[<>:"/\\|?*]', '_', dun_name)
            target_dir = duns_dir / safe_name
            target_dir.mkdir(parents=True, exist_ok=True)
            minimal_md = f"---\nname: {dun_name}\ndescription: Auto-created Dun\nversion: 1.0.0\nskill_dependencies: []\n---\n"
            (target_dir / 'DUN.md').write_text(minimal_md, encoding='utf-8')
            print(f'[Dun] Auto-created directory for Observer Dun: {dun_name}', file=sys.stderr)
            return target_dir
        return None

    def handle_dun_update_skills(self, dun_name: str, data: dict):
        """POST /duns/{name}/skills - 更新 Dun 技能依赖"""
        action = data.get('action', '')  # 'add' or 'remove'
        skill_id = data.get('skillId', '')

        if action not in ('add', 'remove') or not skill_id:
            self.send_error_json('Invalid: need action (add/remove) and skillId', 400)
            return

        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        dun_md = self._find_dun_md(dun_dir) or dun_dir / 'DUN.md'

        frontmatter = parse_dun_frontmatter(dun_md)
        deps = list(frontmatter.get('skill_dependencies', []))

        if action == 'add':
            if skill_id not in deps:
                deps.append(skill_id)
        elif action == 'remove':
            if len(deps) <= 1:
                self.send_error_json('Cannot remove last skill dependency', 400)
                return
            if skill_id in deps:
                deps.remove(skill_id)

        update_dun_frontmatter(dun_md, {'skill_dependencies': deps})

        self.send_json({
            'status': 'ok',
            'dunId': dun_name,
            'skillDependencies': deps,
        })

    def handle_dun_update_meta(self, dun_name: str, data: dict):
        """POST /duns/{name}/meta - 更新 Dun 元数据(名称、skills_confirmed 等)"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return
        dun_md = self._find_dun_md(dun_dir) or dun_dir / 'DUN.md'

        updates = {}
        if 'name' in data and data['name']:
            updates['name'] = str(data['name']).strip()
        if 'skills_confirmed' in data:
            updates['skills_confirmed'] = bool(data['skills_confirmed'])

        if not updates:
            self.send_error_json('No valid fields to update', 400)
            return

        update_dun_frontmatter(dun_md, updates)

        self.send_json({
            'status': 'ok',
            'dunId': dun_name,
            **updates
        })

    def handle_add_experience(self, dun_name: str, data: dict):
        """POST /duns/{name}/experience - 为 Dun 添加经验记录 (优化4: 结构化索引)"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        task = data.get('task', '')
        tools_used = data.get('tools_used', [])
        outcome = data.get('outcome', 'success')
        key_insight = data.get('key_insight', '')

        if not task:
            self.send_error_json('Missing required field: task', 400)
            return

        # 确保 experience 目录存在
        exp_dir = dun_dir / 'experience'
        exp_dir.mkdir(parents=True, exist_ok=True)

        # 构建 Markdown 条目
        from datetime import datetime
        timestamp = datetime.now().strftime('%Y-%m-%d')
        tool_seq = ' → '.join(tools_used) if tools_used else 'N/A'

        entry = f"\n### [{timestamp}] {task[:80]}\n"
        entry += f"- **Tools**: {tool_seq}\n"
        if key_insight:
            entry += f"- **Insight**: {key_insight}\n"
        entry += "---\n"

        # 追加到对应文件
        target_file = exp_dir / ('successes.md' if outcome == 'success' else 'failures.md')
        try:
            with target_file.open('a', encoding='utf-8') as f:
                f.write(entry)
        except Exception as e:
            self.send_error_json(f'Failed to write experience: {str(e)}', 500)
            return

        # 优化4: 同步更新结构化索引 (index.json)
        try:
            self._update_experience_index(exp_dir, {
                'type': 'success' if outcome == 'success' else 'failure',
                'task': task[:200],
                'tools': tools_used,
                'insight': key_insight,
                'timestamp': timestamp,
                'category': self._classify_experience(task, key_insight, tools_used),
            })
        except Exception as e:
            # 索引更新失败不影响主流程
            print(f"[WARN] Failed to update experience index: {e}")

        self.send_json({'status': 'ok', 'outcome': outcome})

    def _classify_experience(self, task: str, insight: str, tools: list) -> str:
        """优化4: 经验分类器 — 将经验归类为可检索的类别"""
        text = f"{task} {insight}".lower()
        if any(kw in text for kw in ['timeout', 'network', '超时', '网络', 'connection']):
            return 'network_error'
        if any(kw in text for kw in ['not found', 'enoent', '找不到', '不存在', 'path', '路径']):
            return 'path_error'
        if any(kw in text for kw in ['permission', '权限', 'access denied', 'forbidden']):
            return 'permission_error'
        if any(kw in text for kw in ['parameter', '参数', 'invalid', 'type error', '格式']):
            return 'param_error'
        if any(kw in text for kw in ['file', '文件', 'write', 'read', '写入', '读取']):
            return 'file_operation'
        if any(kw in text for kw in ['search', '搜索', 'web', '查询']):
            return 'search_operation'
        return 'general'

    def _update_experience_index(self, exp_dir: Path, entry: dict):
        """优化4: 维护结构化经验索引"""
        import json
        index_file = exp_dir / 'index.json'
        index = []

        # 读取现有索引
        if index_file.exists():
            try:
                with index_file.open('r', encoding='utf-8') as f:
                    index = json.load(f)
                    if not isinstance(index, list):
                        index = []
            except (json.JSONDecodeError, Exception):
                index = []

        # 追加新条目
        index.append(entry)

        # 限制索引大小: 保留最近 200 条
        if len(index) > 200:
            index = index[-200:]

        # 写入
        with index_file.open('w', encoding='utf-8') as f:
            json.dump(index, f, ensure_ascii=False, indent=2)

    # ============================================
    # 📚 Knowledge API (Per-Dun 知识库)
    # ============================================

    def handle_output_files_list(self, dun_name: str):
        """GET /duns/{name}/output-files - 列出 output/ 目录下的文件"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_json({'files': []})
            return
        output_dir = dun_dir / 'output'
        if not output_dir.exists():
            self.send_json({'files': []})
            return
        files = []
        TEXT_EXTENSIONS = {'.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.xml', '.html', '.log'}
        for f in sorted(output_dir.iterdir()):
            if f.is_file() and f.suffix.lower() in TEXT_EXTENSIONS:
                files.append({'name': f.name, 'size': f.stat().st_size})
        self.send_json({'files': files})

    def handle_output_file_read(self, dun_name: str, filename: str):
        """GET /duns/{name}/output-file/{filename} - 读取单个 output 文件内容"""
        if '..' in filename or '/' in filename or '\\' in filename:
            self.send_error_json('Invalid filename', 400)
            return
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return
        file_path = dun_dir / 'output' / filename
        if not file_path.exists() or not file_path.is_file():
            self.send_error_json(f"File '{filename}' not found", 404)
            return
        try:
            content = file_path.read_text(encoding='utf-8')
            self.send_json({'content': content, 'name': filename, 'size': len(content)})
        except Exception as e:
            self.send_error_json(f'Failed to read file: {str(e)}', 500)

    def handle_knowledge_list(self, dun_name: str):
        """GET /duns/{name}/knowledge - 列出 knowledge/ 目录下所有 .md 文件"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        knowledge_dir = dun_dir / 'knowledge'
        if not knowledge_dir.exists():
            self.send_json({'files': [], 'indexContent': None})
            return

        files = []
        for md_file in sorted(knowledge_dir.glob('*.md')):
            if md_file.name.startswith('_'):
                continue  # _index.md 和 _archive.md 单独处理
            try:
                stat = md_file.stat()
                files.append({
                    'name': md_file.stem,
                    'filename': md_file.name,
                    'size': stat.st_size,
                    'modifiedAt': int(stat.st_mtime * 1000),
                })
            except Exception:
                pass

        # 读取 _index.md
        index_content = None
        index_file = knowledge_dir / '_index.md'
        if index_file.exists():
            try:
                index_content = index_file.read_text(encoding='utf-8')
            except Exception:
                pass

        self.send_json({'files': files, 'indexContent': index_content})

    def handle_knowledge_read(self, dun_name: str, filename: str):
        """GET /duns/{name}/knowledge/{filename} - 读取单个知识文件"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        # 安全检查：禁止路径穿越
        if '..' in filename or '/' in filename or '\\' in filename:
            self.send_error_json('Invalid filename', 400)
            return

        file_path = dun_dir / 'knowledge' / filename
        if not file_path.exists():
            self.send_json({'content': None, 'exists': False})
            return

        try:
            content = file_path.read_text(encoding='utf-8')
            self.send_json({'content': content, 'exists': True})
        except Exception as e:
            self.send_error_json(f'Failed to read knowledge file: {str(e)}', 500)

    def handle_knowledge_write(self, dun_name: str, data: dict):
        """POST /duns/{name}/knowledge - 写入/更新知识文件"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        filename = data.get('filename', '')
        content = data.get('content', '')

        if not filename or not content:
            self.send_error_json('Missing required fields: filename, content', 400)
            return

        # 安全检查
        if '..' in filename or '/' in filename or '\\' in filename:
            self.send_error_json('Invalid filename', 400)
            return

        if not filename.endswith('.md'):
            filename += '.md'

        knowledge_dir = dun_dir / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        file_path = knowledge_dir / filename
        is_new = not file_path.exists()

        try:
            file_path.write_text(content, encoding='utf-8')
            self.send_json({
                'status': 'ok',
                'filename': filename,
                'created': is_new,
                'size': len(content),
            })
        except Exception as e:
            self.send_error_json(f'Failed to write knowledge file: {str(e)}', 500)

    def handle_knowledge_index_update(self, dun_name: str, data: dict):
        """POST /duns/{name}/knowledge/index - 更新 _index.md"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        content = data.get('content', '')
        if not content:
            self.send_error_json('Missing required field: content', 400)
            return

        knowledge_dir = dun_dir / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        index_file = knowledge_dir / '_index.md'
        try:
            index_file.write_text(content, encoding='utf-8')
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to write _index.md: {str(e)}', 500)

    def handle_knowledge_log_append(self, dun_name: str, data: dict):
        """POST /duns/{name}/knowledge/log - 追加 _log.md"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        entry = data.get('entry', '')
        if not entry:
            self.send_error_json('Missing required field: entry', 400)
            return

        knowledge_dir = dun_dir / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        log_file = knowledge_dir / '_log.md'
        try:
            existing = ''
            if log_file.exists():
                existing = log_file.read_text(encoding='utf-8')

            if not existing.strip():
                existing = '<!-- Knowledge Activity Log -->\n'

            new_content = existing.rstrip('\n') + '\n' + entry + '\n'
            log_file.write_text(new_content, encoding='utf-8')
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to append _log.md: {str(e)}', 500)

    # ============================================
    # Global Knowledge API (跨 Dun 共享知识)
    # ============================================

    def handle_global_knowledge_list(self):
        """GET /knowledge - 列出全局 knowledge/ 目录下所有 .md 文件"""
        knowledge_dir = self.clawd_path / 'knowledge'
        if not knowledge_dir.exists():
            self.send_json({'files': [], 'indexContent': None})
            return

        files = []
        for md_file in sorted(knowledge_dir.glob('*.md')):
            if md_file.name.startswith('_'):
                continue
            try:
                stat = md_file.stat()
                files.append({
                    'name': md_file.stem,
                    'filename': md_file.name,
                    'size': stat.st_size,
                    'modifiedAt': int(stat.st_mtime * 1000),
                })
            except Exception:
                pass

        index_content = None
        index_file = knowledge_dir / '_index.md'
        if index_file.exists():
            try:
                index_content = index_file.read_text(encoding='utf-8')
            except Exception:
                pass

        self.send_json({'files': files, 'indexContent': index_content})

    def handle_global_knowledge_read(self, filename: str):
        """GET /knowledge/{filename} - 读取全局知识文件"""
        if '..' in filename or '/' in filename or '\\' in filename:
            self.send_error_json('Invalid filename', 400)
            return

        file_path = self.clawd_path / 'knowledge' / filename
        if not file_path.exists():
            self.send_json({'content': None, 'exists': False})
            return

        try:
            content = file_path.read_text(encoding='utf-8')
            self.send_json({'content': content, 'exists': True})
        except Exception as e:
            self.send_error_json(f'Failed to read global knowledge file: {str(e)}', 500)

    def handle_global_knowledge_write(self, data: dict):
        """POST /knowledge - 写入/更新全局知识文件"""
        filename = data.get('filename', '')
        content = data.get('content', '')

        if not filename or not content:
            self.send_error_json('Missing required fields: filename, content', 400)
            return

        if '..' in filename or '/' in filename or '\\' in filename:
            self.send_error_json('Invalid filename', 400)
            return

        if not filename.endswith('.md'):
            filename += '.md'

        knowledge_dir = self.clawd_path / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        file_path = knowledge_dir / filename
        is_new = not file_path.exists()

        try:
            file_path.write_text(content, encoding='utf-8')
            self.send_json({
                'status': 'ok',
                'filename': filename,
                'created': is_new,
                'size': len(content),
            })
        except Exception as e:
            self.send_error_json(f'Failed to write global knowledge file: {str(e)}', 500)

    def handle_global_knowledge_index_update(self, data: dict):
        """POST /knowledge/index - 更新全局 _index.md"""
        content = data.get('content', '')
        if not content:
            self.send_error_json('Missing required field: content', 400)
            return

        knowledge_dir = self.clawd_path / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        index_file = knowledge_dir / '_index.md'
        try:
            index_file.write_text(content, encoding='utf-8')
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to write global _index.md: {str(e)}', 500)

    def handle_global_knowledge_log_append(self, data: dict):
        """POST /knowledge/log - 追加全局 _log.md"""
        entry = data.get('entry', '')
        if not entry:
            self.send_error_json('Missing required field: entry', 400)
            return

        knowledge_dir = self.clawd_path / 'knowledge'
        knowledge_dir.mkdir(parents=True, exist_ok=True)

        log_file = knowledge_dir / '_log.md'
        try:
            existing = ''
            if log_file.exists():
                existing = log_file.read_text(encoding='utf-8')

            if not existing.strip():
                existing = '<!-- Knowledge Activity Log -->\n'

            new_content = existing.rstrip('\n') + '\n' + entry + '\n'
            log_file.write_text(new_content, encoding='utf-8')
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to append global _log.md: {str(e)}', 500)

    # ============================================
    # 🧬 SOP Fitness API (SOP 演进系统)
    # ============================================

    def handle_dun_fitness_get(self, dun_name: str):
        """GET /duns/{name}/fitness - 读取 SOP fitness 数据"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        fitness_file = dun_dir / 'sop-fitness.json'
        if not fitness_file.exists():
            # 返回空表示尚无数据，前端会使用默认值
            self.send_json(None)
            return

        try:
            with fitness_file.open('r', encoding='utf-8') as f:
                data = json.load(f)
            self.send_json(data)
        except (json.JSONDecodeError, Exception) as e:
            self.send_error_json(f'Failed to read fitness data: {str(e)}', 500)

    def handle_dun_fitness_save(self, dun_name: str, data: dict):
        """POST /duns/{name}/fitness - 保存 SOP fitness 数据"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        fitness_file = dun_dir / 'sop-fitness.json'
        try:
            with fitness_file.open('w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to save fitness data: {str(e)}', 500)

    def handle_dun_sop_content_get(self, dun_name: str):
        """GET /duns/{name}/sop-content - 读取 DUN.md 完整内容"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        dun_md = self._find_dun_md(dun_dir)
        if not dun_md:
            self.send_json({'content': None})
            return

        try:
            content = dun_md.read_text(encoding='utf-8')
            self.send_json({'content': content})
        except Exception as e:
            self.send_error_json(f'Failed to read DUN.md: {str(e)}', 500)

    def handle_dun_sop_content_save(self, dun_name: str, data: dict):
        """POST /duns/{name}/sop-content - 写入 DUN.md 完整内容"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        content = data.get('content', '')
        if not content:
            self.send_error_json('Missing required field: content', 400)
            return

        dun_md = self._find_dun_md(dun_dir) or dun_dir / 'DUN.md'
        try:
            dun_md.write_text(content, encoding='utf-8')
            self.send_json({'status': 'ok'})
        except Exception as e:
            self.send_error_json(f'Failed to write DUN.md: {str(e)}', 500)

    def handle_dun_sop_history_get(self, dun_name: str):
        """GET /duns/{name}/sop-history - 读取指定版本的 SOP 历史"""
        dun_dir = self._resolve_dun_dir(dun_name)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        # 解析 query 参数获取版本号
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        version = query.get('version', [None])[0]

        history_dir = dun_dir / 'sop-history'
        if not history_dir.exists():
            self.send_json({'content': None, 'versions': []})
            return

        # 列出所有版本
        versions = sorted([
            f.stem  # e.g. 'v1', 'v2'
            for f in history_dir.glob('v*.md')
        ])

        if version:
            history_file = history_dir / f'{version}.md'
            if history_file.exists():
                content = history_file.read_text(encoding='utf-8')
                self.send_json({'content': content, 'versions': versions})
            else:
                self.send_json({'content': None, 'versions': versions})
        else:
            self.send_json({'content': None, 'versions': versions})

    def handle_dun_sop_history_save(self, dun_name: str, data: dict):
        """POST /duns/{name}/sop-history - 保存一个 SOP 版本到历史"""
        dun_dir = self._resolve_dun_dir(dun_name, auto_create=True)
        if not dun_dir:
            self.send_error_json(f"Dun '{dun_name}' not found", 404)
            return

        version = data.get('version', '')
        content = data.get('content', '')
        if not version or not content:
            self.send_error_json('Missing required fields: version, content', 400)
            return

        history_dir = dun_dir / 'sop-history'
        history_dir.mkdir(parents=True, exist_ok=True)

        history_file = history_dir / f'v{version}.md'
        try:
            history_file.write_text(content, encoding='utf-8')
            self.send_json({'status': 'ok', 'version': version})
        except Exception as e:
            self.send_error_json(f'Failed to save SOP history: {str(e)}', 500)


