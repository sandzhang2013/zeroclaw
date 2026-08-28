# ZeroClaw 数智疾控 — 发布打包清单

> 编译完成后，在 Linux x86-64 编译机上打 tar。默认把本机 `deploy/hbcdcagent/.env` 打进包（不进 git）。只要占位符则加 `--no-secrets`。

```bash
# 含密钥（需已有 deploy/hbcdcagent/.env）
./deploy/hbcdcagent/pack-release.sh
# 占位符包：
./deploy/hbcdcagent/pack-release.sh --no-secrets
# 连编译带打包：
./deploy/hbcdcagent/pack-release.sh --build hbcdcagent-v0.4
```

产物默认在 `dist-offline/hbcdcagent-v0.3.tar.gz`（`dist-offline/` 已 gitignore）。

## 〇、前置（编译已完成）

```bash
ls -lh target/ci/zeroclaw target/ci/hbcdcagent-bff target/ci/zerocode
ls web/dist/index.html
```

## 一、打包产物

脚本：`deploy/hbcdcagent/pack-release.sh`。它会收 `bin/`、`web/dist/`、`scripts/`、`config/`，校验 x86-64 ELF，默认把编译机 `.env` 打进包；`--no-secrets` 则只打占位符。

## 二、传输到 150

**方式 A —— 编译机能 ssh 到 150**（或同一内网）：

```bash
scp zeroclaw-release.tar.gz <用户>@<150地址>:/tmp/
```

**方式 B —— 150 无网 / 只能内网**：通过内网共享盘、堡垒机或 U 盘拷贝。

## 三、150 上安装

```bash
cd /tmp && tar xzf zeroclaw-release.tar.gz

# 二进制装到 PATH
sudo install -m 0755 zeroclaw hbcdcagent-bff zerocode /usr/local/bin/

# 前端放固定路径
sudo mkdir -p /opt/zeroclaw/web
sudo cp -r dist /opt/zeroclaw/web/dist
```

## 四、配置 + systemd 启动

```bash
# 1. daemon 配置（从模板复制，填 uri/模型）
mkdir -p ~/.zeroclaw
cp config/config.toml.template ~/.zeroclaw/config.toml
vim ~/.zeroclaw/config.toml        # 填内网模型 uri、agent alias

# 2. daemon 服务 + secret
zeroclaw service install
mkdir -p ~/.config/systemd/user/zeroclaw.service.d
cp config/systemd/zeroclaw-secret.conf ~/.config/systemd/user/zeroclaw.service.d/secret.conf
vim ~/.config/systemd/user/zeroclaw.service.d/secret.conf   # 填真实 secret

# 3. BFF 服务
cp config/systemd/hbcdcagent-bff.service ~/.config/systemd/user/
vim ~/.config/systemd/user/hbcdcagent-bff.service           # 填 150 地址、用户中心密钥

# 4. 启动（先 daemon、后 BFF）
sudo loginctl enable-linger $USER
systemctl --user daemon-reload
systemctl --user enable --now zeroclaw
systemctl --user enable --now hbcdcagent-bff
journalctl --user -u zeroclaw -f
```

## 五、验证

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42617/hbcdcagent/health
# 期望 200
```

daemon 日志应出现 `Gateway listening on http://127.0.0.1:42617`；BFF 日志出现 `hbcdcagent-bff starting`（绑 `0.0.0.0:50001`）。

## 打包产物结构

```
hbcdcagent-v0.3/
├── README.txt
├── bin/{zeroclaw, hbcdcagent-bff, zerocode}
├── web/dist/
├── scripts/{common.sh,start-local.sh,start-user-center.sh,scripts-README.txt}
├── config/
│   ├── config.toml.template
│   ├── env.example
│   ├── .env                 # 默认打入，来自编译机本地文件，--no-secrets 则无
│   └── systemd/
│       ├── zeroclaw-secret.conf
│       └── hbcdcagent-bff.service
└── SHA256SUMS
```

## 安全边界

- git 里只有二进制构建说明、占位符模板、启动脚本。密钥文件 `deploy/hbcdcagent/.env` 必须 gitignore。
- **默认交付 tar 含密钥**：从编译机 `.env` 写入 `config/.env` 和 systemd Environment。给 150 用内网渠道传输，不要再提交回仓库。
- `--no-secrets` 只打占位符，上线前在 150 现场填 `.env`。
- 包内仍不要带真实 `~/.zeroclaw/config.toml`（模型 uri 在目标机填）。
