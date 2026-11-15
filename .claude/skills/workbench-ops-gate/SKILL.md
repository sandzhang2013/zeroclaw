---
name: workbench-ops-gate
description: "Diagnose and fix ZeroClaw workbench ops pages that stay on 正在加载智能体, 加载插件目录失败: Unauthorized, or Failed to fetch dynamically imported module for Config.tsx. Use when a trusted-proxy workbench (X-Auth-Secret plus X-User-Role 管理员) gets 401 from a 0.9 config, plugin, or other ops route, when dashboard sign-in is off, when a new ops handler grows its own pairing check, when tests passed but the browser still says Unauthorized, or when the user asks to restart the local gateway and Vite dev server. Also use when a skill id was hand-written instead of allocated as skNNNN or psNNNN."
---

# Workbench ops gate

The workbench reaches the daemon through the Vite dev proxy. The proxy injects `X-Auth-Secret`, `X-User-Id`, and `X-User-Role` from the mock-login cookie. It does not send a paired bearer token, and dashboard sign-in stays off on this machine. A page that only says `Unauthorized` is the client turning a 401 into that English word.

## Which failure it is

Read the status and the URL before editing.

- **401 and the client text is `Unauthorized`.** The route never admitted the workbench identity. `require_auth` already admits an 管理员 when trusted proxy is on and the secret matches. Routes that do not call it still return 401. Config and onboarding use `config_route_auth`. `GET /api/plugins` checks pairing and a dashboard session inside `list_plugins`.
- **403.** The secret was accepted and the role is not `管理员`. Leave that refusal in place.
- **`Failed to fetch dynamically imported module` on a `src/pages/*.tsx` URL.** The dev server returned 504 for a prebundled dependency (CodeMirror, `rehype-highlight`). The page file itself is usually fine. Restart Vite. Do not treat this as an auth change.

## Admit workbench ops

Do not enable `dashboard_sign_in`. Do not turn pairing off. Do not print `trusted_proxy_secret` or paired tokens.

On a route that does not already call `require_ops_auth`, call `bff_ops_decision` while pairing is required, and drop the config read guard before any `.await`.

- `Admit`: the secret matches and the role is `管理员`. Continue. On `config_route_auth`, insert `RequestAuth` with `principal: None` and `session: None`. That is the unrestricted operator the open posture already uses, so config writes stay allowed.
- `Deny`: return that response. A wrong secret, a missing user id, or any other role must not fall through to a bearer token.
- `Absent`: no secret, or the secret is blank. Keep today's pairing and dashboard-session path.

A request with no BFF headers must still get the pair-first 401 when pairing is on. A valid paired bearer with no BFF secret must still succeed.

## Tests that would have caught it

A green `require_auth_accepts_bff_ops_when_trusted_proxy` does not cover a route that never calls `require_auth`. Web tests that stub `fetch` and return 200 for `/api/config/map-keys` do not cover the gateway.

Add a test on the handler or route the browser hits:

- 管理员 headers → 200
- `普通用户` headers → 403
- no secret, and a blank secret → the existing 401
- wrong secret, even beside a valid bearer → 401
- paired bearer alone → 200

Header values such as `管理员` are UTF-8. Build them with `HeaderValue::from_bytes`, not a client that only encodes Latin-1.

`web/src/pages/config.module-graph.test.ts` loads `Config.tsx` through a throwaway Vite server and requires the editor prebundle URLs to transform. It uses its own cache directory. A dev server that has been up for days can still 504 after that test is green; restart that process.

## Check the live page

Probe through `http://127.0.0.1:5173/hbcdcagent`, with cookie `zeroclaw_mock_user=ops` and `zeroclaw_mock_user=chenmin`. Read the secret from config inside the process and do not echo it. Expect 200 for ops, 403 for chenmin, 401 with no cookie.

This gateway build often has `wasm_plugins_available: false`. An empty plugin catalog with 200 is success. The page then explains that WASM plugins are not in the build.

## Restart

One Cargo at a time. `CARGO_INCREMENTAL=0`. Do not delete `target/debug/deps` or run `deploy/hbcdcagent/scripts/start-local.sh`.

macOS keeps serving the binary inode that was running. Replacing `target/debug/zeroclaw` does nothing until the daemon process is gone. `SIGTERM` can leave it in `U` state while it still holds the config lock; `SIGKILL` is appropriate then. Start it detached (double fork and a new session) from the repo root:

```bash
./target/debug/zeroclaw daemon
```

Append logs to `/tmp/zc-daemon-live.log`. A `nohup` inside a short-lived shell is killed when that shell exits. Wait until `http://127.0.0.1:42617/health` is 200.

Vite listens on `127.0.0.1:5173` via `npm run dev -- --host 127.0.0.1` in `web/`. Start it the same detached way. Log to `/tmp/zc-vite.log`. Confirm `/hbcdcagent/` and `/hbcdcagent/src/pages/Config.tsx` return 200, then ask for a full page refresh.

## Skill ids

Two id spaces. Do not mix them.

A skill in `.claude/skills/` is for the coding agent. Its `name` and directory are lowercase kebab-case. It does not consume `skill-seq`.

A skill the workbench runs uses a system id. Plaza and the skill center take `sk0001`–`sk9999` from `shared/skill-seq` via `POST /api/skill-ids`. Personal skills take `ps0001` onward from `shared/personal-skill-seq` via `POST /api/skill-ids?scope=personal`. Opening New advances the counter even when the form is cancelled. The directory name is that id. The visible title stays in frontmatter `name`. The model is called with the id.

`skillSlug` only cleans a title for import display. A Chinese title left as the directory name, or an English title turned into `weekly-flu`, did not go through the counter. Allocate with the POST above, then save that id as the directory. Do not invent the next number by listing folders.
