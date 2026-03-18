---
name: code-search
description: "Advanced code search with text, AST, and semantic capabilities"
version: "1.0.0"
author: "DunCrew"
executable: execute.py
runtime: python
dangerLevel: safe
tools:
  - toolName: search_codebase
    description: "Search code using text patterns, AST analysis, or semantic similarity"
    inputs:
      query:
        type: string
        required: true
        description: "Search query (natural language or keywords)"
      scope:
        type: string
        required: false
        description: "Directory to search in (default: project root)"
      language:
        type: string
        required: false
        description: "Filter by language (e.g., typescript, python)"
      limit:
        type: integer
        required: false
        default: 10
        description: "Maximum number of results"
      mode:
        type: string
        required: false
        enum: [text, semantic, auto]
        default: auto
        description: "Search mode: text (ripgrep), semantic (embedding), or auto"
    keywords: [搜索, 查找, 代码, search, find, code, grep, 函数, 类, 定义]
  - toolName: search_symbol
    description: "Find function/class/variable definitions and their references"
    inputs:
      symbol:
        type: string
        required: true
        description: "Symbol name to search for"
      relation:
        type: string
        required: false
        enum: [definition, calls, called_by, references, implements]
        default: definition
        description: "Type of relationship to find"
      scope:
        type: string
        required: false
        description: "Directory to search in"
    keywords: [符号, 定义, 引用, 调用, symbol, definition, reference, call]
  - toolName: search_files
    description: "Search for files by name pattern"
    inputs:
      pattern:
        type: string
        required: true
        description: "File name pattern (glob syntax, e.g., *.ts, **/*.py)"
      path:
        type: string
        required: false
        description: "Directory to search in"
    keywords: [文件, 目录, file, directory, glob, find]
metadata:
  openclaw:
    emoji: "🔍"
    primaryEnv: "python"
---

# Code Search

Advanced code search with text, AST, and semantic capabilities.

## Tools

### search_codebase
Search code using text patterns, AST analysis, or semantic similarity.

```json
{"tool": "search_codebase", "args": {"query": "function name", "limit": 10}}
```

### search_symbol
Find function/class/variable definitions and their references.

```json
{"tool": "search_symbol", "args": {"symbol": "MyClass", "relation": "definition"}}
```

### search_files
Search for files by name pattern.

```json
{"tool": "search_files", "args": {"pattern": "**/*.ts"}}
```

## Notes

- Text search uses ripgrep for fast pattern matching
- Semantic search uses embeddings for natural language similarity
- Symbol search uses AST-based analysis for precise results
