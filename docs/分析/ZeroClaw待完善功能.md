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

## 多用户隔离（嵌入场景，已落地）

身份来自平台 BFF 头 + `X-Auth-Secret`，冻在连接上；**禁止** query / body / 模型 args 自报身份，**禁止** 前端拼 `{user_id}:...` 进 `session_id`（`session_id` 为 UUID）。细则见 `ZeroClaw多用户隔离实施方案.md`。

### 会话列表按用户过滤 — 已完成

- `SessionMetadata.user_id`；SQLite `sessions.user_id` 列 + 索引；JSONL sidecar。
- 用户面 `GET /api/sessions` 按冻结身份过滤，非主人 404。
- trait 用默认方法 `set_session_user_id` / `list_sessions_for_user`，未改 4 个 required 签名。生产 SQLite / JSONL 已覆盖。

### 工作区按用户隔离 — 已完成（按用户，不按会话子目录）

- 服务端计算 `users/<user_id>/agents/<alias>/workspace/`，拒绝前缀外 cwd。
- 前端 **不** 传 `cwd` / 不拼 user_id。旧方案「`workspace/sessions/<session_key>/` + 前端传入 cwd」已作废。

### 记忆按用户隔离 — SQLite 已完成

- `TenantScopedMemory` 每调用读 `TOOL_LOOP_USER_ATTRS`；列 `tenant_id`；unique 为 `(agent_id, ifnull(tenant_id,''), key)`。
- 同 agent 同 key 跨用户各写一行；get / forget 只动当前用户。
- **已知限制：** Markdown 记忆工厂未包 wrapper（需求指定 SQLite，默认路径不触发）。

### 安全策略按用户区分 — 不做

- `risk_profiles` 仍是全局 / per-agent。嵌入方案明确不做 per-user 安全策略覆盖。

---

> 记录日期：2026-08-08，更新于 2026-08-14
