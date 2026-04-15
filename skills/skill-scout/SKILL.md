---
name: skill-scout
description: "监测全球 SKILL 社区（OpenClaw 等），根据用户现有技能和目标推荐并安装新技能"
version: "1.0.0"
author: "DunCrew"
dangerLevel: "high"
metadata:
  openclaw:
    emoji: "🔭"
    primaryEnv: "shell"
tags: ["技能发现", "技能推荐", "技能安装", "skill discovery", "skill recommend", "new skill", "install skill", "加载技能", "热门技能", "技能市场", "升级能力", "OpenClaw", "skill store"]
inputs:
  goal:
    type: "string"
    description: "\u7528\u6237\u60f3\u589e\u5f3a\u7684\u80fd\u529b\u65b9\u5411\u6216\u5177\u4f53\u76ee\u6807\uff08\u53ef\u9009\uff09"
  category:
    type: "string"
    description: "\u641c\u7d22\u7684\u6280\u80fd\u7c7b\u522b\uff08\u5982 productivity, dev, creative \u7b49\uff09\uff08\u53ef\u9009\uff09"
---

# Skill Scout

监测全球 SKILL 社区（OpenClaw、GitHub、npm 等），根据用户现有技能和实现目标，智能推荐并安装新技能。

## 核心能力

1. **发现**: 扫描 OpenClaw 社区、GitHub 和 npm 上的新技能
2. **分析**: 对比用户已安装技能，识别能力缺口
3. **推荐**: 根据用户目标推荐最相关的技能
4. **安装**: 自动下载并安装推荐的技能到本地

## 工作流程

当用户请求发现/推荐/安装新技能时，按以下完整流程执行：

### Phase 1: 扫描已安装技能

首先了解用户当前的能力状态：

```json
{"thought": "需要先查看用户已安装的技能，了解当前能力覆盖范围", "tool": "listDir", "args": {"path": "skills"}}
```

分析已安装的技能列表，识别出已覆盖的能力域和缺失的能力域。

### Phase 2: 搜索社区新技能

根据用户目标或能力缺口，搜索在线技能资源：

**搜索 OpenClaw 社区:**
```json
{"thought": "在 OpenClaw 社区搜索相关技能", "tool": "webSearch", "args": {"query": "OpenClaw skill {用户目标关键词} SKILL.md site:github.com"}}
```

**搜索 GitHub 上的 SKILL.md:**
```json
{"thought": "在 GitHub 搜索社区贡献的技能", "tool": "webSearch", "args": {"query": "SKILL.md {类别关键词} AI agent skill github"}}
```

**搜索 npm 上的技能包:**
```json
{"thought": "在 npm 搜索可用的技能包", "tool": "runCmd", "args": {"command": "npm search openclaw-skill --json 2>nul || npm search {关键词} --json 2>nul"}}
```

### Phase 3: 获取技能详情

找到候选技能后，获取其具体内容：

```json
{"thought": "获取技能的详细内容，评估是否适合安装", "tool": "webFetch", "args": {"url": "{技能的 raw SKILL.md URL}", "prompt": "提取这个技能的名称、描述、功能、依赖要求"}}
```

### Phase 4: 推荐决策

基于以下维度评估每个候选技能：

1. **相关性**: 与用户目标的匹配度
2. **互补性**: 与已安装技能的互补程度（填补能力缺口）
3. **质量**: 文档完整性、社区活跃度
4. **安全性**: 是否需要危险权限或敏感数据

输出推荐列表，格式：
```
推荐安装的技能:
1. [技能名] - [描述] - [推荐理由]
2. [技能名] - [描述] - [推荐理由]
3. [技能名] - [描述] - [推荐理由]

是否要安装以上技能？(可选择全部安装或指定编号)
```

### Phase 5: 安装技能

用户确认后，执行安装：

**方式 A: 从 URL 下载 SKILL.md**
```json
{"thought": "用户确认安装，获取技能内容", "tool": "webFetch", "args": {"url": "{SKILL.md 的 raw URL}", "prompt": "返回完整的 SKILL.md 文件内容，不要修改任何内容"}}
```

然后保存到本地：
```json
{"thought": "保存技能文件到本地 skills 目录", "tool": "writeFile", "args": {"path": "skills/{skill-name}/SKILL.md", "content": "{获取到的完整 SKILL.md 内容}"}}
```

**方式 B: 从 Git 仓库克隆**
```json
{"thought": "技能包含多个文件，需要克隆整个目录", "tool": "runCmd", "args": {"command": "cd skills && git clone {仓库URL} {skill-name}"}}
```

### Phase 6: 验证安装

```json
{"thought": "验证技能是否安装成功", "tool": "readFile", "args": {"path": "skills/{skill-name}/SKILL.md"}}
```

安装成功后告知用户：
```
✅ 技能 [{skill-name}] 安装成功！
   路径: skills/{skill-name}/SKILL.md
   描述: {技能描述}

   重启后端服务后生效，或等待系统自动热加载。
```

## Examples

### 根据目标推荐技能
User: "我想增强 Agent 的日程管理能力"

Step 1: 查看已安装技能
```json
{"thought": "先查看用户已安装的技能，看是否已有日程相关技能", "tool": "listDir", "args": {"path": "skills"}}
```

Step 2: 搜索日程类技能
```json
{"thought": "用户需要日程管理能力。搜索 OpenClaw 社区的日历/日程技能", "tool": "webSearch", "args": {"query": "OpenClaw skill calendar schedule planner SKILL.md site:github.com"}}
```

Step 3: 获取候选技能详情
```json
{"thought": "找到 google-calendar 技能，获取详情", "tool": "webFetch", "args": {"url": "https://raw.githubusercontent.com/anthropics/openclaw/main/skills/google-calendar/SKILL.md", "prompt": "提取技能的完整内容"}}
```

Step 4: 推荐并安装
```json
{"thought": "google-calendar 技能适合用户需求，保存到本地", "tool": "writeFile", "args": {"path": "skills/google-calendar/SKILL.md", "content": "..."}}
```

### 发现热门新技能
User: "有什么新的热门技能可以安装？"

Step 1: 扫描现有技能
```json
{"thought": "先查看已安装技能，避免推荐重复的", "tool": "listDir", "args": {"path": "skills"}}
```

Step 2: 搜索热门技能
```json
{"thought": "搜索最近流行的 AI Agent 技能", "tool": "webSearch", "args": {"query": "trending AI agent skills OpenClaw 2025 new SKILL.md"}}
```

Step 3: 对比并推荐
(Agent 对比搜索结果和已安装列表，输出推荐)

### 批量安装多个技能
User: "帮我安装所有跟开发相关的技能"

Step 1: 扫描现有技能
```json
{"thought": "查看已有的开发类技能", "tool": "listDir", "args": {"path": "skills"}}
```

Step 2: 搜索开发类技能
```json
{"thought": "搜索开发相关的技能资源", "tool": "webSearch", "args": {"query": "OpenClaw skill development coding git docker CI CD SKILL.md"}}
```

Step 3-N: 逐个获取并安装

## 搜索源配置

| 来源 | URL 模式 | 优先级 |
|------|---------|--------|
| OpenClaw GitHub | `github.com/anthropics/openclaw/tree/main/skills/` | 高 |
| OpenClaw Community | `github.com/topics/openclaw-skill` | 高 |
| GitHub SKILL.md | `github.com search: path:SKILL.md` | 中 |
| npm Skills | `npm search openclaw-skill` | 中 |
| 其他社区 | 根据 webSearch 发现 | 低 |

## Safety Rules

- **安装前必须展示技能内容摘要**，让用户了解技能会做什么
- **不安装包含恶意命令的技能**（如 rm -rf, format 等危险操作）
- **Git clone 仅限于知名仓库**，不克隆来源不明的代码
- **安装后建议用户审查 SKILL.md 内容**
- **只写入 skills/ 目录**，不修改系统文件

## Notes

- 安装新技能后需重启后端服务 (`python duncrew-server.py`) 或等待热加载
- 如果找不到合适的在线技能，可以建议使用 `skill-generator` 技能自己创建
- 推荐时优先选择有文档、有示例、社区认可的技能
- 保持 SKILL.md 文件原始格式，不要擅自修改获取到的技能内容