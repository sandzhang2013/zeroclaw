#!/usr/bin/env bash
# pack-release.sh — 打原生交付 tar（bin + web/dist + 启动脚本 + 配置）。
#
# 默认把编译机上的 deploy/hbcdcagent/.env 打进包（config/.env + 已填 systemd）。
# 该文件不进 git。占位符包用 --no-secrets。
#
#   ./deploy/hbcdcagent/pack-release.sh
#   ./deploy/hbcdcagent/pack-release.sh --no-secrets
#   ./deploy/hbcdcagent/pack-release.sh --build hbcdcagent-v0.4
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PACK_NAME="${PACK_NAME:-hbcdcagent-v0.3}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/dist-offline}"
BIN_DIR="${BIN_DIR:-${REPO_ROOT}/target/ci}"
WEB_DIST="${WEB_DIST:-${REPO_ROOT}/web/dist}"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"
DO_BUILD=0
ALLOW_ANY_ARCH=0
WITH_SECRETS=1

usage() {
  cat <<'EOF'
Usage: pack-release.sh [--build] [--allow-any-arch] [--no-secrets] [PACK_NAME]

Pack a native delivery tarball: binaries, web/dist, start scripts, config.

  --build            cargo web build + cargo build --profile ci --locked
  --allow-any-arch   skip x86-64 ELF check (local smoke only)
  --no-secrets       placeholders only; do not copy .env
  PACK_NAME          default hbcdcagent-v0.3

Default: include secrets from deploy/hbcdcagent/.env (or ENV_FILE).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) DO_BUILD=1; shift ;;
    --allow-any-arch) ALLOW_ANY_ARCH=1; shift ;;
    --no-secrets) WITH_SECRETS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "unknown flag: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      PACK_NAME="$1"
      shift
      ;;
  esac
done

if [[ ! "$PACK_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid PACK_NAME: $PACK_NAME" >&2
  exit 1
fi

build_all() {
  echo "==> 编译 web/dist 与 ci 二进制"
  (
    cd "$REPO_ROOT"
    cargo web build
    cargo build --profile ci --locked --bin zeroclaw
    cargo build --profile ci --locked -p hbcdcagent-bff
    cargo build --profile ci --locked -p zerocode
  )
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "❌ 缺少 $path" >&2
    echo "   先按 deploy/hbcdcagent/BUILD.md 编译，或加 --build" >&2
    exit 1
  fi
}

require_x86_64_elf() {
  local path="$1"
  local info
  info="$(file -b "$path")"
  if [[ "$info" != *"ELF 64-bit"* ]] || [[ "$info" != *"x86-64"* && "$info" != *"x86_64"* ]]; then
    echo "❌ $path 不是 x86-64 ELF（$info）" >&2
    echo "   交付包须在 Linux amd64 上编，或设 --allow-any-arch 仅作本机试打" >&2
    exit 1
  fi
}

refuse_placeholder_leaks() {
  local stage="$1"
  if find "$stage" \( -name '.env' -o -name 'config.toml' \) | grep -q .; then
    echo "❌ --no-secrets 包不能含 .env 或 config.toml" >&2
    exit 1
  fi
  local hits
  hits="$(grep -R -E 'USER_CENTER_APP_(ID|KEY|SECRET)=[0-9A-Fa-f]{16,}' "$stage" || true)"
  if [[ -n "$hits" ]]; then
    echo "❌ --no-secrets 包出现疑似真实用户中心密钥" >&2
    echo "$hits" | sed 's/=.*/=***/' >&2
    exit 1
  fi
  hits="$(grep -R -E 'trusted_proxy_secret=[0-9A-Fa-f]{16,}' "$stage" || true)"
  if [[ -n "$hits" ]]; then
    echo "❌ --no-secrets 包出现疑似真实 trusted_proxy_secret" >&2
    echo "$hits" | sed 's/=.*/=***/' >&2
    exit 1
  fi
}

require_secret_keys() {
  local missing=0
  local key
  for key in \
    ZEROCLAW_gateway__trusted_proxy_secret \
    HBCDCAGENT_BFF_PUBLIC_ORIGIN \
    USER_CENTER_BASE_URL \
    USER_CENTER_APP_ID \
    USER_CENTER_APP_KEY \
    USER_CENTER_APP_SECRET; do
    if [[ -z "${!key:-}" ]]; then
      echo "❌ $ENV_FILE 缺少 $key" >&2
      missing=1
    fi
  done
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
}

emit_secret_units() {
  local stage="$1"
  (
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    require_secret_keys
    umask 077
    install -m 0600 "$ENV_FILE" "$stage/config/.env"
    HBCDCAGENT_BFF_UPSTREAM="${HBCDCAGENT_BFF_UPSTREAM:-http://127.0.0.1:42617}"
    HBCDCAGENT_BFF_LISTEN="${HBCDCAGENT_BFF_LISTEN:-0.0.0.0:50001}"
    HBCDCAGENT_BFF_COOKIE_SECURE="${HBCDCAGENT_BFF_COOKIE_SECURE:-false}"
    USER_CENTER_SIGN_TYPE="${USER_CENTER_SIGN_TYPE:-MD5}"
    USER_CENTER_LOGIN_URL="${USER_CENTER_LOGIN_URL:-}"
    USER_CENTER_CLIENT_ID="${USER_CENTER_CLIENT_ID:-}"
    USER_CENTER_REALM="${USER_CENTER_REALM:-}"
    USER_CENTER_TERMINAL="${USER_CENTER_TERMINAL:-Web}"
    HBCDCAGENT_BFF_OPS_USER_IDS="${HBCDCAGENT_BFF_OPS_USER_IDS:-}"
    cat >"$stage/config/systemd/zeroclaw-secret.conf" <<EOF
# 由 pack-release.sh 从编译机 .env 生成。勿提交 git。
[Service]
Environment=ZEROCLAW_gateway__trusted_proxy=true
Environment=ZEROCLAW_gateway__trusted_proxy_secret=${ZEROCLAW_gateway__trusted_proxy_secret}
EOF
    cat >"$stage/config/systemd/hbcdcagent-bff.service" <<EOF
# 由 pack-release.sh 从编译机 .env 生成。勿提交 git。
[Unit]
Description=hbcdcagent BFF
After=network.target

[Service]
Environment=HBCDCAGENT_BFF_UPSTREAM=${HBCDCAGENT_BFF_UPSTREAM}
Environment=HBCDCAGENT_BFF_PUBLIC_ORIGIN=${HBCDCAGENT_BFF_PUBLIC_ORIGIN}
Environment=HBCDCAGENT_BFF_COOKIE_SECURE=${HBCDCAGENT_BFF_COOKIE_SECURE}
Environment=HBCDCAGENT_BFF_LISTEN=${HBCDCAGENT_BFF_LISTEN}
Environment=ZEROCLAW_gateway__trusted_proxy_secret=${ZEROCLAW_gateway__trusted_proxy_secret}
Environment=USER_CENTER_BASE_URL=${USER_CENTER_BASE_URL}
Environment=USER_CENTER_APP_ID=${USER_CENTER_APP_ID}
Environment=USER_CENTER_APP_KEY=${USER_CENTER_APP_KEY}
Environment=USER_CENTER_APP_SECRET=${USER_CENTER_APP_SECRET}
Environment=USER_CENTER_SIGN_TYPE=${USER_CENTER_SIGN_TYPE}
Environment=USER_CENTER_LOGIN_URL=${USER_CENTER_LOGIN_URL}
Environment=USER_CENTER_CLIENT_ID=${USER_CENTER_CLIENT_ID}
Environment=USER_CENTER_REALM=${USER_CENTER_REALM}
Environment=USER_CENTER_TERMINAL=${USER_CENTER_TERMINAL}
Environment=HBCDCAGENT_BFF_OPS_USER_IDS=${HBCDCAGENT_BFF_OPS_USER_IDS}
ExecStart=/usr/local/bin/hbcdcagent-bff
Restart=on-failure

[Install]
WantedBy=default.target
EOF
    chmod 0600 \
      "$stage/config/systemd/zeroclaw-secret.conf" \
      "$stage/config/systemd/hbcdcagent-bff.service"
  )
}

if [[ "$DO_BUILD" -eq 1 ]]; then
  build_all
fi

require_file "${BIN_DIR}/zeroclaw"
require_file "${BIN_DIR}/hbcdcagent-bff"
require_file "${BIN_DIR}/zerocode"
require_file "${WEB_DIST}/index.html"
require_file "${SCRIPT_DIR}/config.toml.template"
require_file "${SCRIPT_DIR}/env.example"
require_file "${SCRIPT_DIR}/systemd/zeroclaw-secret.conf"
require_file "${SCRIPT_DIR}/systemd/hbcdcagent-bff.service"
require_file "${SCRIPT_DIR}/scripts/start-local.sh"
require_file "${SCRIPT_DIR}/scripts/start-user-center.sh"
require_file "${SCRIPT_DIR}/scripts/common.sh"

if [[ "$WITH_SECRETS" -eq 1 ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ 缺少 $ENV_FILE" >&2
    echo "   复制 deploy/hbcdcagent/env.example 为 .env 并填写密钥后再打包" >&2
    echo "   只要占位符包则加 --no-secrets" >&2
    exit 1
  fi
fi

if [[ "$ALLOW_ANY_ARCH" -eq 0 ]]; then
  require_x86_64_elf "${BIN_DIR}/zeroclaw"
  require_x86_64_elf "${BIN_DIR}/hbcdcagent-bff"
  require_x86_64_elf "${BIN_DIR}/zerocode"
fi

STAGE="${OUT_DIR}/${PACK_NAME}"
echo "==> 暂存 ${STAGE}"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/web" "$STAGE/config/systemd" "$STAGE/scripts"

install -m 0755 "${BIN_DIR}/zeroclaw" "${BIN_DIR}/hbcdcagent-bff" "${BIN_DIR}/zerocode" "$STAGE/bin/"
cp -R "${WEB_DIST}" "$STAGE/web/dist"

install -m 0755 \
  "${SCRIPT_DIR}/scripts/start-local.sh" \
  "${SCRIPT_DIR}/scripts/start-user-center.sh" \
  "$STAGE/scripts/"
install -m 0644 \
  "${SCRIPT_DIR}/scripts/common.sh" \
  "${SCRIPT_DIR}/scripts/scripts-README.txt" \
  "$STAGE/scripts/"

install -m 0644 "${SCRIPT_DIR}/config.toml.template" "$STAGE/config/"
install -m 0644 "${SCRIPT_DIR}/env.example" "$STAGE/config/env.example"

if [[ "$WITH_SECRETS" -eq 1 ]]; then
  echo "==> 打入密钥（$ENV_FILE → config/.env + systemd，不回显）"
  emit_secret_units "$STAGE"
  cat >"$STAGE/README.txt" <<EOF
${PACK_NAME} — 数智疾控原生交付包（含现场密钥）

解压后：
  本地模拟用户:  ./scripts/start-local.sh
  用户中心 SSO:  ./scripts/start-user-center.sh
                 （已带 config/.env）

daemon 配置在 ~/.zeroclaw/config.toml（首次由脚本从模板生成，需填模型 uri）。
EOF
else
  install -m 0644 \
    "${SCRIPT_DIR}/systemd/zeroclaw-secret.conf" \
    "${SCRIPT_DIR}/systemd/hbcdcagent-bff.service" \
    "$STAGE/config/systemd/"
  cat >"$STAGE/README.txt" <<EOF
${PACK_NAME} — 数智疾控原生交付包（占位符，不含密钥）

解压后：
  本地模拟用户:  ./scripts/start-local.sh
  用户中心 SSO:  复制 config/env.example 为 config/.env 并填写密钥，
                 再 ./scripts/start-user-center.sh
EOF
  refuse_placeholder_leaks "$STAGE"
fi

(
  cd "$STAGE"
  if command -v sha256sum >/dev/null; then
    find . -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
  else
    find . -type f -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS
  fi
)

mkdir -p "$OUT_DIR"
TAR="${OUT_DIR}/${PACK_NAME}.tar.gz"
echo "==> 打包 ${TAR}"
tar -C "$OUT_DIR" -czf "$TAR" "$PACK_NAME"

echo ""
echo "完成："
ls -lh "$TAR"
if command -v sha256sum >/dev/null; then
  sha256sum "$TAR"
elif command -v shasum >/dev/null; then
  shasum -a 256 "$TAR"
fi
echo "解压目录：${STAGE}"
if [[ "$WITH_SECRETS" -eq 1 ]]; then
  echo "本包含密钥，按内网渠道传输，勿提交 git。"
fi
echo "按 scripts/scripts-README.txt 启动。"
