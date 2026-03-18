---
name: code-knowledge-butler
description: 深度代码理解与检索专家，支持语义搜索、架构分析、代码审查、质量评估
emoji: 🔮
version: 1.0.0
homepage: https://github.com/yourname/ddos
author: DunCrew Team
license: MIT

openclaw:
  requires:
    bins: ["node", "python3"]
    skills: ["oracle"]  # 依赖 oracle 进行深度分析
  install:
    - id: node
      kind: node
      package: "@ddos/code-kb"
      bins: ["code-kb"]
      label: "Install Code Knowledge Butler (Node.js)"
    - id: python
      kind: python
      package: "mcp-server"
      bins: ["mcp-code-kb"]
      label: "Install MCP Server (Python)"
  tools:
    - name: search
      description: 语义搜索代码库，理解用户意图找到相关代码
      schema:
        type: object
        properties:
          query:
            type: string
            description: 自然语言查询，如"用户认证逻辑"、"数据库连接池"
          path:
            type: string
            description: 代码库路径（默认为当前项目根目录）
          filePattern:
            type: string
            description: 文件类型过滤，如"*.py,*.js,*.ts"
        required: [query]
        examples:
          - query: "用户登录和JWT验证的实现"
            path: "src/"
          - query: "find_user 函数的定义和调用"
            filePattern: "*.py"
    - name: analyze
      description: 深度分析代码结构、依赖关系和架构
      schema:
        type: object
        properties:
          path:
            type: string
            description: 要分析的项目路径
          analysisType:
            type: string
            enum: ["architecture", "dependencies", "quality", "security"]
            description: 分析类型
        required: [path]
        examples:
          - path: "src/"
            analysisType: "architecture"
    - name: explain
      description: 解释特定文件或代码片段的功能
      schema:
        type: object
        properties:
          file:
            type: string
            description: 文件路径
          startLine:
            type: number
            description: 起始行号（可选）
          endLine:
            type: number
            description: 结束行号（可选）
        required: [file]
        examples:
          - file: "src/auth/login.py"
          - file: "src/components/Button.tsx", startLine: 10, endLine: 50
    - name: review
      description: 代码审查，发现潜在问题并提出改进建议
      schema:
        type: object
        properties:
          files:
            type: array
            items:
              type: string
            description: 要审查的文件列表
          focus:
            type: string
            description: 审查重点（security/performance/maintainability）
        required: [files]
        examples:
          - files: ["src/auth/login.py", "src/auth/token.py"]
            focus: "security"
---