#!/usr/bin/env python3
"""
DunCrew 技能格式迁移脚本 - 全量升级 SKILL.md 到 OpenClaw 标准格式

功能:
1. 扫描 skills/ 下所有 SKILL.md
2. 解析现有 frontmatter，保留已有字段
3. 补全缺失的 OpenClaw 标准字段 (metadata.openclaw 块)
4. 保留正文不变
5. 生成迁移报告

用法: python scripts/migrate-skills.py [--dry-run] [--skills-dir skills/]
"""

import os
import sys
import re
import json
import argparse
from pathlib import Path

# Windows GBK 控制台兼容: 强制 UTF-8 输出
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False
    print("[WARN] PyYAML not installed. Install with: pip install pyyaml")
    print("[WARN] Falling back to regex-based parsing (less reliable)")

# ============================================
# Emoji 映射表 (技能名 -> emoji)
# ============================================
EMOJI_MAP = {
    # 通信/社交
    'discord': '🎮', 'slack': '💬', 'imsg': '💬', 'bluebubbles': '💬',
    'wacli': '📱', 'voice-call': '📞', 'feishu': '🐦',
    # 开发工具
    'github': '🐙', 'coding-agent': '🧩', 'code-runner': '⚡', 'code-search': '🔍',
    'tmux': '🖥️', 'browser-automation': '🌐',
    # 知识库
    '1password': '🔐', 'apple-notes': '📝', 'notion': '📓', 'obsidian': '💎',
    'bear-notes': '🐻', 'apple-reminders': '⏰', 'things-mac': '✅', 'trello': '📋',
    # AI/分析
    'deep-research': '🔬', 'summarize': '📄', 'oracle': '🔮', 'gemini': '♊',
    'structured-reasoning': '🧠', 'critical-evaluation': '🎯', 'diverse-ideation': '💡',
    'strategic-planning': '📊', 'meta-pattern-recognition': '🔄',
    # 媒体
    'openai-image-gen': '🎨', 'openai-whisper': '🎤', 'openai-whisper-api': '🎙️',
    'sherpa-onnx-tts': '🔊', 'video-frames': '🎬', 'camsnap': '📷', 'peekaboo': '👀',
    'songsee': '🎵', 'sonoscli': '🔈', 'spotify-player': '🎧',
    # 文档
    'docx': '📄', 'nano-pdf': '📑', 'powerpoint-pptx': '📊', 'frontend-slides': '🖼️',
    'markdown-formatter': '✍️', 'prose': '📝',
    # 数据
    'dd-os-data': '💾', 'python-dataviz': '📈', 'session-logs': '📋',
    'model-usage': '📊',
    # 技能系统
    'skill-generator': '🛠️', 'skill-creator': '🏗️', 'skill-scout': '🔭',
    'skill-executor': '⚙️',
    # 代理
    'proactive-agent': '🤖', 'self-improving-agent': '🧬', 'coding-agent': '🧩',
    'agent-review-pr': '👀', 'agent-prepare-pr': '📦', 'agent-merge-pr': '🔀',
    'agent-mintlify': '📚',
    # 工具
    'weather': '☁️', 'web-search': '🌐', 'canvas': '🎨', 'food-order': '🍽️',
    'goplaces': '📍', 'gifgrep': '🖼️', 'lobster': '🦞', 'blogwatcher': '📰',
    'healthcheck': '🏥', 'himalaya': '📧',
    # 架构
    'architecture-decision-records': '📐', 'rlm-engine': '🔧',
    'frontend-design': '🎨',
    # 其他
    'openhue': '💡', 'gog': '🎮', 'eightctl': '🔧', 'blucli': '🔵',
    'mcporter': '📦', 'nano-banana-pro': '🍌', 'ordercli': '📦', 'sag': '🔍',
    'tiangong-wps-ppt-automation': '📊',
}

# primaryEnv 推断规则
def infer_primary_env(skill_dir: Path, frontmatter: dict) -> str:
    """根据目录内容推断运行环境"""
    if (skill_dir / 'execute.py').exists():
        return 'python'
    if (skill_dir / 'execute.js').exists() or (skill_dir / 'execute.ts').exists():
        return 'node'
    if (skill_dir / 'execute.go').exists():
        return 'go'
    
    manifest = skill_dir / 'manifest.json'
    if manifest.exists():
        try:
            spec = json.loads(manifest.read_text(encoding='utf-8'))
            runtime = spec.get('runtime', '')
            if runtime in ('python', 'node', 'go', 'rust'):
                return runtime
        except Exception:
            pass
    
    # 从现有 metadata 推断
    oc = frontmatter.get('metadata', {})
    if isinstance(oc, dict):
        oc = oc.get('openclaw', {})
        if isinstance(oc, dict) and oc.get('primaryEnv'):
            return oc['primaryEnv']
    
    return 'shell'


def parse_frontmatter(content: str) -> tuple:
    """解析 SKILL.md，返回 (frontmatter_dict, body_text, has_frontmatter)"""
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n', content, re.DOTALL)
    if not match:
        return {}, content, False
    
    fm_text = match.group(1)
    body = content[match.end():]
    
    if HAS_YAML:
        try:
            fm = yaml.safe_load(fm_text) or {}
        except Exception:
            fm = {}
    else:
        fm = {}
        for line in fm_text.split('\n'):
            m = re.match(r'^(\w[\w.-]*)\s*:\s*(.+)$', line.strip())
            if m:
                key, val = m.group(1), m.group(2).strip()
                if val.startswith('{'):
                    try:
                        val = json.loads(val)
                    except Exception:
                        pass
                elif val.startswith('[') and val.endswith(']'):
                    val = [v.strip().strip('"\'') for v in val[1:-1].split(',') if v.strip()]
                fm[key] = val
    
    return fm, body, True


def extract_description(body: str) -> str:
    """从正文提取描述"""
    for line in body.split('\n'):
        line = line.strip()
        if line and not line.startswith('#') and not line.startswith('---') and not line.startswith('```'):
            return line[:200]
    return ''


def build_frontmatter(fm: dict, skill_dir: Path) -> str:
    """构建标准 OpenClaw YAML frontmatter"""
    skill_name = fm.get('name', skill_dir.name)
    
    lines = ['---']
    lines.append(f'name: {skill_name}')
    
    desc = fm.get('description', '')
    if desc:
        # 确保 description 被正确引用
        desc_escaped = desc.replace('"', '\\"')
        lines.append(f'description: "{desc_escaped}"')
    
    lines.append(f'version: "{fm.get("version", "1.0.0")}"')
    lines.append(f'author: "{fm.get("author", "DunCrew")}"')
    
    if fm.get('license'):
        lines.append(f'license: {fm["license"]}')
    if fm.get('homepage'):
        lines.append(f'homepage: {fm["homepage"]}')
    
    # metadata.openclaw 块
    metadata = fm.get('metadata', {})
    openclaw = {}
    if isinstance(metadata, dict):
        openclaw = metadata.get('openclaw', {}) or {}
    if not isinstance(openclaw, dict):
        openclaw = {}
    
    emoji = openclaw.get('emoji') or EMOJI_MAP.get(skill_name, '🔧')
    primary_env = openclaw.get('primaryEnv') or infer_primary_env(skill_dir, fm)
    requires = openclaw.get('requires', {})
    install = openclaw.get('install', [])
    
    lines.append('metadata:')
    lines.append('  openclaw:')
    lines.append(f'    emoji: "{emoji}"')
    lines.append(f'    primaryEnv: "{primary_env}"')
    
    if requires and isinstance(requires, dict):
        lines.append('    requires:')
        for key in ('bins', 'env', 'config', 'anyBins'):
            if key in requires:
                vals = requires[key]
                if isinstance(vals, list) and vals:
                    items = ', '.join(f'"{v}"' for v in vals)
                    lines.append(f'      {key}: [{items}]')
    
    if install and isinstance(install, list):
        lines.append('    install:')
        for spec in install:
            if isinstance(spec, dict):
                lines.append(f'      - id: "{spec.get("id", "")}"')
                lines.append(f'        kind: "{spec.get("kind", "")}"')
                for k in ('formula', 'package', 'module', 'url'):
                    if k in spec:
                        lines.append(f'        {k}: "{spec[k]}"')
                if 'bins' in spec and isinstance(spec['bins'], list):
                    bins_str = ', '.join(f'"{b}"' for b in spec['bins'])
                    lines.append(f'        bins: [{bins_str}]')
                if 'label' in spec:
                    lines.append(f'        label: "{spec["label"]}"')
    
    # tags
    tags = fm.get('tags', fm.get('keywords', []))
    if tags and isinstance(tags, list):
        tags_str = ', '.join(f'"{t}"' for t in tags)
        lines.append(f'tags: [{tags_str}]')
    
    # inputs
    if fm.get('inputs') and isinstance(fm['inputs'], dict):
        lines.append('inputs:')
        for param, schema in fm['inputs'].items():
            lines.append(f'  {param}:')
            if isinstance(schema, dict):
                for k, v in schema.items():
                    lines.append(f'    {k}: {json.dumps(v)}')
            else:
                lines.append(f'    type: "string"')
    
    # allowed-tools
    if fm.get('allowed-tools'):
        tools = fm['allowed-tools']
        if isinstance(tools, list):
            tools_str = ', '.join(f'"{t}"' for t in tools)
            lines.append(f'allowed-tools: [{tools_str}]')
    
    # dangerLevel
    if fm.get('dangerLevel'):
        lines.append(f'dangerLevel: "{fm["dangerLevel"]}"')
    
    lines.append('---')
    return '\n'.join(lines) + '\n'


def migrate_skill(skill_md: Path, dry_run: bool = False) -> dict:
    """迁移单个技能，返回报告"""
    skill_dir = skill_md.parent
    skill_name = skill_dir.name
    
    content = skill_md.read_text(encoding='utf-8')
    fm, body, had_frontmatter = parse_frontmatter(content)
    
    # 补全缺失字段
    if not fm.get('name'):
        fm['name'] = skill_name
    if not fm.get('description'):
        fm['description'] = extract_description(body)
    
    # 构建新的 frontmatter
    new_frontmatter = build_frontmatter(fm, skill_dir)
    new_content = new_frontmatter + '\n' + body.lstrip('\n')
    
    report = {
        'name': skill_name,
        'had_frontmatter': had_frontmatter,
        'had_openclaw': bool(isinstance(fm.get('metadata'), dict) and isinstance(fm.get('metadata', {}).get('openclaw'), dict)),
        'changed': new_content != content,
    }
    
    if not dry_run and new_content != content:
        skill_md.write_text(new_content, encoding='utf-8')
        report['written'] = True
    else:
        report['written'] = False
    
    return report


def main():
    parser = argparse.ArgumentParser(description='Migrate DunCrew skills to OpenClaw format')
    parser.add_argument('--dry-run', action='store_true', help='Preview changes without writing')
    parser.add_argument('--skills-dir', default='skills', help='Skills directory path')
    args = parser.parse_args()
    
    # 确定项目根目录
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    skills_dir = project_root / args.skills_dir
    
    if not skills_dir.exists():
        print(f"Error: Skills directory not found: {skills_dir}")
        sys.exit(1)
    
    print(f"{'[DRY RUN] ' if args.dry_run else ''}Scanning: {skills_dir}")
    print(f"PyYAML: {'available' if HAS_YAML else 'NOT available'}")
    print()
    
    reports = []
    skill_mds = sorted(skills_dir.rglob('SKILL.md'))
    
    for skill_md in skill_mds:
        try:
            report = migrate_skill(skill_md, dry_run=args.dry_run)
            reports.append(report)
            
            status = []
            if not report['had_frontmatter']:
                status.append('NEW-FM')
            elif not report['had_openclaw']:
                status.append('ADD-OC')
            else:
                status.append('UPDATE')
            
            if report['changed']:
                status.append('CHANGED')
            else:
                status.append('OK')
            
            icon = '✅' if not report['changed'] else ('📝' if report['written'] else '🔍')
            print(f"  {icon} {report['name']:40s} [{', '.join(status)}]")
            
        except Exception as e:
            print(f"  ❌ {skill_md.parent.name:40s} ERROR: {e}")
            reports.append({'name': skill_md.parent.name, 'error': str(e)})
    
    # 汇总
    total = len(reports)
    errors = sum(1 for r in reports if 'error' in r)
    changed = sum(1 for r in reports if r.get('changed'))
    written = sum(1 for r in reports if r.get('written'))
    new_fm = sum(1 for r in reports if not r.get('had_frontmatter') and 'error' not in r)
    add_oc = sum(1 for r in reports if r.get('had_frontmatter') and not r.get('had_openclaw') and 'error' not in r)
    
    print(f"\n{'=' * 60}")
    print(f"Migration Report")
    print(f"{'=' * 60}")
    print(f"Total skills scanned:    {total}")
    print(f"Errors:                  {errors}")
    print(f"New frontmatter added:   {new_fm}")
    print(f"OpenClaw metadata added: {add_oc}")
    print(f"Files changed:           {changed}")
    print(f"Files written:           {written}")
    
    if args.dry_run and changed > 0:
        print(f"\n[DRY RUN] Run without --dry-run to apply {changed} changes")


if __name__ == '__main__':
    main()
