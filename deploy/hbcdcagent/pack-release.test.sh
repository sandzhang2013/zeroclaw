#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PACK="${ROOT}/deploy/hbcdcagent/pack-release.sh"

bash -n "$PACK"

help_out="$("$PACK" --help)"
echo "$help_out" | grep -q -- --no-secrets

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/web"
: >"$tmp/bin/zeroclaw"
: >"$tmp/bin/hbcdcagent-bff"
: >"$tmp/bin/zerocode"
echo '<html></html>' >"$tmp/web/index.html"

if BIN_DIR="$tmp/bin" WEB_DIST="$tmp/web" OUT_DIR="$tmp/out" \
  "$PACK" --allow-any-arch --no-secrets 'bad/name' >/dev/null 2>&1; then
  echo "expected invalid PACK_NAME to fail" >&2
  exit 1
fi

if BIN_DIR="$tmp/missing" WEB_DIST="$tmp/web" OUT_DIR="$tmp/out" \
  "$PACK" --allow-any-arch --no-secrets smoke-pack >/dev/null 2>&1; then
  echo "expected missing binaries to fail" >&2
  exit 1
fi

BIN_DIR="$tmp/bin" WEB_DIST="$tmp/web" OUT_DIR="$tmp/out" \
  "$PACK" --allow-any-arch --no-secrets smoke-pack >/dev/null

tar -tzf "$tmp/out/smoke-pack.tar.gz" | grep -q 'smoke-pack/scripts/start-local.sh'
tar -tzf "$tmp/out/smoke-pack.tar.gz" | grep -q 'smoke-pack/config/env.example'
if tar -tzf "$tmp/out/smoke-pack.tar.gz" | grep -E '(^|/)config/\.env$' >/dev/null; then
  echo "--no-secrets pack must not contain config/.env" >&2
  exit 1
fi
if grep -q '^\./SHA256SUMS ' "$tmp/out/smoke-pack/SHA256SUMS"; then
  echo "SHA256SUMS must not checksum itself" >&2
  exit 1
fi
grep -q 'replace-with-long-random' "$tmp/out/smoke-pack/config/env.example"

cat >"$tmp/secrets.env" <<'EOF'
ZEROCLAW_gateway__trusted_proxy_secret=0123456789abcdef0123456789abcdef
HBCDCAGENT_BFF_PUBLIC_ORIGIN=http://127.0.0.1:50001
USER_CENTER_BASE_URL=http://uc.example
USER_CENTER_APP_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
USER_CENTER_APP_KEY=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
USER_CENTER_APP_SECRET=cccccccccccccccccccccccccccccccc
EOF

BIN_DIR="$tmp/bin" WEB_DIST="$tmp/web" OUT_DIR="$tmp/out" ENV_FILE="$tmp/secrets.env" \
  "$PACK" --allow-any-arch secret-pack >/dev/null

tar -tzf "$tmp/out/secret-pack.tar.gz" | grep -q 'secret-pack/config/.env'
tar -tzf "$tmp/out/secret-pack.tar.gz" | grep -q 'secret-pack/config/systemd/hbcdcagent-bff.service'
grep -q 'USER_CENTER_APP_ID=' "$tmp/out/secret-pack/config/.env"

if BIN_DIR="$tmp/bin" WEB_DIST="$tmp/web" OUT_DIR="$tmp/out" ENV_FILE="$tmp/missing.env" \
  "$PACK" --allow-any-arch missing-env >/dev/null 2>&1; then
  echo "expected missing ENV_FILE to fail" >&2
  exit 1
fi

echo "pack-release.test.sh ok"
