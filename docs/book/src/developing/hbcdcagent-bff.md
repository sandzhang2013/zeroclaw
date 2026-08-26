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

The BFF does not depend on `zeroclaw-*` crates. Sign and SM4 follow
`docs/集成/用户中心集成工具类/` without executing those Java classes.

## Identity headers

Same contract as [trusted proxy](../architecture/decisions/ADR-014-platform-chat-embed.md)
and `crates/zeroclaw-gateway/src/trusted_proxy.rs`: `X-Auth-Secret`,
`X-User-Id`, `X-User-Role`, optional region/org. UTF-8 header bytes for
Chinese role/region values. Query `user_id` remains ignored by the
daemon.
