---
name: file-operations
description: "Read, write, and manage files on the local system."
version: "1.0.0"
author: "DunCrew"
metadata:
  openclaw:
    emoji: "🔧"
    primaryEnv: "shell"
---

# File Operations Skill

Read, write, and manage files on the local system.

## Usage

```json
{"thought": "...", "tool": "readFile|writeFile|appendFile|listDir", "args": {...}}
```

## Examples

### Read then Modify
User: "帮我看看 config.json 的内容，把端口改成 8080"
Step 1:
```json
{"thought": "先读取 config.json 查看当前内容", "tool": "readFile", "args": {"path": "config.json"}}
```
Step 2 (after reading, found port: 3000):
```json
{"thought": "当前端口是 3000，需要改为 8080。将修改后的完整内容写回文件。", "tool": "writeFile", "args": {"path": "config.json", "content": "{\"port\": 8080, \"host\": \"localhost\"}"}}
```

### Explore Directory
User: "帮我看看项目里有哪些 markdown 文件"
Step 1:
```json
{"thought": "先列出项目根目录，查找 .md 文件", "tool": "listDir", "args": {"path": "."}}
```
Step 2 (if found subdirectories):
```json
{"thought": "根目录有 docs 文件夹，可能有更多 markdown 文件", "tool": "listDir", "args": {"path": "docs"}}
```

### Append Log
User: "帮我在日志文件里记录一下今天完成了登录功能"
```json
{"thought": "用 appendFile 追加记录到日志，不会覆盖已有内容", "tool": "appendFile", "args": {"path": "dev-log.md", "content": "\n- 2024-01-15: 完成登录功能开发\n"}}
```

## Notes

- Use relative paths from project root
- readFile before writeFile to avoid accidental overwrites
- appendFile is safer than writeFile for logs and records
- writeFile will create parent directories if they don't exist
