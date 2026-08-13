# ZeroClaw 数智助理 — 多用户隔离改造风险评估

## 场景

- Fork 独立维护，不期望合入上游
- 嵌入现有 Web 平台，用户身份从平台透传（不做自有账户体系）
- <50 人，内网部署，SQLite
- 大模型：内网 DeepSeek/Qwen（OpenAI 兼容协议）
- 数据获取：主要通过 MCP
- 数据分析：AI 自动生成执行 Python/R 脚本
- 新部署，无历史数据

## 风险逐一验证

### 1. 隔离正确性（风险等级：低/可控）

**会话层 — 编译器兜底。** `SessionBackend` trait（`session_backend.rs:70`）4 个 required 方法，2 个生产 impl。加 `user_id: &str` 参数 → 编译器强制所有 impl 和 ~150-200 调用点更新。不传 = 编译不过。

**记忆层 — 架构兜底。** 仿 `AgentScopedMemory`（`agent_scoped.rs:9`）写 `TenantScopedMemory` wrapper，唯一入口强制注入 tenant 过滤。绕过需要刻意构造裸 backend，不是 bug 是蓄意。

**目录层 — 路径兜底。** `user_workspace_dir(user_id, alias)` 替代 `agent_workspace_dir(alias)`，workspace 隔离后 skills/、JSONL sessions 自动隔离。

**三重保障：**

| 层 | 机制 | 性质 |
|----|------|------|
| 会话 | trait required 方法签名含 `user_id` | 编译期杜绝遗漏 |
| 记忆 | `TenantScopedMemory` wrapper 为唯一入口 | 架构层杜绝绕过 |
| 端到端 | 跨用户隔离集成测试 | 运行时验证 |

### 2. MCP 用户上下文（风险等级：中 — 取决于 MCP 服务端需求）

**现状：** `McpRegistry::call_tool()`（`mcp_client.rs:1157`）不传 `user_id`、`session_key`、`agent_alias` 任何身份。

| 场景 | 风险 |
|------|------|
| 所有用户访问同样的内网数据 | **无风险** — 全局 registry 共享即可 |
| 不同用户应看到不同的数据 | **需改造** — MCP 调用链加 `user_id`，MCP 服务端需感知 |
| 需要审计"谁通过 MCP 查了什么" | **需改造** — 调用链加身份 |

如需要改造，改动路径短：

```
McpToolWrapper::execute → McpRegistry::call_tool → McpServer::call_tool
                                                → HTTP header / args 传给服务端
```

### 3. 透传认证安全性（风险等级：低）

**模型：** 上游平台传入 `user_id`，ZeroClaw 不验证真伪。

**缓解：**
- 内网部署，网络层面可控
- 可加一个共享 secret header（`X-Auth-Secret`）验证请求来自可信上游
- user_id 只用于隔离，不影响系统安全策略

### 4. Python/R 脚本执行安全（风险等级：中）

**风险：** AI 自动生成的脚本可能包含恶意代码、访问其他用户的文件。

**缓解：**
- 复用 ZeroClaw 现有沙箱机制（`RiskProfileConfig.workspace_only`、`forbidden_paths`、`allowed_commands`）
- 脚本执行目录限定在用户 workspace 内
- 超时限制、输出截断
- 脚本使用临时文件，用户隔离

### 5. 内网环境限制（风险等级：低）

**需关闭/禁用的功能：**
- `open_skills`（默认关闭，依赖 GitHub）
- `web_search` / `web_fetch`（无法连互联网）
- 如需替代 → 对接内网知识库或 MCP

### 6. 上游合并冲突（Fork 后可控）

- 核心改动集中在：`SessionBackend` trait 签名、`TenantScopedMemory` 新文件、`user_workspace_dir` 路径函数
- 改动边界清晰，冲突范围可预期
- 合并后跑全套隔离测试即可验证

---

## 风险等级总览

| 风险 | 等级 | 说明 |
|------|------|------|
| 隔离正确性 | **低/可控** | 编译期 + wrapper + 测试三重保障 |
| MCP 用户上下文 | **看需求** | 如 MCP 不需要用户级数据隔离则无风险 |
| 透传认证安全 | **低** | 内网 + 可选共享 secret |
| Python/R 脚本安全 | **中** | 依赖沙箱配置，需测试覆盖 |
| 内网限制 | **低** | 关掉几个 feature 即可 |
| 上游合并 | **低** | 边界清晰 |

## 不存在的风险（相比通用多用户方案）

| 原风险 | 为何不存在 |
|--------|-----------|
| 用户账户体系 | 不做，上游平台负责 |
| 数据迁移（旧数据） | 新部署 |
| 安全模型重构（per-user 权限） | 全局 risk_profile 共享 |
| 会话并发 | SQLite WAL + <50 人 |
| 设计哲学冲突 | Fork 独立维护 |
