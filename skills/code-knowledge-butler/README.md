# Code Knowledge Butler 🔮

深度代码理解与检索专家 - DunCrew 核心技能

## ✨ 功能特性

- 🔍 **语义搜索**: 用自然语言描述，智能定位代码
- 🏗️ **架构分析**: 自动分析项目结构、依赖关系、设计模式
- 📖 **代码解释**: 详细解释任意文件或代码片段
- 🔍 **代码审查**: 安全/性能/可维护性多维度审查
- 🔗 **跨文件关联**: 自动关联相关代码，还原上下文

## 📦 安装

### 方式一：本地安装（开发中）

```powershell
# 在 DunCrew 项目根目录
clawhub install ./skills/code-knowledge-butler
```

### 方式二：ClawHub 发布后

```powershell
clawhub install code-knowledge-butler
```

## 🚀 快速开始

### 1. 语义搜索

```powershell
# 搜索用户认证相关的代码
claw run code-knowledge-butler search --query "用户登录和JWT验证的实现" --path "src/"

# 查找特定函数
claw run code-knowledge-butler search --query "find_user 函数的定义和调用" --filePattern "*.py"
```

### 2. 架构分析

```powershell
# 分析项目整体架构
claw run code-knowledge-butler analyze --path "src/" --analysisType architecture

# 分析依赖关系
claw run code-knowledge-butler analyze --path "." --analysisType dependencies
```

### 3. 代码解释

```powershell
# 解释整个文件
claw run code-knowledge-butler explain --file "src/auth/login.py"

# 解释特定代码块（注意：oracle 会分析整个文件，建议配合行号注释）
claw run code-knowledge-butler explain --file "src/components/Button.tsx"
```

### 4. 代码审查

```powershell
# 安全审查
claw run code-knowledge-butler review --files "src/auth/login.py","src/auth/token.py" --focus security

# 全面审查
claw run code-knowledge-butler review --files "src/**/*.py" --focus all
```

## 🔧 底层实现

本技能基于以下技术：

- **oracle**: 核心分析引擎，使用 GPT-5.2 Pro
- **PowerShell 脚本**: 本地文件收集和命令封装
- **OpenClaw Skill 系统**: 标准技能接口

## 📋 依赖要求

- Node.js (oracle CLI)
- Python 3 (MCP server，可选)
- `oracle` 已安装并配置

## 🎯 与 SOP 的对应

| SOP 需求 | 本技能实现 |
|---------|-----------|
| 语义搜索 | `search` 工具 |
| 符号查找 | `search` 工具（用自然语言描述符号） |
| 文件搜索 | `search` 工具 + filePattern 参数 |
| 架构分析 | `analyze` 工具 |
| 代码理解 | `explain` 工具 |
| 质量评估 | `review` 工具 |

## 📝 输出格式

所有工具返回格式遵循 OpenClaw Skill 规范，并附带：
- 📁 文件路径和行号
- 🔍 关键代码片段
- 📊 结构化分析（如适用）
- 💡 改进建议

## 🐛 故障排除

### 问题: "oracle: command not found"
**解决**: 确保 oracle CLI 已安装
```powershell
npm install -g @steipete/oracle
```

### 问题: 分析超时
**解决**: 减少文件数量或使用更具体的路径

### 问题: 结果不准确
**解决**: 提供更详细的查询描述，或缩小文件范围

## 📄 License

MIT © DunCrew Team
