# ZeroClaw 数智助理 — 需求与架构分析

## 场景

基于 ZeroClaw 改造，嵌入现有 Web 平台，作为每个用户的"数智助理"。

## 约束

| 维度 | 约束 |
|------|------|
| 部署 | 内网，不能连互联网 |
| 用户 | 已有平台提供用户体系，<50 人 |
| 模型 | 内网部署 DeepSeek/Qwen，OpenAI 兼容 API |
| 入口 | 浏览器只连已登录平台；平台 BFF/反代代连 ZeroClaw WebSocket。无 channels 需求 |
| 脚本 | 模型可生成并执行 Python/R（如流感预测）并返回结果；主机/镜像须预装解释器与科学计算包（内网不能 pip/CRAN 现场装） |
| 数据 | SQLite，新部署无历史数据 |

## 铁律：用户身份不可变

**一旦用户进入页面，身份即确认。整个会话生命周期内，用户身份不可改变。**

1. **身份来源唯一**：浏览器不直连 ZeroClaw。已登录平台（BFF/反代）用服务端连接补上 `X-User-Id`（及角色/地区/机构）和 `X-Auth-Secret`。ZeroClaw 校验 secret 后，把身份冻在这条连接上。
2. **不可被模型改变**：即使对话中说"假装我是 Bob"，连接上的身份不变；每个 turn 再 scope 到只读的 `TOOL_LOOP_USER_ATTRS`。
3. **不可被工具改变**：任何工具没有修改用户上下文的权限。
4. **隔离的根基**：会话、目录、记忆、MCP、脚本执行——全部从这份已担保、不可变的身份派生。

### 架构保障

```
浏览器（已登录）→ 平台 BFF/反代
  → WS 头: X-User-Id + X-Auth-Secret（可选 Role/Region/Org）
  → ZeroClaw 校验 secret，身份冻在 WS session
  → 每个 turn scope TOOL_LOOP_USER_ATTRS（只读）
  → 工具 try_with() 读取；MCP 拿到网关保证的身份
```

### 反例

| 错误做法 | 后果 |
|----------|------|
| 浏览器直连 ZeroClaw，`?user_id=` 或自报 `X-User-Id` | 身份可伪造；浏览器也设不了自定义 WS 头 |
| 从 LLM 输出的 tool args 中提取 user_id | 模型可伪造身份 |
| 从对话内容中解析"作为XX用户" | 提示注入 |
| 用 `allowed_commands` 或专用 `python_execute` 当跨用户文件隔离 | 只限制能否启动解释器，不管脚本里 `open()` / `os.system()` |

### 正确做法

| 做法 | 保障 |
|------|------|
| 浏览器只连平台；BFF 代连并带头 + secret | 身份由已认证会话担保 |
| user_id 只从通过校验的上游 header 取 | 单一可信来源；忽略 query/body |
| 身份冻在连接上，每 turn 再 scope task-local | 连接级不变，spawn 后也不丢 |
| 所有工具只读 task-local | 代码级只读 |
| MCP 透传网关保证的身份 | 服务端信任链完整 |
| 脚本跑在用户 session cwd + OS 沙箱 | 文件隔离；`allowed_commands` 只限制启动 python3/Rscript |

## 与原有方案的关键差异

| 原方案 | 新方案 |
|--------|--------|
| 自建 `[users]` 配置 + 认证系统 | **透传**：平台已登录用户由 BFF 担保后传入，ZeroClaw 不管理账号 |
| 浏览器直连 ZeroClaw / 设备配对登录 | **业务口**：平台代连 + `X-Auth-Secret`；运维 Dashboard 仍可用 pairing |
| 独立部署的 web dashboard 给终端用户 | **嵌入平台**：工作台给所有登录用户；运维页仅全平台运维 |

## 透传认证模型

```
浏览器（平台登录态）
  │  不直连 ZeroClaw
  ▼
平台 BFF / 反代（从自己的 session 取出 alice）
  │  WS/HTTP → ZeroClaw
  │  X-User-Id: alice
  │  X-Auth-Secret: <仅平台与 ZeroClaw 共享>
  │  可选: X-User-Role / X-User-Region / X-User-Org
  ▼
ZeroClaw Gateway（trusted_proxy）
  │  校验 secret → 构造 Principal → 冻在连接上
  ▼
Agent → Session → Memory → Workspace
  （全程只用这份已担保的 user_id）
```

**关键决策：** ZeroClaw 不做登录，但必须确认请求来自可信 BFF。不信任浏览器自报的 `user_id`，忽略 query/body 中的身份。secret 用环境变量注入。

### 平台角色约定

角色经 `X-User-Role` 冻在连接上。当前约定：

| 角色 | 谁有 | 能做什么 |
|------|------|----------|
| 普通用户 | 默认登录用户 | 使用工作台；使用组织 Skill 和自己已有的个人技能；不能新增技能、不能进运维页 |
| 高级用户 | 平台授予 | 普通用户能力 + **保存个人技能**（只写自己的 `skills/`） |
| 运维 | **全平台一个运维**（不是按地区的管理员） | 助手管理（Config/Logs/组织 Skill）。打开的是整机视图，能看到所有用户相关数据 |

运维不是「武汉运维只看武汉」。地区过滤只作用于普通/高级用户的 MCP 业务数据。

## Web 页面需求

Web **不是** 把 ZeroClaw 自带 Dashboard（`web/`）发给用户，而是嵌在 **现有平台** 里的两套路由。登录、角色用平台用户体系；浏览器只连平台，由 BFF 代连 ZeroClaw。不要 iframe 整份 ZeroClaw Dashboard，也不要在用户包里挂载 Config/Logs/配对路由。

### 两套页面

| 页面 | 谁能开 | 干什么 |
|------|--------|--------|
| **工作台** | 所有登录用户 | 左侧边栏 + 中间对话区 + 右侧结果区 |
| **助手管理** | 仅全平台运维 | Config、日志、组织 Skill 等；**整机视图**，不按地区裁剪 |

| 角色 | 工作台 | 保存个人技能 | 管理页 |
|------|--------|--------------|--------|
| 普通用户 | 有 | 无（接口也 403） | 无 |
| 高级用户 | 有 | 有 | 无 |
| 运维 | 有 | 不作为其主路径（组织 Skill 走运维页） | 有 |

前端藏按钮不够：BFF 必须按角色拒绝。页面上不出现登录、配对码；身份来自平台会话。

### 工作台

工作台整体结构：**左侧边栏** + **中间对话区** + **右侧结果区**。列表与会话只含当前用户；不拼 `?user_id=`，不在前端把 `user_id` 写进 session_id（隔离在 BFF/ZeroClaw）。

#### 左侧边栏（上 → 下）

1. **新建会话**：创建一条新会话（新 `session`），进入中间对话区。
2. **工作区**：会话分组（文件夹）。一个工作区/文件夹下可有多条会话。
3. **会话列表**：按工作区/文件夹展开，列出其中的会话；点选一条，中间对话区切换到该会话。同一用户可开多条会话，互不串上下文。

工作区是界面分组，不是 ZeroClaw agent 的磁盘 workspace，也不是跨用户共享目录。附件与生成文件仍落在该会话的 session cwd。

#### 中间对话区

当前选中会话的对话：流式输出；Markdown（表格/代码）；工具调用可折叠（MCP、脚本、文件等）。高级用户可「保存为技能」，只写入自己的 `skills/`。

交互观感参考 `docs/分析/ZeroClaw聊天界面UI设计参考.md`（滚动、工具卡片、输入框、hover 操作）。那是体验参考，协议仍走 ZeroClaw WS；**不直接复用 poco-claw 代码**。

#### 右侧结果区

展示本会话产出的结果（脚本输出、图表、生成文件等），与中间对话区分开。细则另定。

多任务靠左侧边栏的工作区与会话列表，实现落在 **平台工作台**。`docs/分析/Web前端多任务面板设计.md` 里「前端拼接 `{user_id}:...` 做隔离」作废；也不用 ZeroClaw Dashboard 顶部 Tab 充当工作台导航。

### 管理页

运维在平台内打开，BFF 转 ZeroClaw 运维 API。可改配置、看日志、发布组织 Skill。能看到所有用户相关数据。普通用户、高级用户打这些 API → 403。

### 明确不做

- 给终端用户打开 `http://zeroclaw:端口/` 整站
- 业务用户走 pairing 登录
- 把 ZeroClaw `web/` 的 Config/Logs/Doctor 编进用户前端包

## 改动范围（重新评估）

去掉认证系统后，改动量更小：

| 模块 | 原评估 | 新评估 | 说明 |
|------|--------|--------|------|
| 用户账户 | 中 | **不做** | 上游平台管理 |
| 认证 (`gateway`) | 中 | **中** | `trusted_proxy`：校验 BFF secret，从身份头构造 Principal，冻在连接上 |
| 会话 (`infra` + `gateway`) | 中偏小 | 同 | trait 加参数 + WHERE 过滤 |
| 目录 | 小 | 同 | `user_workspace_dir()` |
| 记忆 | 小 | 同 | `TenantScopedMemory` wrapper |
| 技能 | 极小 | **中（新增个人技能）** | 组织 Skill 仅全平台运维；个人技能仅「高级用户」可新增，只加载到该用户连接 |
| Python/R | 无 | **运行环境 + 现有 shell** | 预装 python3/R 及依赖；第一期用 `shell` 执行，不把新工具当安全边界 |
| Web 前端 | 中 | **平台两套页** | 工作台（全员：左侧边栏 + 中间对话区 + 右侧结果区）；管理仅运维；无登录页；BFF 按角色闸门 |

## 内网环境特殊处理

| 功能 | 处理 |
|------|------|
| `open-skills` | 关闭（默认） |
| Provider URL | 指向内网 API：`base_url = "http://deepseek.internal:8080/v1"` |
| Provider 类型 | 用 `compatible.rs`（OpenAI 兼容） |
| Python/R 运行环境 | 镜像或主机预装 `python3` / `Rscript` 及预测常用包（pandas、numpy、statsmodels 或对应 R 包）；禁止运行时访问公网装包 |

## 检索方案

**不使用公共 web_search 引擎（不能连互联网），采用三层检索替代：**

| 层 | 数据类型 | 方案 | 延迟 |
|----|----------|------|------|
| MCP 直连 | 业务数据库 | MCP 服务直连查询 | **实时** |
| MCP 封装 | 内网系统（Wiki/CRM/OA） | MCP 服务封装内网 HTTP/API | **实时** |
| MCP + FTS5 | 外部公开数据（竞品/政策/行业） | 爬虫拉取 → SQLite FTS5 → MCP 暴露 | **T+1** |

**外部数据爬取：**
```
可上网机器(DMZ)             安全通道            内网
爬虫(cron定时)  ──导入──► SQLite FTS5 ◄── MCP(stdio) ◄── Agent
```

**实现要点：**
- 爬虫：Python + cron，产出 SQLite 文件，经审批导入内网
- 存储：SQLite FTS5 全文检索（ZeroClaw 已有此技术栈）
- 接入：stdio 模式的 MCP 服务，暴露 `internal_search` 工具
- 隔离：MCP 调用时注入 user_id，搜索结果可按用户权限过滤
- 原有 `web_search` 工具从 `excluded_tools` 排除，用自定义 MCP 替代

## Python/R 脚本执行

这是 **能力需求**：模型生成的分析/预测脚本必须能跑完并给出结果（例如流感预测出图、出数）。不是「做一个更安全的专用工具」。

### 一次预测怎么走

```
用户（区域=武汉）问：预测下周流感
  → MCP 只返回该用户可见的数据（头里 region=武汉）
  → 模型把数据落到用户 session cwd，并生成 predict.py / predict.R
  → 现有 shell 执行：python3 predict.py  或  Rscript predict.R
       cwd = .../users/<user_id>/agents/<alias>/workspace/
       OS 沙箱（Landlock/Seatbelt/Docker）只允许碰该目录
  → 图表/CSV 写在同一目录，stdout 截断后回给模型，再回复用户
```

### 分层（不要混）

| 需求 | 靠什么 | 不靠什么 |
|------|--------|----------|
| 脚本能跑、有科学计算库 | 主机/容器预装解释器与包 | 运行时 `pip install` / `install.packages` |
| 只用武汉的数据 | MCP 按 `X-User-Region` 过滤后再交给脚本 | 脚本自己去翻库或改 region 参数 |
| 读不到其他用户的文件 | 用户 cwd + OS 沙箱 | `allowed_commands`、专用 `python_execute` 工具名 |
| 只能启动 Python/R，不能乱起 bash | `allowed_commands = ["python3", "Rscript"]` | 把它当成脚本内部的权限系统 |
| 不挂死、不刷屏 | 超时、输出截断 | — |

第一期复用 `shell`，不必新增 `python_execute` / `r_execute`。专用工具以后可以加，只为传参/截断体验，**不增加隔离能力**。

ZeroClaw 已有执行器可参考：`shell`（`zeroclaw-runtime`）、`coding_cli_executor`。

## 个人技能沉淀

有必要让用户把跑通的做法沉淀下来，但 **不能** 写进 `agents/<alias>/workspace/skills/` 或 `shared/skills/`（那是全员 Skill，由运维发布）。

### 两套技能

| | 组织 Skill | 个人技能 |
|---|---|---|
| 谁维护 | 全平台运维 | 高级用户 |
| 路径 | agent workspace / `shared/skills` | `<install>/users/<user_id>/agents/<alias>/workspace/skills/<name>/SKILL.md` |
| 谁加载 | 该 agent 下所有用户 | **仅** 当前连接的 `user_id`（普通用户也能用自己已有的） |
| 谁可以新增/改 | 仅运维；BFF 拦截非运维 | 仅高级用户；无该角色则「保存为技能」失败 |

加载顺序：组织 Skill + 该用户 `skills/`。同名时 **组织优先**，用户不得覆盖 `always: true` 或同名共享 skill（换自己的名字沉淀）。个人技能默认 **不允许** `allow_scripts` 可执行附件；脚本仍放用户 cwd 用 shell 跑。

**新增权限由平台角色控制（BFF 为闸，ZeroClaw 再校验连接上冻住的 `roles`）：**

| 动作 | 角色 | 写到哪 |
|------|------------------------|--------|
| 发布/修改组织 Skill | 运维（全平台一个） | agent / `shared/skills` |
| 保存个人技能 | **高级用户** | 仅该用户 cwd `skills/` |
| 使用已有技能（组织 + 自己的） | 普通用户即可 | 只读加载 |

前端藏按钮不够：无角色的请求必须 403。角色只来自 BFF 头里的 `X-User-Role`，模型不能给自己授权。

### 用户怎么沉淀

```
对话中跑通「按近 8 周做武汉流感图」
  → 用户说「保存成我的技能」（连接上的 roles 含高级用户）
  → 写入该用户目录 skills/flu-weekly/SKILL.md
  → 无该角色 → 拒绝写入，不创建文件
  → 下次同一用户进线，turn 加载组织 Skill ∪ 其个人技能
  → Bob 的连接不加载 Alice 的 skills/
```

记忆（偏好、事实）仍然互补：短口径进 memory；可复用工作流进个人 SKILL.md。

禁止：用户面调用现有 `POST /api/skills`（那是安装级）。个人技能的读写只走用户 cwd，BFF 已担保的身份。

---

不改动认证系统后，实际改动收敛为：

```
gateway/ws.rs            ← 校验 BFF secret + 身份头，Principal 冻在 WS session
gateway/api.rs           ← 用户面 API 走 require_trusted_proxy（pairing 留给运维面）
runtime/agent/loop_.rs   ← 每 turn 从连接身份 scope TOOL_LOOP_USER_ATTRS
infra/session_backend.rs ← 默认方法 set_session_user_id / list_sessions_for_user（未改 required 签名）
infra/session_sqlite.rs  ← SQL 加 user_id 列 + WHERE user_id = ?
config/schema.rs         ← user_workspace_dir() 新方法
memory/tenant_scoped.rs  ← TenantScopedMemory；SQLite unique (agent_id, ifnull(tenant_id,''), key)
部署/镜像                ← 预装 python3/R 及科学计算包；shell 允许这两条命令（仓外）
runtime/skills           ← 每 turn 额外加载用户 cwd 下 skills/；禁止用户写入共享 Skill 库
平台前端                 ← 工作台（全员）+ 管理页（仅运维）；不发 ZeroClaw Dashboard 整站（仓外）
```

## MCP — 外部数据主通道

### 当前架构

MCP 是 per-agent 的（通过 `mcp_bundles` 配置授予），服务器全局定义在 `[mcp.servers]`。

```
[agent.alias].mcp_bundles → 解析为服务器列表 → McpRegistry.connect_all()
  → 工具前缀 {server}__{tool} → McpToolWrapper → execute()
```

### 当时发现：MCP 调用签名不带用户

`McpRegistry::call_tool()` 签名里没有 `session_key`、`agent_alias`、`user_id`。身份不能走这条签名，也不能从模型可见的 tool args 里「补」。

**需求确认：** MCP 需要区分用户的角色、地区、机构等属性来做数据隔离。数据 `WHERE` 在 MCP 服务端（仓外）；ZeroClaw 只把连接上已冻结的身份盖到传输层。

### 工具执行上下文的现有机制

ZeroClaw 工具不通过 `execute()` 签名传上下文，而是用 **Tokio task-local storage**：

```rust
tokio::task_local! {
    pub static TOOL_LOOP_SESSION_KEY: Option<String>;
    pub static TOOL_LOOP_USER_ATTRS: Option<UserAttrs>;
    // ...
}
```

`shell.rs` 通过 `TOOL_LOOP_SESSION_KEY.try_with(...)` 读 session key。身份用同一模式：`TOOL_LOOP_USER_ATTRS`。

`call_prep` 会向即将 `execute()` 的 args 注入 `approved` 等运行时字段。**不要**把 `user_id` / `region` / `role` / `_zeroclaw_user` 走这条路：那些字段会进会话历史，下一轮可被模型伪造。

### MCP 用户上下文：只走传输层（现行）

**禁止** 合并到模型可见 args JSON，也 **禁止** 在 `call_prep` 里注入身份。

```
1. TOOL_LOOP_USER_ATTRS task-local
   └─ UserAttrs { user_id, role, region, organization }

2. Gateway 把 UserAttrs 冻在 WS session；每个 turn 再 scope 到 task-local
   └─ 身份只来自已通过 secret 校验的 BFF 头，不从 query / body / 模型 args 读

3. McpToolWrapper::execute()
   ├─ 读 TOOL_LOOP_USER_ATTRS；缺失 → 该 MCP 调用失败关闭
   └─ strip_identity_args：丢掉模型带来的身份键，历史只留业务 args

4. MCP transport 层盖章（模型看不见）
   ├─ HTTP/SSE: X-User-Id / X-User-Role / X-User-Region / X-User-Org
   └─ Stdio: JSON-RPC params._zeroclaw_user（与 arguments 并列，不回写历史）
```

**数据流：**

```
平台 BFF → X-User-Id / Role / Region / Org + X-Auth-Secret
  → Gateway 校验 secret，冻在连接上
  → 每 turn scope TOOL_LOOP_USER_ATTRS
  → McpToolWrapper 读取并剥离模型身份键
  → MCP HTTP 头 / stdio 内部字段
  → MCP 服务端：无头失败关闭；有头则 WHERE region = …
```

**为什么不改 Tool trait：** 身份不进 `execute()` 的 args。task-local 给内部读；传输层给 MCP 服务端。`_zeroclaw_user` 只存在 stdio 信封上，大多数 MCP SDK 会忽略未知 params 字段。

### Python/R 数据流

```
用户提问「预测下周流感」
  → MCP 按连接上的 region 返回可见数据（武汉用户看不到外地）
  → 模型生成脚本，在用户 workspace 读写
  → python3 / Rscript 在同一 cwd + OS 沙箱中执行
  → 结果文件留在用户目录，文本回给模型
```

临时文件、输出文件都在该用户 session cwd；不要让脚本成为跨用户读盘的通道。

---

## 和之前分析的关系

之前的三份文档仍然有效，但需要调整的部分：

- **风险评估**：去掉"安全模型重构"（无 per-user 安全策略需求）、"数据迁移"（无旧数据）；新增 MCP 用户上下文评估
- **实施方案**：第 1 步 BFF 担保；第 5 步 MCP **只走传输层**（不把身份合并进模型可见 args）；第 6 步脚本 = 环境 + shell + 沙箱；第 8 步个人技能；**第 9 步平台工作台**（三栏，不用前端拼 user_id）
- **变更记录**：去掉认证系统相关条目；新增工具条目；新增 MCP 条目（如需要）
- **测试用例设计**：已按 BFF 担保、入口角色闸门、会话/目录/记忆、MCP 盖章、Python/R 沙箱、高级用户/运维技能补齐
- **Web 页面**：本节为产品清单；工作台 = 左侧边栏（新建会话 / 工作区 / 会话）+ 中间对话区 + 右侧结果区；UI 细节见聊天界面设计参考；不用 ZeroClaw `web/` 整站、不用前端拼 user_id
