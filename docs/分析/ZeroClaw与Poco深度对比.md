# ZeroClaw vs Poco 深度对比分析

> 分析日期：2026-08-08

---

## 一、整体架构对比

| 维度 | ZeroClaw | Poco (poco-claw) |
|------|----------|-------------------|
| 语言 | Rust | Python (FastAPI) × 3 服务 |
| 分发形态 | 单一二进制 (~12MB) | Docker Compose 多容器 |
| 前端 | React 19 + Vite | Next.js 16 + shadcn/ui |
| 数据库 | SQLite（内置） | PostgreSQL + Neo4j + S3 |
| 空闲内存 | ~4MB | ~180MB+ (含 Docker) |
| 冷启动 | <10ms | ~3s+ |
| 部署复杂度 | 单文件，零依赖 | 需 Docker + 3 服务 + DB |

**架构哲学差异：**

```
ZeroClaw: "一个二进制搞定一切"
  zeroclaw daemon → Gateway + Channels + Scheduler + Agent Runtime
  所有功能内嵌，SQLite 内置，无外部依赖

Poco: "微服务 + 容器隔离"
  backend (8000) + executor_manager (8001) + executor (container 8000)
  PostgreSQL + Neo4j + S3 + Docker daemon
```

---

## 二、数据流对比

### ZeroClaw

```
Channel / WS / REST / CLI
  → Gateway (AppState)
    → SessionQueue (per-session Semaphore)
      → Agent::from_live_config()
        → ToolLoop (调用 LLM → 解析 → 执行工具 → 追加历史)
          → WebSocket 实时推送 chunk/tool_call/tool_result/done
```

### Poco

```
Frontend HTTP POST
  → Next.js Proxy (app/api/v1/[...path]/route.ts)
    → Backend FastAPI (持久化到 Postgres)
      → ExecutorManager (pull claim 队列)
        → ContainerPool (Docker 启动沙箱容器)
          → Executor FastAPI (Claude Agent SDK)
            → HTTP Callback 逐条回传
              → ExecutorManager → Backend → 前端轮询
```

**关键差异：ZeroClaw 是同步内嵌循环 + WebSocket 推送，Poco 是异步 pull-claim 队列 + HTTP 回调 + 前端轮询。**

---

## 三、Agent 执行机制

| | ZeroClaw | Poco |
|--|----------|------|
| 执行引擎 | 自研 `ToolLoop` (Rust) | Claude Agent SDK (Python) |
| 工具系统 | 自研 `Tool` trait，~30+ 内置工具 | Claude SDK `allowed_tools` + MCP 注入 |
| 审批链 | `ApprovalManager` + `SecurityPolicy` | SDK `permission_mode` + `ToolPermissionHandler` |
| 循环上限 | `max_tool_iterations` (默认 10) | SDK 内置控制 |
| MCP 工具 | `McpToolWrapper` 适配为普通 Tool | 直接注入 SDK `mcp_servers` 列表 |
| 并行工具 | 支持（审批工具降级串行） | 依赖 SDK 实现 |

---

## 四、实时通信（核心差异）

| | ZeroClaw | Poco |
|--|----------|------|
| 协议 | **WebSocket** (`zeroclaw.v1`) + SSE | **HTTP 轮询**（无 WS，无 SSE） |
| 消息传输 | 服务端推送 14 种帧类型 | 前端 `useAdaptivePolling` 每 3-6s 拉取 |
| 流式文本 | WS `chunk` 帧实时推送 | Delta 接口 `?after_message_id=` 光标翻页 |
| 工具状态 | WS `tool_call`/`tool_result` 帧 | Delta 接口 + 单独 `getToolExecutionsDelta` |
| 断线恢复 | WS 自动重连 + 指数退避 | 轮询本身就是持续重试 |
| 效率 | 低延迟，事件驱动 | 3-6s 延迟，轮询浪费带宽 |

**这是两者最大的架构差异。ZeroClaw 是实时推送，Poco 是定时轮询。**

---

## 五、前端架构

| | ZeroClaw | Poco |
|--|----------|------|
| 框架 | React 19 + Vite 8 | Next.js 16.1 + React 19.2 |
| UI 库 | 自研组件 | shadcn/ui (Radix) + Tailwind v4 |
| 状态管理 | React Context + `turnStream.logic.ts` 纯 reducer | Context + 自定义 hooks + module 级缓存 |
| 路由 | React Router 7 (~20 页) | Next.js App Router，`/[lng]/` i18n 前缀 |
| 多 Session | ChatWorkspace 多 Tab（始终挂载） | 任务侧边栏 + URL 路由 `/chat/[id]` |
| 实时通信 | WebSocket `WebSocketClient` | HTTP 轮询 `useAdaptivePolling` |
| API 层 | `apiFetch` + `ws.ts` 直连 Gateway | `apiFetch` → Next.js Proxy → Backend |
| 消息状态 | `reduceTurnFrame` 纯 reducer | 乐观更新 + mutation token 回滚 |
| I18n | 无 | i18next (6 语言) |
| 协作层 | 无 | Servers/Channels/Kanban/Workspace |

---

## 六、安全模型

| | ZeroClaw | Poco |
|--|----------|------|
| 认证 | 设备配对（6 位码 + Bearer token） | OAuth (Google/GitHub/Feishu) + session cookie |
| 沙箱 | firejail/landlock/seatbelt (OS 级) | Docker 容器 |
| 命令控制 | shell 命令白名单 + 路径黑名单 | Claude SDK 内置权限 |
| 密钥保护 | ChaCha20-Poly1305 加密存储 | 环境变量注入容器 |
| 审批粒度 | ReadOnly / Supervised / Full | Claude SDK `permission_mode` |

---

## 七、权限模式（关键差异）

| | ZeroClaw | Poco |
|--|----------|------|
| Ask（只聊不动） | `ReadOnly` ✅ | SDK `permission_mode: "read-only"` ✅ |
| Craft（你说我做） | `Full` ✅ | SDK 默认 ✅ |
| **Plan（先规划后动手）** | ❌ **无** | ✅ **有！** `plan_mode` + `PlanApprovalCard` |
| 审批粒度 | 工具级别（每步弹窗） | 方案级别（确认方案后批量执行） |

**Poco 有 Plan 模式！** 后端在 `engine.py:117` 的 `ToolPermissionHandler` 中：plan 模式下只允许只读工具 + `AskUserQuestion`/`ExitPlanMode`，用户通过前端的 `PlanApprovalCard` 确认方案后，agent 才进入执行阶段。

---

## 八、协作能力

| | ZeroClaw | Poco |
|--|----------|------|
| 多用户 | 隔离改造 WIP（`Principal` 类型已定义未接线） | ✅ Servers/Channels 多人协作 |
| 频道内 Agent | 1:1（一个 agent 一个对话） | Server/Channel 内多 agent 协作 |
| 团队空间 | 无 | Workspace + Kanban Board |
| 任务管理 | session 列表 | Project + Task + 拖拽分配 |
| 会话分享 | 无 | ✅ `share/[token]` 分享链接 |
| 消息队中发送 | 不支持（agent 忙时拒绝） | ✅ `PendingMessageList` 排队发送 |

---

## 九、UI 体验

| | ZeroClaw | Poco |
|--|----------|------|
| 美观度 | 功能性，简洁 | shadcn/ui，现代美观 |
| 暗色模式 | ✅ | ✅ (next-themes) |
| I18n | ❌ | ✅ 6 语言 |
| 语音输入 | ❌ | ✅ react-speech-recognition |
| 会话导出 | ❌ | ✅ html-to-image |
| Markdown 渲染 | react-markdown | react-markdown + KaTeX + Mermaid |
| 画图 | ❌ | ✅ Excalidraw |
| 拖拽 | ❌ | ✅ dnd-kit |
| 移动端 | 响应式 | ✅ 移动端独立布局 |
| HTML 预览 | ❌ | ❌（两者都不支持 Artifact 级内嵌渲染） |

---

## 九点五、嵌入/iframe 支持

| | ZeroClaw | Poco |
|--|----------|------|
| iframe 阻止 | ❌ `X-Frame-Options: DENY` + `frame-ancestors 'none'` 硬编码 | ✅ 无阻止（无安全头限制） |
| CORS | `same-origin` 硬编码 | `cors_origins` 可配置 |
| 内嵌认证 | `?token=` WS 查询参数 | `X-Internal-Token` + `X-User-Id` 头<br>Bearer token (Authorization 头) |
| 外部传入用户身份 | `Principal` 类型已定义，WS 层未接线 | ✅ `X-User-Id` 头直接注入 `get_current_user_id` |
| 单用户模式 | `SharedOperator` 哨兵值（配对令牌） | ✅ `single_user_mode` 绕过认证 |
| 前端嵌入检测 | ❌ 无 `postMessage`/`window.parent` 逻辑 | ❌ 无 |
| 嵌入 UI 适配 | ❌ 无 | ❌ 无 |

**关键差异：** ZeroClaw 主动阻止（安全优先），需改安全头 + 前端；Poco 默认允许（集成优先），外部系统配好 `cors_origins` + 传 `X-Internal-Token` + `X-User-Id` 头即可嵌入使用。但两者都没有专门的嵌入 UI 模式（如去掉导航栏、`postMessage` 通信、自适应宿主尺寸等）。

### Poco 内部令牌认证细节

```python
# backend/app/core/deps.py
def get_current_user_id(
    # ① session cookie（OAuth 登录）— same_site=lax，跨域 iframe 不发送
    session_token = request.cookies.get(settings.auth_cookie_name)
    
    # ② Bearer token — Authorization 头，iframe 友好
    or _extract_bearer_token(authorization)
    
    # ③ 内部令牌 + 用户 ID — 外部系统直接传 HTTP 头，无需登录
    x_internal_token == settings.internal_api_token  →  trust x_user_id
    
    # ④ 单用户模式 — 完全绕过认证
    auth_service.is_single_user_mode_effective()
)
```

---

## 十、优劣势总结

### ZeroClaw 优势
- 🚀 **极致性能**：4MB 内存、<10ms 启动，可跑在 $10 单板机上
- 🔒 **安全第一**：Rust 内存安全、设备配对、密钥加密、OS 级沙箱
- 📦 **零依赖部署**：一个 12MB 二进制文件
- 🌐 **30+ 通道**：覆盖几乎所有消息平台
- ⚡ **WebSocket 实时**：低延迟事件推送
- 🦀 **Trait 体系**：Provider/Tool/Memory 全可替换

### ZeroClaw 劣势
- ❌ **无 Plan 模式**：只有工具级审批，缺方案级审批
- ❌ **无协作层**：单用户设计，无团队空间
- ❌ **不支持嵌入**：安全头硬编码阻止 iframe，无双层认证机制
- ❌ **UI 体验一般**：功能可用但不美观，无 i18n
- ❌ **无 HTML 预览**：生成的富内容无法内嵌渲染

### Poco 优势
- 🎨 **UI 精美**：shadcn/ui + Tailwind v4，移动端适配
- 📋 **Plan 模式**：先出方案 → 审核 → 执行
- 👥 **团队协作**：Servers/Channels/Kanban/Workspace
- 🔌 **Claude SDK 原生**：工具/权限/子 agent 开箱即用
- 🌍 **I18n**：6 语言支持
- 🔗 **嵌入就绪**：无 iframe 阻止，`X-Internal-Token` 模式天然支持外部集成

### Poco 劣势
- 🐌 **性能开销大**：3 服务 + PostgreSQL + Neo4j + Docker
- 📡 **HTTP 轮询**：3-6s 延迟，非实时
- 🐍 **Python 内存**：~180MB 起步
- 🔒 **安全面窄**：只有容器隔离 + 命令黑名单（8 条）
- 📦 **部署复杂**：需要 Docker Compose 全家桶

---

## 十一、ZeroClaw 可借鉴的改进方向

| 优先级 | 方向 | 来源 |
|--------|------|------|
| **P0** | **Plan 模式**：方案级审批，先规划后执行 | Poco 的 `plan_mode` + `PlanApprovalCard` |
| **P1** | **UI 升级**：现代组件库、暗色/亮色主题统一、移动端 | Poco 的 shadcn/ui 方案 |
| **P1** | **多任务排队**：agent 忙时消息不拒绝，排队等待 | Poco 的 `PendingMessageList` |
| **P2** | **会话分享**：生成分享链接 | Poco 的 `share/[token]` |
| **P2** | **协作基础**：多用户 session 隔离完善 | Poco 的 Server/Channel 模型 |
| **P3** | **I18n**：多语言支持 | Poco 的 i18next |
| **P3** | **富内容渲染**：Mermaid/KaTeX/Excalidraw | Poco 的图表能力 |
