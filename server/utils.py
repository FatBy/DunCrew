"""DunCrew Server - Utility Functions"""
from __future__ import annotations

import re
import json
import uuid
import time
import threading
from pathlib import Path

from server.constants import HAS_YAML
try:
    import yaml
except ImportError:
    yaml = None

def safe_utf8_truncate(text: str, max_bytes: int) -> str:
    """UTF-8 安全截断，不破坏多字节字符"""
    encoded = text.encode('utf-8')
    if len(encoded) <= max_bytes:
        return text
    safe_idx = max_bytes
    while safe_idx > 0 and (encoded[safe_idx] & 0xC0) == 0x80:
        safe_idx -= 1
    return encoded[:safe_idx].decode('utf-8') + f"\n[已截断至约 {max_bytes // 1024}KB]"


def calculate_text_similarity(text1: str, text2: str) -> float:
    """计算两个文本的 N-gram Jaccard 相似度"""
    if not text1 or not text2:
        return 0.0
    
    def get_ngrams(text: str) -> set:
        text = text.lower()
        # 清理符号，保留中英文和数字
        text = re.sub(r'[^\w\s\u4e00-\u9fff]', '', text)
        chars = list(text.replace(' ', ''))
        if len(chars) < 2:
            return set(chars)
        # 提取单字和相邻双字词 (Bi-gram)
        bigrams = [''.join(chars[i:i+2]) for i in range(len(chars)-1)]
        return set(chars + bigrams)
    
    set1 = get_ngrams(text1)
    set2 = get_ngrams(text2)
    if not set1 or not set2:
        return 0.0
    
    intersection = set1.intersection(set2)
    union = set1.union(set2)
    return len(intersection) / len(union)

def parse_skill_frontmatter(skill_md_path: Path) -> dict:
    """从 SKILL.md 提取 YAML frontmatter 元数据 (支持嵌套 metadata.openclaw)"""
    try:
        content = skill_md_path.read_text(encoding='utf-8')
    except Exception:
        return {}

    match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', content, re.DOTALL)
    if not match:
        # 无 frontmatter，提取第一段非标题文本作为 description
        desc = ''
        for line in content.split('\n'):
            line = line.strip()
            if line and not line.startswith('#'):
                desc = line[:200]
                break
        return {'description': desc}

    if HAS_YAML:
        try:
            raw = yaml.safe_load(match.group(1)) or {}
        except Exception:
            return {}
    else:
        # 无 PyYAML 时用简单正则提取 key: value
        raw = {}
        for line in match.group(1).split('\n'):
            m = re.match(r'^(\w+)\s*:\s*(.+)$', line.strip())
            if m:
                key, val = m.group(1), m.group(2).strip()
                # 简单处理数组 [a, b, c]
                if val.startswith('[') and val.endswith(']'):
                    val = [v.strip().strip('"\'') for v in val[1:-1].split(',') if v.strip()]
                # 尝试 JSON 解析 (处理 metadata 等嵌套字段)
                elif val.startswith('{'):
                    try:
                        val = json.loads(val)
                    except Exception:
                        pass
                raw[key] = val
        return _flatten_openclaw_metadata(raw)

    return _flatten_openclaw_metadata(raw)


def _flatten_openclaw_metadata(raw: dict) -> dict:
    """从 frontmatter 中提取 metadata.openclaw 字段并扁平化到顶层"""
    metadata = raw.get('metadata', {})
    if isinstance(metadata, dict):
        openclaw = metadata.get('openclaw', {})
        if isinstance(openclaw, dict):
            # 提升 openclaw 字段到顶层 (不覆盖已有字段)
            for key in ('emoji', 'primaryEnv', 'requires', 'install', 'anyBins'):
                if key in openclaw and key not in raw:
                    raw[key] = openclaw[key]
            # requires 中的 anyBins 提升
            oc_requires = openclaw.get('requires', {})
            if isinstance(oc_requires, dict):
                if 'requires' not in raw:
                    raw['requires'] = oc_requires
                else:
                    # 合并
                    existing = raw['requires'] if isinstance(raw['requires'], dict) else {}
                    for k, v in oc_requires.items():
                        if k not in existing:
                            existing[k] = v
                    raw['requires'] = existing
            oc_install = openclaw.get('install', [])
            if oc_install and 'install' not in raw:
                raw['install'] = oc_install
        # 保留原始 metadata.openclaw 用于序列化
        raw['_openclaw'] = openclaw
    return raw

def skill_name_to_tool_name(name: str) -> str:
    """将 skill 名称标准化为工具名 (kebab-case -> snake_case)"""
    return name.replace('-', '_').replace(' ', '_').lower()


# Dun frontmatter 读-改-写锁 (防止并发 TOCTOU)
_dun_frontmatter_lock = threading.Lock()

def parse_dun_frontmatter(dun_md_path: Path) -> dict:
    """从 DUN.md 提取 YAML frontmatter 元数据"""
    try:
        content = dun_md_path.read_text(encoding='utf-8')
    except Exception:
        return {}

    match = re.match(r'^---\s*\r?\n(.*?)\r?\n---\s*\r?\n', content, re.DOTALL)
    if not match:
        return {}

    if HAS_YAML:
        try:
            return yaml.safe_load(match.group(1)) or {}
        except Exception:
            return {}
    else:
        result = {}
        for line in match.group(1).split('\n'):
            m = re.match(r'^(\w+)\s*:\s*(.+)$', line.strip())
            if m:
                key, val = m.group(1), m.group(2).strip()
                if val.startswith('[') and val.endswith(']'):
                    val = [v.strip().strip('"\'') for v in val[1:-1].split(',') if v.strip()]
                result[key] = val
        return result


def extract_dun_body(dun_md_path: Path) -> str:
    """从 DUN.md 提取 Markdown 正文 (跳过 frontmatter)"""
    try:
        content = dun_md_path.read_text(encoding='utf-8')
    except Exception:
        return ''

    # 去掉 frontmatter
    match = re.match(r'^---\s*\r?\n.*?\r?\n---\s*\r?\n', content, re.DOTALL)
    if match:
        return content[match.end():].strip()
    return content.strip()


# Dun frontmatter 读-改-写锁 (防止并发 TOCTOU)
_dun_frontmatter_lock = threading.Lock()

def update_dun_frontmatter(dun_md_path: Path, updates: dict):
    """更新 DUN.md 的 frontmatter 字段 (保留 body 不变, 带锁防并发)"""
    with _dun_frontmatter_lock:
        body = extract_dun_body(dun_md_path)
        frontmatter = parse_dun_frontmatter(dun_md_path)
        frontmatter.update(updates)

        # 重建 YAML frontmatter
        if HAS_YAML:
            fm_text = yaml.dump(frontmatter, default_flow_style=False, allow_unicode=True, sort_keys=False).rstrip('\n')
        else:
            # Fallback: 简单序列化（不支持多行字符串）
            fm_lines = []
            for key, val in frontmatter.items():
                if isinstance(val, list):
                    fm_lines.append(f'{key}:')
                    for item in val:
                        fm_lines.append(f'  - {item}')
                elif isinstance(val, dict):
                    fm_lines.append(f'{key}:')
                    for k, v in val.items():
                        fm_lines.append(f'  {k}: {v}')
                else:
                    fm_lines.append(f'{key}: {val}')
            fm_text = '\n'.join(fm_lines)

        content = f'---\n{fm_text}\n---\n\n{body}'
        dun_md_path.write_text(content, encoding='utf-8')


def count_experience_entries(exp_dir: Path) -> int:
    """统计经验目录中的条目数，用于 XP 计算"""
    xp = 0
    successes = exp_dir / 'successes.md'
    failures = exp_dir / 'failures.md'
    if successes.exists():
        try:
            lines = successes.read_text(encoding='utf-8').split('\n')
            xp += sum(1 for l in lines if l.startswith('### ')) * 10
        except Exception:
            pass
    if failures.exists():
        try:
            lines = failures.read_text(encoding='utf-8').split('\n')
            xp += sum(1 for l in lines if l.startswith('### ')) * 5
        except Exception:
            pass
    return xp

