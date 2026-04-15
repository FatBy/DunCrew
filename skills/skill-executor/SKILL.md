---
name: skill-executor
description: "SKILL.md parser and execution engine for autonomous agent capabilities. Enables dynamic discovery, inspection, and execution of modular skills. Ideal for orchestrating complex agent workflows, managing toolchains, and extending capabilities through isolated subprocess execution."
version: "1.0.0"
author: "DunCrew"
executable: execute.py
runtime: python
tags:
  - agent
  - execution
  - tool-management
  - automation
keywords:
  - execute skill
  - run tool
  - list skills
  - skill info
  - agent capability
  - SKILL.md
dangerLevel: high
inputs:
  action:
    type: string
    required: true
    description: "Action to perform: run, list, or info"
  skill_name:
    type: string
    required: false
    description: "Target skill name for run or info actions"
  arguments:
    type: object
    required: false
    description: "Parameters to pass to the target skill"
  project_root:
    type: string
    required: false
    description: "Base directory for resolving skill paths"
tools:
  - toolName: run_skill
    description: "Execute a skill from SKILL.md definition"
    dangerLevel: medium
    inputs:
      skill_name:
        type: string
        required: true
        description: "Name of the skill to execute"
      args:
        type: object
        required: false
        description: "Arguments to pass to the skill"
      project_root:
        type: string
        required: false
        description: "Project root directory"
    keywords: [技能, skill, 执行, 运行, run, agent]
  - toolName: list_skills
    description: "List all available skills from preset and custom locations"
    dangerLevel: safe
    inputs:
      include_builtin:
        type: boolean
        required: false
        default: true
        description: "Include builtin preset skills"
      include_custom:
        type: boolean
        required: false
        default: true
        description: "Include custom user skills"
    keywords: [技能列表, list, skills, 查看, 可用]
  - toolName: get_skill_info
    description: "Get detailed information about a specific skill"
    dangerLevel: safe
    inputs:
      skill_name:
        type: string
        required: true
        description: "Name of the skill"
    keywords: [技能信息, skill, info, 详情]
metadata:
  openclaw:
    emoji: "⚡"
    primaryEnv: "python"
enabled: false
---
# Skill Executor

SKILL.md parser and execution engine for autonomous agent capabilities.

## Tools

### run_skill
Execute a skill from SKILL.md definition.

```json
{"tool": "run_skill", "args": {"skill_name": "coding-agent", "args": {"task": "fix the bug"}}}
```

### list_skills
List all available skills from preset and custom locations.

```json
{"tool": "list_skills", "args": {"include_builtin": true}}
```

### get_skill_info
Get detailed information about a specific skill.

```json
{"tool": "get_skill_info", "args": {"skill_name": "weather"}}
```

## Notes

- Parses SKILL.md frontmatter for metadata and instructions
- Supports both preset (bundled) and custom (user) skill locations
- Skills are executed in isolated subprocess environments