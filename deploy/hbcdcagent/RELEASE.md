# ZeroClaw 数智疾控 — 发布打包清单

> 编译完成后，在编译机上把产物收拢成一个可传输的 tar 包，再拷贝到生产 150 主机安装上线。

## 〇、前置（编译已完成）

```bash
ls -lh target/ci/zeroclaw target/ci/hbcdcagent-bff target/ci/zerocode
ls web/dist/index.html
```

## 一、打包产物

```bash
RELEASE=zeroclaw-release
rm -rf /tmp/$RELEASE
mkdir -p /tmp/$RELEASE/bin /tmp/$RELEASE/web /tmp/$RELEASE/config/systemd

# 1. 二进制 + 前端
cp target/ci/zeroclaw target/ci/hbcdcagent-bff target/ci/zerocode /tmp/$RELEASE/bin/
cp -r web/dist /tmp/$RELEASE/web/dist

# 2. 模板文件（占位符版，不含真实密钥）
cp config.toml.template /tmp/$RELEASE/config/
cp systemd/zeroclaw-secret.conf systemd/hbcdcagent-bff.service /tmp/$RELEASE/config/systemd/

# 3. 校验架构（必须 x86-64）
file /tmp/$RELEASE/bin/*

# 4. 生成校验和
cd /tmp/$RELEASE
find . -type f -exec sha256sum {} \; | sort -k2 > SHA256SUMS

# 5. 打包
cd /tmp
tar czf zeroclaw-release.tar.gz $RELEASE

# 6. 确认
ls -lh /tmp/zeroclaw-release.tar.gz
sha256sum /tmp/zeroclaw-release.tar.gz
```

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
zeroclaw-release/
├── bin/{zeroclaw, hbcdcagent-bff, zerocode}
├── web/dist/
├── config/
│   ├── config.toml.template
│   └── systemd/
│       ├── zeroclaw-secret.conf
│       └── hbcdcagent-bff.service
└── SHA256SUMS
```

## 安全边界

- 包内**只有二进制 + 前端 + 占位符模板 + 校验和**。
- **绝不打入**：`config.toml`（真实）、secret、用户中心密钥（`USER_CENTER_APP_ID/KEY/SECRET`）、真实内网 IP。
- 那些一律在 150 上现场填写，走 systemd 环境变量，不进 git、不进包。
