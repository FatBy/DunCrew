# DunCrew V2 架构字段完全记录

> 本文件记录 Agent 架构升级涉及的所有新增/修改/废弃字段。
> 用途：后续 World 和 Nexus 前端渲染大调整时的数据契约参考。
> 创建时间：2026-03-11

---

## 目录

1. [AgentRunState 事件状态机（25+ 字段）](#1-agentrunstate)
2. [AgentEvent 事件类型（7 类 22 种事件）](#2-agentevent)
3. [NexusScoring 评分系统（替代 XP/Level）](#3-nexusscoring)
4. [NexusContextEngine 接口](#4-nexuscontextengine)
5. [ChildAgent 子智能体系统](#5-childagent)
6. [MemoryStore 统一存储](#6-memorystore)
7. [Session 会话持久化](#7-session)
8. [FailoverReason 多层错误恢复](#8-failover)
9. [类型迁移映射（旧 → 新）](#9-migration)
10. [前端组件数据消费关系](#10-ui-data)

---

## 1. AgentRunState

> 有状态事件转换器的核心状态。对标 OpenClaw `pi-embedded-subscribe.ts` 的 25+ 字段。
> 每个 ReAct 执行实例持有一个 AgentRunState。

```typescript
interface AgentRunState {
  // ═══ 1.1 生命周期 ═══
  runId: string;                    // 唯一执行 ID (uuid)
  seq: number;                      // 单调递增事件序号（支持断点重放/排序）
  phase: AgentPhase;                // 当前阶段
  aborted: boolean;                 // 用户主动终止
  timedOut: boolean;                // 超时标记

  // ═══ 1.2 消息流 ═══
  assistantTexts: string[];         // 所有助手文本片段（完整历史）
  deltaBuffer: string;              // 流式增量缓冲（未刷新的文本碎片）
  blockState: {                     // 块标签状态机（跨 chunk 有状态）
    thinking: boolean;              //   <think> 标签内
    codeBlock: boolean;             //   代码块内（防止标签误匹配）
  };
  assistantMessageIndex: number;    // 当前消息序号（每条新消息递增）
  lastStreamedText: string | undefined;   // 重复检测用
  suppressLateChunks: boolean;      // message_end 后阻止晚到的块

  // ═══ 1.3 推理流 ═══
  reasoningMode: 'off' | 'on' | 'stream';
  reasoningBuffer: string;          // 推理内容积累
  reasoningStreamOpen: boolean;     // 推理流是否开启

  // ═══ 1.4 工具执行 ═══
  currentTool: {                    // 当前正在执行的工具（null=无）
    name: string;
    callId: string;
    startTime: number;
    args: Record<string, unknown>;
  } | null;
  toolHistory: ToolCallSummary[];   // 已完成工具的元数据列表
  toolResultById: Map<string, ToolResult>;  // 按 callId 索引结果
  lastToolError: {                  // 最近一次工具错误（供 Reflexion 消费）
    toolName: string;
    error: string;
    isMutating: boolean;            //   是否修改了文件系统
  } | undefined;

  // ═══ 1.5 上下文压缩 ═══
  compactionInFlight: boolean;      // 压缩正在进行中
  compactionCount: number;          // 本次 run 累计压缩次数
  tokensBefore: number;             // 最近一次压缩前 token 数
  tokensAfter: number;              // 最近一次压缩后 token 数

  // ═══ 1.6 错误恢复 ═══
  failoverReason: FailoverReason | null;   // 当前故障原因
  attemptIndex: number;             // 当前尝试序号（0-based）
  modelChain: string[];             // fallback 模型链（按优先级）
  currentModel: string;             // 当前使用的模型名

  // ═══ 1.7 Nexus 上下文（DunCrew 特有）═══
  activeNexusId: string | null;     // 当前激活的 Nexus ID
  nexusSopInjected: boolean;        // SOP 是否已注入到上下文
  nexusScore: number;               // 当前 Nexus 的实时分数
  planProgress: {                   // 计划执行进度
    total: number;                  //   总步骤数
    completed: number;              //   已完成步骤数
    currentStep: string;            //   当前步骤描述
  } | null;

  // ═══ 1.8 Critic/Reflexion（DunCrew 特有）═══
  reflexionCount: number;           // 本次 run 反思次数
  criticPending: boolean;           // 等待 Critic 验证
  approvalPending: boolean;         // 等待用户审批（危险操作）
  approvalRequest: ApprovalRequest | null;  // 当前审批请求详情

  // ═══ 1.9 子智能体追踪 ═══
  activeChildren: string[];         // 活跃子智能体的 runId 列表
  childrenCompleted: number;        // 已完成的子智能体数
  childrenFailed: number;           // 失败的子智能体数

  // ═══ 1.10 Token 预算 ═══
  tokenBudget: number;              // 模型窗口上限
  tokenUsed: number;                // 当前已使用 token 数
  tokenPercentage: number;          // 使用百分比 (0-100)
}
```

### AgentPhase 枚举

```typescript
type AgentPhase =
  | 'idle'           // 空闲
  | 'planning'       // 任务规划
  | 'executing'      // 工具执行中
  | 'reflecting'     // Reflexion 反思中
  | 'compacting'     // 上下文压缩中
  | 'waiting_approval' // 等待用户审批
  | 'recovering'     // 错误恢复中（模型切换/重试）
  | 'done'           // 正常完成
  | 'error'          // 异常终止
  | 'aborted'        // 用户终止
```

### ToolCallSummary

```typescript
interface ToolCallSummary {
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  status: 'success' | 'error';
  result?: string;                  // 成功时的结果（截断）
  error?: string;                   // 失败时的错误信息
  durationMs: number;               // 执行耗时
  isMutating: boolean;              // 是否是修改类操作
  timestamp: number;
}
```

### ToolResult

```typescript
interface ToolResult {
  callId: string;
  toolName: string;
  success: boolean;
  output: string;                   // 完整输出
  durationMs: number;
  timestamp: number;
}
```

---

## 2. AgentEvent

> 7 类 22 种事件，每个事件携带 stream + type + data。
> UI 层通过订阅 AgentEventBus 获取实时状态。

```typescript
interface AgentEventEnvelope {
  runId: string;        // 关联的 run
  seq: number;          // 单调递增序号
  ts: number;           // 时间戳 (ms)
  stream: AgentEventStream;
  type: string;         // 事件子类型
  data: Record<string, unknown>;
  sessionId?: string;   // 关联会话
  nexusId?: string;     // 关联 Nexus
}

type AgentEventStream =
  | 'lifecycle'     // 生命周期
  | 'assistant'     // 助手消息流
  | 'tool'          // 工具执行
  | 'context'       // 上下文管理
  | 'recovery'      // 错误恢复
  | 'reflexion'     // 反思/Critic
  | 'approval'      // 审批
  | 'plan'          // 计划追踪
  | 'child'         // 子智能体
```

### 2.1 lifecycle 事件 (3 种)

```typescript
| { stream: 'lifecycle'; type: 'run_start'; data: {
    runId: string;
    nexusId: string | null;
    model: string;
    nexusScore: number;
    tokenBudget: number;
  }}
| { stream: 'lifecycle'; type: 'phase_change'; data: {
    from: AgentPhase;
    to: AgentPhase;
    reason?: string;       // 为什么切换
  }}
| { stream: 'lifecycle'; type: 
'run_end'; data: {
    success: boolean;
    turns: number;
    tokensUsed: number;
    toolsCalled: number;
    reflexionCount: number;
    compactionCount: number;
    durationMs: number;
    scoreChange: number;      // Nexus 分数变化 (+5, -8 等)
    childrenSpawned: number;
    childrenCompleted: number;
  }}
```

### 2.2 assistant 事件 (4 种)

```typescript
| { stream: 'assistant'; type: 'message_start'; data: {
    messageIndex: number;
  }}
| { stream: 'assistant'; type: 'text_delta'; data: {
    delta: string;            // 增量文本
    fullText: string;         // 当前消息的完整文本
  }}
| { stream: 'assistant'; type: 'thinking_delta'; data: {
    delta: string//            // 推理增量
  }}
| { stream: 'assistant'; type: 'message_end'; data: {
    finalText: string;
    messageIndex: number;
  }}
```

### 2.3 tool 事件 (4 种)

```typescript
| { stream: 'tool'; type: 'tool_start'; data: {
    toolName: string;
    callId: string;
    args: Record<string, unknown>;
    isMutating: boolean;      // 是否修改类工具
  }}
| { stream: 'tool'; type: 'tool_progress'; data: {
    callId: string;
    progress: string;         // 进度文本
  }}
| { stream: 'tool'; type: 'tool_end'; data: {
    callId: string;
    toolName: string;
    success: boolean;
    result: string;           // 截断到合理长度
    durationMs: number;
    // Nexus 维度分数变化
    dimensionScoreChange?:

number; // +2 成功 / -3 失败
  }}
| { stream: 'tool'; type: 'tool_error'; data: {
    callId: string;
    toolName: string;
    error: string;
    isMutating: boolean;
  }}
```

### 2.4 context 事件 (3 种)

```typescript
| { stream: 'context'; type: 'compaction_start'; data: {
    tokensBefore: number;
    trigger: 'overflow' | 'budget' | 'proactive';
  }}
| { stream: 'context'; type: 'compaction_end'; data: {
    tokensAfter: number;
    tokensBefore: number;
    success: boolean;
    summary?: string;         // 压缩摘要
  }}
| { stream: 'context'; type: 'token_warning'; data: {
    used: number;
    budget: number;
    percentage: number;       // 0-100
  }}
```

### 2.5 recovery 事件 (2 种)

```typescript
| { stream: 'recovery'; type: 'failover_start'; data: {
    reason: FailoverReason;
    fromModel: string;
    toModel: string;
    attemptIndex: number;
  }}
| { stream: 'recovery'; type: 'retry'; data: {
    attemptIndex: number;
    backoffMs: number;        // 退避时间
    reason: FailoverReason;
  }}
```

### 2.6 reflexion 事件 (2 种)

```typescript
| { stream: 'reflexion'; type: 'reflexion_start'; data: {
    failedTool: string;
    error: string;
    reflexionIndex: number;   // 第几次反思
    nexusScore: number;       // 当前分数（影响反思深度）
  }}
| { stream: 'reflexion'; type: 'reflexion_end'; data: {
    insight: string;          // 反思洞察
    strategy: string;         // 下一步策略
    reflexionIndex: number;
  }}
```

### 2.7 approval 事件 (2 种)

```typescript
| { stream: 'approval'; type: 'approval_required'; data: {
    requestId: string;
    command: string;
    toolName: string;
    risk: 'high' | 'critical';
    reason: string;
  }}
| { stream: 'approval'; type: 'approval_resolved'; data: {
    requestId: string;
    approved: boolean;
    resolvedBy: 'user' | 'auto';
  }}
```

### 2.8 plan 事件 (2 种)

```typescript
| { stream: 'plan'; type: 'step_start'; data: {
    stepIndex: number;
    totalSteps: number;
    description: string;
    dependsOn: string[];
  }}
| { stream: 'plan'; type: 'step_complete'; data: {
    stepIndex: number;
    success: boolean;
    result?: string;
    error?: string;
    durationMs: number;
  }}
```

### 2.9 child 事件 (3 种)

```typescript
| { stream: 'child'; type: 'child_spawned'; data: {
    childRunId: string;
    childSessionId: string;
    nexusId: string;
    task: string;
    depth: number;
    model: string;
  }}
| { stream: 'child'; type: 'child_progress'; data: {
    childRunId: string;
    phase: AgentPhase;
    turns: number;
    currentTool?: string;
  }}
| { stream: 'child'; type: 'child_completed'; data: {
    childRunId: string;
    nexusId: string;
    success: boolean;
    result?: string;
    error?: string;
    durationMs: number;
    scoreChange: number;      // 子 Nexus 分数变化
    genesHarvested: number;   // 收割的基因数
  }}
```

---

## 3. NexusScoring

> 替代现有的 `level: number` + `xp: number`。
> 分数驱动 Reflexion 深度、上下文分配、Critic 频率。

### 3.1 NexusScoring 接口

```typescript
interface NexusScoring {
  score: number;              // 核心分数 0-100，初始 50
  streak: number;             // 连续成功/失败次数（正=连胜，负=连败）
  totalRuns: number;          // 总执行次数
  successCount: number;
  failureCount: number;
  successRate: number;        // successCount / totalRuns (0-1)

  // 维度分数（每个常用工具的细分能力）
  dimensions: Record<string, ToolDimensionScore>;

  // 最近执行记录（前端渲染用，最多保留 20 条）
  recentRuns: RecentRunEntry[];

  lastUpdated: number;        // 最后更新时间戳
}
```

### 3.2 ToolDimensionScore

```typescript
interface ToolDimensionScore {
  toolName: string;
  score: number;              // 0-100
  calls: number;              // 总调用次数
  successes: number;
  failures: number;
  avgDurationMs: number;      // 平均耗时
  lastUsedAt: number;
}
```

### 3.3 RecentRunEntry

```typescript
interface RecentRunEntry {
  runId: string;
  task: string;               // 任务描述（截断 80 字）
  success: boolean;
  scoreChange: number;        // +5, -8 等
  turns: number;              // ReAct 轮次
  toolsCalled: string[];      // 调用的工具名列表
  durationMs: number;
  timestamp: number;
  genesHarvested?: number;    // 收割的基因数
}
```

### 3.4 计分规则常量

```typescript
const SCORING_RULES = {
  // 成功得分
  SUCCESS_BASE: 5,
  SUCCESS_STREAK_BONUS: 1,           // 每连胜 +1，上限 5
  SUCCESS_STREAK_MAX_BONUS: 5,
  SUCCESS_COMPLEXITY_BONUS: 3,       // turnCount > 10 的复杂任务
  SCORE_MAX: 100,

  // 失败扣分
  FAILURE_BASE: -8,
  FAILURE_STREAK_PENALTY: -2,        // 每连败额外 -2，上限 -10
  FAILURE_STREAK_MAX_PENALTY: -10,
  SCORE_MIN: 0,

  // 工具维度
  TOOL_SUCCESS_DELTA: 2,
  TOOL_FAILURE_DELTA: -3,

  // 分数区间阈值
  EXPERT_THRESHOLD: 80,              // >= 80 Expert 模式
  CAPABLE_THRESHOLD: 60,             // >= 60 Capable 模式
  LEARNING_THRESHOLD: 40,            // >= 40 Learning 模式
  // < 40 = Weak 模式
};
```

### 3.5 分数驱动行为映射

```typescript
// 前端渲染用的分数等级标签
type ScoreTier = 'Expert' | 'Capable' | 'Learning' | 'Weak';

function getScoreTier(score: number): ScoreTier {
  if (score >= 80) return 'Expert';
  if (score >= 60) return 'Capable';
  if (score >= 40) return 'Learning';
  return 'Weak';
}

// 分数区间对应的颜色（前端渲染）
const SCORE_TIER_COLORS: Record<ScoreTier, string> = {
  Expert:   '#22c55e',   // green-500
  Capable:  '#3b82f6',   // blue-500
  Learning: '#f59e0b',   // amber-500
  Weak:     '#ef4444',   // red-500
};

// 分数区间对应的行为参数
interface ScoreDrivenBehavior {
  criticFrequency: 'all_mutating' | 'standard' | 'reduced';
  reflexionDepth: 'deep' | 'standard' | 'shallow';
  sopBudgetRatio: number;           // SOP 占上下文预算比例
  memoryBudgetRatio: number;        // 记忆占上下文预算比例
  geneInjection: boolean;           // 是否注入基因建议
  fewShotInjection: boolean;        // 是否注入成功案例
  autoApproveThreshold: 'high' | 'critical' | 'none';
}

const SCORE_BEHAVIORS: Record<ScoreTier, ScoreDrivenBehavior> = {
  Expert: {
    criticFrequency: 'reduced',
    reflexionDepth: 'shallow',
    sopBudgetRatio: 0.08,
    memoryBudgetRatio: 0.10,
    geneInjection: false,
    fewShotInjection: false,
    autoApproveThreshold: 'high',     // 自动批准 high 级操作
  },
  Capable: {
    criticFrequency: 'standard',
    reflexionDepth: 'standard',
    sopBudgetRatio: 0.15,
    memoryBudgetRatio: 0.20,
    geneInjection: true,
    fewShotInjection: false,
    autoApproveThreshold: 'none',
  },
  Learning: {
    criticFrequency: 'standard',
    reflexionDepth: 'deep',
    sopBudgetRatio: 0.15,
    memoryBudgetRatio: 0.25,
    geneInjection: true,
    fewShotInjection: false,
    autoApproveThreshold: 'none',
  },
  Weak: {
    criticFrequency: 'all_mutating',
    reflexionDepth: 'deep',
    sopBudgetRatio: 0.20,
    memoryBudgetRatio: 0.25,
    geneInjection: true,
    fewShotInjection: true,           // 注入成功案例作为 few-shot
    autoApproveThreshold: 'none',
  },
};
```

---

## 4. NexusContextEngine

> Nexus 作为 ContextEngine 的实现者。每个 Nexus 拥有自己的上下文策略。
> 对标 OpenClaw ContextEngine 接口 (assemble/compact/ingest/afterTurn/prepareSubagentSpawn)。

### 4.1 接口定义

```typescript
interface NexusContextEngine {
  readonly info: {
    id: string;                        // engine ID
    nexusId: string;                   // 绑定的 Nexus
    name: string;                      // 引擎名称
  };

  // ═══ 必需方法 ═══

  /** 组装上下文：决定注入什么、裁剪什么、优先级如何 */
  assemble(params: AssembleParams): AssembleResult;

  /** 压缩上下文：决定保留哪些历史、如何汇总 */
  compact(params: CompactParams): Promise<CompactResult>;

  /** 摄入消息：每条新消息是否值得持久化 */
  ingest(params: IngestParams): IngestResult;

  // ═══ 可选方法 ═══

  /** 轮次结束后：更新经验、触发基因收割、主动压缩决策 */
  afterTurn?(params: AfterTurnParams): Promise<void>;

  /** 初始化：加载历史上下文 */
  bootstrap?(params: BootstrapParams): Promise<BootstrapResult>;

  /** 子智能体生成前：准备共享上下文 */
  prepareChildSpawn?(params: PrepareChildSpawnParams): Promise<ChildSpawnPreparation>;

  /** 子智能体结束后：经验回收 */
  onChildEnded?(params: OnChildEndedParams): Promise<void>;

  /** 清理资源 */
  dispose?(): Promise<void>;
}
```

### 4.2 方法参数和返回值

```typescript
// ── assemble ──
interface AssembleParams {
  sessionId: string;
  messages: ChatMessage[];
  tokenBudget: number;
  taskDescription?: string;          // 辅助语义筛选
}

interface AssembleResult {
  messages: ChatMessage[];           // 裁剪后的消息
  estimatedTokens: number;
  systemPromptAddition?: string;     // 额外系统提示（SOP、规则、基因）
  budgetBreakdown: {                 // 预算分配明细（前端可视化用）
    system: number;
    sop: number;
    memory: number;
    genes: number;
    skills: number;
    history: number;
  };
}

// ── compact ──
interface CompactParams {
  sessionId: string;
  tokenBudget: number;
  trigger: 'overflow' | 'budget' | 'proactive';
  currentTokenCount: number;
}

interface CompactResult {
  ok: boolean;
  compacted: boolean;
  tokensBefore: number;
  tokensAfter?: number;
  summary?: string;                  // 压缩产生的摘要
  reason?: string;                   // 为什么成功/失败
}

// ── ingest ──
interface IngestParams {
  sessionId: string;
  message: ChatMessage;
}

interface IngestResult {
  ingested: boolean;                 // 是否被持久化
}

// ── afterTurn ──
interface AfterTurnParams {
  sessionId: string;
  messages: ChatMessage[];
  prePromptMessageCount: number;
  tokenBudget: number;
  toolResults: ToolCallSummary[];    // 本轮工具执行结果
  runState: AgentRunState;           // 完整运行状态（供基因收割分析）
}

// ── bootstrap ──
interface BootstrapParams {
  sessionId: string;
}

interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
}

// ── prepareChildSpawn ──
interface PrepareChildSpawnParams {
  parentSessionId: string;
  childSessionId: string;
  childNexusId: string;
  inheritContext: boolean;
}

interface ChildSpawnPreparation {
  contextSummary?: string;           // 传递给子任务的父级上下文摘要
  sharedGenes?: Gene[];              // 共享的基因
  rollback: () => Promise<void>;     // 失败时回滚
}

// ── onChildEnded ──
interface OnChildEndedParams {
  childSessionId: string;
  childNexusId: string;
  reason: 'completed' | 'error' | 'timeout' | 'killed';
  outcome?: {
    success: boolean;
    result?: string;
    error?: string;
    tokensUsed?: number;
    toolsCalled?: string[];
    scoreChange?: number;
    genesHarvested?: Gene[];
  };
}
```

---

## 5. ChildAgent

> 子智能体系统。对标 OpenClaw sessions_spawn + subagents 工具。
> DunCrew 特有：子智能体绑定 Nexus 角色。

### 5.1 SpawnChildParams

```typescript
interface SpawnChildParams {
  task: string;                      // 子任务描述
  nexusId?: string;                  // 指定执行 Nexus（不指定则自动匹配）
  model?: string;                    // 模型覆盖
  mode: 'run' | 'session';          // run=一次性, session=持久
  cleanup: 'delete' | 'keep';       // 完成后清理策略
  timeout?: number;                  // 超时秒数
  inheritContext?: boolean;          // 是否继承父级上下文摘要
  shareGenes?: boolean;              // 是否共享父级基因库
  priority?: 'high' | 'normal' | 'background';
}
```

### 5.2 ChildRunRecord

```typescript
interface ChildRunRecord {
  runId: string;
  childSessionId: string;           // 格式: {parentSessionId}:child:{uuid}
  parentSessionId: string;
  nexusId: string;                   // 绑定的 Nexus
  nexusLabel: string;                // Nexus 显示名称
  task: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'timeout' | 'killed';
  outcome?: ChildOutcome;
  depth: number;                     // 0=主会话, 1=一级子任务, 2=二级
  model: string;                     // 使用的模型
  // 生命周期
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  // 追踪
  turns: number;                     // ReAct 轮次
  toolsCalled: string[];             // 调用过的工具
  currentPhase: AgentPhase;          // 实时阶段
}

interface ChildOutcome {
  success: boolean;
  result?: string;                   // 冻结的完成文本
  error?: string;
  tokensUsed: number;
  durationMs: number;
  scoreChange: number;               // Nexus 分数变化
  genesHarvested: number;
}
```

### 5.3 SpawnChildResult

```typescript
interface SpawnChildResult {
  status: 'accepted' | 'forbidden' | 'error';
  childSessionId?: string;
  runId?: string;
  error?: string;
  nexusId?: string;                  // 实际使用的 Nexus（自动匹配时返回）
}
```

### 5.4 深度和并行限制常量

```typescript
const CHILD_LIMITS = {
  maxSpawnDepth: 2,                  // 最多 2 级嵌套
  maxChildrenPerSession: 5,          // 单会话最大活跃子任务
  defaultTimeoutSeconds: 300,        // 5 分钟默认超时
};
```

### 5.5 工具定义（LLM 调用接口）

```typescript
// spawnChild 工具
interface SpawnChildToolParams {
  task: string;                      // required
  nexusId?: string;
  inheritContext?: boolean;          // default: true
  priority?: 'high' | 'normal' | 'background'; // default: 'normal'
}

// manageChildren 工具
interface ManageChildrenToolParams {
  action: 'list' | 'kill' | 'wait'; // required
  target?: string;                   // runId 或索引
}
```

---

## 6. MemoryStore

> SQLite 统一存储。替代 localStorage + JSONL 双源。
> 对标 OpenClaw MemoryIndexManager。

### 6.1 数据库表结构

```sql
-- 文件追踪
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- 'memory' | 'exec_trace' | 'gene' | 'nexus_xp' | 'session'
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

-- 内容块
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT,                    -- JSON array (可选)
  model TEXT,                        -- embedding 模型名
  nexus_id TEXT,                     -- 关联 Nexus
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 全文索引
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  nexus_id UNINDEXED
);

-- Embedding 缓存
CREATE TABLE embedding_cache (
  hash TEXT PRIMARY KEY,
  embedding TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 基因库 (替代 JSONL 全文件重写)
CREATE TABLE genes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                -- 'repair' | 'optimize' | 'capability' | 'artifact' | 'activity'
  source_nexus TEXT,
  target_nexus TEXT,
  description TEXT NOT NULL,
  pattern TEXT NOT NULL,             -- error/trigger pattern
  action TEXT NOT NULL,              -- recovery/optimization action
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  ttl_days INTEGER DEFAULT 90
);
```

### 6.2 SearchResult

```typescript
interface MemorySearchResult {
  id: string;
  path: string;                      // 相对路径
  startLine: number;
  endLine: number;
  score: number;                     // 0-1 (融合+衰减+MMR 后)
  snippet: string;                   // 截断到 700 字符
  source: string;                    // 'memory' | 'exec_trace' | 'gene' | ...
  nexusId?: string;                  // 关联 Nexus
}
```

### 6.3 搜索算法常量

```typescript
const SEARCH_CONFIG = {
  // 混合搜索权重
  FTS_WEIGHT: 0.3,                   // BM25 关键词得分权重
  VECTOR_WEIGHT: 0.7,                // 向量相似度权重 (无 embedding 时全部给 FTS)

  // 时间衰减
  TEMPORAL_DECAY_HALF_LIFE_DAYS: 30, // 30 天半衰期
  // score *= e^(-ln2/30 * age_days)

  // MMR 多样性重排
  MMR_LAMBDA: 0.7,                   // 0=最大多样性, 1=最大相关性
  // MMR = 0.7 * relevance - 0.3 * max_jaccard_similarity

  // 结果限制
  SNIPPET_MAX_CHARS: 700,
  DEFAULT_MAX_RESULTS: 10,
  DEFAULT_MIN_SCORE: 0.3,
};
```

---

## 7. Session

> 会话持久化。SQLite 后端替代 localStorage 全量覆盖。

### 7.1 数据库表

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  type TEXT NOT NULL,                -- 'general' | 'nexus'
  nexus_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  last_message_preview TEXT,
  checkpoint_data TEXT               -- JSON: AgentRunState 快照
);

CREATE TABLE session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                -- 'user' | 'assistant' | 'system' | 'tool'
  content TEXT NOT NULL,
  metadata TEXT,                     -- JSON: execution steps, tool calls
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
```

### 7.2 前端类型变更

```typescript
// 旧的 Conversation 类型保持兼容，但存储层改变
// localStorage: 仅缓存最近 5 个会话元数据
// SQLite: source of truth（消息体、checkpoint）

interface SessionMeta {
  id: string;
  title: string;
  type: 'general' | 'nexus';
  nexusId?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview?: string;
  hasCheckpoint: boolean;            // 是否有未完成的断点
}
```

---

## 8. FailoverReason

> 多层错误恢复的故障分类。

```typescript
type FailoverReason =
  | 'auth'                   // API Key 无效或过期
  | 'rate_limit'             // 速率限制
  | 'context_overflow'       // 上下文超出模型窗口
  | 'timeout'                // 请求超时
  | 'model_error'            // 模型返回错误
  | 'network'                // 网络连接失败
  | 'billing'                // 账户余额不足

// 恢复策略映射
const FAILOVER_STRATEGIES: Record<FailoverReason, string[]> = {
  auth:              ['rotate_api_key', 'prompt_user'],
  rate_limit:        ['exponential_backoff', 'switch_model'],
  context_overflow:  ['compact_context', 'truncate_tool_results'],
  timeout:           ['retry_with_backoff', 'switch_model'],
  model_error:       ['switch_model', 'simplify_prompt'],
  network:           ['retry_with_backoff', 'prompt_user'],
  billing:           ['switch_model', 'prompt_user'],
};

// 退避配置
const BACKOFF_CONFIG = {
  initialMs: 250,
  maxMs: 1500,
  factor: 2,                         // 指数退避因子
  maxAttempts: 3,                     // 同一 reason 最大重试次数
};
```

---

## 9. 类型迁移映射（旧 → 新）

### 9.1 NexusEntity 字段变更

```
旧字段               → 新字段                    说明
──────────────────────────────────────────────────────────────
level: number         → scoring.score             等级概念废弃，改为分数
xp: number            → scoring (整个对象)        XP 概念废弃
                      → scoring.streak            新增：连胜/连败
                      → scoring.totalRuns          新增
                      → scoring.successCount       新增
                      → scoring.failureCount       新增
                      → scoring.successRate        新增
                      → scoring.dimensions         新增：工具维度分数
                      → scoring.recentRuns         新增：最近执行记录
boundSkillIds         → (保留)                    不变
sopContent            → (保留)                    不变，ContextEngine 读取
customModel           → (保留)                    不变
objective/metrics     → (保留)                    不变
strategy              → (保留)                    不变
```

### 9.2 NexusExperience 字段变更

```
旧类型                → 新类型                    说明
──────────────────────────────────────────────────────────────
NexusExperience {     → RecentRunEntry {
  title               →   task                    改名
  outcome             →   success: boolean        从枚举改为布尔
  content             →   (废弃)                  详细内容不再存于此
                      →   runId                   新增：关联 run
                      →   scoreChange             新增：+5, -8
                      →   turns                   新增：轮次
                      →   toolsCalled             新增：工具列表
                      →   durationMs              新增：耗时
                      →   genesHarvested          新增：收割基因数
}
```

### 9.3 ExecutionStep 字段变更

```
旧类型                → 新类型                    说明
──────────────────────────────────────────────────────────────
ExecutionStep {       → (保留，但扩展为 AgentEvent 的子集)
  type: 5种           →   stream + type 组合       事件分类更精细
                      →   reflexion 事件           新增
                      →   recovery 事件            新增
                      →   context 事件             新增
                      →   child 事件               新增
}
```

### 9.4 ExecTrace 字段变更

```
旧类型                → 新类型                    说明
──────────────────────────────────────────────────────────────
ExecTrace {           → (保留，但后端存储改为 SQLite chunks 表)
  tags                →   (保留)
  turnCount           →   (保留)
  errorCount          →   (保留)
  activeNexusId       →   (保留)
                      →   scoreChange             新增：分数变化
                      →   reflexionCount           新增
                      →   compactionCount          新增
                      →   failoverAttempts         新增
                      →   childrenSpawned          新增
                      →   genesHarvested           新增
}
```

### 9.5 Gene 类型变更

```
旧类型                → 新类型                    说明
──────────────────────────────────────────────────────────────
Gene {                → (保留结构，存储层从 JSONL 改为 SQLite genes 表)
  metadata.confidence →   confidence (提升到顶层)   简化
  metadata.useCount   →   success_count + fail_count 拆分
                      →   ttl_days                 新增：生命周期
}
```

### 9.6 废弃的字段/概念

```
废弃项                  替代方案
──────────────────────────────────────────────────────────────
NexusEntity.level       → NexusScoring.score (getScoreTier() 映射文字等级)
NexusEntity.xp          → NexusScoring (整个评分对象)
XP_THRESHOLDS           → SCORING_RULES (计分规则)
NexusExperience         → RecentRunEntry (更丰富的执行记录)
localStorage 全量写入    → SQLite 增量写入
JSONL 基因存储           → SQLite genes 表
```

---

## 10. 前端组件数据消费关系

> 记录每个组件需要消费的数据源和字段，防止后续渲染出错。

### 10.1 TaskHouse (重做)

```
TaskHouse/
├── RunDashboard.tsx
│   消费: AgentRunState
│   字段: phase, tokenUsed, tokenBudget, tokenPercentage,
│         currentModel, activeNexusId, nexusScore,
│         compactionCount, reflexionCount, attemptIndex
│   事件: lifecycle.run_start, lifecycle.phase_change
│
├── EventStream.tsx
│   消费: AgentEvent[]（全部事件流）
│   订阅: AgentEventBus.subscribe()
│   过滤: 按 stream 类型分类显示
│   着色:
│     lifecycle → 灰色 (#6b7280)
│     tool.success → 青色 (#06b6d4)
│     tool.error → 红色 (#ef4444)
│     assistant → 白色 (#f9fafb)
│     reflexion → 黄色 (#f59e0b)
│     recovery → 橙色 (#f97316)
│     approval → 紫色+闪烁 (#a855f7)
│     context → 蓝色 (#3b82f6)
│     plan → 蓝绿 (#14b8a6)
│     child → 靛蓝 (#6366f1)
│
├── ChildAgentPanel.tsx
│   消费: ChildRunRecord[]
│   字段: runId, nexusId, nexusLabel, task, status,
│         currentPhase, turns, depth, outcome
│   事件: child.child_spawned, child.child_progress, child.child_completed
│   操作: kill(runId), 查看子任务事件流
│
├── PlanProgress.tsx
│   消费: TaskPlan (现有) + AgentRunState.planProgress
│   字段: subTasks[].status, subTasks[].description,
│         subTasks[].dependsOn, subTasks[].result, subTasks[].error
│   事件: plan.step_start, plan.step_complete
│
├── ContextBudgetBar.tsx
│   消费: AgentRunState
│   字段: tokenUsed, tokenBudget, tokenPercentage,
│         compactionInFlight, compactionCount
│   事件: context.token_warning, context.compaction_start, context.compaction_end
│
├── RecoveryIndicator.tsx
│   消费: AgentRunState
│   字段: failoverReason, attemptIndex, currentModel, modelChain
│   事件: recovery.failover_start, recovery.retry
│
└── RunHistory.tsx
    消费: SessionMeta[] + RecentRunEntry[]
    字段: 同现有 HistoryDrawer，新增 scoreChange 列
```

### 10.2 NexusDetailPanel (重做)

```
NexusDetailPanel/
├── NexusScoreCard.tsx
│   消费: NexusScoring
│   字段: score, streak, totalRuns, successCount, failureCount, successRate
│   渲染:
│     分数进度条 (0-100)
│     等级标签 (getScoreTier)
│     颜色 (SCORE_TIER_COLORS)
│     趋势箭头 (streak > 0 → ↑, streak < 0 → ↓)
│     成功率百分比
│     最近结果序列 (✓✗✓✓✓)
│
├── ToolDimensionList.tsx
│   消费: NexusScoring.dimensions
│   字段: toolName, score, calls, successes, avgDurationMs
│   渲染:
│     每个工具一行进度条 (score/100)
│     调用次数标签
│     分数颜色同 SCORE_TIER_COLORS
│
├── RecentRunsList.tsx
│   消费: NexusScoring.recentRuns (最多 20 条)
│   字段: task, success, scoreChange, turns, durationMs, timestamp, toolsCalled
│   渲染:
│     ✓/✗ 图标
│     时间
│     任务描述 (截断)
│     +N/-N 分数变化 (绿/红)
│     轮次和耗时
│
├── ActiveGenesList.tsx
│   消费: Gene[] (从 MemoryStore 查询, nexus_id 过滤)
│   字段: type, description, pattern, action, confidence, last_used_at
│   渲染:
│     基因类型图标 (repair/optimize/capability/...)
│     描述文本
│     置信度条
│
├── BoundSkillsPanel.tsx (现有，小改)
│   消费: boundSkillIds + SkillNode[]
│   字段: (保持不变)
│
├── SOPSection.tsx (现有，保持)
│   消费: sopContent, version
│   字段: (保持不变)
│
├── ObjectiveSection.tsx (现有，保持)
│   消费: objective, metrics, strategy
│   字段: (保持不变)
│
├── PlanetPreview.tsx (现有，改造)
│   消费: VisualDNA + NexusScoring.score
│   变更:
│     旧: LV.N + XP 进度条
│     新: Score 数值 + 分数进度条 + 等级标签
│     星球视觉保持不变（VisualDNA 不动）
│
├── ConversationHistory.tsx (现有，保持)
│   消费: Conversation[]
│   字段: (保持不变)
│
├── ActiveRules.tsx (现有，保持)
│   消费: NexusRule[]
│   字段: (保持不变)
│
└── ModelConfig.tsx (现有，保持)
    消费: customModel
    字段: (保持不变)
```

### 10.3 World 渲染影响

```
World 组件与 NexusEntity 的关系:

NexusNode.tsx (星球渲染)
  旧依赖: level (决定大小), xp (显示标签)
  新依赖: scoring.score (决定大小), getScoreTier(score) (显示标签)
  变更:
    旧: 星球大小 = BASE_SIZE + level * LEVEL_SCALE
    新: 星球大小 = BASE_SIZE + (score / 100) * MAX_SCALE
    旧: 标签 "LV.3"
    新: 标签 "82" 或 "Expert"

NexusGrid.tsx (网格布局)
  无变更: 位置、拖拽、连线逻辑不受影响

NexusParticles.tsx (粒子效果)
  旧依赖: level (影响粒子密度和颜色)
  新依赖: scoring.score + scoring.streak
  变更:
    score >= 80 → 高密度金色粒子
    score >= 60 → 标准蓝色粒子
    score >= 40 → 低密度琥珀粒子
    score < 40  → 极低密度红色粒子
    streak >= 3 → 添加连胜光环
    streak <= -3 → 粒子变暗

WorldCanvas.tsx
  无变更: 整体渲染管线不受影响
```

---

## 附录 A: AgentEventBus 接口

```typescript
// 前端订阅接口
interface AgentEventBus {
  subscribe(listener: (event: AgentEventEnvelope) => void): () => void;
  subscribeStream(stream: AgentEventStream, listener: (event: AgentEventEnvelope) => void): () => void;
  getState(): AgentRunState;
  getEvents(runId: string): AgentEventEnvelope[];
}
```

## 附录 B: 终止操作粒度

```typescript
// 可终止的操作层级
type AbortTarget =
  | { level: 'run' }                       // 终止整个 Run
  | { level: 'tool'; callId: string }      // 终止当前工具调用
  | { level: 'child'; childRunId: string } // 终止子智能体
  | { level: 'step'; stepIndex: number }   // 跳过当前计划步骤
  | { level: 'compact' }                   // 强制压缩
```

## 附录 C: NexusEntity 完整新结构

```typescript
interface NexusEntity {
  id: string;
  position: GridPosition;

  // ▼▼▼ 废弃字段（保留以兼容过渡期，读取时映射到 scoring）▼▼▼
  /** @deprecated 使用 scoring.score 替代 */
  level: number;
  /** @deprecated 使用 scoring 替代 */
  xp: number;

  // ▼▼▼ 新增评分系统 ▼▼▼
  scoring: NexusScoring;

  // ── 以下字段保持不变 ──
  visualDNA: VisualDNA;
  label?: string;
  constructionProgress: number;
  createdAt: number;
  boundSkillIds?: string[];
  flavorText?: string;
  lastUsedAt?: number;
  customModel?: { baseUrl: string; model: string; apiKey?: string };
  sopContent?: string;
  triggers?: string[];
  version?: string;
  location?: 'local' | 'bundled';
  path?: string;
  objective?: string;
  metrics?: string[];
  strategy?: string;
  updatedAt?: number;
  source?: string;
  agentIdentity?: { name?: string; emoji?: string };
}
```
