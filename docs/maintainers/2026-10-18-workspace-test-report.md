# 工作区测试报告（2026-10-18）

分支 `feat/multi-user-isolation`，基线提交 `40c344028`。用例在当前工作区上编译，工作区相对该提交还有未提交改动：`crates/hbcdcagent-bff/src/proxy.rs`、`crates/hbcdcagent-bff/src/ticket.rs`、`crates/zeroclaw-runtime/src/skills/document.rs`、`web/src/contexts/AgentContext.tsx`、`web/src/lib/skillPackage.ts`、`web/src/lib/skillPackage.logic.test.ts`，以及 `Cargo.toml` 里的 `[profile.dev] debug = "line-tables-only"`。下面两处仍然失败的运行时用例不经过这些文件。

环境：macOS，`cargo 1.97.0`，`cargo test -- --test-threads=8`。补跑时设置了 `CARGO_INCREMENTAL=0`。

## 结论

Rust 与 Web 合计 **19641 通过，2 失败，42 忽略**。

| 套件 | 通过 | 失败 | 忽略 |
| --- | ---: | ---: | ---: |
| `cargo test --locked --workspace --exclude zeroclaw-desktop` | 19336 | 2 | 42 |
| `web/` 的 `npm test` | 305 | 0 | 0 |
| 合计 | 19641 | 2 | 42 |

两处失败都能在单线程下复现，见文末。另外 4 个用例在 8 线程全量跑里失败，单独重跑通过，记为通过，并在下面单独列出。

## 命令

与 `dev/ci.sh` 的 `test` 目标同一条 Rust 命令，不包含桌面端 crate：

```bash
cargo test --locked --workspace --exclude zeroclaw-desktop -- --test-threads=8
```

第一轮在 `zeroclaw-hardware` 失败后按 Cargo 默认 fail-fast 停下。磁盘随后写满，补跑中断。清掉可再生的 `target/debug/incremental`（约 40GB）后，用 `--no-fail-fast` 跑完尚未完成的包，再单线程重跑失败用例，并对第一轮没走到的库补了 `cargo test --doc`。

Web：

```bash
cd web && npm test
```

`npm test` 含 pretest。结果：chatSessions 8、chatWorkspace 14、sessionLifecycle 21、turnStream 13、主套件 233、sops 5、sop-editor 10、channel-form 1。全部通过。

## Rust 分项

数字已按最终一次有效结果合并：磁盘写满时中断的 memory / providers 结果作废；并行失败但单线程通过的 4 个用例计入通过。

| 范围 | 通过 | 失败 | 忽略 |
| --- | ---: | ---: | ---: |
| 根包 `zeroclaw`（lib、main、架构 / 组件 / 集成 / 系统） | 1300 | 0 | 9 |
| `hbcdcagent-bff` | 84 | 0 | 0 |
| `xtask` 与翻译、文档 bin | 247 | 0 | 0 |
| `zeroclaw-api`（含 1 个 doc-test） | 298 | 0 | 0 |
| `zeroclaw-buildinfo` | 6 | 0 | 0 |
| `zeroclaw-channels` | 1971 | 0 | 2 |
| `zeroclaw-commands` | 8 | 0 | 0 |
| `zeroclaw-config` | 1907 | 0 | 0 |
| `zeroclaw-dist` | 10 | 0 | 0 |
| `zeroclaw-eval` | 71 | 0 | 0 |
| `zeroclaw-gateway` | 745 | 0 | 7 |
| `zeroclaw-infra` | 315 | 0 | 0 |
| `zeroclaw-log` | 165 | 0 | 0 |
| `zeroclaw-macros` | 12 | 0 | 2 |
| `zeroclaw-plugins` | 146 | 0 | 0 |
| `zeroclaw-hardware` | 103 | 0 | 0 |
| `zeroclaw-memory` | 554 | 0 | 1 |
| `zeroclaw-providers` | 1978 | 0 | 8 |
| `zeroclaw-relay-proto` | 15 | 0 | 0 |
| `zeroclaw-runtime` | 5536 | 2 | 8 |
| `zeroclaw-sop-graph` | 3 | 0 | 0 |
| `zeroclaw-spawn` | 4 | 0 | 0 |
| `zeroclaw-tls` | 41 | 0 | 0 |
| `zeroclaw-tool-call-parser` | 192 | 0 | 1 |
| `zeroclaw-tools` | 2085 | 0 | 2 |
| `zerocode` | 1450 | 0 | 2 |
| `zerorelay` | 90 | 0 | 0 |

`zeroclaw-runtime` 的 5536 含 lib 5492 以及 cron、docker、relay、wss 等集成测试 44。providers 的 1978 含 lib 1917、dispatch 1、hailo 60。根包的 9 个忽略里有 `tests/test_live.rs` 的 7 个，那些用例默认不跑。

插件夹具包设置了 `test = false` 和 `doctest = false`，没有独立测试目标。对应的 e2e harness 编译成功，里面是 0 个用例。

链接 `zeroclaw-runtime` 测试二进制时有一条 `__eh_frame section too large` 警告，测试仍继续执行。

## 并行失败、单线程通过

这 4 个在 `--test-threads=8` 的全量结果里失败，`--test-threads=1` 单独重跑通过：

- `subprocess::tests::execute_returns_success_before_descendant_closes_output_pipes`（`zeroclaw-hardware`）。全量跑两次都在 4 秒内等不到子进程 PID 文件。单线程 0.54 秒通过。
- `openai::tests::responses_model_listing_carries_header_only_profile_and_surfaces_auth_failure`。并行时得到 `missing field data`，不是预期的鉴权失败。单线程通过。
- `openai::tests::responses_provider_honors_runtime_proxy_config`。并行时代理收到 3 次请求，断言是 2 次。单线程通过。
- `security::shell_identity::tests::shell_identity_probe_rejects_unsupported_and_stalled_helpers`。并行时结果是 `TimedOut`，断言是 `Unsupported`。单线程通过。

磁盘写满期间，`zeroclaw-memory` 的 `agent_migration` 三个用例报 `disk I/O error`，lib 里 `migration_factory_uses_selected_lucid_alias` 也失败了一次。补跑后 memory lib 550 通过、1 忽略，`agent_migration` 4 个通过。同一次中断里 providers 的 multimodal 失败没有形成完整测试结果，以上面的补跑为准。

## 仍失败

两处都在单线程下复现。

1. `skills::workspace_dir_regression_tests::org_skill_wins_on_name_collision_with_user_skill`  
   `crates/zeroclaw-runtime/src/skills/mod.rs:5741`  
   断言要求 shadow 列表里有 `name == "flu-forecast"` 且 `origin_hint == "user"`。用例通过 `SKILL.toml` 写技能，不经过未提交的 `document.rs` 围栏修改。

2. `tools::delegate::tests::enriched_prompt_resolves_explicit_global_full_skill_mode`  
   `crates/zeroclaw-runtime/src/tools/delegate.rs:11211`  
   `SkillsPromptInjectionMode::Full` 下，生成的 prompt 仍包含 `read_skill`。用例直接构造 `Skill`，不读技能文件。

## 没有跑的部分

- `zeroclaw-desktop`。CI 的 `test` 目标同样排除它。
- `scripts/ci/parallel_runtime_test_gate.sh`。那是 runtime 与 channels 的重复压测，不是另一套用例。
- 标记为 `#[ignore]` 的用例，包括 live 测试和部分 golden frame。数量已计入上表的忽略列，没有执行。
- `cargo fmt`、`cargo clippy` 和文档门禁。这次只跑测试用例。
