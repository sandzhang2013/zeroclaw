# Web 前端多任务面板设计

## 背景

ZeroClaw 后端已天然支持同一 agent 的多个并发 session（不同 `session_id` 走独立 `SessionActorQueue` 插槽，互不阻塞）。但 Web 前端将 `1 agent alias = 1 session` 硬编码在 `getOrCreateSessionId(agentAlias)` 中，导致同一 agent 只能有一个会话。

## 改动目标

把前端 Tab 模型从"per-agent"升级为"per-task（agent + session）"，让用户对同一 agent 开启多个独立任务会话，切换/并排查看。**后端零改动。**

## 数据模型

```
现在：openChats = ["alice", "bob"]
改为：tabs = [TaskTab{id:"alice::__default__", agentAlias:"alice", taskId:"__default__"},
             TaskTab{id:"alice::a1b2c3d4", agentAlias:"alice", taskId:"a1b2c3d4"},
             TaskTab{id:"bob::__default__",   agentAlias:"bob",   taskId:"__default__"}]

TaskTab.id = "agentAlias::taskId"  ← 全局唯一键
```

每个 task 有独立 `session_id` → 独立 WebSocket → 独立对话历史和上下文。

## 改动文件

### 1. `web/src/lib/ws.ts` — Session ID 管理

新增函数：
- `createTaskSessionId(agentAlias)` — 创建独立 task session，返回短 taskId
- `resolveTaskSessionId(agentAlias, taskId)` — 根据 taskId 查 session_id
- `listTaskSessions(agentAlias)` — 列出某 agent 的所有 task
- `removeTaskSession(agentAlias, taskId)` — 清理 task session + 历史

`WebSocketClient` 新增 `sessionId` 选项，支持显式传入。

### 2. `web/src/contexts/AgentContext.tsx` — AgentProvider

`AgentProviderProps` 新增 `taskId?: string`：
- 有 taskId → 从 localStorage 解析对应 session_id
- 无 taskId → fallback 到默认 per-agent session（向后兼容）

### 3. `web/src/pages/ChatWorkspace.tsx` — 核心改造

- `openChats: string[]` → `tabs: TaskTab[]`
- localStorage schema v1→v2 兼容迁移
- 新增 `newTask(agentAlias)` 方法
- `splitAliases` → `splitTabIds`
- AgentProvider key 从 alias 改为 tab.id

### 4. `web/src/components/ChatTabBar.tsx` — Tab 栏 UI

- Props 从 `openChats: string[]` 改为 `tabs: TaskTab[]`
- 新增 `onNewTask` 回调
- Agent picker 分两组：
  - 未打开 agent → 打开默认任务
  - 已打开 agent → "新建独立任务"
- Tab 标签：默认任务只显示 agent 名，独立任务显示 "alias / taskId"

### 5. `web/src/lib/i18n.ts` — 国际化

新增 key：`workspace.new_task_heading`、`workspace.task_tooltip`

## 会话 ID 体系

| 层级 | ID | 示例 | 用途 |
|------|-----|------|------|
| Tab 唯一键 | `tab.id` | `"deepseek::a1b2c3d4"` | 组件 key、切换、indicators |
| 任务短 ID | `tab.taskId` | `"a1b2c3d4"` 或 `"__default__"` | UI 显示 |
| 后端 Session | `session_id` (UUID) | `"7f3c8a21-..."` | WS 参数、后端持久化 |

## 多用户前缀方案（可选叠加）

如需多用户隔离，session_id 结构可扩展为：

```
session_id = "{user_id}:{agent_alias}:{task_id}:{uuid}"
```

前端 session 函数统一加 `getUserPrefix()` 拼接，改动仅限 `ws.ts` 一处。隔离效果：对话历史隔离，但长期记忆和安全策略仍共享。
