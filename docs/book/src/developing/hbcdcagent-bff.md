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
  → http://<workbench-host>:50002     hbcdcagent-bff
       GET /hbcdcagent/auth/health
       GET /hbcdcagent/auth/callback?verifyCode=
       /hbcdcagent/*  (HTML, /api, /ws)
          strip client X-User-* / X-Auth-Secret
          set those headers from the BFF session
          → 127.0.0.1:42617           zeroclaw daemon
               path_prefix=/hbcdcagent
               trusted_proxy=true
```

Register the user-center `redirectUrl` as
`http://<workbench-host>:50002/hbcdcagent/auth/callback`, not the daemon port and
not a workbench URL that carries `userId`.

Direct workbench visits redirect to the login URL with a random `state`
(HttpOnly cookie + query on `redirectUrl`). The callback rejects a
mismatch. Portal jumps that carry only `verifyCode` (no BFF `state`) still
succeed: the user-center document treats `verifyCode` as one-time for
`/sso/code/userInfo`, but does not bind it to the browser that started
login. That leftover login-CSRF window is the portal path; close it on
the user-center side if they add a bound `state`.

BFF-owned login routes live under `/hbcdcagent/auth/*` so an nginx
`location /hbcdcagent` can forward the whole prefix. Probe the BFF
process at `/hbcdcagent/auth/health` (`ok`). `GET /hbcdcagent/health`
is the daemon JSON snapshot and is proxied without a session. Session
cookies use `Path=/hbcdcagent`.

`GET/POST /hbcdcagent/auth/logout` clears the session cookie, the SSO
`state` cookie, and `zeroclaw_mock_user`. If `USER_CENTER_LOGOUT_URL` is
set, the browser is sent there; otherwise SSO mode shows a logged-out
page instead of bouncing back into SSO.

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

- `HBCDCAGENT_BFF_UPSTREAM=http://127.0.0.1:42617` (http origin only;
  https is rejected at startup: the proxy and WebSocket splice are TCP)
- `HBCDCAGENT_BFF_PUBLIC_ORIGIN=http://<workbench-host>:50002`
- `ZEROCLAW_gateway__trusted_proxy_secret` (same string as the daemon)
- `USER_CENTER_BASE_URL`, `USER_CENTER_APP_ID`, `USER_CENTER_APP_KEY`,
  `USER_CENTER_APP_SECRET`

Alert-system encrypted tickets (AES-256-GCM, separate from user-center SM4)
are optional. Set both `HBCDCAGENT_SSO_CLIENT_ID` and `HBCDCAGENT_SSO_KEY_B64`
(32-byte key, standard Base64). `HBCDCAGENT_SSO_KEY_VERSION` defaults to `1`.
The BFF reads them at startup and serves `POST /hbcdcagent/sso/auth/verify`
(also `POST /sso/auth/verify`). A top-level browser opening
`/hbcdcagent/workbench…?clientId=&verifyData=` with no session is verified
on that GET: a valid ticket sets `hbcdcagent_session` and redirects to the
same path without those parameters. An iframe navigation (`Sec-Fetch-Dest:
iframe`) is not verified on the GET. The page script still has the ticket,
posts it with `X-Hbcdcagent-Embed: 1`, and keeps `sessionId` in memory.
Static `/_app/` files load without a session so that script can run. Leave
both variables unset to keep the endpoint closed. Do not put the key in
`config.toml` or git.

When 智能预警 embeds the workbench, the page loads `docs/集成/iframe-bridge.js`
(copied to `/_app/iframe-bridge.js` at build time) only inside an iframe or
popup. The parent sends `ai:ask` as part of opening the iframe, before or
after the handshake; messages sent early stay queued. The workbench collapses the session
sidebar, sends `content` immediately, and keeps `provideData` out of the
visible transcript. Add `embed=chat` to that workbench URL to open the
conversation directly, without the session sidebar, homepage, or results
pane. Other query values, including a ticket's `clientId` and `verifyData`,
keep the full workbench. The page answers with `{ accepted, sessionId, mode: "new" }`
and later emits `ai:done`. Set `HBCDCAGENT_BFF_FRAME_ANCESTORS` to the
parent origins (`https://alert.example`, comma-separated). An empty value
keeps `frame-ancestors 'none'`. Do not use `*`. Cross-site iframes on
plain HTTP cannot store the `SameSite=Lax` cookie; the verify response
then includes `sessionId` only when the page sends `X-Hbcdcagent-Embed: 1`,
and the workbench keeps that id in memory. Step-by-step integrator
instructions are in `docs/集成/嵌入开发说明.md`.

Optional demo mode: set `HBCDCAGENT_BFF_LOCAL_MOCK=true` to skip SSO and
derive the identity from a `zeroclaw_mock_user` cookie instead. Allowed
ids: `chenmin`, `liuyang`, `zhoujing`, `ops` (`MOCK_USERS` in
`crates/hbcdcagent-bff/src/identity.rs`). Open
`/hbcdcagent/auth/mock?user=chenmin` to set the cookie, or load `/hbcdcagent/workbench`
without a cookie to reach the SPA picker. Optional `next` must be a path
under `/hbcdcagent/workbench` (for example `?embed=chat`); anything else
falls back to the workbench root. The embed example uses this so a local
iframe opens as 陈敏, an ordinary user. API and WebSocket still return
401 until a cookie is present. Demo only: do not enable in production.

The BFF does not depend on `zeroclaw-*` crates. Sign and SM4 follow
`docs/集成/用户中心集成工具类/` without executing those Java classes.

## Identity headers

Same contract as [trusted proxy](../architecture/decisions/ADR-014-platform-chat-embed.md)
and `crates/zeroclaw-gateway/src/trusted_proxy.rs`: `X-Auth-Secret`,
`X-User-Id`, `X-User-Role`, optional region/org. `X-User-Region` comes from
`POST /console/tenant/detail` after the `verifyCode` exchange, selected by
`devisionType`: `1` → `provinceCode`, `2` → `cityCode`, `3` → `districtCode`.
UTF-8 header bytes for
Chinese role/region values. Query `user_id` remains ignored by the
daemon. MCP geography: non-ops calls are rewritten to the frozen
`X-User-Region`. Admin (`管理员`) calls follow the user turn text: no named
city → `全省`; an explicit city (e.g. 武汉) → that city. Model-chosen
geography is ignored when it disagrees with the user text. The system
prompt also tells the model that an upstream “全省 = 武汉哨点口径”
footnote is the API’s province-wide mapping, not workbench isolation:
city logins stay on their city and must not repeat that note.
Workbench
autonomy (`只读` / `监督` / `自主`) is a per-message overlay; the risk
profile `level` is the ceiling (delivery template uses `full` so ops can
raise to 自主; ordinary users stay capped at 监督).

Workbench HTML responses also get a `<head>` script:

`window.__ZEROCLAW_BASE__ = "/hbcdcagent"` and
`window.__ZEROCLAW_PLATFORM_USER__ = { userId, displayName, role, region, org }`
(camelCase). The SPA reads the prefix so `/api` and `/ws` stay under
`/hbcdcagent` (cookie `Path=/hbcdcagent` is then sent; a missing prefix
opens `ws://…/ws/chat` and the browser reports close 1006). It also
skips mock login and the device pairing gate. JSON, API, and WebSocket
bodies are unchanged. `displayName` is `realName`, then `nickName`, then
`accountName`, then `userId`.

Delivery-pack start scripts live in `deploy/hbcdcagent/scripts/`. Both
local mock and user-center SSO run `zeroclaw daemon` plus
`hbcdcagent-bff` against `web/dist`. Local mode sets
`HBCDCAGENT_BFF_LOCAL_MOCK=true` and logs
`/hbcdcagent/auth/mock?user=chenmin`; SSO mode loads `config/.env` and leaves mock
off. Do not point those scripts at a Vite source tree.

Opening the workbench with no session renders a self-contained Chinese
page titled 无法进入工作台. It tells the user to open a ticket URL from
省统筹平台, or to enter from the 省统筹平台门户 item 「数智疾控」. The
steps are the alert ticket (`clientId` + `verifyData` on the workbench
URL, or `POST /hbcdcagent/sso/auth/verify`) and the portal callback (`verifyCode` to
`/hbcdcagent/auth/callback`). It
does not ask for `USER_CENTER_LOGIN_URL`, `USER_CENTER_CLIENT_ID`, or
`USER_CENTER_REALM`. Callback failures still list the verifyCode steps
(callback, `/sso/code/userInfo`, `/console/tenant/detail`, session) with
status 已配置 / 通过 / 未配置 / 失败 / 未执行. Secrets are not shown.
API and WebSocket still return `401 login required` as text.

WebSocket proxying splices the HTTP upgrade onto the daemon so Chinese
`X-User-Role` / region / org bytes and `zeroclaw.v1` pass through.
Terminating the socket in the BFF (tungstenite `connect_async`) produced
browser close code 1006 (`UTF-8 encoding error` or dropped frames).
