---
title: Platform chat embed
status: proposed
relates-to:
  - docs/book/src/architecture/decisions/ADR-014-platform-chat-embed.md
---

# Platform chat embed

Status: **agreed design, not shipped.** Durable boundaries live in
[ADR-014](../architecture/decisions/ADR-014-platform-chat-embed.md). This page
is the integrator contract those boundaries imply. Do not treat the
`/embed/chat` path as live until that ADR is accepted.

The workbench is a three-pane shell: session list, conversation, artifacts.
Platform product pages need the conversation (and optional artifacts) to
analyze page-specific data. They must not iframe the ops dashboard, config,
logs, pairing, or the full workbench.

## What the host sees

When a platform page opens the embed for an analysis:

1. The current BFF user gets a **new task session** (new session UUID).
2. The iframe shows the **middle conversation pane**.
3. The **right artifacts/results pane** exists and starts **collapsed**.
4. The **left session sidebar is omitted**.
5. The new session is appended to the **same workbench session list** for
   that user. Opening `/workbench` later resumes the same analysis,
   including files written under the session workspace.

Title the session with a host-supplied analysis label when one exists
(for example an order or ticket id). Otherwise use the first user message.

## What must never be embeddable

These surfaces stay deny-framed (`X-Frame-Options: DENY` and
`frame-ancestors 'none'`):

- `/dashboard` and other ops routes (config, logs, doctor, cron, skills)
- `/workbench` (full three-pane shell)
- pairing, quickstart, and gateway-served HTML other than `/embed/chat`

Only `/embed/chat` may receive a `frame-ancestors` allowlist, and only for
explicit platform origins. Do not use `*`.

## Identity and data

| Fact | Source of truth |
| --- | --- |
| Who the user is | Platform BFF headers (`X-Auth-Secret`, `X-User-Id`, `X-User-Role`, optional region/org). Query `user_id` is ignored. |
| Which agent | Host configuration (for example `agent=deepseek` on the embed URL). |
| Which session | Newly created UUID, persisted on the workbench session list for that user. |
| Analysis payload | Host `postMessage` or JS API body, not the iframe query string. |

Do not put tokens, secrets, or the analysis dataset in the iframe URL.
Those values leak through logs, Referer, and copied links.

Same-origin BFF reverse-proxy is the supported deployment: the product page
and `/embed`, `/api`, `/ws` share a site so `SameSite=Lax` cookies work.
Cross-origin floating widgets are deferred; third-party cookie and storage
partitioning would otherwise drop the login.

## Shells (same core)

All three host shells reuse `AgentChatInner` plus `AgentProvider`. They do
not fork a second chat implementation.

| Shell | First ship? | Host integration |
| --- | --- | --- |
| iframe of `/embed/chat` | Yes | Always-visible pane on a product or help page. |
| Floating JS widget | After iframe | Script shows a launcher; the panel still loads `/embed/chat`. |
| JavaScript API | After widget | `open` / `send` / events (`message`, `approval`) with origin checks. Host scripts cannot raise autonomy or skip tool approval. |

Suggested host open (not implemented yet):

```text
open({
  agent: "deepseek",
  title: "Analyze order 123",
  context: { /* page-specific analysis data */ }
})
```

That call creates the workbench-visible session, then sends `context` as
the first turn (or an equivalent structured prompt), then shows the embed
with the results pane collapsed.

## Deployment

`/embed/chat` is not shipped yet. The layout below is how to run the **whole
current stack** on a server: daemon, workbench UI, per-user sessions, and
the platform BFF. Point product pages at `/embed/chat` only after
[ADR-014](../architecture/decisions/ADR-014-platform-chat-embed.md) is
accepted.

### What runs

| Process | Listens | Role |
| --- | --- | --- |
| ZeroClaw daemon | `127.0.0.1:42617` only | Agents, tools, sessions, `/api`, `/ws`, static `/workbench` |
| Platform app + BFF | `:443` (public) | Login, product pages, identity injection, reverse proxy |
| Optional MCP (for example a disease server) | loopback only | Tools the agent calls; not a public port |

Vite on `:5174` is a laptop stand-in for the BFF. Do not run it as the
server front door.

Official container defaults (`allow_public_bind = true`,
`require_pairing = false`, published `:42617`) are the wrong posture for
this product. Do not expose the daemon port.

### Topology

```text
Internet
  →  https://app.example.com:443     platform TLS + BFF
        reverse_proxy  /workbench /api /ws [/embed]
          →  127.0.0.1:42617
        strip client X-User-* / X-Auth-Secret
        set those headers from the platform session
  →  ZeroClaw daemon (systemd)       127.0.0.1:42617
        trusted_proxy = true
        data dir  ~/.zeroclaw  (or a dedicated service home)
```

Firewall: public `443` (and `80` for ACME). `42617` stays on loopback.
MCP ports stay on loopback.

### Build and install the daemon

Use the branch that contains the workbench and trusted-proxy work, not a
stock image that predates it.

On the server (or in CI, then copy the artifacts):

```sh
cargo web build
cargo build --release --bin zeroclaw
sudo install -m 0755 target/release/zeroclaw /usr/local/bin/zeroclaw
```

`cargo web build` writes `web/dist/`. A release daemon serves that tree
when `web/dist` sits next to the source checkout the process can see, or
when `gateway.web_dist_dir` points at the copied bundle. Rebuild both
whenever the UI changes: an old `web/dist` plus a new binary (or the
reverse) is a common production footgun. See
[Building the web dashboard](./web.md) and
[Web dashboard](../gateway/web-dashboard.md).

Create a dedicated OS user if this is a shared box. Keep
`~/.zeroclaw/config.toml` (agents, providers, `mcp_bundles`) on that
user. Put `api_key` and `trusted_proxy_secret` in the service
environment, not in git.

```sh
zeroclaw service install
sudo loginctl enable-linger "$USER"
systemctl --user edit zeroclaw.service
```

Override:

```ini
[Service]
Environment=ZEROCLAW_gateway__trusted_proxy=true
Environment=ZEROCLAW_gateway__trusted_proxy_secret=<same-secret-as-bff>
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now zeroclaw
journalctl --user -u zeroclaw -f
```

Confirm `Gateway listening on http://127.0.0.1:42617`. Details:
[Service management](../setup/service.md).

### Platform BFF (required)

Multi-user isolation does not work if browsers talk to `:42617`
directly. The BFF must:

- Share origin with the product pages (`https://app.example.com`).
- Proxy `/api` and `/ws` (WebSocket upgrade).
- Proxy `/workbench` (and later `/embed`) to the daemon.
- Inject `X-Auth-Secret`, `X-User-Id`, `X-User-Role` from the **server
  session**. Ignore client-supplied identity headers.
- Use the same secret string as `ZEROCLAW_gateway__trusted_proxy_secret`.

When the workbench cannot share the portal origin, run
[`hbcdcagent-bff`](./hbcdcagent-bff.md) on the workbench host
([ADR-016](../architecture/decisions/ADR-016-hbcdcagent-bff.md)). Do not
put user-center secrets in the daemon.

After the embed ships, a product page iframes
`/embed/chat?agent=<alias>` on that origin. Analysis payloads use
`postMessage`, not the query string.

### Health checks

From the server:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:42617/health
```

Through the BFF, with a real logged-in cookie:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Cookie: <platform-session>" \
  https://app.example.com/api/status
```

Expect `200` for ops or a normal user on `/api/status`. Direct
`https://server:42617` from the internet should fail (port closed).

### Do not

- Publish `:42617` on the LAN or internet as the user URL.
- Run the official image with pairing off and a public bind for this
  layout.
- Relax `frame-ancestors` for `/dashboard` or `/workbench`.
- Put provider keys or the BFF secret in the image or in git.

TLS termination in front of a loopback gateway:
[Network deployment](../ops/network-deployment.md).

## Implementation notes

When the route ships:

- Skip device pairing on `/embed/chat` the same way `/workbench` does in
  BFF mode. Pairing remains required for the gateway-served ops dashboard
  on the daemon port.
- Namespace embed session keys so a new analysis does not reuse the
  workbench default per-agent UUID, while still writing the new row into
  the workbench folder/session snapshot.
- Keep workbench chrome (folder tree, right-pane toggle as a workbench
  layout control, dashboard link) out of the embed. The embed may still
  expose a control to expand the results pane.

## Related

- [ADR-014](../architecture/decisions/ADR-014-platform-chat-embed.md)
- [Building the web dashboard](./web.md)
- [Web dashboard](../gateway/web-dashboard.md)
- [Gateway HTTP API](../gateway/api.md)
