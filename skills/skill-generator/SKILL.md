---
name: skill-generator
description: "帮助用户通过对话创建新的 DunCrew 技能。"
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🛠️"
    primaryEnv: "shell"
---

# Skill Generator

帮助用户通过对话创建新的 DunCrew 技能。

## 工作流程

当用户请求创建新技能时，按以下步骤执行：

### Step 1: 收集需求
必须询问用户以下信息：
1. **技能名称** - 小写带连字符 (如 `git-helper`, `file-backup`)
2. **简短描述** - 一句话说明功能
3. **使用的工具** - 从 readFile, writeFile, appendFile, listDir, runCmd, weather, webSearch 中选择
4. **使用示例** - 2-3 个典型场景
5. **触发关键词** - 中英文关键词列表

### Step 2: 生成 SKILL.md 内容
按以下模板结构生成：

```
# {技能名称}

{简短描述}

## Usage
{"thought": "说明推理过程", "tool": "{工具名}", "args": {...}}

## Examples

### {示例1标题}
User: "{用户输入}"
{"thought": "{推理}", "tool": "{工具}", "args": {...}}

### {示例2标题}
...

## Notes
- {注意事项1}
- {注意事项2}
```

### Step 3: 保存文件
```json
{"thought": "需求收集完毕，保存技能定义到 skills/{skill-name}/SKILL.md", "tool": "writeFile", "args": {"path": "skills/{skill-name}/SKILL.md", "content": "{生成的完整内容}"}}
```

### Step 4: 输出注册指南
保存成功后，告知用户：

> 技能已创建！请在 `src/services/LocalClawService.ts` 的 SKILL_TRIGGERS 添加：
> ```typescript
> '{skill-id}': {
>   keywords: ['{关键词1}', '{关键词2}', ...],
>   path: 'skills/{skill-name}/SKILL.md',
> },
> ```
> 重启前端后即可使用。

## Usage

创建技能的标准流程：
```json
{"thought": "用户想创建新技能，需要先收集需求信息", "tool": null, "args": {}}
```

保存技能文件：
```json
{"thought": "需求已收集，生成并保存 SKILL.md", "tool": "writeFile", "args": {"path": "skills/example-skill/SKILL.md", "content": "# Example Skill\n\n..."}}
```

## Examples

### 创建备份技能
User: "帮我创建一个备份文件的技能"

Agent 回复：
"好的！我需要了解一些信息来创建这个技能：

1. 技能名称是什么？（建议: `file-backup`）
2. 简短描述这个技能的功能？
3. 需要用到哪些工具？（readFile/writeFile/runCmd 等）
4. 请给我 2-3 个使用场景示例
5. 用户可能用什么关键词触发？（中英文）"

[用户回答后]

```json
{"thought": "用户需求: 名称 file-backup, 使用 readFile+writeFile, 关键词 '备份/backup'。生成 SKILL.md 内容并保存", "tool": "writeFile", "args": {"path": "skills/file-backup/SKILL.md", "content": "# File Backup\n\n自动备份指定文件到备份目录。\n\n## Usage\n..."}}
```

### 创建 Git 辅助技能
User: "创建一个帮我提交 Git 的技能"

[同样的需求收集流程]

## Notes

- **文件命名**: 使用小写字母和连字符 (lowercase-with-dashes)
- **路径限制**: 只能在 `skills/` 目录下创建
- **父目录**: writeFile 会自动创建父目录
- **格式一致**: 始终保持 Usage/Examples/Notes 三段式结构
- **信息完整**: 必须收集完所有 5 项信息后才能生成
