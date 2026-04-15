---
name: code-runner
description: "Execute shell commands and scripts on the user's local machine."
version: "1.0.0"
author: "DunCrew"
tags:
  - shell
  - execution
  - system-ops
  - windows
keywords:
  - run command
  - execute script
  - terminal
  - cmd
  - system diagnostics
  - package management
dangerLevel: "high"
inputs:
  - name: command
    type: string
    description: "The shell command or script path to execute on the local machine."
    required: true
metadata:
  openclaw:
    emoji: "⚡"
    primaryEnv: "shell"
---

# Code Runner Skill

Execute shell commands and scripts on the user's local machine.

## Usage

```json
{"thought": "...", "tool": "runCmd", "args": {"command": "..."}}
```

## Examples

### Simple Command
User: "查看当前目录有哪些文件"
```json
{"thought": "用户想查看当前目录的文件列表，使用 dir 命令（Windows 系统）", "tool": "runCmd", "args": {"command": "dir /b"}}
```

### Multi-step Task
User: "帮我创建一个 Python 虚拟环境并安装 requests 库"
Step 1:
```json
{"thought": "需要先创建虚拟环境，使用 python -m venv 命令", "tool": "runCmd", "args": {"command": "python -m venv myenv"}}
```
Step 2 (after success):
```json
{"thought": "虚拟环境创建成功，现在激活并安装 requests。Windows 下用 myenv\\Scripts\\pip", "tool": "runCmd", "args": {"command": "myenv\\Scripts\\pip install requests"}}
```
Step 3 (verify):
```json
{"thought": "安装完成，验证一下 requests 是否正确安装", "tool": "runCmd", "args": {"command": "myenv\\Scripts\\pip list | findstr requests"}}
```

### Diagnostic Task
User: "看看端口 3001 被谁占用了"
```json
{"thought": "需要查看端口占用情况，使用 netstat 命令过滤 3001 端口", "tool": "runCmd", "args": {"command": "netstat -ano | findstr 3001"}}
```

### Error Recovery
If previous command failed with "python not found":
```json
{"thought": "python 命令未找到，可能系统用的是 python3 或完整路径。先检查 Python 安装位置。", "tool": "runCmd", "args": {"command": "where python"}}
```

## Safety Rules

1. Never execute destructive commands (rm -rf, format, etc.) without explicit user confirmation
2. Avoid commands that modify system settings
3. Prefer read-only commands for diagnostics
4. Always explain what a command will do in the thought field

## Notes

- Commands run in project directory
- Output is captured and returned
- Timeout: 60 seconds
- This is a Windows system, use Windows commands (dir, findstr, type, etc.)