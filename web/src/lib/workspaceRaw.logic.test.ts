import assert from "node:assert/strict";
import test from "node:test";

import { rememberEmbedSession } from "./iframeSession.ts";

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("workspace raw fetch sends the embed session instead of a naked URL", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
    writable: true,
  });
  const { fetchWorkspaceRaw } = await import("./api.ts");
  rememberEmbedSession(SESSION);
  const calls: { url: string; header: string | null; credentials: RequestCredentials | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      header: headers.get("X-Hbcdcagent-Session"),
      credentials: init?.credentials,
    });
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as typeof fetch;
  try {
    const blob = await fetchWorkspaceRaw("hbcdc", "sessions/a/report.html");
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call);
    assert.match(call.url, /\/api\/agents\/hbcdc\/workspace\/raw\?/);
    assert.match(call.url, /path=sessions%2Fa%2Freport\.html/);
    assert.equal(call.url.includes(SESSION), false);
    assert.equal(call.header, SESSION);
    assert.equal(call.credentials, "same-origin");
    assert.equal(blob.size, 3);
  } finally {
    globalThis.fetch = original;
    rememberEmbedSession(null);
  }
});
