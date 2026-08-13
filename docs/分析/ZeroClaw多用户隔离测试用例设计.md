# ZeroClaw 数智助理 — 测试用例设计

## 测试先行原则

每步：**先写测试 → 测试失败 → 写实现 → 测试通过。** 测试即规格。

角色约定（`X-User-Role`）：`普通用户` | `高级用户` | `运维`（全平台一个，非整机按地区裁剪）。

参考模板：
- Agent 隔离：`tests/system/multi_agent_e2e.rs`
- Session 列迁移：`crates/zeroclaw-infra/tests/proof_session_routing_columns.rs`
- AgentScopedMemory：`crates/zeroclaw-memory/src/agent_scoped.rs`
- Config 解析：`crates/zeroclaw-config/tests/nodes_mdns_config.rs`

除非注明，身份一律来自 BFF 头 + 正确 `X-Auth-Secret`，**不用** query `user_id`。

---

## 第 1 步：可信上游担保 Principal

**文件：** `tests/system/multi_user_principal.rs`

```
test_trusted_proxy_without_secret_refuses_to_start
  前置: trusted_proxy = true 且未配置 secret
  断言: 启动失败（失败关闭）

test_ws_rejects_missing_secret
  前置: 只有 X-User-Id: alice，无 X-Auth-Secret
  断言: 401，不建立连接

test_ws_rejects_wrong_secret
  前置: X-User-Id: alice + 错误 secret
  断言: 401

test_ws_rejects_query_user_id_even_with_secret
  前置: ?user_id=alice，secret 正确，无 X-User-Id 头
  断言: 401。query 不得作为身份来源

test_ws_ignores_query_user_id_when_header_present
  前置: 头 X-User-Id: alice，query user_id=bob，secret 正确
  断言: Principal.user_id = "alice"

test_ws_rejects_empty_or_unsafe_user_id
  前置: secret 正确，X-User-Id 为空 / 含 ../ / 含斜杠
  断言: 400

test_ws_accepts_bff_headers
  前置: X-User-Id: alice，X-User-Role: 普通用户，X-User-Region: 武汉，正确 secret
  断言: 连接上 user_id=alice，role=普通用户，region=武汉

test_principal_frozen_on_connection
  前置: 以 alice 建连后，后续消息或 tool args 试图改成 bob
  断言: 仍是 alice；TOOL_LOOP_USER_ATTRS 不被模型/工具改写

test_http_session_api_requires_same_secret
  前置: GET 用户面会话 API 无 secret 或错 secret
  断言: 401
```

---

## 第 1b 步：入口与角色闸门

**文件：** `tests/system/multi_user_gateway_surface.rs`

业务口走 trusted_proxy；Config/Logs/组织 Skill 仅运维。普通用户即使用户面 token 也不能打运维 API。

```
test_normal_user_cannot_get_config
  前置: 普通用户 + 正确 secret
  断言: GET /api/config（或等价运维配置口）→ 403

test_normal_user_cannot_get_logs
  前置: 同上
  断言: GET /api/logs → 403

test_ops_can_get_config
  前置: 运维 + 正确 secret（或约定的运维入口）
  断言: 配置口 200（整机视图，不按 region 过滤）

test_ops_sees_install_wide_sessions
  前置: alice、bob 各有会话；运维拉会话列表
  断言: 运维能看到全量（或运维专用列表）；普通用户列表仍只有自己的

test_advanced_user_cannot_get_config
  前置: 高级用户 + 正确 secret
  断言: Config/Logs 仍 403（高级用户只有保存个人技能，没有运维面）
```

---

## 第 2 步：会话隔离

**文件：** `tests/system/multi_user_sessions.rs`

`user_id` 只来自连接上的 Principal。

```
test_user_a_cannot_list_user_b_sessions
  alice 创建 2 个会话，bob 创建 1 个
  → 以 alice 列出 → 2 条，无 bob

test_user_a_cannot_read_user_b_session
  bob 的 session_key 用 alice 去读 → None / 404

test_user_a_cannot_delete_user_b_session
  alice 删 bob 的会话 → 失败，bob 的记录仍在

test_session_created_stamps_user_id
  alice 连接上发消息 → 元数据 user_id = "alice"

test_session_search_scoped_to_user
  双方会话都含 "hello" → alice 搜索只返回自己的

test_api_sessions_list_filtered_by_user
  GET 用户面 /api/sessions（alice 头）→ 只有 alice

test_api_cannot_access_other_user_session
  alice 调 bob 的 messages → 403/404

test_session_user_id_not_taken_from_query
  连接是 alice，请求带 session 或 query 声称 bob
  → 仍只操作 alice 的会话
```

---

## 第 3 步：目录隔离

**文件：** `tests/system/multi_user_workspace.rs`

```
test_different_users_have_different_workspace_dirs
  user_workspace_dir("alice","default") 含 users/alice
  user_workspace_dir("bob","default") 含 users/bob
  两者不等

test_user_workspace_contains_skills_subdir
  用户 workspace 下 skills/ 可创建

test_shared_dir_unchanged
  shared_workspace_dir() 仍是 <install>/shared

test_agent_identity_dir_unchanged
  agent_workspace_dir("default") 仍是 agents/default/workspace
  （人设不随用户目录搬家）

test_ws_computes_cwd_from_principal
  alice 连接、不传 cwd → session cwd = users/alice/.../workspace/

test_ws_rejects_client_cwd_outside_user_prefix
  alice 连接，cwd=/tmp 或 users/bob/...
  → 拒绝或强制拉回 alice 前缀，不得以客户端路径为根
```

---

## 第 4 步：记忆隔离

**文件：** `tests/system/multi_user_memory.rs`

模板：`multi_agent_e2e.rs`。wrapper 按 **连接** 包，不是 agent 工厂单例。

```
test_user_a_recall_does_not_return_user_b_memories
  alice store "alice data"，bob store "bob data"
  → alice recall "data" 只有 alice

test_user_a_get_does_not_return_user_b_entry
  bob 写入 → alice get(bob_key) → None

test_tenant_scoped_memory_rejects_foreign_writes
  alice 的 wrapper store_with_options(tenant_id="bob") → Err

test_tenant_scoped_memory_filters_recall_by_tenant
  同库两行不同 tenant → alice recall 只有自己

test_tenant_id_index_exists
  PRAGMA index_list('memories') 含 idx_memories_tenant

test_memory_wrapper_is_per_connection_not_agent_singleton
  同一 agent、alice 与 bob 两个 wrapper
  → 互不可见（禁止 create_memory_for_agent 包死一个 tenant）
```

---

## 第 5 步：MCP 传输层盖章（必做）

**文件：** `tests/system/multi_user_mcp.rs`

测 ZeroClaw 出站盖章，不测 MCP 服务端 SQL（那是 MCP 仓库合同）。

```
test_mcp_http_sends_identity_headers_from_task_local
  连接：user_id=alice，role=普通用户，region=武汉
  → HTTP 含 X-User-Id / X-User-Role / X-User-Region: 武汉
  → 这些字段不写入即将记入历史的 tool args

test_mcp_stdio_sends_internal_user_field
  同上，stdio
  → JSON-RPC 带 _zeroclaw_user.region=武汉
  → 该字段不出现在返回给模型的 args 快照

test_mcp_strips_model_supplied_identity_args
  模型 args 含 user_id=bob、region=北京
  → 出站头仍是 alice / 武汉
  → 历史 args 不含被采信的身份

test_mcp_call_without_task_local_fails_closed
  未 scope UserAttrs
  → 不发出无身份 MCP 调用

test_mcp_does_not_merge_identity_into_call_prep_args
  跑一轮带 MCP 的 turn
  → call_prep / 会话历史里的工具参数没有 user_id、region
```

**MCP 服务端合同（不在本仓库，验收清单）：**

```
test_mcp_server_filters_by_region_wuhan
  头 X-User-Region: 武汉 → 只返回武汉行

test_mcp_server_fails_closed_without_region
  无 X-User-Region → 错误，不得返回全国数据
```

---

## 第 6 步：Python/R 运行环境

**文件：** `tests/system/python_r_runtime.rs`

能力：脚本能跑。隔离：用户 cwd + OS 沙箱。  
`allowed_commands` 只测「能否启动 python3/Rscript」，**不要** 断言脚本里的 `os.system` 被它拦住。

环境无解释器时 skip（CI 镜像应预装）。

```
test_python_script_executes_and_returns_output
  用户 cwd 写入 print("hello") → shell python3 → 输出含 hello

test_r_script_executes_and_returns_output
  写入 print("hello") → Rscript → 输出含 hello

test_script_timeout_is_enforced
  无限循环 → 超时错误，不挂住

test_script_output_is_truncated
  大量输出 → 截断到上限

test_script_runs_in_user_workspace
  python print(os.getcwd()) → 路径在 users/<id>/.../workspace/

test_user_a_cannot_read_user_b_output_file
  alice 写出 result.csv → bob file_read 该路径失败

test_sandbox_blocks_python_open_other_user_path
  alice 脚本 open(".../users/bob/.../secret.csv")
  → OS 沙箱或策略拒绝（不是 allowed_commands 的功劳）

test_allowed_commands_rejects_bash
  shell 直接跑 bash → 拒绝
  shell 跑 python3 → 允许启动
```

---

## 第 7 步：内网适配

**文件：** `tests/component/intranet_config.rs`（配置解析即可）

```
test_openai_compatible_base_url_accepted
  providers.models.openai.deepseek.base_url = 内网地址 → 校验通过

test_open_skills_can_be_disabled
  open_skills_enabled = false → 配置有效

test_web_search_in_excluded_tools
  risk_profile.excluded_tools 含 web_search、web_fetch → 解析成功
```

---

## 第 8 步：个人技能与角色

**文件：** `tests/system/multi_user_skills.rs`

```
test_user_skill_loaded_only_for_owner
  alice 目录 skills/flu-weekly/SKILL.md
  → alice turn 能加载；bob 不能

test_normal_user_can_load_existing_personal_skill
  普通用户目录里已有个人技能（例如曾由高级用户写入，或测试夹具）
  → 可以加载；「保存为技能」仍失败

test_save_personal_skill_requires_advanced_user
  普通用户保存 → 失败，磁盘无新文件
  高级用户保存 → 写入 users/<id>/.../skills/
  → agents/default/workspace/skills 与 shared/skills 无新文件

test_user_cannot_write_shared_skill_via_user_api
  高级用户调用用户面保存
  → 只出现在自己的 users/.../skills/

test_org_skill_wins_on_name_collision
  组织与用户都有 flu-forecast
  → 生效组织那份

test_user_skill_scripts_not_auto_enabled
  个人 SKILL 声明 allow_scripts → 不按可执行 skill 加载

test_save_org_skill_requires_ops_role
  普通用户、高级用户写组织 Skill → 403
  运维写入 → shared 或 agent workspace/skills 有文件

test_normal_and_advanced_cannot_post_api_skills
  非运维调用 POST /api/skills → 403
```

---

## 测试文件清单

| 文件 | 步骤 | 用例数 | 参考 |
|------|------|--------|------|
| `tests/system/multi_user_principal.rs` | 1 | 9 | 新建 |
| `tests/system/multi_user_gateway_surface.rs` | 1b | 5 | 新建 |
| `tests/system/multi_user_sessions.rs` | 2 | 8 | `proof_session_routing_columns.rs` |
| `tests/system/multi_user_workspace.rs` | 3 | 6 | 新建 |
| `tests/system/multi_user_memory.rs` | 4 | 6 | `multi_agent_e2e.rs` |
| `tests/system/multi_user_mcp.rs` | 5 | 5 | 新建（MCP 服务端 2 条在对端仓库） |
| `tests/system/python_r_runtime.rs` | 6 | 8 | `shell` 工具测试 |
| `tests/component/intranet_config.rs` | 7 | 3 | config 解析 |
| `tests/system/multi_user_skills.rs` | 8 | 8 | 新建 |

本仓库约 **58** 条；另加 MCP 服务端区域过滤 2 条作为对端验收。
