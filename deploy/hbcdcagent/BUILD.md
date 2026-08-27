# ZeroClaw 数智疾控 — 编译清单

> 分支 `feat/multi-user-isolation`，非 Docker 直接部署。产出三个二进制 + 前端，供后续打包发布。

## 〇、前置环境

| 项 | 要求 |
|---|---|
| 编译机 | x86-64 Linux，能上公网（github / rustup.rs / crates.io / npm） |
| Rust | ≥ 1.96.0（建议 `1.96.0`，对齐 CI） |
| Node | 必须，`24`（见 `.nvmrc`，前端构建用） |
| 磁盘 | 留 ≥ 10 GB（target + 依赖缓存 + node_modules） |

## 一、取代码

```bash
git clone -b feat/multi-user-isolation \
  https://github.com/sandzhang2013/zeroclaw.git
cd zeroclaw
```

## 二、装工具链（Rust + Node 都要）

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup toolchain install 1.96.0
rustup default 1.96.0
rustc --version

# Node 24
nvm install 24 && nvm use 24
node --version
```

## 三、构建 Web 前端（必须，产出 `web/dist`）

```bash
cargo web build
# 产物：web/dist/  （供运行时 gateway.web_dist_dir 读）
```

## 四、编译三件套（必须）

```bash
cargo build --profile ci --locked --bin zeroclaw      # 根包 bin，用 --bin
cargo build --profile ci --locked -p hbcdcagent-bff   # workspace member，用 -p
cargo build --profile ci --locked -p zerocode         # workspace member，用 -p
```

> 第三、四步**无顺序依赖**（默认构建不把 `web/dist` 嵌进二进制），但两者都必须做。

## 五、产出物（全部必须）

| 产物 | 路径 | 用途 |
|---|---|---|
| `web/dist/` | `web/dist/` | 前端静态文件，运行时 `gateway.web_dist_dir` 读 |
| `zeroclaw` | `target/ci/zeroclaw` | 主 daemon：agent/session/memory/MCP，绑 `127.0.0.1:42617` |
| `hbcdcagent-bff` | `target/ci/hbcdcagent-bff` | 平台 BFF：用户中心换票 + 身份头转发，绑 `0.0.0.0:50001` |
| `zerocode` | `target/ci/zerocode` | TUI 配置管理器（运维辅助工具） |

## 六、验证

```bash
ls -lh target/ci/zeroclaw target/ci/hbcdcagent-bff target/ci/zerocode
file target/ci/zeroclaw        # 确认 x86-64 ELF，不是 arm64
ls web/dist/index.html         # 确认前端已产出
```

## 关键坑（实测）

1. **用 `--profile ci`，不用 `--release`**：后者 `lto="fat"` + `codegen-units=1`，最终链接在低内存机器（≤ 8G、无 swap）有 OOM 风险。`ci` 是 `lto="thin"` + `codegen-units=16`。
2. **`--bin` vs `-p`**：`hbcdcagent-bff` / `zerocode` 是独立 workspace member，必须 `-p`；`--bin` 只在根包（`default-run`）里找，跨包会报 `no bin target named ... in default-run packages`。
3. **模型端点字段是 `uri`，不是 `base_url`**：`[providers.models.<family>.<alias>]` 下只有 `uri`（`schema.rs` 的 `ModelProviderConfig`）。
4. **默认构建不内嵌 `web/dist`**：`default` features 不含 `embedded-web`，前端运行时从 `gateway.web_dist_dir` 读文件系统；所以编译三个 Rust 二进制不需要先 `cargo web build`，但交付时必须带上 `web/dist`。
