"""DunCrew Server - Dun Skill Binding + Generation Tools Mixin"""
from __future__ import annotations

import json
import re
from pathlib import Path
from datetime import datetime

from server.utils import parse_dun_frontmatter, update_dun_frontmatter, parse_skill_frontmatter

class DunToolsMixin:
    """Dun Skill Binding + Generation Tools Mixin"""

    def _tool_dun_bind_skill(self, args: dict) -> str:
        """为 Dun 绑定新技能"""
        dun_id = args.get('dunId') or args.get('nexusId', '')
        skill_id = args.get('skillId', '')
        if not dun_id or not skill_id:
            raise ValueError('Missing dunId or skillId')

        dun_dir = self._resolve_dun_dir(dun_id, auto_create=False)
        if not dun_dir:
            raise ValueError(f"Dun '{dun_id}' not found")
        dun_md = dun_dir / 'NEXUS.md'

        # 验证技能存在 (skills/ 目录中有对应目录)
        skill_dir = self.clawd_path / 'skills' / skill_id
        if not skill_dir.exists():
            raise ValueError(f"Skill '{skill_id}' not found in skills/")

        frontmatter = parse_dun_frontmatter(dun_md)
        deps = list(frontmatter.get('skill_dependencies', []))

        if skill_id in deps:
            return f"Skill '{skill_id}' already bound to Dun '{dun_id}'"

        deps.append(skill_id)
        update_dun_frontmatter(dun_md, {'skill_dependencies': deps})
        return f"Skill '{skill_id}' bound to Dun '{dun_id}'. Dependencies: {deps}"

    def _tool_dun_unbind_skill(self, args: dict) -> str:
        """从 Dun 解绑技能"""
        dun_id = args.get('dunId') or args.get('nexusId', '')
        skill_id = args.get('skillId', '')
        if not dun_id or not skill_id:
            raise ValueError('Missing dunId or skillId')

        dun_dir = self._resolve_dun_dir(dun_id, auto_create=False)
        if not dun_dir:
            raise ValueError(f"Dun '{dun_id}' not found")
        dun_md = dun_dir / 'NEXUS.md'

        frontmatter = parse_dun_frontmatter(dun_md)
        deps = list(frontmatter.get('skill_dependencies', []))

        if skill_id not in deps:
            return f"Skill '{skill_id}' not bound to Dun '{dun_id}'"

        if len(deps) <= 1:
            return f"Cannot remove last skill from Dun '{dun_id}'. At least 1 skill required."

        deps.remove(skill_id)
        update_dun_frontmatter(dun_md, {'skill_dependencies': deps})
        return f"Skill '{skill_id}' unbound from Dun '{dun_id}'. Remaining: {deps}"

    def _tool_generate_skill(self, args: dict) -> str:
        """动态生成 Python SKILL 并保存
        
        当遇到无法完成的任务时，Agent 可以调用此工具生成新的 Python 技能来解决问题。
        生成的技能会保存到 skills/ 目录（或 nexuses/{dunId}/ 目录）并自动热加载。
        
        参数:
        - name: 技能名称 (kebab-case, 如 "pdf-merger")
        - description: 技能描述
        - pythonCode: Python 实现代码 (必须包含 main() 函数)
        - dunId: 可选，如果指定则保存到对应 Dun 目录
        - triggers: 可选，触发关键词列表
        """
        name = args.get('name', '')
        description = args.get('description', '')
        python_code = args.get('pythonCode', '')
        dun_id = args.get('dunId') or args.get('nexusId', '')
        triggers = args.get('triggers', [])
        tags = args.get('tags', [])
        danger_level = args.get('dangerLevel', 'safe')
        
        if not name or not description or not python_code:
            raise ValueError("Missing required parameters: name, description, pythonCode")
        
        # 规范化技能名称 (kebab-case)
        safe_name = re.sub(r'[^\w-]', '-', name.lower()).strip('-')
        safe_name = re.sub(r'-+', '-', safe_name)
        
        if not safe_name:
            raise ValueError("Invalid skill name")
        
        # 验证 Python 代码包含 main() 函数
        if 'def main(' not in python_code and 'async def main(' not in python_code:
            raise ValueError("Python code must contain a main() function")
        
        # 自动从 Python 代码中提取环境变量引用
        env_patterns = [
            r'''os\.environ\s*\[\s*['"](\w+)['"]\s*\]''',
            r'''os\.environ\.get\s*\(\s*['"](\w+)['"]''',
            r'''os\.getenv\s*\(\s*['"](\w+)['"]''',
            r'''environ\s*\[\s*['"](\w+)['"]\s*\]''',
        ]
        detected_envs = set()
        for pat in env_patterns:
            for m in re.finditer(pat, python_code):
                env_name = m.group(1)
                # 过滤常见非 API 环境变量
                if env_name not in ('PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'PWD', 'TMPDIR', 'TEMP', 'TMP'):
                    detected_envs.add(env_name)
        
        # 合并用户显式声明的 requires_env
        requires_env = list(detected_envs | set(args.get('requiresEnv', [])))
        
        # 自动从 triggers/description 推断 tags (如果未提供)
        if not tags and triggers:
            tags = [t.lower().replace(' ', '-') for t in triggers[:5]]
        
        # 确定保存路径
        if dun_id:
            # 保存到 Dun 专属目录
            skill_dir = self.clawd_path / 'nexuses' / dun_id / 'skills' / safe_name
        else:
            # 保存到全局 skills 目录
            skill_dir = self.clawd_path / 'skills' / safe_name
        
        skill_dir.mkdir(parents=True, exist_ok=True)
        
        # 生成 SKILL.md (完整 frontmatter)
        trigger_list = '\n'.join(f'- {t}' for t in triggers) if triggers else f'- {safe_name}'
        tags_yaml = ', '.join(tags) if tags else ''
        
        fm_parts = [
            '---',
            f'name: {safe_name}',
            f'description: "{description}"',
            'version: "1.0.0"',
            'author: auto-generated',
            f'dangerLevel: {danger_level}',
        ]
        if tags_yaml:
            fm_parts.append(f'tags: [{tags_yaml}]')
        fm_parts.append(f'keywords: [{", ".join(triggers) if triggers else safe_name}]')
        if requires_env:
            fm_parts.append('requires:')
            fm_parts.append(f'  env: [{", ".join(requires_env)}]')
        fm_parts.append('executable: ' + f'{safe_name}.py')
        fm_parts.append('runtime: python')
        fm_parts.append('metadata:')
        fm_parts.append('  openclaw:')
        fm_parts.append('    primaryEnv: python')
        fm_parts.append('---')
        
        env_note = ''
        if requires_env:
            env_list = ', '.join(f'`{e}`' for e in requires_env)
            env_note = f'\n> **API 依赖**: 此技能需要配置以下环境变量: {env_list}\n'
        
        skill_md_content = '\n'.join(fm_parts) + f'''

# {name}

{description}
{env_note}
## 使用方法

此技能由 DunCrew Agent 自动生成，用于解决特定任务。

### 执行

```bash
python {safe_name}.py
```

### 参数

请参考 Python 代码中的 `main()` 函数签名。

## 实现

参见 `{safe_name}.py`
'''
        
        # 写入文件
        skill_md_path = skill_dir / 'SKILL.md'
        skill_md_path.write_text(skill_md_content, encoding='utf-8')
        
        python_file_path = skill_dir / f'{safe_name}.py'
        python_file_path.write_text(python_code, encoding='utf-8')
        
        # 热加载: 重新注册工具
        try:
            tool_registry.refresh_skills()
            loaded_msg = "并已热加载到工具列表"
        except Exception as e:
            loaded_msg = f"但热加载失败: {e}"
        
        return json.dumps({
            'action': 'skill_created',
            'message': f'技能 "{safe_name}" 已成功创建{loaded_msg}',
            'skillName': safe_name,
            'skillDir': str(skill_dir),
            'files': [str(skill_md_path), str(python_file_path)],
            'dunId': dun_id or None,
        }, ensure_ascii=False)


