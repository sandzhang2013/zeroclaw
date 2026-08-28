#!/usr/bin/env bash
# ============================================================
# 交付包 — 本地模拟用户（不接用户中心）
#
#   进程: zeroclaw daemon 127.0.0.1:42617
#         hbcdcagent-bff  0.0.0.0:50001  (HBCDCAGENT_BFF_LOCAL_MOCK=true)
#
#   用户 → :50001 → BFF 按 cookie zeroclaw_mock_user 注入身份
#        → 127.0.0.1:42617（path_prefix=/hbcdcagent，读包内 web/dist）
#
#   不需要 web 源码 / Vite / npm。白名单：chenmin / liuyang / zhoujing / ops
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

hbcdcagent_resolve_root "$SCRIPT_DIR"
hbcdcagent_require_pack
hbcdcagent_ensure_config

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export HBCDCAGENT_BFF_LOCAL_MOCK=true
export ZEROCLAW_gateway__trusted_proxy_secret="${ZEROCLAW_gateway__trusted_proxy_secret:-zeroclaw-local-bff-secret}"
export HBCDCAGENT_BFF_PUBLIC_ORIGIN="${HBCDCAGENT_BFF_PUBLIC_ORIGIN:-http://127.0.0.1:50001}"
export USER_CENTER_BASE_URL="${USER_CENTER_BASE_URL:-http://127.0.0.1}"
export USER_CENTER_APP_ID="${USER_CENTER_APP_ID:-local}"
export USER_CENTER_APP_KEY="${USER_CENTER_APP_KEY:-local}"
export USER_CENTER_APP_SECRET="${USER_CENTER_APP_SECRET:-00112233445566778899aabbccddeeff}"
export USER_CENTER_SIGN_TYPE="${USER_CENTER_SIGN_TYPE:-MD5}"

hbcdcagent_export_runtime_env

trap hbcdcagent_cleanup EXIT
hbcdcagent_start_daemon
hbcdcagent_start_bff

echo "✅ 本地模拟用户已启动"
echo "   入口：${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/hbcdcagent/workbench"
echo "   浏览器先执行再刷新："
echo "     document.cookie = \"zeroclaw_mock_user=chenmin; Path=/; SameSite=Lax\""
echo "   可选用户：chenmin 陈敏 / liuyang 刘洋 / zhoujing 周静 / ops 系统运维"
echo "   从其他机器访问时设置 HBCDCAGENT_BFF_PUBLIC_ORIGIN=http://<主机>:50001"

hbcdcagent_wait
