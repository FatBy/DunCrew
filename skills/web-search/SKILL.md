---
name: web-search
description: "Use the webSearch tool to find information online. Ideal for real-time data lookup, technical research, comparing tools, and finding tutorials or documentation."
version: "1.0.0"
author: "DunCrew"
tags:
  - research
  - information-retrieval
  - web
  - search
keywords:
  - search
  - find information
  - web search
  - lookup
  - research
  - query
dangerLevel: safe
inputs:
  - name: query
    type: string
    description: "The search query string to find information online."
    required: true
metadata:
  openclaw:
    emoji: "🌐"
    primaryEnv: "shell"
---

# Web Search Skill

Use the webSearch tool to find information online.

## Usage

```json
{"thought": "...", "tool": "webSearch", "args": {"query": "..."}}
```

## Examples

### Simple Search
User: "帮我搜一下 React 19 的新特性"
```json
{"thought": "用户想了解 React 19 新特性，我需要用搜索工具查找最新信息", "tool": "webSearch", "args": {"query": "React 19 new features 2024"}}
```

### Multi-step Research
User: "对比一下 Vite 和 Webpack 的性能差异"
Step 1:
```json
{"thought": "需要分别搜索两个工具的性能数据来对比。先搜 Vite 的性能数据。", "tool": "webSearch", "args": {"query": "Vite build performance benchmark 2024"}}
```
Step 2 (after getting results):
```json
{"thought": "已获得 Vite 数据，现在搜索 Webpack 的性能数据来完成对比。", "tool": "webSearch", "args": {"query": "Webpack 5 build performance benchmark 2024"}}
```
Step 3: Synthesize results into comparison.

### Refining Results
User: "搜一下 Python 异步编程教程"
```json
{"thought": "用户需要学习资料，搜索中文教程会更贴合需求", "tool": "webSearch", "args": {"query": "Python asyncio 异步编程入门教程"}}
```

## Notes

- Keep queries concise and specific
- Results come from DuckDuckGo
- For Chinese topics, mix Chinese and English keywords for best results
- If first search doesn't get good results, refine the query and retry