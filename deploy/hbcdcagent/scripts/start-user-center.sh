#!/usr/bin/env bash
# ============================================================
# 交付包 — 用户中心 SSO
#
#   进程: zeroclaw daemon 127.0.0.1:42617
#         hbcdcagent-bff  0.0.0.0:50001  (真实 USER_CENTER_*)
#
#   用户 → :50001 → SSO verifyCode → BFF session → 127.0.0.1:42617
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

hbcdcagent_resolve_root "$SCRIPT_DIR"
hbcdcagent_require_pack
hbcdcagent_ensure_config

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ 缺少 $ENV_FILE（用户中心密钥）" >&2
  echo "   从 config 模板复制 .env 后填写 USER_CENTER_* 与 trusted_proxy_secret" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export HBCDCAGENT_BFF_LOCAL_MOCK=false
: "${ZEROCLAW_gateway__trusted_proxy_secret:?需要 ZEROCLAW_gateway__trusted_proxy_secret}"
: "${HBCDCAGENT_BFF_PUBLIC_ORIGIN:?需要 HBCDCAGENT_BFF_PUBLIC_ORIGIN}"
: "${USER_CENTER_BASE_URL:?需要 USER_CENTER_BASE_URL}"
: "${USER_CENTER_APP_ID:?需要 USER_CENTER_APP_ID}"
: "${USER_CENTER_APP_KEY:?需要 USER_CENTER_APP_KEY}"
: "${USER_CENTER_APP_SECRET:?需要 USER_CENTER_APP_SECRET}"

hbcdcagent_export_runtime_env

trap hbcdcagent_cleanup EXIT
hbcdcagent_start_daemon
hbcdcagent_start_bff

echo "✅ 用户中心方式已启动"
echo "   入口：${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/hbcdcagent/workbench"
echo "   redirectUrl 应登记为 ${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/auth/callback"

hbcdcagent_wait
