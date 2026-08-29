# ZeroClaw 编译说明

数智疾控交付：分支 `feat/multi-user-isolation`，非 Docker 直接部署。产出三个二进制 + 前端，供后续打包发布。

日常本机开发（macOS / Linux）也可以按本文拉代码、编 debug；**打交付包必须在 x86-64 Linux 上用 `--profile ci`**。

## 一、获取最新代码

编译前先对齐远程分支，不要在过期树上编。文档翻译 submodule（`docs/book/po`）**不需要**，Rust / 前端 / BFF 都不读它。

### 已有仓库（日常）

在仓库根目录：

```bash
cd /path/to/zeroclaw

git status
# 有未提交改动：先自己处理（提交、stash 或丢掉），再拉代码。
# 不要在脏工作区上 git pull。

git fetch origin
git checkout feat/multi-user-isolation
git pull --ff-only origin feat/multi-user-isolation
git log -1 --oneline
```

`--ff-only` 在本地有分叉提交时会失败，避免 silently merge。若失败，先看 `git status` / `git log --oneline origin/feat/multi-user-isolation..HEAD`，再决定 rebase 或丢掉本地提交。

远程应是：

```text
https://github.com/sandzhang2013/zeroclaw.git
# 或 git@github.com:sandzhang2013/zeroclaw.git
```

用 `git remote -v` 确认。若 `origin` 指向上游 `zeroclaw-labs/zeroclaw`，改拉 fork，或把 fork 加成第二个 remote 再 pull。

### 第一次克隆

```bash
git clone -b feat/multi-user-isolation \
  https://github.com/sandzhang2013/zeroclaw.git
cd zeroclaw
```

不需要 `--recurse-submodules`。

### 拉完后确认

```bash
git branch --show-current    # feat/multi-user-isolation
git rev-parse --short HEAD
```

后面所有 `cargo` / `nvm` 命令都在这个仓库根目录执行。

## 二、前置环境

| 项 | 本机开发 | 交付编译机 |
|---|---|---|
| 系统 | macOS 或 Linux | **x86-64 Linux**，能访问 github / rustup.rs / crates.io / npm |
| Rust | ≥ 1.96.0（建议 `1.96.0`，对齐 CI） | 同左 |
| Node | 必须，`24`（见仓库根 `.nvmrc`） | 同左 |
| 磁盘 | 建议 ≥ 10 GB（`target` + 依赖缓存 + `node_modules`） | 同左 |

Linux 若缺 C 工具链：Debian/Ubuntu 装 `build-essential pkg-config`。

## 三、装工具链（Rust + Node）

已装过且 `rustc --version` / `node --version` 满足上表，可跳过。

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install 1.96.0
rustup default 1.96.0
rustc --version

# Node 24
nvm install 24 && nvm use 24
node --version   # 应对齐 .nvmrc，目前是 24
```

## 四、构建 Web 前端（交付必须）

```bash
cargo web build
# 产物：web/dist/  （运行时 gateway.web_dist_dir 读取）
```

`cargo web` 是仓库 `.cargo/config.toml` 别名，实际跑 `xtask`。缺 `web/node_modules/` 时会先 `npm install`。

本机只改 UI、不打交付包时，用 `cargo web dev`（或 `cd web && npm run dev`）即可，不必每次 `cargo web build`。

## 五、编译二进制

### 交付（Linux x86-64，必须用 `ci` profile）

```bash
cargo build --profile ci --locked --bin zeroclaw
cargo build --profile ci --locked -p hbcdcagent-bff
cargo build --profile ci --locked -p zerocode
```

第四、五步**无顺序依赖**（默认 feature 不把 `web/dist` 嵌进二进制），但交付时两者都要做。

### 本机开发（debug）

```bash
cargo build --bin zeroclaw
cargo build -p hbcdcagent-bff
```

产物在 `target/debug/`。默认 feature 已含 `acp-bridge`，同一次 `cargo build` 也会编出 `zeroclaw-acp-bridge`（工作台交付不需要这个二进制）。

## 六、产出物（交付全部必须）

| 产物 | 路径 | 用途 |
|---|---|---|
| `web/dist/` | `web/dist/` | 前端静态文件，运行时 `gateway.web_dist_dir` 读 |
| `zeroclaw` | `target/ci/zeroclaw` | 主 daemon：agent/session/memory/MCP，绑 `127.0.0.1:42617` |
| `hbcdcagent-bff` | `target/ci/hbcdcagent-bff` | 平台 BFF：用户中心换票 + 身份头转发，绑 `0.0.0.0:50001` |
| `zerocode` | `target/ci/zerocode` | TUI 配置管理器（运维辅助） |

打交付 tar（编译完成后，Linux amd64）：

```bash
./deploy/hbcdcagent/pack-release.sh
```

细节见 `deploy/hbcdcagent/RELEASE.md`。

## 七、验证

```bash
ls -lh target/ci/zeroclaw target/ci/hbcdcagent-bff target/ci/zerocode
file target/ci/zeroclaw        # 确认 x86-64 ELF，不是 arm64 / Mach-O
ls web/dist/index.html         # 确认前端已产出
```

本机 debug 把路径换成 `target/debug/`。

## 关键坑（实测）

1. **交付用 `--profile ci`，不要用 `--release`**：后者 `lto="fat"` + `codegen-units=1`，低内存机器（≤ 8G、无 swap）链接容易 OOM。`ci` 是 `lto="thin"` + `codegen-units=16`。
2. **`--bin` vs `-p`**：`hbcdcagent-bff` / `zerocode` 是独立 workspace member，必须 `-p`；`--bin` 只在根包里找，跨包会报 `no bin target named ... in default-run packages`。
3. **模型端点字段是 `uri`，不是 `base_url`**：`[providers.models.<family>.<alias>]` 下只有 `uri`。
4. **默认构建不内嵌 `web/dist`**：`default` features 不含 `embedded-web`，前端运行时从文件系统读；编三个 Rust 二进制不必先 `cargo web build`，但交付 tar 必须带上 `web/dist`。
5. **在脏仓库上 pull**：未提交改动会让 `git pull --ff-only` 失败或把你的改动和远程搅在一起。先 `git status`。

## 可选（工作台交付不需要）

| 产物 | 命令 | 说明 |
|---|---|---|
| `zeroclaw-acp-bridge` | 默认 `cargo build` 已包含 | IDE stdio ACP → daemon `/acp` WebSocket，见 `docs/book/src/channels/acp.md` |
| 文档站 | `cargo mdbook serve` | 需要 `docs/book/po` submodule；见 `docs/book/src/developing/building-docs.md` |
