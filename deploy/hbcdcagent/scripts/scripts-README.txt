# 交付包启动脚本

两种接入共用同一套进程：daemon (127.0.0.1:42617) + hbcdcagent-bff (0.0.0.0:50001)。
前端永远是包内 web/dist，不需要 Vite / npm / web 源码。

daemon 配置目录是 ~/.zeroclaw（可用 ZEROCLAW_CONFIG_DIR 覆盖），不是 ~/.config/zeroclaw。
脚本会用环境变量覆盖 web_dist_dir 为包内 web/dist，并打开 trusted_proxy + path_prefix=/hbcdcagent。

## start-local.sh —— 本地模拟用户
- 设置 HBCDCAGENT_BFF_LOCAL_MOCK=true，不调用户中心
- 浏览器 cookie：zeroclaw_mock_user=chenmin|liuyang|zhoujing|ops
- 入口：http://<主机>:50001/hbcdcagent/workbench
- 可选：config/.env 里的 trusted_proxy_secret（没有则用 zeroclaw-local-bff-secret）

## start-user-center.sh —— 用户中心 SSO
- 需要 config/.env（USER_CENTER_*、ZEROCLAW_gateway__trusted_proxy_secret、HBCDCAGENT_BFF_PUBLIC_ORIGIN）
- 入口：HBCDCAGENT_BFF_PUBLIC_ORIGIN/hbcdcagent/workbench
- 用户中心 redirectUrl：…/auth/callback

## 共通用
- 先填 ~/.zeroclaw/config.toml 的内网模型 uri（首次运行会从模板生成后退出）
- daemon 已在跑时脚本会复用，不会再起一个（避免 daemon.sock 占用）
- Ctrl+C 只停本脚本拉起的进程；原先已在跑的 daemon 不会被杀
- 打包：`./deploy/hbcdcagent/pack-release.sh` 默认把编译机 `.env` 打进 `config/.env`
