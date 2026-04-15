---
name: memory-system
description: "Unified memory search and management system for retrieving, storing, and organizing information across daily logs, persistent memory, SOPs, and execution traces. Use this skill to recall past events, manage knowledge bases, update important notes, or filter historical data by tags and time ranges."
version: "1.0.0"
author: "DunCrew"
tags:
  - memory
  - search
  - data-management
  - knowledge-base
keywords:
  - 记忆管理
  - 记忆搜索
  - 历史记录
  - 知识检索
  - memory management
  - search memory
  - recall
  - update memory
  - 笔记
  - 日志
inputs:
  action:
    type: string
    required: true
    enum: [search, update]
    description: "Action to perform on the memory system"
  query:
    type: string
    required: false
    description: "Search query (for search) or memory content (for update)"
  target:
    type: string
    required: false
    enum: [daily, persistent, sop, trace]
    description: "Target memory type or source to operate on"
  tags:
    type: array
    required: false
    description: "Tags to filter search results or assign to new memory"
executable: execute.py
runtime: python
dangerLevel: safe
tools:
  - toolName: search_memory
    description: "Search across all memory sources (daily logs, persistent memory, SOP, traces)"
    inputs:
      query:
        type: string
        required: true
        description: "Search query (natural language or keywords)"
      sources:
        type: array
        required: false
        description: "Memory sources to search: daily, persistent, sop, trace (default: all)"
      tags:
        type: array
        required: false
        description: "Filter by tags"
      limit:
        type: integer
        required: false
        default: 10
        description: "Maximum number of results"
      days:
        type: integer
        required: false
        default: 7
        description: "Number of days to search back for daily logs"
    keywords: [记忆, 搜索, 查找, 历史, memory, search, history, recall, 记录]
  - toolName: update_memory
    description: "Create, update, or delete memory entries"
    inputs:
      operation:
        type: string
        required: true
        enum: [create, update, delete, tag]
        description: "Operation type"
      content:
        type: string
        required: false
        description: "Memory content (required for create/update)"
      id:
        type: string
        required: false
        description: "Memory ID (required for update/delete)"
      target:
        type: string
        required: false
        enum: [daily, persistent]
        default: daily
        description: "Target memory type for create"
      tags:
        type: array
        required: false
        description: "Tags to add"
      importance:
        type: integer
        required: false
        default: 50
        description: "Importance score (0-100)"
    keywords: [保存, 记住, 记录, save, remember, store, 记忆, 更新]
metadata:
  openclaw:
    emoji: "🧠"
    primaryEnv: "python"
---

# Memory System

Unified memory search and management system.

## Tools

### search_memory
Search across all memory sources (daily logs, persistent memory, SOP, traces).

```json
{"tool": "search_memory", "args": {"query": "yesterday's meeting", "days": 7}}
```

### update_memory
Create, update, or delete memory entries.

```json
{"tool": "update_memory", "args": {"operation": "create", "content": "Important note", "target": "persistent", "importance": 80}}
```

## Notes

- Supports multiple memory sources: daily logs, persistent memory, SOP documents, execution traces
- Search uses keyword matching and relevance scoring
- Tags provide structured organization for memory entries