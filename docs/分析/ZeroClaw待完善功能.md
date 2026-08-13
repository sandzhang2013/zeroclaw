# ZeroClaw 待完善功能

## 前端交互

### HTML / 富内容预览
- **现状**：ZeroClaw 对话中生成的 HTML 文件仅展示为源码，不支持内嵌渲染预览。
- **对比**：Claude Code 的 Artifact 功能可在对话流中直接渲染 HTML/React/SVG 等内容。
- **影响**：用户需手动将生成的 HTML 文件用浏览器打开才能看到渲染效果，体验割裂。

---

## 权限模型

### Plan（先规划后动手）模式缺失

- **现状**：ZeroClaw 权限模型仅三层 — `ReadOnly` / `Supervised` / `Full`。`Supervised` 是工具级审批（每次工具调用弹窗），而非方案级审批。
- **对比**：Claude Code 有三种工作模式：
  - **Ask**（只聊不动）→ ZeroClaw `ReadOnly` ✅
  - **Craft**（你说我做）→ ZeroClaw `Full` ✅
  - **Plan**（先规划后动手）→ ZeroClaw **无对应** ❌
- **关键差异**：
  | | Claude Code Plan | ZeroClaw Supervised |
  |--|------------------|---------------------|
  | 审批粒度 | 方案级别 — 确认方案后一次执行 | 工具级别 — 每次工具调用都弹窗 |
  | 用户体验 | 先 Review 计划 → 点确认 → 自动执行 | 不停弹窗 → 用户疲于审批 |
- **上游追踪**：GitHub issue 中暂未发现 Plan mode 相关议题（open/closed 均无）。

---

## 多用户隔离

### 会话列表按用户过滤

- **现状**：`GET /api/sessions` 返回所有可归属的会话（按 `agent_alias` 或 `channel_id` 过滤孤儿行），不做用户级过滤。`SessionMetadata`（`crates/zeroclaw-infra/src/session_backend.rs`）没有 `user_id` 字段。
- **已有基础**：
  - `Principal`（`crates/zeroclaw-api/src/principal.rs`）已定义完整的用户身份模型：`user_id`、`roles`、`scopes`、`auth_method`、`allowed_aliases`。
  - 外部打开 ZeroClaw 时会传入用户 ID 和用户信息（通过 OIDC/SSH Key/Peercred 等方式认证，产生 `Principal`）。
  - 前端 `Web前端多任务面板设计.md` 已规划 session_id 编码方案：`{user_id}:{agent_alias}:{task_id}:{uuid}`。
- **待改**：
  - `SessionMetadata` 加 `user_id: Option<String>` 字段
  - `session_sqlite.rs` 的 sessions 表加 `user_id` 列 + 索引
  - WS 握手时从 `Principal.user_id` 提取并写入 session
  - `GET /api/sessions` 按当前用户的 `user_id` 过滤
  - 前端 `Session` 类型（`web/src/types/api.ts`）加 `user_id` 字段

### 会话产物（Workspace）按会话隔离

- **现状**：同一 Agent 的所有会话共享同一个 workspace 目录（`agents/<alias>/workspace/`）。`GET /ws/chat` 支持通过 `cwd`/`workspace_dir` 参数覆盖，但前端未使用。
- **目标**：每个会话只看到自己相关的文件产物。
- **方案**：
  - `resolve_ws_session_cwd()` 接受 session-scoped 路径，当 session 非默认任务时自动派生子目录，如 `agents/<alias>/workspace/sessions/<sanitized_session_key>/`
  - 前端 `ChatWorkspace` 的 task 标签页在创建 WebSocket 时传入对应的 `cwd`
  - `AgentWorkspaceExplorer`（文件浏览器）按会话 cwd 展示，而非固定展示 agent workspace 根目录

### 记忆（Memory）按用户隔离

- **现状**：所有会话、所有配对设备共享同一 Agent 的记忆（SQLite `brain.db`、向量检索）。
- **待改**：
  - `memory` 表加 `user_id` 列
  - 所有 recall/store/consolidation 查询加 `WHERE user_id = ?`
  - 向量检索按 `user_id` 过滤
  - `AgentWorkspaceConfig.read_memory_from`（跨 Agent 记忆读取）需加来源用户校验

### 安全策略按用户区分

- **现状**：`risk_profiles` 是全局定义，`allowed_commands`、`forbidden_paths`、自主级别等是 per-agent 的。
- **待改**：多用户场景下需决定安全策略维度 — `risk_profile` 是管理员统一定义还是允许用户自定义？哪些配置可下放给用户？

---

> 记录日期：2026-08-08，更新于 2026-08-10
