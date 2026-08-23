# Agent Harness

> 生产级 AI Agent 框架。插件化架构、多模型支持、安全沙箱、持久化会话、向量记忆、并行调度、MCP 协议兼容。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## 简介

Agent Harness 是一个受 [DeepSeek Harness](https://github.com/deepseek-ai/awesome-deepseek-integration) 和 [OpenAI Codex CLI](https://github.com/openai/codex) 启发的 AI Agent 框架。从零开始构建，目标是提供一个**类型安全、可扩展、生产就绪**的 Agent 运行时。

**核心理念：**
- **插件优先**：所有能力都是插件，不侵入核心
- **零依赖默认**：核心框架不依赖外部服务，可选能力按需加载
- **安全第一**：代码执行沙箱化，操作需审批
- **持久化**：SQLite ACID 持久化，重启后状态不丢失
- **多模态**：支持 OpenAI、MiniMax 等多种模型，一键切换

---

## 功能特性

### 已实现的完整功能栈

| 模块 | 特性 | 状态 | 说明 |
|------|------|------|------|
| **核心架构** | 插件系统 | ✅ | Kernel + ServiceRegistry + EventBus |
| | TypeScript 严格模式 | ✅ | 完整类型推导 |
| **模型层** | OpenAI 兼容 | ✅ | GPT-4 / GPT-3.5 / 自定义兼容端点 |
| | MiniMax 国区 | ✅ | MiniMax-M3，国内直连 |
| | 多模型热切换 | ✅ | 改配置即可切换 |
| **工具层** | 文件系统 | ✅ | 读写文件、目录操作 |
| | Shell 执行 | ✅ | 带超时和目录限制 |
| | 代码执行 | ✅ | JavaScript / Python / Bash |
| | 自定义工具 | ✅ | 简单函数即可注册 |
| **安全** | 进程沙箱 | ✅ | 临时目录 + 超时 + 输出限制 |
| | Docker 沙箱 | ✅ | 容器隔离 + 内存/CPU 限制 |
| | 审批策略 | ✅ | auto / confirm / reject 三级 |
| | 危险命令拦截 | ✅ | rm -rf /、fork bomb 等 |
| **会话管理** | Item/Turn/Thread 原语 | ✅ | Codex-inspired |
| | 内存存储 | ✅ | 开发调试 |
| | SQLite 持久化 | ✅ | ACID + 搜索 + Fork |
| | 向量记忆 | ✅ | RAG 检索历史上下文 |
| | 上下文压缩 | ✅ | 阈值触发 + 摘要 |
| **通信协议** | Agent Bus (内存) | ✅ | 同进程通信 |
| | Agent Bus (HTTP) | ✅ | P2P / Registry 中继 |
| | MCP Server | ✅ | 对外暴露工具 |
| | MCP Client | ✅ | 调用外部 MCP 工具 |
| | WebSocket | ✅ | 实时双向通信 |
| **Web UI** | 聊天界面 | ✅ | 现代化 React-less 前端 |
| | Thread 管理 | ✅ | 创建 / 切换 / Fork / 归档 |
| | 实时流式 | ✅ | WebSocket 推送 |
| | 审批弹窗 | ✅ | 人工确认操作 |
| **调度** | 子 Agent 并行 | ✅ | Map-Reduce 模式 |
| | 任务路由 | ✅ | 关键字自动分配 |
| | 结果聚合 | ✅ | LLM 合成多 Agent 输出 |
| **可观测性** | 执行追踪 | ✅ | 全链路事件 |

---

## 架构设计

```
┌─────────────────────────────────────────────────────┐
│                    Client Layer                      │
│   CLI (stdio) / Web UI (WebSocket) / MCP Client     │
├─────────────────────────────────────────────────────┤
│                  App Server                          │
│   JSON-RPC  │  Thread Manager  │  Turn Executor      │
├─────────────────────────────────────────────────────┤
│                    Agent Core                        │
│   Prompt Builder │ Approver │ Compactor │ Memory     │
├─────────────────────────────────────────────────────┤
│                  Execution Layer                     │
│   Model Provider │ Tool Registry │ Parallel Scheduler│
├─────────────────────────────────────────────────────┤
│                   Sandbox Layer                      │
│   Process Sandbox │ Docker Sandbox │ Danger Filter   │
├─────────────────────────────────────────────────────┤
│                  Persistence Layer                   │
│   SQLite (Thread/Turn/Item) │ Vector Memory (RAG)   │
└─────────────────────────────────────────────────────┘
```

---

## 快速开始

### 安装

```bash
git clone <repo-url>
cd agent-harness
npm install
```

### 环境配置

```bash
# 方案一：OpenAI
export OPENAI_API_KEY=sk-...

# 方案二：MiniMax 国区
export MINIMAX_API_KEY=sk-...
export MINIMAX_BASE_URL=https://api.minimaxi.com/v1
export MINIMAX_MODEL=MiniMax-M3

# 可选：持久化路径
export AGENT_DB_PATH=./data/threads.db
```

### 启动方式

```bash
# 1. CLI 模式（stdio）
npm run dev

# 2. Web UI 模式（WebSocket + HTTP）
npm run dev:v2
# 打开 http://localhost:3456

# 3. MCP Server 模式（stdio，供 Claude Desktop 使用）
npm run mcp
```

### 最小代码示例

```typescript
import { HarnessV2 } from './harness-v2.js';

const agent = new HarnessV2({
  modelProvider: 'minimax',
  model: {
    apiKey: process.env.MINIMAX_API_KEY!,
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
  },
  filesystem: { rootPath: './workspace' },
  agent: {
    maxIterations: 10,
    systemInstruction: 'You are a helpful coding assistant.',
  },
  persistence: { dbPath: './data/threads.db' },
  enableMemory: true,
  transports: ['stdio', 'websocket'],
  webUI: { enabled: true, port: 3456 },
});

await agent.start();
```

---

## 核心概念

### 1. Thread / Turn / Item 三原语

受 OpenAI Codex CLI 启发，会话管理采用三级结构：

- **Thread**：会话线程，独立上下文边界
- **Turn**：单次用户输入到 Agent 响应的完整回合
- **Item**：Turn 内的原子消息单元（用户输入、Assistant 回复、工具调用、工具结果）

```typescript
// 创建线程
const thread = threadManager.create();

// Fork 线程（保留历史，独立发展）
const forked = threadManager.fork(thread.id);

// 归档线程
threadManager.archive(thread.id);
```

### 2. 审批策略

三级策略控制工具执行：

```typescript
const approval = {
  autoApprove: ['filesystem:read'],  // 自动放行
  confirm: ['filesystem:write', 'shell'],  // 需确认
  reject: ['rm', 'mkfs'],  // 直接拒绝
};
```

### 3. 上下文压缩

当 Token 数超过阈值时，自动压缩历史：

```typescript
const compactor = new ContextCompactor({
  tokenThreshold: 12000,  // 触发阈值
  summaryModel: modelProvider,  // 用于摘要的模型
});

// 自动保留最近 N 轮，老消息摘要化
```

### 4. 向量记忆

无需外部向量数据库，轻量 RAG：

```typescript
const memory = new ThreadMemory();

// 自动索引
memory.indexThread(thread);

// 检索相关上下文
const context = memory.getRelevantContext("帮我优化那个函数");
// 返回: "Relevant previous context: [assistant]: ..."
```

---

## 插件系统

### 内置插件

| 插件 | 功能 |
|------|------|
| `model:openai` | OpenAI API 兼容模型 |
| `model:minimax` | MiniMax 国区 API |
| `tool:filesystem` | 文件读写、目录操作 |
| `tool:shell` | Shell 命令执行 |
| `sandbox:process` | 进程级代码沙箱 |
| `sandbox:docker` | Docker 容器沙箱 |
| `session:memory` | 内存会话存储 |
| `session:persistence` | JSON 文件持久化 |
| `agent-loop:react` | ReAct 决策循环 |
| `agent:bus` | 多 Agent 通信 |
| `mcp` | MCP 协议适配 |

### 自定义插件

```typescript
import { Plugin } from './core/plugin.js';
import { Tool } from './plugins/tools/interface.js';

const myTool: Tool = {
  name: 'weather',
  description: '获取城市天气',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  async execute(args) {
    return { temp: 24, condition: 'sunny' };
  },
};

export const myPlugin: Plugin = {
  name: 'tool:weather',
  dependencies: ['tool:registry'],
  async activate(ctx) {
    const registry = ctx.services.get('tool:registry') as any;
    registry.register(myTool);
  },
};
```

---

## 多 Agent 并行调度

### 基础用法

```typescript
import { ParallelScheduler } from './core/scheduler.js';

const scheduler = new ParallelScheduler(
  {
    agents: [
      { id: 'coder', systemPrompt: 'You are a code expert.', tools: ['shell', 'code'] },
      { id: 'writer', systemPrompt: 'You are a writer.', tools: ['filesystem'] },
    ],
    maxConcurrency: 3,
  },
  modelProvider,
  toolRegistry
);

// 并行执行
const results = await scheduler.runParallel([
  { id: 'task-1', description: 'Write a fibonacci function', agentId: 'coder' },
  { id: 'task-2', description: 'Write documentation', agentId: 'writer' },
]);

// 聚合结果
const summary = await scheduler.aggregate('Create a math library', results);
```

### Map-Reduce 模式

```typescript
const documents = ['doc1.txt', 'doc2.txt', 'doc3.txt'];

const summary = await scheduler.mapReduce(
  documents,
  (doc) => ({
    id: doc,
    description: `Summarize ${doc}`,
  }),
  async (results) => {
    // 自定义聚合逻辑
    return results.map(r => r.output).join('\n');
  }
);
```

---

## MCP 协议兼容

### 作为 MCP Server

暴露所有工具给外部 MCP 客户端（如 Claude Desktop）：

```typescript
// claude_desktop_config.json
{
  "mcpServers": {
    "agent-harness": {
      "command": "node",
      "args": ["/path/to/agent-harness/dist/mcp/stdio-server.js"]
    }
  }
}
```

### 作为 MCP Client

调用外部 MCP Server 的工具：

```typescript
const harness = new HarnessV2({
  mcp: {
    clients: [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed'],
      },
    ],
  },
});

// 外部工具自动注册为 harness:toolName
```

---

## Web UI 控制台

### 启动

```bash
npm run dev:v2
# 自动启动:
# - HTTP 静态服务器: http://localhost:3456
# - WebSocket JSON-RPC: ws://localhost:3456/jsonrpc
```

### 功能

- **Thread 管理**：侧边栏列出所有线程，点击切换
- **实时通信**：WebSocket 双向推送，无需轮询
- **流式输出**：Agent 思考过程实时展示
- **审批交互**：危险操作弹窗确认
- **代码高亮**：消息中的代码块自动格式化
- **移动端适配**：响应式设计

### 截图

```
┌─────────────┬─────────────────────────────────────────┐
│ Agent Harness│ 🤖 Agent                                │
│ [Status: 🟢] │ ───────────────────────────────────────│
│             │                                         │
│ + New Thread│ User: 写一个快速排序                    │
│             │                                         │
│ 💬 thread-1 │ 🤖 我来实现一个快速排序算法...          │
│ 💬 thread-2 │ [代码块]                                │
│ 💬 thread-3 │                                         │
│             │ 🔧 shell: node test.js                  │
│             │ 输出: [1, 2, 3, 4, 5]                   │
│             │                                         │
│             ├─────────────────────────────────────────┤
│             │ [输入框...                    ] [Send]  │
└─────────────┴─────────────────────────────────────────┘
```

---

## API 参考

### JSON-RPC 方法

**Thread 生命周期**

| 方法 | 参数 | 说明 |
|------|------|------|
| `thread/create` | `{ id?: string }` | 创建线程 |
| `thread/get` | `{ id: string }` | 获取线程状态 |
| `thread/list` | - | 列出所有线程 |
| `thread/fork` | `{ sourceId, newId? }` | 分叉线程 |
| `thread/archive` | `{ id }` | 归档线程 |
| `thread/delete` | `{ id }` | 删除线程 |

**执行**

| 方法 | 参数 | 说明 |
|------|------|------|
| `turn/submit` | `{ threadId, input }` | 提交用户输入 |
| `turn/cancel` | `{ turnId }` | 取消执行 |

**审批**

| 方法 | 参数 | 说明 |
|------|------|------|
| `approval/list` | - | 列出待审批 |
| `approval/resolve` | `{ id, approved }` | 审批操作 |

**记忆**

| 方法 | 参数 | 说明 |
|------|------|------|
| `memory/search` | `{ query, topK? }` | 搜索历史 |
| `memory/context` | `{ query, maxTokens? }` | 获取相关上下文 |

### 通知 (Server → Client)

| 通知 | 说明 |
|------|------|
| `turn/started` | Turn 开始执行 |
| `turn/completed` | Turn 完成 |
| `item/delta` | 流式输出增量 |
| `item/completed` | Item 完成 |
| `tool_call/started` | 工具调用开始 |
| `tool_call/completed` | 工具调用完成 |
| `approval/required` | 需要人工审批 |
| `system/connected` | 客户端连接成功 |

---

## 配置详解

### 完整配置示例

```typescript
import { HarnessV2 } from './harness-v2.js';

const harness = new HarnessV2({
  // 模型配置
  modelProvider: 'minimax',
  model: {
    apiKey: process.env.MINIMAX_API_KEY!,
    baseUrl: 'https://api.minimaxi.com/v1',
    model: 'MiniMax-M3',
    temperature: 0.7,
  },

  // 文件系统
  filesystem: {
    rootPath: './workspace',
    allowedPaths: ['./workspace', './temp'],
  },

  // Agent 行为
  agent: {
    maxIterations: 10,
    systemInstruction: 'You are a helpful assistant.',
    enableCompaction: true,
    compactionThreshold: 12000,
  },

  // 审批策略
  approval: {
    readonly: false,
    network: false,
    autoApprove: ['filesystem:read', 'filesystem:list'],
    confirm: ['filesystem:write', 'shell', 'code'],
    reject: ['rm', 'mkfs', 'dd'],
  },

  // 持久化
  persistence: {
    dbPath: './data/threads.db',
  },

  // 向量记忆
  enableMemory: true,

  // 传输层
  transports: ['stdio', 'websocket'],

  // Web UI
  webUI: {
    enabled: true,
    port: 3456,
    host: '0.0.0.0',
  },
});
```

---

## 项目结构

```
agent-harness/
├── src/
│   ├── core/                      # 核心框架
│   │   ├── kernel.ts              # 插件内核
│   │   ├── plugin.ts              # 插件接口
│   │   ├── event-bus.ts           # 事件总线
│   │   ├── service-registry.ts    # 服务注册表
│   │   ├── thread.ts              # Thread/Turn/Item 原语
│   │   ├── sqlite-thread.ts       # SQLite 持久化
│   │   ├── prompt-builder.ts      # Cache-aware prompt 构建
│   │   ├── approver.ts            # 三级审批策略
│   │   ├── compactor.ts           # 上下文压缩
│   │   ├── vector-memory.ts       # 轻量 RAG
│   │   └── scheduler.ts           # 并行调度器
│   ├── appserver/                 # App Server
│   │   ├── protocol.ts            # JSON-RPC 协议
│   │   ├── server.ts              # App Server 核心
│   │   ├── server-v2.ts           # 集成版 (SQLite + Memory)
│   │   ├── stdio-transport.ts     # stdio 传输
│   │   ├── websocket-transport.ts # WebSocket 传输
│   │   └── static-server.ts       # 静态文件服务
│   ├── mcp/                       # MCP 协议适配
│   │   ├── protocol.ts            # MCP 协议实现
│   │   └── plugin.ts              # MCP 插件
│   ├── plugins/
│   │   ├── model/                 # 模型提供者
│   │   │   ├── interface.ts       # 模型接口
│   │   │   ├── openai.ts          # OpenAI 实现
│   │   │   └── minimax.ts         # MiniMax 实现
│   │   ├── tools/                 # 工具
│   │   │   ├── interface.ts       # 工具接口
│   │   │   ├── filesystem.ts      # 文件系统
│   │   │   └── shell.ts           # Shell 执行
│   │   ├── sandbox/               # 沙箱
│   │   │   ├── process-sandbox.ts # 进程沙箱
│   │   │   └── docker-sandbox.ts  # Docker 沙箱
│   │   ├── agent-loop/            # Agent 循环
│   │   │   └── react-loop.ts      # ReAct 实现
│   │   ├── session/               # 会话
│   │   │   ├── memory.ts          # 内存存储
│   │   │   └── persistence.ts     # JSON 持久化
│   │   ├── agent-bus/             # 多 Agent 通信
│   │   │   ├── bus.ts             # 总线实现
│   │   │   └── http-transport.ts  # HTTP 传输
│   │   └── observability/         # 可观测性
│   │       └── tracer.ts          # 执行追踪
│   ├── harness.ts                 # 基础组装
│   ├── harness-pro.ts             # 产品级组装
│   ├── harness-v2.ts              # V2 组装器
│   ├── cli.ts                     # CLI 入口
│   ├── cli-v2.ts                  # V2 CLI 入口
│   └── demo-*.ts                  # 示例脚本
├── public/                        # Web UI 前端
│   └── index.html                 # 单页应用
├── dist/                          # 编译输出
├── package.json
├── tsconfig.json
└── README.md
```

---

## 开发指南

### 编译

```bash
npm run build        # TypeScript 编译
npm run build:watch  # 监视模式
```

### 测试

```bash
npm test             # 运行测试
```

### 添加新模型

实现 `ModelProvider` 接口：

```typescript
import { ModelProvider, Message, ToolSchema, ModelResponse } from './plugins/model/interface.js';

export class MyProvider implements ModelProvider {
  async generate(messages: Message[], tools?: ToolSchema[]): Promise<ModelResponse> {
    // 调用你的 API
    return { content: 'Hello', toolCalls: [] };
  }
}
```

### 添加新工具

实现 `Tool` 接口并注册：

```typescript
const myTool: Tool = {
  name: 'myTool',
  description: 'Does something',
  parameters: { type: 'object', properties: {} },
  async execute(args) {
    return { result: 'done' };
  },
};
```

---

## 路线图

### 已完成 ✅

- [x] 插件化架构
- [x] 多模型支持（OpenAI、MiniMax）
- [x] 工具调用（文件系统、Shell、代码执行）
- [x] 安全沙箱（进程 + Docker）
- [x] 会话持久化（SQLite）
- [x] 向量记忆（RAG）
- [x] 任务规划
- [x] 多 Agent 通信（内存 / P2P / 跨网络）
- [x] 可观测性（执行追踪）
- [x] Codex-inspired 架构（V2）
- [x] Web UI 控制台
- [x] MCP 协议适配
- [x] 子 Agent 并行调度

### 计划中 📋

- [ ] REST API 服务（HTTP 轮询）
- [ ] 更多模型（Claude、Gemini、本地模型）
- [ ] 插件市场（npm 式分发）
- [ ] 可视化工作流编辑器
- [ ] 分布式集群调度
- [ ] 更多沙箱语言（Rust、Go、Java）
- [ ] 性能基准测试套件

---

## 实际案例

### 案例 1：生成俄罗斯方块

Agent 独立完成完整游戏开发：

1. 分析需求（7 种方块、旋转、消行、计分）
2. 生成 `index.html`、`styles.css`、`game.js`
3. 自检查语法和逻辑
4. 修复边界 case

**产出**：27KB 完整游戏，可直接浏览器运行。

```bash
python3 -m http.server 3456 --directory tetris-game
```

### 案例 2：多 Agent 协作写文档

```typescript
const scheduler = new ParallelScheduler({
  agents: [
    { id: 'coder', systemPrompt: 'Write code examples' },
    { id: 'writer', systemPrompt: 'Write explanations' },
    { id: 'reviewer', systemPrompt: 'Review for accuracy' },
  ],
}, model, tools);

const results = await scheduler.runParallel([
  { id: 'code', description: 'Write quicksort implementation' },
  { id: 'explain', description: 'Explain quicksort algorithm' },
  { id: 'review', description: 'Review for correctness' },
]);

const doc = await scheduler.aggregate('Create a quicksort guide', results);
```

---

## 贡献指南

欢迎 Issue 和 PR。设计原则：

1. **插件优先**：新功能优先以插件形式实现
2. **零依赖默认**：核心不依赖外部服务
3. **类型安全**：TypeScript 严格模式
4. **安全第一**：默认安全，显式授权

---

## 许可证

MIT License

---

> 我不负责让场面热闹。我负责让事情变清楚。
