---
id: ADR-016
title: User-center login lives in a separate BFF process, not in ZeroClaw
date: 2026-08-22
status: accepted
relates-to:
  - ADR-014
  - docs/book/src/developing/hbcdcagent-bff.md
  - docs/分析/数智疾控BFF实施方案.md
  - crates/hbcdcagent-bff
  - crates/zeroclaw-gateway/src/trusted_proxy.rs
---

# ADR-016: User-Center Login Lives in a Separate BFF Process

## Context

The 数智疾控 workbench is the ZeroClaw web UI. Users sign in on the
provincial portal, then open the workbench. The portal and the workbench
are different origins (different hosts). Portal cookies do not arrive on
the workbench host. Same-origin reverse-proxy of `/hbcdcagent` through
the portal is not available. The workbench host has no JVM.

ZeroClaw already authenticates user APIs with `gateway.trusted_proxy`:
the daemon checks `X-Auth-Secret` and freezes `X-User-*`. Query `user_id`
is ignored. Putting user-center `appSecret`, SM4, `/auth/ticket`, or
`/sso/code/userInfo` inside `zeroclaw daemon` would mix login secrets
into the agent process.

Local Vite `injectBffIdentity` is a development stand-in only.

## Decision

Ship **`hbcdcagent-bff`**, a separate Axum binary in
`crates/hbcdcagent-bff`. It:

1. Exchanges `verifyCode` with the user-center OpenAPI (`/auth/ticket`
   then `/sso/code/userInfo`), then loads tenant `cityCode` from
   `/console/tenant/detail`, using a Rust port of the vendor sign/SM4
   rules.
2. Stores identity in a server-side session and an HttpOnly cookie on
   the workbench origin.
3. Reverse-proxies `/hbcdcagent` (HTTP and WebSocket) to loopback
   ZeroClaw **without stripping the prefix**, after stripping
   client-supplied identity headers and writing trusted-proxy headers.
   Login itself is `/hbcdcagent/auth/callback` so the user-center
   `redirectUrl` shares the workbench prefix; the BFF handles `/hbcdcagent/auth/*`
   before proxying.

The daemon stays login-free. Java vendor utilities stay reference
implementations; they are not run on the workbench host.

## Consequences

- Two processes on the workbench host: BFF on the public port, daemon on
  `127.0.0.1:42617`.
- `appSecret` lives only in BFF environment variables.
  `trusted_proxy_secret` is shared by BFF and daemon environment
  variables.
- Role mapping remains BFF-owned. Non-ops users default to `普通用户`.
  `X-User-Region` is the tenant `cityCode` from `/console/tenant/detail`.
- In-memory sessions are single-instance; a restart requires a new
  `verifyCode` callback.
- `HBCDCAGENT_BFF_UPSTREAM` must be an `http` origin. Parse failures and
  `https` abort startup; the proxy does not fall back to
  `127.0.0.1:42617`.
- BFF-initiated SSO binds a `state` cookie to the callback. Portal
  `verifyCode`-only callbacks stay allowed until the user-center binds
  the code to the initiating browser.

## Acceptance

- `cargo test -p hbcdcagent-bff` and crate clippy pass.
- A callback with `verifyCode` sets the session cookie and redirects to
  `/hbcdcagent/workbench` without the code in the URL. A BFF-issued
  `state` cookie must match the callback `state` query when either is
  present.
- Forged `X-User-*` from the browser do not survive the proxy.
- The daemon is not reachable as the user entry port.
