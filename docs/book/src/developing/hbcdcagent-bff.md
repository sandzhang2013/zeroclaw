# Platform BFF (`hbcdcagent-bff`)

The 数智疾控 workbench is the ZeroClaw web UI. User-center login does
**not** run inside `zeroclaw daemon`. Production puts a small BFF on the
workbench host in front of loopback ZeroClaw.

Chinese plan (background, stack choice, rollout, tests):
`docs/分析/数智疾控BFF实施方案.md`.
Decision record: [ADR-016](../architecture/decisions/ADR-016-hbcdcagent-bff.md).

Local development still uses Vite `injectBffIdentity` and the mock-user
cookie. Do not treat that as production login.

## Topology

```text
Browser
  → http://<workbench-host>:50001     hbcdcagent-bff
       GET /auth/callback?verifyCode=
       /hbcdcagent/*  (HTML, /api, /ws)
          strip client X-User-* / X-Auth-Secret
          set those headers from the BFF session
          → 127.0.0.1:42617           zeroclaw daemon
               path_prefix=/hbcdcagent
               trusted_proxy=true
```

Register the user-center `redirectUrl` as
`http://<workbench-host>:50001/auth/callback`, not the daemon port and
not a workbench URL that carries `userId`.

## Build and run

```sh
cargo build --release -p hbcdcagent-bff
cargo test -p hbcdcagent-bff
```

Intranet Docker (no outbound internet on the workbench host):
`docs/分析/数智疾控Docker离线部署手册.md`.

Joint debugging against the real user-center gateway (ticket, callback,
cookie, `/api/status`): `docs/分析/数智疾控BFF联调手册.md`.

Required environment (secrets stay out of git and out of
`~/.zeroclaw/config.toml`):

- `HBCDCAGENT_BFF_UPSTREAM=http://127.0.0.1:42617`
- `HBCDCAGENT_BFF_PUBLIC_ORIGIN=http://<workbench-host>:50001`
- `ZEROCLAW_gateway__trusted_proxy_secret` (same string as the daemon)
- `USER_CENTER_BASE_URL`, `USER_CENTER_APP_ID`, `USER_CENTER_APP_KEY`,
  `USER_CENTER_APP_SECRET`

Optional demo mode: set `HBCDCAGENT_BFF_LOCAL_MOCK=true` to skip SSO and
derive the identity from a `zeroclaw_mock_user` cookie instead. Allowed
ids: `chenmin`, `liuyang`, `zhoujing`, `ops` (`MOCK_USERS` in
`crates/hbcdcagent-bff/src/identity.rs`). Open
`/auth/mock?user=chenmin` to set the cookie, or load `/hbcdcagent/workbench`
without a cookie to reach the SPA picker. API and WebSocket still return
401 until a cookie is present. Demo only — do not enable in production.

The BFF does not depend on `zeroclaw-*` crates. Sign and SM4 follow
`docs/集成/用户中心集成工具类/` without executing those Java classes.

## Identity headers

Same contract as [trusted proxy](../architecture/decisions/ADR-014-platform-chat-embed.md)
and `crates/zeroclaw-gateway/src/trusted_proxy.rs`: `X-Auth-Secret`,
`X-User-Id`, `X-User-Role`, optional region/org. UTF-8 header bytes for
Chinese role/region values. Query `user_id` remains ignored by the
daemon.

Workbench HTML responses also get a `<head>` script:

`window.__ZEROCLAW_PLATFORM_USER__ = { userId, displayName, role, region, org }`
(camelCase). The SPA reads this and skips mock login. JSON, API, and
WebSocket bodies are unchanged. `displayName` is `realName`, then
`nickName`, then `accountName`, then `userId`.

Delivery-pack start scripts live in `deploy/hbcdcagent/scripts/`. Both
local mock and user-center SSO run `zeroclaw daemon` plus
`hbcdcagent-bff` against `web/dist`. Local mode sets
`HBCDCAGENT_BFF_LOCAL_MOCK=true` and logs
`/auth/mock?user=chenmin`; SSO mode loads `config/.env` and leaves mock
off. Do not point those scripts at a Vite source tree.

WebSocket proxying uses a hyper HTTP/1 upgrade so Chinese
`X-User-Role` / region / org bytes reach the daemon. `tungstenite`
`connect_async` rejects those headers (`UTF-8 encoding error`).
