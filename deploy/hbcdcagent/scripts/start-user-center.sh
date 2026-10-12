#!/usr/bin/env bash
# ============================================================
# 交付包 — 用户中心 SSO
#
#   进程: zeroclaw daemon 127.0.0.1:42617
#         hbcdcagent-bff  0.0.0.0:50002  (真实 USER_CENTER_*)
#
#   用户 → :50002 → SSO verifyCode → BFF session → 127.0.0.1:42617
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
  echo "   复制 deploy/hbcdcagent/env.example 为 .env 后填写，不要提交真实密钥" >&2
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

sso_id="${HBCDCAGENT_SSO_CLIENT_ID:-}"
sso_key="${HBCDCAGENT_SSO_KEY_B64:-}"
if [[ -n "$sso_id" && -z "$sso_key" ]] || [[ -z "$sso_id" && -n "$sso_key" ]]; then
  echo "❌ 票据 SSO 要同时填写 HBCDCAGENT_SSO_CLIENT_ID 与 HBCDCAGENT_SSO_KEY_B64" >&2
  exit 1
fi
if [[ -z "$sso_id" ]]; then
  echo "⚠️  未配置票据 SSO。带 clientId 与 verifyData 的工作台链接不会验票。" >&2
fi

hbcdcagent_export_runtime_env

trap hbcdcagent_cleanup EXIT
hbcdcagent_start_daemon
hbcdcagent_start_bff

echo "✅ 用户中心方式已启动"
echo "   入口：${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/hbcdcagent/workbench"
echo "   门户 redirectUrl：${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/hbcdcagent/auth/callback"
echo "   预警票据：${HBCDCAGENT_BFF_PUBLIC_ORIGIN}/hbcdcagent/workbench/deepseek?clientId=&verifyData="

hbcdcagent_wait
