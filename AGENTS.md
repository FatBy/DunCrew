# DunCrew Repository Guidelines

> 本文件为 AI Agent (Qoder, Claude, Cursor 等) 提供项目级开发指南。

## Project Overview

DunCrew 是一个运行在用户本地电脑上的 AI 操作系统前端，具备：
- ReAct 循环执行引擎（支持 Function Calling 和 Legacy 两种模式）
- 技能系统（SKILL.md 定义的可扩展能力）
- 双层记忆系统（短暂层 + 持久层）
- MCP 客户端集成

**Repository**: 本地项目
**Tech Stack**: React + TypeScript + Vite + Zustand + Tailwind CSS + Framer Motion

## Project Structure

```
src/
├── components/        # React 组件
│   ├── ai/           # AI 相关组件 (AIChatPanel, ChatMessage 等)
│   ├── houses/       # 各功能模块 UI (TaskHouse, SkillHouse 等)
│   └── ...
├── services/         # 核心服务
│   ├── LocalClawService.ts  # ReAct 执行引擎 (核心!)
│   ├── llmService.ts        # LLM API 调用
│   └── contextBuilder.ts    # 上下文构建
├── store/            # Zustand 状态管理
│   └── slices/       # 各功能切片
├── types.ts          # 类型定义
└── utils/            # 工具函数

skills/               # 技能定义 (SKILL.md 文件)
memory/               # 记忆存储 (日志文件)
duncrew-server.py  # Python 本地服务器 (工具执行后端)
```

## Build, Test, and Development Commands

- **Install deps**: `npm install` 或 `pnpm install`
- **Dev server**: `npm run dev` (Vite dev server, 端口 5173)
- **Build**: `npm run build`
- **Type check**: `npx tsc --noEmit`
- **Lint**: `npm run lint` (如果配置了)
- **后端服务**: `python duncrew-server.py` (端口 3001)

**重要**: 修改代码后务必运行 `npx tsc --noEmit` 验证类型正确。

## Coding Style & Conventions

### TypeScript
- 使用严格类型，避免 `any`
- 接口/类型定义放在 `src/types.ts` 或相关文件顶部
- 组件使用函数式组件 + Hooks

### React 组件
- 使用 Tailwind CSS 进行样式
- 状态管理使用 Zustand store
- 动画使用 Framer Motion

### 命名规范
- 组件: PascalCase (`AIChatPanel.tsx`)
- 服务/工具: camelCase (`localClawService.ts`)
- 类型: PascalCase (`ExecutionStep`, `ToolInfo`)
- 常量: UPPER_SNAKE_CASE (`CONFIG`, `SYSTEM_PROMPT_FC`)

### 文件大小
- 单文件建议不超过 700 行
- 复杂逻辑拆分为独立模块

## Key Files Reference

### 核心执行引擎
- `src/services/LocalClawService.ts` - ReAct 循环、任务规划、工具调用
  - `runReActLoopFC()` - Function Calling 模式执行
  - `runReActLoopLegacy()` - 文本 JSON 模式执行
  - `executeTool()` - 工具执行器
  - `buildDynamicContext()` - JIT 上下文构建

### 状态管理
- `src/store/slices/aiSlice.ts` - AI 聊天状态、执行状态
- `src/store/slices/agentSlice.ts` - Agent 连接状态
- `src/store/slices/skillSlice.ts` - 技能列表状态

### 后端服务
- `duncrew-server.py` - Python 工具执行服务器
  - ToolRegistry: 工具注册和管理
  - MCPClientManager: MCP 服务器集成

## Agent Execution Architecture

### ReAct 循环流程
```
用户输入 → 任务理解 → 工具选择 → 工具执行 → 结果验证 → 下一步/完成
              ↑                              ↓
              └──── 失败时 Reflexion 反思 ←──┘
```

### 关键机制
1. **Function Calling 模式**: 使用 OpenAI-compatible tools API
2. **Reflexion 机制**: 工具失败时触发结构化反思
3. **Critic 机制**: 修改类操作后自动验证
4. **危险操作审批**: 高风险命令需用户确认

### 配置常量 (LocalClawService.ts)
```typescript
CONFIG = {
  MAX_REACT_TURNS: 25,      // 最大循环轮次
  MAX_PLAN_STEPS: 12,       // 最大计划步骤
  TOOL_TIMEOUT: 60000,      // 工具超时 (ms)
  CRITIC_TOOLS: ['writeFile', 'runCmd', 'appendFile'],  // 需要 Critic 验证的工具
  HIGH_RISK_TOOLS: ['runCmd'],  // 高风险工具
}
```

## SKILL System

技能通过 `skills/*/SKILL.md` 定义，包含：
- 元数据 (name, description, inputs)
- 使用说明 (Instructions)
- 示例 (Examples)
- 安全规则 (Safety Rules)

### 创建新技能
1. 在 `skills/` 下创建目录
2. 编写 `SKILL.md` 文件
3. 如需工具，在 `duncrew-server.py` 注册
4. 重启后端服务

## Common Patterns

### 添加新工具
1. 在 `duncrew-server.py` 的 `ToolRegistry` 中注册
2. 在 `builtin_handlers` 字典添加处理函数
3. 更新 `builtin_names` 列表
4. 重启后端服务

### 修改系统提示词
- Function Calling 模式: `SYSTEM_PROMPT_FC` (LocalClawService.ts)
- Legacy 模式: `SYSTEM_PROMPT_TEMPLATE` (LocalClawService.ts)

### 添加新的 Store Slice
1. 在 `src/store/slices/` 创建新 slice
2. 在 `src/store/index.ts` 中合并

## Troubleshooting

### 常见问题

**后端连接失败**
- 确认 `duncrew-server.py` 已运行
- 检查端口 3001 是否被占用: `netstat -ano | findstr 3001`

**工具执行超时**
- 检查网络连接
- 增加 `CONFIG.TOOL_TIMEOUT` 值

**类型错误**
- 运行 `npx tsc --noEmit` 查看详细错误
- 检查 `src/types.ts` 中的类型定义

**技能未加载**
- 检查 `skills/*/SKILL.md` 格式是否正确
- 查看控制台日志中的加载错误

## Git Workflow

- 提交前运行类型检查: `npx tsc --noEmit`
- 提交前运行构建验证: `npm run build`
- Commit message 使用中文，简洁描述变更
- 不要提交 `node_modules/`、`dist/`、`__pycache__/`

## Security Notes

- 不要在代码中硬编码 API Key
- LLM 配置存储在 localStorage
- 危险命令模式在 `CONFIG.DANGER_PATTERNS` 中定义
- 高风险操作需要用户审批

## Agent-Specific Notes

- 修改 `LocalClawService.ts` 后务必验证两种模式都能正常工作
- 修改系统提示词时考虑对 LLM 行为的影响
- 添加新工具时同步更新 SKILL.md 文档
- 保持 Legacy 和 FC 模式的功能一致性
