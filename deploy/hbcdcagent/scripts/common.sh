# Shared by start-local.sh and start-user-center.sh.
# Delivery pack has bin/ + web/dist only — both modes run daemon + BFF.

hbcdcagent_resolve_root() {
  local script_dir="$1"
  ROOT="$script_dir"
  if [[ ! -d "$ROOT/bin" ]]; then
    ROOT="$(cd "$script_dir/.." && pwd)"
  fi
  BIN="$ROOT/bin"
  WEB_DIST="$ROOT/web/dist"
  TEMPLATE="$ROOT/config/config.toml.template"
  ENV_FILE="$ROOT/config/.env"
  export ZEROCLAW_CONFIG_DIR="${ZEROCLAW_CONFIG_DIR:-$HOME/.zeroclaw}"
}

hbcdcagent_require_pack() {
  if [[ ! -x "$BIN/zeroclaw" ]]; then
    echo "❌ 找不到 $BIN/zeroclaw" >&2
    exit 1
  fi
  if [[ ! -x "$BIN/hbcdcagent-bff" ]]; then
    echo "❌ 找不到 $BIN/hbcdcagent-bff" >&2
    exit 1
  fi
  if [[ ! -f "$WEB_DIST/index.html" ]]; then
    echo "❌ 找不到 $WEB_DIST/index.html（交付包需要 web/dist，不是 Vite 源码）" >&2
    exit 1
  fi
  if [[ ! -f "$TEMPLATE" ]]; then
    echo "❌ 找不到 $TEMPLATE" >&2
    exit 1
  fi
}

hbcdcagent_ensure_config() {
  mkdir -p "$ZEROCLAW_CONFIG_DIR"
  local cfg="$ZEROCLAW_CONFIG_DIR/config.toml"
  if [[ ! -f "$cfg" ]]; then
    cp "$TEMPLATE" "$cfg"
    echo "⚠️  已生成 $cfg" >&2
    echo "    请填内网模型 uri 后重跑本脚本" >&2
    exit 1
  fi
}

hbcdcagent_export_runtime_env() {
  export ZEROCLAW_gateway__trusted_proxy=true
  export ZEROCLAW_gateway__host="${ZEROCLAW_gateway__host:-127.0.0.1}"
  export ZEROCLAW_gateway__port="${ZEROCLAW_gateway__port:-42617}"
  export ZEROCLAW_gateway__path_prefix="${ZEROCLAW_gateway__path_prefix:-/hbcdcagent}"
  export ZEROCLAW_gateway__web_dist_dir="${ZEROCLAW_gateway__web_dist_dir:-$WEB_DIST}"
  export ZEROCLAW_gateway__require_pairing="${ZEROCLAW_gateway__require_pairing:-false}"
  export HBCDCAGENT_BFF_UPSTREAM="${HBCDCAGENT_BFF_UPSTREAM:-http://127.0.0.1:42617}"
  export HBCDCAGENT_BFF_LISTEN="${HBCDCAGENT_BFF_LISTEN:-0.0.0.0:50001}"
}

hbcdcagent_daemon_up() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:42617/hbcdcagent/health" \
    || curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:42617/health"
}

hbcdcagent_wait_daemon() {
  local i
  for i in $(seq 1 40); do
    if hbcdcagent_daemon_up; then
      return 0
    fi
    sleep 0.25
  done
  echo "❌ daemon 未在 127.0.0.1:42617 就绪" >&2
  return 1
}

STARTED_DAEMON=0
DAEMON_PID=
BFF_PID=

hbcdcagent_start_daemon() {
  if hbcdcagent_daemon_up; then
    echo "▶ daemon 已在 127.0.0.1:42617，复用（不重复启动）"
    return 0
  fi
  echo "▶ 启动 daemon  127.0.0.1:42617  (web_dist=$ZEROCLAW_gateway__web_dist_dir)"
  "$BIN/zeroclaw" daemon --host 127.0.0.1 --port 42617 &
  DAEMON_PID=$!
  STARTED_DAEMON=1
  hbcdcagent_wait_daemon
}

hbcdcagent_start_bff() {
  echo "▶ 启动 hbcdcagent-bff  ${HBCDCAGENT_BFF_LISTEN}"
  "$BIN/hbcdcagent-bff" &
  BFF_PID=$!
}

hbcdcagent_cleanup() {
  if [[ -n "${BFF_PID:-}" ]]; then
    kill "$BFF_PID" 2>/dev/null || true
  fi
  if [[ "${STARTED_DAEMON:-0}" -eq 1 && -n "${DAEMON_PID:-}" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
}

hbcdcagent_wait() {
  if [[ -n "${BFF_PID:-}" && -n "${DAEMON_PID:-}" ]]; then
    wait "$BFF_PID" "$DAEMON_PID"
  elif [[ -n "${BFF_PID:-}" ]]; then
    wait "$BFF_PID"
  fi
}
