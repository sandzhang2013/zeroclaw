---
id: ADR-014
title: Platform pages embed only the chat pane; workbench sessions stay shared
date: 2026-08-21
status: proposed
relates-to:
  - ADR-011
  - docs/book/src/developing/platform-chat-embed.md
  - docs/book/src/developing/web.md
  - docs/book/src/gateway/web-dashboard.md
  - crates/zeroclaw-gateway/src/security_headers.rs
  - crates/zeroclaw-gateway/src/trusted_proxy.rs
  - web/src/pages/AgentChat.tsx
  - web/src/pages/ChatWorkspace.tsx
---

# ADR-014: Platform Pages Embed Only the Chat Pane; Workbench Sessions Stay Shared

This record captures the agreed embed contract for hosting the workbench
conversation on other platform pages. The route and framing exceptions are
not shipped yet. The ADR stays **proposed** until the acceptance gates below
land.

## Context

A platform BFF already injects `X-Auth-Secret` and `X-User-*` into ZeroClaw
user APIs (`gateway.trusted_proxy`). Product pages need to open a chat to
analyze page-specific data without taking the user through the full
workbench (session sidebar, folders, dashboard).

Three host shells were considered: a same-origin iframe, a floating JS
widget, and a JavaScript API. All three can share one conversation core.
The gateway today sends `X-Frame-Options: DENY` and
`Content-Security-Policy: frame-ancestors 'none'` on every HTML response,
which correctly blocks clickjacking of the ops dashboard and config UI.

Putting analysis payloads or user identity in the iframe URL would leak
into logs, Referer headers, and shared links. Query `user_id` is already
ignored by trusted-proxy auth.

## Decision

We will expose **one framable surface**: the chat embed page (target path
`/embed/chat`). Dashboard, config, logs, pairing, quickstart, and the full
workbench **must not** be offered as embeddable pages and must keep
deny-framing headers.

The embed reuses the existing conversation core (`AgentChatInner` plus
`AgentProvider`). It does not grow a second chat stack. Shells layer as:

1. Same-origin iframe of `/embed/chat` (first ship).
2. Optional floating widget that loads that same page.
3. Optional host JavaScript API (`open` / `send` / events) over
   `postMessage`, still without a second core.

Layout inside the embed:

- No left session sidebar.
- Middle transcript and composer are visible.
- Right artifacts/results pane exists and defaults to collapsed.
- Opening the embed for a page analysis creates a **new task session** for
  the current BFF user. Identity comes only from BFF headers, never from
  URL tokens or `user_id` query parameters.
- That session is written into the **same workbench session list** so the
  user can open `/workbench` later and continue the same analysis,
  including workspace artifacts.
- The session title prefers a host-supplied analysis label; otherwise it
  uses the first user message.

The host passes specified analysis data through `postMessage` or the JS
API, not through the iframe query string. Autonomy and tool approval stay
capped by the user's role. Same-origin BFF reverse-proxy is the supported
deployment; cross-origin widgets are out of scope until cookie and storage
partitioning is solved without putting secrets in frontend scripts.

Framing exceptions apply only to `/embed/chat` and only for an explicit
platform origin allowlist. A wildcard `frame-ancestors` policy is rejected.

## Consequences

Positive consequences:

- Platform pages get a fixed chat without ops surfaces in an iframe.
- One session identity spans embed and workbench, so analysis is not a
  dead-end transcript.
- Widget and JS API work can reuse the iframe page instead of forking UI.

Negative consequences:

- Gateway static/security headers must become route-aware. A mistaken
  global CSP relax would expose the dashboard to clickjacking.
- Embed-created sessions must use the workbench persistence path, so the
  embed cannot keep an isolated local-only transcript.
- Cross-origin third-party embeds remain unsupported in the first ship.

## Acceptance gates

Mark this ADR accepted only when all of the following are true:

- `/embed/chat` renders the conversation core with no left sidebar and a
  collapsed-by-default results pane.
- Automated coverage proves non-embed HTML keeps `frame-ancestors 'none'`
  (or equivalent DENY framing) and that `/embed/chat` allows only the
  configured origin list.
- Creating an embed analysis inserts a workbench session for that BFF
  user that can be resumed from `/workbench`.
- Unauthenticated or non-BFF callers cannot use the embed as a pairing
  bypass onto ops routes.

## References

- [Platform chat embed](../../developing/platform-chat-embed.md): integrator
  contract and phased delivery.
- [Building the web dashboard](../../developing/web.md)
- [Web dashboard](../../gateway/web-dashboard.md)
- [ADR-011](./ADR-011-multi-agent-runtime-boundaries.md): per-agent
  workspace and session boundaries under one daemon.
