# ZeroClaw 数智助理 — 变更记录

## 用途

记录每处代码改动，用于后续合并上游版本。

## 格式

```
### <序号> <标签> <简短标题>

- **文件:** `<crate>/src/path.rs`
- **位置:** 函数/行号
- **说明:** 改了什么、为什么
- **关联测试:**
- **上游合并注意:**
```

## 标签

| 标签 | 含义 |
|------|------|
| `[隔离]` | 核心隔离逻辑，合并冲突需仔细处理 |
| `[接线]` | user_id 参数传递 |
| `[DB]` | 数据库 schema 变更 |
| `[路径]` | 目录结构变更 |
| `[配置]` | 内网适配 / trusted_proxy 配置 |

---

## 第 1 步：可信上游担保 Principal

### 1-1 `[配置]` gateway.trusted_proxy + secret

- **文件:** `crates/zeroclaw-config/src/schema.rs`
- **位置:** `GatewayConfig`、`Config::validate`
- **说明:** `trusted_proxy = true` 时必须配置 `trusted_proxy_secret`（可用 `ZEROCLAW_gateway__trusted_proxy_secret`），否则启动校验失败关闭。pairing 运维面保留。
- **关联测试:** `tests/component/config_schema.rs::trusted_proxy_without_secret_fails_validation`
- **上游合并注意:** 上游若给 `GatewayConfig` 加字段，保留这两个键和 validate 分支

### 1-2 `[隔离]` UserAttrs + task-local

- **文件:** `crates/zeroclaw-api/src/user_attrs.rs`、`crates/zeroclaw-api/src/lib.rs`
- **位置:** `TOOL_LOOP_USER_ATTRS`、`mcp_identity()`、`strip_identity_args`
- **说明:** 连接冻住 `UserAttrs`。`None` = 从未 scope（pairing 透传）；`Some(None)` = 已 scope 但空 → 失败关闭；`Some(Some(attrs))` = 冻结身份。角色常量：`普通用户` / `高级用户` / `运维`。
- **关联测试:** `zeroclaw-api` `user_attrs::tests`
- **上游合并注意:** 新文件；上游改 `lib.rs` 导出时勿丢掉 `TOOL_LOOP_USER_ATTRS`

### 1-3 `[隔离]` require_trusted_proxy / require_user_principal / require_ops_auth

- **文件:** `crates/zeroclaw-gateway/src/trusted_proxy.rs`（新文件）
- **位置:** 全文件
- **说明:** 用户面走 BFF 头 `X-Auth-Secret` + `X-User-Id`（可选 Role/Region/Org）。**不**改现有 `require_auth()` pairing。身份头按 UTF-8 字节解码（`HeaderValue::to_str()` 会丢掉中文角色/地区）。
- **关联测试:** `trusted_proxy::tests`
- **上游合并注意:** 新文件不冲突

### 1-4 `[隔离]` WS 忽略 query user_id，身份冻在连接上

- **文件:** `crates/zeroclaw-gateway/src/ws.rs`
- **位置:** `handle_ws_chat`、`handle_socket`、每 turn `scope_user_attrs`
- **说明:** trusted_proxy 开则只信 BFF 头；query `user_id` 显式忽略。UserAttrs 挂在 socket，每个 turn 再 scope 到 task-local。
- **关联测试:** `ws_rejects_missing_secret_when_trusted_proxy`、`ws_rejects_query_user_id_without_identity_header`
- **上游合并注意:** 上游改 WS 握手时保留 BFF 分支

### 1-5 `[接线]` 运维面 Config/Logs/组织 Skill 走 require_ops_auth

- **文件:** `api_config.rs` / `api_logs.rs` / `api_skills.rs`
- **说明:** `require_auth` 别名为 `require_ops_auth`：有 BFF secret 则必须 `X-User-Role: 运维`；否则仍 pairing。
- **关联测试:** `trusted_proxy::tests::normal_user_cannot_hit_ops`
- **上游合并注意:** 上游新增运维 handler 应同样走 ops 入口

---

## 第 2 步：会话隔离

### 2-1 `[DB]` session_metadata 加 user_id

- **文件:** `crates/zeroclaw-infra/src/session_sqlite.rs`
- **说明:** `user_id TEXT` 迁移 + `idx_session_metadata_user_id`。未改 4 个 required trait 签名，用默认方法 `set_session_user_id` / `list_sessions_for_user`。
- **关联测试:** `zeroclaw-infra` session + `proof_session_routing_columns`
- **上游合并注意:** **[中冲突]** 上游可能给 metadata 加列；保留 user_id 与索引。方案原文曾要求改 required 签名，落地改为默认方法以降低侵入

### 2-2 `[隔离]` JSONL sidecar user_id

- **文件:** `crates/zeroclaw-infra/src/session_store.rs`
- **说明:** sidecar `{key}.user_id`；list/load 按主人过滤
- **关联测试:** infra session 测试
- **上游合并注意:** 上游改 JSONL 布局时保留 sidecar

### 2-3 `[隔离]` 用户面会话 API 按冻结身份过滤

- **文件:** `crates/zeroclaw-gateway/src/api.rs`
- **位置:** `require_session_access`、`handle_api_sessions_list` 等
- **说明:** 走 `require_user_principal`；非主人 404；列表 `list_sessions_for_user`
- **关联测试:** `session_list_only_returns_frozen_user`、`user_cannot_delete_another_users_session`、`user_cannot_read_another_users_session`
- **上游合并注意:** 上游新增会话 API 必须调 `require_session_access`

---

## 第 3 步：目录隔离

### 3-1 `[路径]` Config::user_workspace_dir

- **文件:** `crates/zeroclaw-config/src/schema.rs`
- **说明:** `<install>/users/<user_id>/agents/<alias>/workspace/`
- **关联测试:** `user_workspace_dir_is_under_install_users`
- **上游合并注意:** 上游新增 `_dir` 方法时勿覆盖此函数

### 3-2 `[路径]` WS session cwd 由服务端计算

- **文件:** `crates/zeroclaw-gateway/src/ws.rs`
- **位置:** `resolve_ws_session_cwd`
- **说明:** 默认用户目录，拒绝前缀外 cwd，创建 `skills/`
- **关联测试:** ws cwd 回归测试
- **上游合并注意:** 不要再接受客户端任意 cwd 当用户根

---

## 第 4 步：记忆隔离

### 4-1 `[隔离]` TenantScopedMemory

- **文件:** `crates/zeroclaw-memory/src/tenant_scoped.rs`（新文件）
- **说明:** 每调用读 `TOOL_LOOP_USER_ATTRS`，不把 tenant bake 进 agent 单例
- **关联测试:** `zeroclaw-memory` `tenant_scoped::tests`
- **上游合并注意:** 新文件。上游改 Memory trait 时更新 wrapper

### 4-2 `[DB]` idx_memories_tenant

- **文件:** `crates/zeroclaw-memory/src/sqlite.rs`
- **说明:** `CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id)`
- **上游合并注意:** 低风险。unique 仍是 `(agent_id, key)`，跨用户同 key 会互相覆盖（已知限制）

### 4-3 `[接线]` create_memory_for_agent 外包一层

- **文件:** `crates/zeroclaw-memory/src/lib.rs`
- **说明:** SQL 路径在 `AgentScopedMemory` 外再包 `TenantScopedMemory`
- **上游合并注意:** 上游改 factory 时保留外包

---

## 第 5 步：MCP 传输层盖章

### 5-1 `[隔离]` 剥离模型身份 args + 缺身份失败关闭

- **文件:** `crates/zeroclaw-tools/src/mcp_tool.rs`
- **说明:** `strip_identity_args`；`mcp_identity()` 失败则不发调用
- **关联测试:** `execute_fails_closed_when_user_attrs_scoped_empty`
- **上游合并注意:** 不要把身份写回模型可见 args

### 5-2 `[接线]` HTTP/SSE 出站头

- **文件:** `crates/zeroclaw-tools/src/mcp_transport.rs`
- **位置:** `apply_frozen_user_headers`
- **说明:** `X-User-Id` / `X-User-Role` / `X-User-Region` / `X-User-Org`
- **关联测试:** `frozen_user_headers_stamp_utf8_identity`、`frozen_user_headers_fail_closed_when_scoped_empty`
- **上游合并注意:** 上游改 HTTP 出站时调用此函数

### 5-3 `[接线]` stdio JSON-RPC `_zeroclaw_user`

- **文件:** `crates/zeroclaw-tools/src/mcp_client.rs`
- **位置:** `call_tool` params（与 `arguments` 并列）
- **说明:** 不进会话历史可见 args
- **上游合并注意:** 不要把该字段 merge 进 arguments

---

## 第 6 步：Python/R（现有 shell）

### 6-1 `[路径]` 不新增专用工具

- **说明:** 模型走现有 `shell`；cwd = 用户 workspace；`allowed_commands` 含 `python3` / `Rscript` 由部署配置。无 `python_execute` / `r_execute`。
- **关联测试:** `shell_python3_runs_in_user_cwd`、`shell_python3_writes_stay_in_user_cwd`、`shell_rscript_runs_in_user_cwd`（无 Rscript 则 skip）
- **上游合并注意:** 不要为隔离再加专用解释器工具

---

## 第 7 步：内网适配

纯配置，无代码。`open_skills_enabled` 默认已是 false。Provider 走 OpenAI 兼容 `base_url`。

---

## 第 8 步：个人技能

### 8-1 `[隔离]` 加载用户 skills/，组织同名优先

- **文件:** `crates/zeroclaw-runtime/src/skills/mod.rs`
- **位置:** `append_user_skills`（`allow_scripts=false`）
- **关联测试:** `user_skill_loaded_only_for_owner`、`org_skill_wins_on_name_collision_with_user_skill`、`user_skill_scripts_not_auto_enabled`
- **上游合并注意:** 上游改 skill 加载顺序时，用户目录必须在组织/bundle 之后

### 8-2 `[隔离]` POST /api/user/skills 仅高级用户

- **文件:** `crates/zeroclaw-gateway/src/api_skills.rs`、`lib.rs` 路由
- **说明:** 写入用户目录；禁止走 `POST /api/skills` 写组织技能
- **关联测试:** `save_personal_skill_requires_advanced_user`
- **上游合并注意:** 新路由；组织 Skill 写入仍仅运维

---

## 第 9 步：Web 原型约束

### 9-1 `[隔离]` session_id 禁止拼 user_id

- **文件:** `web/src/lib/ws.ts`、`web/src/lib/ws.session.test.ts`
- **说明:** `getOrCreateSessionId` 只生成 UUID。隔离靠 BFF 冻结身份，不靠前端拼 `{user_id}:...`
- **关联测试:** `npm test` 含 `ws.session.test.ts`
- **上游合并注意:** 三栏工作台是原型；产品落点在平台路由
