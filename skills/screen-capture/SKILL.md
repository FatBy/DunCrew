---
name: screen-capture
description: "Windows 屏幕截图工具。支持全屏截图、指定区域截图、指定窗口截图，以及列出所有可见窗口。Agent 可主动截取屏幕内容用于分析。"
version: "1.0.0"
author: "DunCrew"
tags:
  - screenshot
  - screen-capture
  - windows
keywords:
  - 截图
  - 截屏
  - 屏幕截图
  - 窗口截图
  - screenshot
  - screen capture
dangerLevel: safe
inputs:
  - name: mode
    type: string
    required: true
    description: "截图模式: fullscreen / region / window / list_windows"
  - name: monitor
    type: number
    required: false
    description: "显示器编号(默认1=主显示器)。仅 fullscreen 模式"
  - name: region
    type: object
    required: false
    description: "截图区域 {x, y, width, height}。仅 region 模式"
  - name: windowTitle
    type: string
    required: false
    description: "窗口标题关键词。仅 window 模式"
metadata:
  openclaw:
    emoji: "📸"
    primaryEnv: "python"
    requires:
      bins: ["python3"]
---

# Screen Capture

Windows 屏幕截图工具，支持多种截图模式。

## Instructions

使用 `screenCapture` 工具截取屏幕内容。截图保存为 PNG 文件并返回文件路径。

### 模式说明

1. **list_windows** - 列出所有可见窗口（建议在 window 模式前先调用）
2. **fullscreen** - 全屏截图（可指定显示器）
3. **region** - 指定区域截图（需要 x, y, width, height）
4. **window** - 指定窗口截图（按标题模糊匹配）

### 典型工作流

1. 先用 `list_windows` 查看有哪些窗口
2. 用 `window` 模式截取目标窗口
3. 将截图路径传给 `ocrExtract` 或 `imageUnderstand` 进行分析

## Examples

列出所有窗口:
```json
{"mode": "list_windows"}
```

全屏截图:
```json
{"mode": "fullscreen", "monitor": 1}
```

截取指定窗口:
```json
{"mode": "window", "windowTitle": "Chrome"}
```

截取指定区域:
```json
{"mode": "region", "region": {"x": 100, "y": 100, "width": 800, "height": 600}}
```

## Notes

- 依赖 Python `mss` 和 `pygetwindow` 库
- window 模式支持模糊匹配窗口标题
- 最小化的窗口会自动恢复后截图
- 截图文件会在 1 小时后自动清理
