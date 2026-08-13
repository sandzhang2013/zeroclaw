# ZeroClaw 框架技术分析

## 定位

ZeroClaw 是一个 **Agent Runtime**（单一 Rust 二进制），不是 SaaS、不是协议、不是库。

> "You own the agent. You own the data. You own the machine it runs on."

核心公式：**Model（LLM 大脑） + Harness（运行时身体） = Agent（完整助手）**

---

## 一、协议体系

### 内部协议

| 协议 | 传输 | 用途 |
|------|------|------|
| **Gateway REST** | HTTP/JSON | 配置、会话、记忆、cron、SOP 管理等 ~105 个端点 |
| **Gateway WebSocket** | WS + sub-protocol `zeroclaw.v1` | Agent 实时聊天（/ws/chat）、SOP 运行、Canvas |
| **ACP** (Agent Client Protocol) | JSON-RPC 2.0 over stdio / WS | IDE/编辑器集成，类似 LSP |
| **A2A** (Agent-to-Agent) | JSON-RPC 2.0 over HTTP | 跨 Agent 任务委托（Google/Linux Foundation 标准） |
| **RPC Socket** | JSON-RPC 2.0 over NDJSON / Unix Domain Socket | 本地 zerocode TUI 通信 |
| **SSE** | Server-Sent Events | 观测事件流、Dashboard 实时刷新 |
| **WIT/WASI** | WASM Component Model | 沙箱插件接口（experimental） |

### 外部协议

| 类别 | 协议 | 数量 |
|------|------|------|
| **LLM Provider** | Anthropic / OpenAI / Ollama / OpenAI-compatible | 20+ |
| **消息平台** | Discord / Telegram / Matrix / Slack / Signal / IRC / WhatsApp / LINE / Mattermost / Twitch / Nextcloud Talk … | 30+ |
| **社交/广播** | AT Protocol (Bluesky) / NIP-01 (Nostr) / Twitter API v2 / Reddit JSON API | 4 |
| **邮件** | IMAP/SMTP / Google Pub/Sub push | 2 |
| **事件源** | MQTT / AMQP / Webhook / Filesystem watch | 4 |
| **语音/电话** | SIP via Telnyx/Twilio/Plivo | 1 |
| **硬件** | GPIO / I2C / SPI / USB (Raspberry Pi / STM32 / Arduino / ESP32) | 4 |
| **MCP Client** | stdio / HTTP / SSE（连接外部 MCP Server） | 3 |

---

## 二、代码架构（22 crates）

```
┌─────────────────────────────────────────────────────────────┐
│  zeroclaw-api       内核 ABI — 所有 trait 定义               │
│  Tool / Memory / Channel / Provider / Observer / Peripheral  │
├─────────────────────────────────────────────────────────────┤
│  zeroclaw-runtime   引擎 — Agent + ToolLoop + Security + SOP │
│  zeroclaw-config    配置 — Schema + SecurityPolicy           │
│  zeroclaw-gateway   网关 — AppState + Router + WS + ACP      │
├─────────────────────────────────────────────────────────────┤
│  zeroclaw-tools     工具 — shell / browser / HTTP / MCP …   │
│  zeroclaw-memory    记忆 — SQLite + 向量 + agent_scoped      │
│  zeroclaw-channels  通道 — 30+ 适配器 + orchestrator          │
│  zeroclaw-providers 大脑 — 20+ LLM 客户端 + routing          │
├─────────────────────────────────────────────────────────────┤
│  zeroclaw-plugins   WASM 沙箱宿主 (wasmtime + WIT)           │
│  zeroclaw-hardware  硬件抽象 (GPIO/I2C/SPI/USB)              │
│  zeroclaw-infra     基础设施 (session_queue / SQLite / ACP)   │
│  zeroclaw-log       日志 — JSONL schema + attribution         │
│  zeroclaw-spawn     受控 tokio::spawn 包装                    │
│  zeroclaw-macros    derive 宏                                 │
│  zeroclaw-sop-graph SOP 工作流图引擎                           │
│  zeroclaw-tool-call-parser 模型侧 tool-call 解析               │
│  zeroclaw-eval      评估框架                                   │
│  zeroclaw-commands  CLI 命令                                   │
├─────────────────────────────────────────────────────────────┤
│  zerocode           TUI 终端界面                              │
│  aardvark-sys / robot-kit  专用硬件支持                        │
└─────────────────────────────────────────────────────────────┘
```

### 分层结构

```
Channel / Gateway / ACP / CLI        ← 入口层
        │
   Agent 构建 + SecurityPolicy       ← 初始化层
        │
   ToolLoop (对话主循环)              ← 引擎层
   ├─ memory_inject (记忆注入)
   ├─ call_provider (调 LLM)
   ├─ parse_response (解析响应)
   ├─ execute_tools (执行工具)
   ├─ approval_gate (审批门)
   └─ append_history + loop_detect
        │
   memory consolidation + persist     ← 持久层
```

---

## 三、核心类型

### Agent（`agent.rs:275`）

```rust
Agent {
    model_provider,          // 大脑：Box<dyn ModelProvider>
    tools,                   // 手：Vec<Box<dyn Tool>>
    memory,                  // 记忆：Arc<dyn Memory>
    security_policy,         // 安全边界
    workspace_dir,           // 沙箱根目录
    history,                 // 当前对话
    memory_session_id,       // 会话级记忆 scope
    skills,                  // 技能包
    channel_handles,         // 通道句柄
    // ... ~40 字段
}
```

构造入口：
- `from_config()` — CLI/TUI 一次性
- `from_live_config_with_session_cwd_and_mcp_backchannel()` — Daemon/WS/ACP（共享 live config）

### ToolLoop（`turn/mod.rs:90`）

```rust
ToolLoop {
    exec: ResolvedAgentExecution,   // model + tools + approval + knobs
    history,                        // 对话历史
    channel,                        // 输出通道
    memory: TurnMemory,             // 本轮记忆注入上下文
    cancellation_token,             // 中止信号
    steering,                       // 旁路操控消息
    // ...
}
// 循环：max_tool_iterations（默认 10）
// ├─ call_provider → stream/response
// ├─ parse → text | tool_calls
// ├─ execute → sequential | parallel
// ├─ approval_gate → allow/deny
// └─ append + loop_detect
```

### SecurityPolicy（`policy.rs:155`）

```rust
SecurityPolicy {
    autonomy: AutonomyLevel,       // Full/Supervised/Restricted/Block
    workspace_dir,                 // 沙箱根
    allowed_commands,              // shell 命令白名单
    forbidden_paths,               // 禁止路径
    allowed_tools,                 // 工具白名单
    excluded_tools,                // 工具黑名单
    sandbox_enabled,               // 沙箱开关
    sandbox_backend,               // firejail/landlock/bubblewrap/seatbelt/docker
    max_actions_per_hour,
    max_cost_per_day_cents,
    // ...
}
```

### AppState（`gateway/lib.rs:445`）

```rust
AppState {
    config: Arc<RwLock<Config>>,           // 共享 live config
    mem: Arc<dyn Memory>,                  // 共享记忆
    session_queue: Arc<SessionActorQueue>, // 会话队列（Semaphore(1) per key）
    session_backend,                       // 会话持久化（SQLite）
    pairing: Arc<PairingGuard>,            // 设备配对
    sop_engine / sop_audit,                // SOP 引擎
    event_tx / event_buffer,               // SSE 广播
    cancel_tokens,                         // 中止 token 注册表
    canvas_store,                          // Live Canvas
    // ...
}
```

---

## 四、数据流（一次完整对话）

```
1. 入口
   Channel msg / WS connect / REST POST / CLI input
        │
2. 会话解析
   session_key = "{prefix}{session_id}"
   session_queue.acquire(session_key) → 排队/并发
        │
3. Agent 构建
   Agent::from_live_config_with_session_cwd_and_mcp_backchannel()
   ├─ resolve model_provider + routing
   ├─ SecurityPolicy::for_agent()
   ├─ ScopedToolRegistry::assemble()
   └─ create_memory_for_agent()
        │
4. 记忆注入
   memory.recall(query, session_id) → 注入到系统提示词
        │
5. ToolLoop（每轮对话）
   a. 构建消息（system + history + user）
   b. model_provider.chat(messages, tools) → stream
   c. 解析响应：
      - text → 流式输出给用户
      - tool_call → 进入执行
   d. SecurityPolicy.validate(tool_call) → approved/blocked
   e. tool.execute(args) → result
   f. result → 追加到 history → 回到步骤 b（下一轮）
   g. 最多 10 轮（loop_detector 防死循环）
        │
6. 持久化
   ├─ session_backend.store(session_key, messages)
   ├─ memory.store(..., session_id)
   └─ consolidation（长期记忆整理）
```

---

## 五、并发模型

```
SessionActorQueue
├─ 每个 session_key → Semaphore(1)
├─ 同 session 内串行（保证上下文一致性）
├─ 不同 session 并行（不同 key 互不阻塞）
└─ 参数：queue_depth=8, lock_timeout=30s, idle_ttl=600s

Gateway WS：无 session 数量上限
ACP：max_sessions=10（可配）
Channel：全局 in_flight semaphore = max_concurrent_per_channel × channel_count
RPC/TUI：SessionStore::new(64)
```

---

## 六、多用户隔离现状

### 已有但未接线的基础设施

| 设施 | 位置 | 状态 |
|------|------|------|
| `Principal`（user_id + roles + scopes） | `zeroclaw-api/src/principal.rs` | 已定义，未接入 gateway |
| `AuthProvider` trait + `NevisAuthProvider` | `runtime/src/security/auth_provider.rs` | 已实现，未接入 |
| `tenant_id` 列 | `memory/src/sqlite.rs:333` | 已存可取，从未过滤 |
| per-session `cwd` | `agent.rs:1440` | 已工作，可覆盖 policy.workspace_dir |
| `AgentScopedMemory` 包装 | `memory/src/agent_scoped.rs` | 可复制为 UserScopedMemory |

### 平台集成模式精简改动（~8 文件）

| 模块 | 改动要点 |
|------|----------|
| Gateway 入口 | 加 axum 中间件提取平台 `user_id` |
| WS session | `session_key` + `session_cwd` 加 user 前缀 |
| ACP session | 同上 + `acp_sessions` 表加 `user_id` |
| Memory | UserScopedMemory 包装 + 修复 durable-global 泄漏 + tenant_id 索引 |
| Channel | `conversation_history_key` 加 user 前缀 |
| Session 持久层 | `session_metadata` 加 `user_id` 列 |

### 最大风险：durable-global 记忆泄漏

`sqlite.rs:745,902` — Core/Daily 类型且 `session_id IS NULL` 的长期记忆行会被所有用户无条件召回。这是多用户隔离中必须修复的唯一隐私泄漏点。

---

## 七、关键文件索引

| 文件 | 内容 |
|------|------|
| `crates/zeroclaw-runtime/src/agent/agent.rs` | Agent struct + 构造器链 |
| `crates/zeroclaw-runtime/src/agent/loop_.rs` | 对话主循环入口 |
| `crates/zeroclaw-runtime/src/agent/turn/mod.rs` | ToolLoop 引擎 |
| `crates/zeroclaw-api/src/tool.rs` | Tool trait |
| `crates/zeroclaw-api/src/memory_traits.rs` | Memory trait |
| `crates/zeroclaw-api/src/channel.rs` | Channel trait |
| `crates/zeroclaw-config/src/schema.rs` | 完整配置 schema (~13000 行) |
| `crates/zeroclaw-config/src/policy.rs` | SecurityPolicy |
| `crates/zeroclaw-gateway/src/lib.rs` | AppState + 路由组装 |
| `crates/zeroclaw-gateway/src/ws.rs` | WebSocket 聊天 + Agent 构建 |
| `crates/zeroclaw-gateway/src/acp.rs` | ACP over WS |
| `crates/zeroclaw-gateway/src/a2a.rs` | A2A 协议 |
| `crates/zeroclaw-memory/src/sqlite.rs` | 记忆 SQLite 后端 |
| `crates/zeroclaw-memory/src/agent_scoped.rs` | Agent 级记忆包装 |
| `crates/zeroclaw-infra/src/session_queue.rs` | SessionActorQueue |
| `crates/zeroclaw-infra/src/session_sqlite.rs` | 会话持久化 |
| `crates/zeroclaw-channels/src/orchestrator/mod.rs` | 频道调度中心 |
| `crates/zeroclaw-tools/src/tools/mod.rs` | 工具组装入口 |
| `crates/zeroclaw-runtime/src/tools/scoped.rs` | ScopedToolRegistry |
| `web/src/pages/ChatWorkspace.tsx` | 前端多任务工作区 |
| `web/src/contexts/AgentContext.tsx` | 前端 AgentProvider |
| `web/src/lib/ws.ts` | 前端 WebSocketClient + session 管理 |

---

## 八、Provider 体系（LLM 路由与模型选择）

### 核心文件

| 文件 | 内容 |
|------|------|
| `crates/zeroclaw-providers/src/lib.rs` (4783行) | 中心工厂枢纽 |
| `crates/zeroclaw-providers/src/factory.rs` (2507行) | 各厂家的工厂方法 |
| `crates/zeroclaw-providers/src/reliable.rs` (5524行) | 重试/退避/降级 |
| `crates/zeroclaw-providers/src/router.rs` (1470行) | 路由提示 & 成本路由 |
| `crates/zeroclaw-api/src/model_provider.rs` | `ModelProvider` trait 定义 |

### 核心 trait：ModelProvider

`model_provider.rs:443` — 异步 trait，对 `Arc<T>` 做了 blanket impl：

```
ModelProvider
├─ 能力查询: supports_native_tools / supports_vision / ...
├─ 非流式 chat: simple_chat → chat_with_system → chat_with_history → chat → chat_with_tools
├─ 流式 chat: stream_chat / stream_chat_with_tools → StreamResult<StreamChunk>
└─ ToolsPayload 枚举:
    ├─ Anthropic 格式 (tools)
    ├─ OpenAI 格式 (tools/tool_choice)
    └─ PromptGuided（不支持原生 tool 的模型降级为 prompt 内指令）
```

### 装饰器链（Composition over Inheritance）

```
create_model_provider_inner (单一构造入口, lib.rs:1169)
  │
  ├─ 1. canonicalize_v2_model_provider_name (名称规范化)
  ├─ 2. apply_vision_override (视觉覆盖)
  ├─ 3. scrub_secret_patterns (密钥脱敏)
  └─ 4. dispatch_family_factory → FamilyProviderFactory (按厂家分发)
        │
        ├─ ReliableModelProvider  ← 重试+降级包装
        │   ├─ transient_error_hint (瞬时错误识别)
        │   ├─ is_non_retryable (不可重试错误)
        │   └─ append_fallback_chain (降级链: 主→备1→备2)
        │
        ├─ RouterModelProvider   ← 路由包装
        │   ├─ resolve: 按路由提示选择
        │   └─ resolve_cost_optimized: 选最便宜的可用模型
        │
        └─ ProviderDispatch      ← 归因包装
            └─ attribution_span! + scope!(model:)
```

### 关键模式

- **宏驱动分发**：`zeroclaw-config` 定义 `for_each_model_provider_slot!` 宏枚举所有厂家，providers crate 遍历构建 match 分支，新增厂家只需加宏条目
- **单一构造入口**：`create_model_provider_inner` 是唯一创建点，安全审计只需看一处
- **WireApi** 枚举：chat-completions vs Responses 双协议支持
- **错误清理**：`sanitize_api_error` 在错误冒泡前剥离 API key

---

## 九、Tool 体系（注册/作用域/审批链）

### 核心文件

| 文件 | 内容 |
|------|------|
| `crates/zeroclaw-api/src/tool.rs` | `Tool` trait |
| `crates/zeroclaw-runtime/src/tools/scoped.rs` (1484行) | `ScopedToolRegistry` |
| `crates/zeroclaw-runtime/src/tools/mod.rs` (3165行) | 内置工具组装 |
| `crates/zeroclaw-runtime/src/approval/mod.rs` (1043行) | `ApprovalManager` |
| `crates/zeroclaw-runtime/src/agent/tool_execution.rs` | 执行 + 审批门控 |

### Tool trait

```rust
// tool.rs:319
trait Tool {
    name()        → &str
    description() → &str
    parameters_schema() → Value      // JSON Schema
    spec()        → ToolSpec          // Arc<Value> 避免深拷贝
    execute(args) → anyhow::Result<ToolResult>
}
```

### ScopedToolRegistry 组装流水线（唯一门控点）

```
ScopedToolRegistry::assemble()    // scoped.rs:175
  │
  ├─ 1. Peripherals（会话上下文、运行时句柄）
  ├─ 2. SecurityPolicy 过滤 ← is_tool_allowed / is_tool_excluded
  ├─ 3. Context 过滤
  ├─ 4. MCP scoping ← ToolAccessPolicy 门控
  ├─ 5. Skills 注册 ← register_skill_tools_with_context_and_runtime
  └─ 6. excluded_tools 最终减法
```

### 审批链

```
Model 发出 tool_call
  │
  ├─ apply_policy_tool_filter (移除不允许的工具)
  ├─ ApprovalManager::needs_approval
  │   ├─ Full 自治 → 永远跳过
  │   ├─ Supervised → 默认弹窗
  │   ├─ auto_approve 列表 → 跳过
  │   └─ always_ask 列表 → 强制弹窗
  ├─ record_decision (记录+更新 session allowlist)
  └─ execute_one_tool / execute_tools_parallel / execute_tools_sequential
      └─ 并行安全门: should_execute_tools_in_parallel
          当批次中任一工具需审批时 → 强制串行
```

### 关键模式

- **ToolSpec Arc 共享**：每个 tool 的 schema 用 `Arc<Value>` 持有，每轮迭代不做深拷贝
- **MCP 工具统一适配**：外部 MCP 工具包装为 `McpToolWrapper`，走相同的 Tool 管道，自动继承审批/作用域
- **非交互式安全**：channel 驱动的会话使用 NonInteractive ApprovalManager，自动拒绝

---

## 十、SOP 工作流引擎

### 核心文件

| 文件 | 内容 |
|------|------|
| `crates/zeroclaw-sop-graph/src/lib.rs` (479行) | 图投影模型 |
| `crates/zeroclaw-runtime/src/sop/types.rs` (1444行) | SOP 数据模型 & 触发器 |
| `crates/zeroclaw-runtime/src/sop/engine.rs` (14955行) | 执行引擎 |
| `crates/zeroclaw-runtime/src/sop/dispatch.rs` (3146行) | 事件扇入/扇出 |
| `crates/zeroclaw-runtime/src/sop/trigger_registry.rs` (742行) | 触发器绑定 |

### 设计哲学：Disk-backed, Markdown-authored

SOP 是文件对：
- `SOP.toml` — 元数据 + 步骤定义 + 触发器
- `SOP.md` — 人类可读的流程文档（与代码库一起版本控制）

```
load_sops → parse_steps (Markdown 步骤语法) → validate_sop_strict → render_steps
```

### 图模型（zeroclaw-sop-graph crate）

```
SopGraph (投影 DAG)
├─ GraphNode   — 步骤/触发器/决策节点
├─ GraphWire   — 节点间的有向边
├─ GraphPin    — 输入/输出端口 (PinClass: trigger/pin)
├─ FlowRole    — 节点在流中的角色
└─ NodeRunState — 运行时状态追踪
```

### 触发体系

```rust
SopTrigger 枚举:
  Mqtt | Webhook | Cron | Peripheral | Filesystem | Calendar
  | Channel | Manual | Amqp
```

`TriggerRegistry` 将触发源绑定到具体 ingress 通道。

### 生命周期：Trigger → Admission → Run

```
1. 入站事件 → SopIngress
      │
2. match_trigger / wants_source / can_start
      │
3. evaluate_admission (并发策略)
      ├─ Parallel  — 每个事件独立运行
      ├─ Hold      — 排队等待
      ├─ Coalesce  — 合并为一次运行
      └─ Drop      — 丢弃重复事件
      │
4. start_run → reserve_run_slot → activate_reserved_run
      │                      (预留解耦，避免竞态)
5. 步骤推进
      ├─ advance_step     — 正常推进
      ├─ approve_step     — 监督模式检查点
      ├─ decide_checkpoint — LLM/确定性分支决策
      └─ run_maintenance_tick — 清理过期运行
```

### 执行模式

| 模式 | 描述 |
|------|------|
| Auto | 全自动执行，无需人工干预 |
| Supervised | 关键步骤需审批 |
| StepByStep | 每步手动确认 |
| Deterministic | 纯规则，不调 LLM |

### SOP 工具（agent 可调用）

`sop_execute / sop_approve / sop_list / sop_status / sop_advance / sop_workshop` — agent 可以像使用普通工具一样操作 SOP。

---

## 十一、MCP 集成（外部工具发现）

### 核心文件

| 文件 | 内容 |
|------|------|
| `crates/zeroclaw-tools/src/mcp_transport.rs` (2775行) | 三种传输后端 |
| `crates/zeroclaw-tools/src/mcp_client.rs` (3115行) | McpServer + McpRegistry |
| `crates/zeroclaw-tools/src/mcp_tool.rs` (269行) | McpToolWrapper 适配器 |
| `crates/zeroclaw-tools/src/mcp_protocol.rs` (230行) | JSON-RPC 类型 |
| `crates/zeroclaw-config/src/schema.rs:4900-5076` | MCP 配置 schema |

### 传输层三后端

```
McpTransportConn trait
├─ StdioTransport — 启动子进程，stdin/stdout 走 JSON-RPC
├─ HttpTransport  — HTTP POST JSON-RPC（可流式）
└─ SseTransport   — SSE 事件流
```

协议版本: `MCP_PROTOCOL_VERSION = "2024-11-05"`

### 工具发现与注册流程

```
Config (McpConfig.servers)
  │
McpRegistry::connect_all
  │
├─ create_transport (stdio/http/sse)
├─ McpServer::connect
│   ├─ initialize 握手
│   └─ tools/list → McpToolDef[]
│
└─ 每个 McpToolDef → McpToolWrapper
    └─ 注册名: "<server>__<tool>"  (server 名作为命名空间)
```

### McpToolWrapper 适配

```rust
// mcp_tool.rs
struct McpToolWrapper {
    spec: Arc<ToolSpec>,        // Arc 共享，避免热路径深拷贝
    registry: Arc<McpRegistry>, // 回指注册中心
}

fn execute(args):
    1. 剥离 approved 字段（MCP 服务器不认识）
    2. registry.call_tool(server__tool, args)
    3. 归一化为 ToolResult（失败非致命，返回 success: false）
```

### 关键模式

- **统一适配**：MCP 工具通过 `McpToolWrapper` 走标准 Tool 管道，自动获得 SecurityPolicy 过滤、审批链、并行调度
- **延迟加载**：`ToolSearchTool` + `DeferredMcpToolSet` 支持按需连接，避免慢速 MCP 服务器阻塞启动
- **作用域门控**：`ToolAccessPolicy` 在组装时 + `mcp_tool_access_policy` 在运行时双重门控
- **前缀命名**：`server__tool` 格式天然防碰撞，`split_prefixed` 解析路由

---

## 十二、Gateway 路由架构

### AppState（`gateway/lib.rs:455`）

```rust
AppState {
    // 配置
    config: Arc<RwLock<Config>>,
    config_write_lock: Arc<Mutex<()>>,   // 所有写入必须持锁 → 防并发覆写

    // 模型/记忆
    model_provider: Arc<dyn ModelProvider>,
    mem: Arc<dyn Memory>,

    // 安全
    pairing: Arc<PairingGuard>,
    auth_limiter: AuthRateLimiter,       // 暴力破解防护
    rate_limiter: GatewayRateLimiter,     // 滑动窗口限流

    // 事件总线
    event_tx: broadcast::Sender<Value>,   // 单总线喂 WS+SSE+跨轮事件

    // 会话
    session_queue: SessionActorQueue,     // per-session Semaphore(1)
    session_backend: SessionSqlite,
    cancel_tokens: HashMap<SessionId, CancellationToken>,

    // SOP/Canvas
    sop_engine: SopEngine,
    sop_audit: SopAuditTrail,
    canvas_store: CanvasStore,
}
```

### 路由组织（~113 路径）

```
Router
├─ /health, /metrics, /pair, /webhook         (内联)
├─ /hooks/claude-code
├─ /api/* (105 REST 端点, 9 个 handler 模块)
│   ├─ api::         — webhook/status
│   ├─ api_config::  — 配置 CRUD
│   ├─ api_sop::     — SOP 管理
│   ├─ api_sections:: — Section 管理
│   ├─ api_browse::  — 文件浏览
│   ├─ api_skills::  — 技能管理
│   ├─ api_personality::
│   ├─ api_quickstart::
│   └─ api_logs::
├─ /ws/chat            (WebSocket 聊天)
├─ /ws/sops/runs       (SOP 运行监控)
├─ /ws/canvas/{id}     (Live Canvas)
├─ /acp                 (ACP over WS)
├─ /api/events          (SSE 事件流)
└─ /_app/{*path}        (SPA 静态文件)
```

### 中间件策略（混合模式）

```
路由器级 (tower layer):
  ├─ RequestBodyLimitLayer (64KB)
  ├─ TimeoutLayer (30s，长路由除外)
  └─ SecurityHeaders

处理器内联 (handler 顶部显式调用):
  ├─ require_auth (bearer token 验证)
  ├─ AuthRateLimiter::check (暴力破解检测)
  ├─ GatewayRateLimiter::allow_pair / allow_webhook
  └─ IdempotencyStore (X-Idempotency-Key, 300s TTL)
```

> 设计选择：不用 axum 中间件栈做 auth/限流，而是每个 handler 显式调用——更显式、更可审计。

### WS 聊天主循环（`ws.rs:611`）

```
tokio::select! {
    1. Client Frame
       ├─ message          → process_chat_message
       ├─ approval_response → 唤醒等待的 oneshot
       └─ SOP frame        → handle_ws_sop_frame

    2. Broadcast Event (event_tx)
       ├─ cron_result 等 → 过滤后转发
       └─ 丢弃观测遥测帧

    3. Approval Event
       └─ approval_request 帧 → 前端弹窗

    4. Shutdown Signal
}
```

`process_chat_message`: 获取 session 锁 → `Agent::turn_streamed` → 流式输出 `chunk/thinking/tool_call/tool_result/done`

---

## 十三、Web 前端架构

### 技术栈

React 19 + TypeScript + Vite 8 + React Router 7

### 入口引导

```
main.tsx → BrowserRouter → App → AuthProvider → ThemeProvider → AppContent
                                                                    │
                                          ┌─────────────────────────┘
                                          │
                             配对检查 ← /health require_pairing
                                          │
                               ┌─ 未配对 → PairingDialog
                               └─ 已配对 → DraftContext
                                            → ConfigDraftProvider
                                            → LocaleContext
                                            → Router (~20 路由)
```

### Context 层（状态管理）

```
AgentProvider (AgentContext.tsx, 894行)
  ├─ 拥有一个 WebSocketClient (per agent+task)
  ├─ 聊天历史水合 (REST 优先, localStorage 降级)
  ├─ 中央 WS 消息处理器 → reduceTurnFrame
  ├─ switchModel — 切模型+重建连接
  ├─ clearAllMessages — 删后端 session+重建连接
  └─ pendingApproval + respondToApproval

turnStream.logic.ts — 纯 reducer (reduceTurnFrame)
  所有帧解析 → 状态转换 → 单元测试覆盖

AuthProvider (useAuth.ts)
  ├─ token 存 localStorage zeroclaw_token
  ├─ 跨标签页同步 (storage 事件)
  └─ 全局 401 监听 → 强制登出

useApi / useApiCall<T> (hooks/useApi.ts)
  泛型 fetch 封装 + 并发相同 GET 合并
```

### ChatWorkspace 多 Tab 架构

```
ChatWorkspace (pages/ChatWorkspace.tsx)
  │
  ├─ TaskTab = { id: "alias::taskId", agentAlias, taskId }
  │   taskId === '__default__' → 稳定 per-agent 会话
  │
  ├─ 持久化: localStorage → 'zeroclaw-chat-workspace-v2'
  │   v1→v2 自动迁移
  │
  ├─ 布局: tabs | split (双栏)
  │
  └─ 多 Tab 并发模型（关键设计）
      每个 tab = 独立 <AgentProvider key={tab.id}>
      所有 tab 始终挂载 (CSS hidden 隐藏非活跃 tab)
      → 后台 tab 持续流式接收，不中断
      → 关闭 tab 才卸载
      状态上行: onStatusFor → statusRef → TabIndicator (脉冲点/未读数)
```

### WebSocketClient（`lib/ws.ts`）

```
WebSocketClient
  ├─ connect()
  │   ws://host/ws/chat?token=&session_id=&agent=
  │   subprotocols: ['zeroclaw.v1', 'bearer.<token>']
  │
  ├─ onMessage → handleWsMessage → reduceTurnFrame
  ├─ sendMessage / sendApprovalResponse
  ├─ 自动重连 (指数退避 1s→30s)
  └─ disconnect() (不自动重连)

Session 管理:
  ├─ getOrCreateSessionId(agentAlias)  → localStorage UUID
  └─ createTaskSessionId / resolveTaskSessionId → per-task UUID
```

### 消息帧类型（`types/api.ts:251`）

14 种 WS 帧：`chunk | thinking | tool_call | tool_result | done | approval_request | history_trimmed | aborted | ...`

### API 客户端（`lib/api.ts`）

```
apiFetch
  ├─ Authorization: Bearer <token>
  ├─ 并发相同 GET 合并 (inFlightGets Map)
  ├─ 401 → 清除 token + dispatch 'zeroclaw-unauthorized'
  └─ 结构化 ApiError 解析
```

---

## 十四、跨切面设计模式

### Decorator Pattern（一层 trait，多层包装）

三个核心子系统遵循同一模式：

| 子系统 | Trait | 包装器 |
|--------|-------|--------|
| Provider | `ModelProvider` | Reliable → Router → Dispatch |
| Tool | `Tool` | Policy → Approval → MCP Wrapper |
| MCP Transport | `McpTransportConn` | Stdio / Http / Sse |

### 集中化组装 = 可审计安全

- Provider：`create_model_provider_inner` 唯一入口
- Tool：`ScopedToolRegistry::assemble` 唯一门控
- Config：`config_write_lock` 串行所有写入

### 非交互安全一等公民

- ApprovalManager 区分 Interactive / NonInteractive 两种模式
- channel 驱动的会话默认拒绝审批操作
- 并行执行安全门：批次中任一工具需审批 → 降级串行

### 事件总线单播

`event_tx` (tokio broadcast) 单通道喂给 WS chat + SSE + 内部监听器，订阅者自己过滤。WS 订阅者按 session 过滤 + 丢弃遥测帧。
