# ZeroClaw 数智助理 — 多用户隔离实施方案

## 原则

**测试先行：** 先写测试 → 测试失败 → 写实现 → 测试通过。测试即规格。

**透传身份，但必须担保：** 不做账户体系，用户登录仍由上游平台负责。ZeroClaw 不管理账号，但 **必须确认 `user_id` 来自可信上游，而不是连接方自报**。隔离过滤的是已担保的身份，不是 URL 里的字符串。

**最小侵入：** 优先改动面小的方案（TenantScopedMemory wrapper 而非改 22 个 impl）。

**变更可追溯：** 所有改动记录在变更记录文档中。

---

## 身份模型（第 1 步的合同）

过滤 ≠ 认证。`WHERE user_id = 'alice'` 只能保证「按这个字符串分柜子」，不能保证「连接方就是 Alice」。

```
浏览器（已登录）
  → 平台 BFF（知道当前用户是谁，浏览器不直连 ZeroClaw）
  → WS/HTTP：X-User-Id + X-Auth-Secret（可选 X-User-Role / Region / Org）
  → ZeroClaw 校验 secret
  → 把 UserAttrs 冻在这条连接上（连接期内只读）
  → 会话 / 目录 / 记忆 / MCP 只从这份冻结身份派生
```

| 做法 | 是否允许 |
|------|----------|
| BFF 带共享 secret 传入 `X-User-Id` | 允许，这是唯一真源 |
| `?user_id=alice` 或 body 里的 user_id | **拒绝**（可被伪造，会进日志） |
| 浏览器直连 ZeroClaw 自报身份 | **拒绝** |
| 从模型 tool args / 对话内容解析身份 | **拒绝** |
| 把 user_id/region 写进模型可见的 tool args | **拒绝**（会进会话历史，下一轮可被伪造） |
| 工具或 MCP 回写身份 | **拒绝** |

`user_id` 规范化后才能进路径和 session_key：拒绝空串、`../`、斜杠、控制字符。

**角色约定（与需求一致）：** `X-User-Role` 为 `普通用户` | `高级用户` | `运维`。运维是全平台一个，不是按地区的管理员。新增个人技能仅高级用户；组织 Skill 与 Config/Logs 仅运维。

现有 `Principal` 没有 `source: Platform`。使用：

```rust
Principal::new(user_id, user_id, AuthMethod::Native)
    .with_roles(roles)
```

（若要审计上区分 pairing 与 BFF，可后续给 `AuthMethod` 加 `TrustedProxy` 变体；第一期用 `Native` 即可。）

---

## 第 1 步：可信上游担保 Principal

### 先写测试

**文件：** `tests/system/multi_user_principal.rs`

```
test_ws_rejects_missing_secret
  前置: trusted_proxy 已开，只有 X-User-Id: alice，无 secret
  断言: 401，不建立连接

test_ws_rejects_wrong_secret
  前置: X-User-Id: alice + 错误 X-Auth-Secret
  断言: 401

test_ws_rejects_query_user_id_even_with_secret
  前置: ?user_id=alice，secret 正确，但没有 X-User-Id 头
  断言: 401。query 不得作为身份来源

test_ws_rejects_empty_or_unsafe_user_id
  前置: secret 正确，X-User-Id 为空 / 含 ../ / 含斜杠
  断言: 400

test_ws_accepts_bff_headers
  前置: X-User-Id: alice + 正确 X-Auth-Secret
  断言: 连接上的 Principal.user_id = "alice"

test_principal_frozen_on_connection
  前置: 以 alice 建连后，后续消息试图改身份
  断言: 仍是 alice；task-local 不被模型或工具改写

test_http_session_api_requires_same_secret
  前置: GET /api/sessions 无 secret 或错 secret
  断言: 401。用户面 API 与 WS 同一套担保
```

### 然后实现

**配置（trusted_proxy 模式，不拆掉 pairing）：**

```toml
[gateway]
# 业务聊天走 BFF；运维 Dashboard 仍可用 pairing
trusted_proxy = true
# 建议用环境变量注入，不要把明文写进仓库
# trusted_proxy_secret 从 ZEROCLAW_TRUSTED_PROXY_SECRET 读取
```

- `trusted_proxy = true` 时：`/ws/chat` 以及用户会话相关 API **不走 pairing bearer**，改为校验 `X-Auth-Secret` 常量时间比较，再读身份头。
- 运维面（Config / Logs / Doctor / Pairing）继续 pairing，不对终端用户开放。
- secret 未配置却打开了 `trusted_proxy` → 启动失败（失败关闭）。

**`handle_ws_chat`（`crates/zeroclaw-gateway/src/ws.rs`）：**

1. 从 header 读 `X-Auth-Secret`、`X-User-Id`（可选 `X-User-Role` / `X-User-Region` / `X-User-Org`）。
2. secret 校验失败 → 401。缺少或非法 `X-User-Id` → 400/401。
3. **忽略** query / body 中的 `user_id`。
4. 构造 `Principal` + `UserAttrs`，挂到 WS session（连接级存储，不是只 scope 一次 task-local）。
5. 每个 turn 从 session 上的 `UserAttrs` 再 `scope` 到 `TOOL_LOOP_USER_ATTRS`。Tokio task-local 跟的是 turn 所在 task，连接时 scope 一次会在后续 spawn 中丢失。

**用户面 HTTP（会话列表等）：**

新增 `require_trusted_proxy(headers) -> Result<Principal, ...>`，与 WS 同一套头。  
**不要**把现有 `require_auth()` 改成返回 Principal：那个函数仍负责 pairing。两套入口并存。

**RPC：** 第一期嵌入场景以 Gateway WS 为主。zerocode RPC 若未走 BFF，保持原样，不把未担保的 `user_id` 打进隔离链。

### 改动文件

| 文件 | 改动 |
|------|------|
| `zeroclaw-config` schema | `[gateway] trusted_proxy` + secret（env） |
| `crates/zeroclaw-gateway/src/ws.rs` | BFF 头校验；Principal/UserAttrs 冻在 session；每 turn 再 scope |
| `crates/zeroclaw-gateway/src/api.rs` | 新增 `require_trusted_proxy`，会话类用户 API 改走它 |
| `crates/zeroclaw-api/src/lib.rs` | 新增 `TOOL_LOOP_USER_ATTRS` task-local |
| `crates/zeroclaw-runtime` agent loop | 每个 turn 从连接身份 scope task-local |

---

## 第 2 步：会话隔离

后续步骤使用的 `user_id` **只允许**来自第 1 步冻在连接上的 Principal，禁止从请求参数再读一遍。

### 先写测试

**文件：** `tests/system/multi_user_sessions.rs`

```
test_user_a_cannot_list_user_b_sessions
test_user_a_cannot_read_user_b_session
test_user_a_cannot_delete_user_b_session
test_session_created_stamps_user_id
test_session_search_scoped_to_user
```

### 然后实现

**数据库：** `session_metadata` 表加 `user_id TEXT NOT NULL` 列和索引。

**SessionBackend trait（`session_backend.rs`）：** 4 个 required 方法签名加 `user_id: &str`。

**SqliteSessionBackend（`session_sqlite.rs`）：** 所有读查询加 `WHERE user_id = ?`。

**SessionStore（`session_store.rs`）：** JSONL 路径或内容加 `user_id` 过滤。

**写路径：**
- WS 创建/绑定会话时，从连接上的 `Principal.user_id` stamp
- 网关用户面会话 API 从 `require_trusted_proxy` 得到的 Principal stamp

**保障：** 编译器强制（trait 签名），漏一个调用点 = 编译不过。

---

## 第 3 步：目录隔离

### 先写测试

**文件：** `tests/system/multi_user_workspace.rs`

```
test_different_users_have_different_workspace_dirs
test_user_workspace_contains_skills_subdir
test_shared_dir_unchanged
```

### 然后实现

`Config` 新增 `user_workspace_dir(user_id, agent_alias)`：

```
<install>/users/<user_id>/agents/<alias>/workspace/
```

`user_id` 必须是第 1 步已规范化、已担保的值。WS 的 session cwd 由服务端按该函数计算并校验前缀，**不接受客户端传入任意 cwd 作为用户根**。

说明：这只隔离文件/脚本沙箱。默认 SQLite 记忆和 sessions 在 `data_dir`，不会因为换目录而自动隔离；第 2、4 步仍需要。Agent 人设（`IDENTITY.md` / `SOUL.md`）可继续从共享的 agent workspace 读取。

---

## 第 4 步：记忆隔离

### 先写测试

**文件：** `tests/system/multi_user_memory.rs`（模板：`multi_agent_e2e.rs`）

```
test_user_a_recall_does_not_return_user_b_memories
test_user_a_get_does_not_return_user_b_entry
test_tenant_scoped_memory_rejects_foreign_writes
test_tenant_scoped_memory_filters_recall_by_tenant
```

### 然后实现

**方案：`TenantScopedMemory` wrapper**（仿 `AgentScopedMemory`）

不改 `Memory` trait 签名，新文件 `crates/zeroclaw-memory/src/tenant_scoped.rs`：
- 持有 `tenant_id`（= 连接上的 `user_id`）+ `allowed_tenant_ids`
- 写：拒绝 foreign tenant_id
- 读：自动注入 tenant 过滤

**SQLite：** 加 `CREATE INDEX idx_memories_tenant ON memories(tenant_id)`（列已存在）。

**接线：** 每个 WS 连接/turn 用已担保的 `user_id` 包一层 wrapper。不要在 `create_memory_for_agent` 里按 agent 单例包死（一个 agent 服务多个用户）。

---

## 第 5 步：MCP 按用户属性过滤数据（必做）

业务数据隔离发生在 **MCP 服务端**（例如 `WHERE region = '武汉'`）。ZeroClaw 不改 SQL，只把连接上已冻结的身份盖到 **传输层**。模型 args 不是身份来源，也不把身份写回给模型看的那份 args。

### 合同

```
连接已冻结: UserAttrs { user_id, role, region, org }   ← 例如 region=武汉
        │
        ├─ 内部：TOOL_LOOP_USER_ATTRS（只读 try_with）
        └─ MCP 传输层（模型看不见）
              HTTP: X-User-Id / X-User-Role / X-User-Region / X-User-Org
              stdio: JSON-RPC 内部字段 _zeroclaw_user（不回写会话历史）
        │
        ▼
MCP 服务端：无头 → 失败（禁止返回全国数据）
            有头 → WHERE region = '武汉' AND ...
```

模型若在 args 里写 `"region": "北京"`：丢掉，仍传连接上的「武汉」。

### 先写测试

**文件：** `tests/system/multi_user_mcp.rs`

```
test_mcp_http_sends_identity_headers_from_task_local
  前置: 连接冻住 user_id=alice, region=武汉
  断言: 出站 HTTP 含 X-User-Id: alice、X-User-Region: 武汉
        不含把这些字段写入即将记入历史的 tool args

test_mcp_stdio_sends_internal_user_field
  前置: 同上，stdio transport
  断言: JSON-RPC 带 _zeroclaw_user.region=武汉
        该字段不出现在返回给模型的 tool-call args 快照里

test_mcp_strips_model_supplied_identity_args
  前置: 模型 args 含 user_id=bob、region=北京
  断言: 发给 MCP 的头仍是 alice/武汉；历史里的 args 不含被采信的身份

test_mcp_call_without_task_local_fails_closed
  前置: 未 scope UserAttrs
  断言: 不发起「无身份」的 MCP 调用（错误返回，避免服务端看到空头后吐全量）
```

MCP 服务端自身的 `WHERE region = ?` 与缺头失败，由 MCP 仓库测；此处测 ZeroClaw 盖章行为。

### 然后实现（ZeroClaw）

**不改 `Tool` trait，不改 `call_prep` 往模型 args 里塞身份。**

1. `McpToolWrapper::execute` 从 `TOOL_LOOP_USER_ATTRS` 只读取出 `UserAttrs`。缺失 → 该 MCP 调用失败关闭。
2. 从即将发送的 `arguments` 中 **删除** 模型带来的身份键（`user_id`、`region`、`role`、`org`、`_zeroclaw_user` 等），再发给 MCP。会话历史只保留清洗后的业务 args。
3. `McpServer::call_tool` / HTTP transport：出站请求加
   - `X-User-Id`
   - `X-User-Role`
   - `X-User-Region`
   - `X-User-Org`
4. stdio transport：JSON-RPC `params` 增加 `_zeroclaw_user` 对象（与 `arguments` 并列或仅在 transport 信封上），**不要** 把它合并进会回写历史的 tool args。

### MCP 服务端（合同，不在本仓库实现）

数据权限在这里落地。以区域=武汉为例：

```
region = request.headers["X-User-Region"]   # 或 stdio 的 _zeroclaw_user.region
if region 为空: return error          # 失败关闭，禁止 SELECT 全国
rows = db.query("SELECT ... WHERE region = ?", region)
```

- 区域码与平台、库表约定死一种（`武汉` 或行政区划代码）。
- 总部/多地账号由平台发角色或约定哨兵值，MCP 按角色放宽；不让模型传城市列表。
- ZeroClaw 盖章正确但服务端不按头过滤，隔离无效。这是 MCP 服务的验收条件。

### 改动文件

| 文件 | 改动 |
|------|------|
| `crates/zeroclaw-tools` MCP HTTP/stdio 出站 | 加身份头 / `_zeroclaw_user`；缺 task-local 则失败 |
| MCP wrapper / call 路径 | 剥离模型 args 中的身份键，不写进历史 |
| 不改 | `Tool::execute` 签名、`call_prep` 对模型可见 args 的身份注入 |

---

## 第 6 步：Python/R 运行环境（现有 shell）

这是能力需求：模型生成的脚本必须能跑完。第一期 **不新增** `python_execute` / `r_execute`。专用工具以后可以加，只为传参/截断体验，**不增加隔离能力**。`allowed_commands` 只限制能否启动解释器，不管脚本里 `open()` / `os.system()`。

### 先写测试

**文件：** `tests/system/python_r_tool.rs`

```
test_shell_python3_runs_in_user_cwd
test_shell_rscript_runs_in_user_cwd
test_script_timeout_is_enforced
test_script_output_is_truncated
test_user_a_cannot_read_user_b_cwd_via_script
```

### 然后实现

1. 镜像/主机预装 `python3`、`Rscript` 及科学计算包；禁止运行时 pip/CRAN。
2. `allowed_commands` 含 `python3`、`Rscript`（不要把脚本内部当权限系统）。
3. session cwd = 第 3 步 `user_workspace_dir`；OS 沙箱（Landlock/Seatbelt/Docker）只允许碰该目录。
4. 走现有 `shell`；参考 `coding_cli_executor.rs` 的超时与输出截断。

数据从 MCP 按 region 过滤后再交给脚本；脚本不自己翻库、不改 region。

---

## 第 7 步：内网适配

### Provider 配置

```toml
[providers.models.openai.deepseek]
base_url = "http://deepseek.internal:8080/v1"
model = "deepseek-chat"
api_key = "not-needed"

[providers.models.openai.qwen]
base_url = "http://qwen.internal:8080/v1"
model = "qwen-max"
api_key = "not-needed"
```

走 `compatible.rs`（OpenAI 兼容），无需改代码。

### 关闭互联网功能

```toml
[skills]
open_skills_enabled = false

# 在 risk_profile 中排除：
excluded_tools = ["web_search", "web_fetch"]
```

---

## 第 8 步：个人技能沉淀

组织 Skill 仅 **运维**（全平台一个）可写入 agent / `shared/skills`。个人技能仅 **高级用户** 可写入自己的目录，只给自己的连接加载。  
普通用户可使用组织 Skill 和自己已有的个人技能，不能新增。角色来自连接上冻结的 `UserAttrs.roles`（不信请求体）。

路径（`user_id` 来自第 1 步已担保身份）：

```
<install>/users/<user_id>/agents/<alias>/workspace/skills/<name>/SKILL.md
```

### 先写测试

**文件：** `tests/system/multi_user_skills.rs`

```
test_user_skill_loaded_only_for_owner
  alice 目录下有 skills/flu-weekly/SKILL.md
  → alice 的 turn 能加载到 flu-weekly
  → bob 的 turn 加载不到

test_user_cannot_write_shared_skill_via_user_api
  以 alice 身份调用用户面「保存技能」
  → 文件出现在 users/alice/.../skills/
  → agents/default/workspace/skills/ 与 shared/skills/ 无新文件

test_org_skill_wins_on_name_collision
  组织与用户都有 name=flu-forecast
  → 生效的是组织那份；用户这份被跳过或改名提示

test_user_skill_scripts_not_auto_enabled
  用户 SKILL 声明 allow_scripts
  → 不按可执行 skill 加载（脚本仍只能当 cwd 里的普通文件用 shell 跑）

test_save_personal_skill_requires_advanced_user
  连接 roles 不含高级用户
  → 「保存为技能」失败，users/alice/.../skills/ 无新文件

test_save_org_skill_requires_ops_role
  非运维角色调用组织 Skill 写入
  → 403；shared/skills 与 agent workspace/skills 不变
```

### 然后实现

1. `load_skills_for_agent` 在现有组织/bundle 之后，若 turn 带 `UserAttrs`，再扫 `user_workspace_dir(user_id, alias)/skills/`（加载不要求新增角色）。
2. 「保存为技能」：冻结的 `roles` 必须含 **高级用户**；只写入用户 cwd。否则失败。**禁止** 走 `POST /api/skills`。
3. 组织 Skill 写入：仅 **运维**；BFF 拦截 + ZeroClaw 再校验。运维 Skills 页仍管组织 Skill（整机，不按地区裁剪）。

依赖第 3 步用户目录已经存在。

---

## 第 9 步：平台工作台（Web）

产品落点是 **现有平台两套路由**，不是把 ZeroClaw `web/` 整站发给用户。浏览器只连平台；BFF 代连 ZeroClaw。本地可先在本仓库 `web/` 做三栏原型，验证会话切换与结果区，但隔离仍走第 1 步冻结身份，**禁止** 前端拼 `{user_id}:...` 进 session_id。

### 两套页面

| 页面 | 谁能开 | 实现要点 |
|------|--------|----------|
| **工作台** | 所有登录用户 | 左侧边栏 + 中间对话区 + 右侧结果区 |
| **助手管理** | 仅全平台运维 | Config / 日志 / 组织 Skill；整机视图，不按地区裁剪 |

BFF 按角色 403；藏按钮不够。页面无登录、无配对码。

### 工作台布局

从左到右：

1. **左侧边栏**（上 → 下）：「新建会话」→「工作区」→ 各工作区/文件夹内的多条会话。工作区是界面分组，不是磁盘 workspace。
2. **中间对话区**：当前会话；流式 Markdown；工具卡片可折叠。高级用户「保存为技能」只写自己的 `skills/`。
3. **右侧结果区**：本会话产出（脚本输出、图表、生成文件）。

多任务靠左侧会话列表，不用 ZeroClaw Dashboard 顶部 Tab。列表只含当前用户会话（第 2 步过滤）。

### 先写测试

平台侧闸门（BFF 仓库）+ ZeroClaw 用户面 API：

```
test_non_ops_cannot_hit_config_logs
test_session_list_only_returns_frozen_user
test_frontend_cannot_select_other_user_by_session_id
```

本地 `web/` 原型不替代上述隔离测试。

### 然后实现

- 平台：工作台、助手管理两套路由；BFF 带头 + secret 代连。
- 本仓库可选：`ChatWorkspace` 三栏（左侧边栏 / 对话 / 结果），仅作体验原型。
- 不 iframe 整份 Dashboard；不把 Config/Logs/Doctor 编进用户前端包。

---

## 改动总览

| 步骤 | 模块 | 改动量 | 保障机制 |
|------|------|--------|----------|
| 1 | 可信上游担保 Principal | **中** | secret 校验 + 连接冻结 + 拒绝 query 身份；测试覆盖伪造 |
| 2 | 会话隔离 | **中偏小** | SQLite/JSONL 实现按主人过滤；trait 用默认方法，未改 required 签名 |
| 3 | 目录隔离 | **小** | 服务端计算用户 cwd 并校验前缀 |
| 4 | 记忆隔离 | **小** | 每连接 `TenantScopedMemory` + 隔离测试 |
| 5 | MCP 传输层盖身份章 | **中** | 头/内部字段 + 剥离模型身份 args + 缺身份失败关闭；数据 WHERE 在 MCP 服务端 |
| 6 | Python/R 运行环境 | **中** | 预装解释器 + 现有 shell + 用户 cwd/OS 沙箱；不新增专用工具当安全边界 |
| 7 | 内网适配 | **极小** | 纯配置 |
| 8 | 个人技能 | **中** | 用户 cwd `skills/`；新增仅高级用户；组织 Skill 仅全平台运维；同名组织优先 |
| 9 | 平台工作台 | **中** | 两套路由；三栏工作台；隔离不靠前端拼 user_id |

## 仓外（外部实现，本仓库不改）

| 事项 | 谁做 | 合同 |
|------|------|------|
| 平台 BFF 代连 | 现有 Web 平台 | 从登录态带头 `X-User-Id` / `Role` / `Region` / `Org` + `X-Auth-Secret`；浏览器不直连 ZeroClaw |
| 两套路由闸门 | 现有 Web 平台 | 工作台：所有登录用户；助手管理：仅运维。BFF 按角色 403 |
| 业务 MCP `WHERE` | 业务 MCP 服务 | 无 `X-User-Region` 失败关闭，禁止返回全国数据；有头则按地区过滤 |
| 内网镜像 | 部署 | DeepSeek/Qwen OpenAI compatible；预装 `python3` / `Rscript` 与科学计算包；禁止运行时 pip/CRAN |

## 本仓已知限制（嵌入场景可接受）

1. **Markdown 记忆工厂未包 `TenantScopedMemory`。** `create_memory_for_agent` 在 `backend = markdown` 时提前 return，读写的是 `agents/<alias>/workspace/`，不是用户目录。需求指定 SQLite，默认路径已隔离。若有人改成 markdown，同 agent 下用户会共享记忆文件。
2. **会话 trait 用默认方法，不是编译期强制。** `set_session_user_id` 默认空操作；`list_sessions_for_user` 默认事后过滤。生产 SQLite / JSONL 已覆盖。新建 `SessionBackend` 若漏实现，盖章会静默丢掉，合并时要人工盯。

## 不做的事

- 用户账户体系（上游平台负责登录/离职/角色）
- 把 query / body / 模型 args 当作 `user_id` 或 `region` 真源
- 把身份写进模型可见的 tool args（会进会话历史）
- 让模型在工具参数里选择区域来「看北京的数据」
- 浏览器直连 ZeroClaw 自报身份
- 为嵌入场景拆掉全部 pairing（运维面仍用 pairing）
- WebAuthn/OIDC（平台已做认证；ZeroClaw 只校验 BFF secret）
- `[users]` 配置段
- 前端登录页/用户管理
- per-user 安全策略覆盖（全局 risk_profile 共享）
- 让用户面调用 `POST /api/skills` 或写 `shared/skills`（会变成全员技能）
- 新增 `python_execute` / `r_execute` 当跨用户文件隔离
- 给终端用户打开 ZeroClaw Dashboard 整站，或 iframe 整份 `web/`
- 前端把 `user_id` 拼进 session_id 当隔离
- channels 集成
