import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEmbedSession,
  embedSessionId,
  embedWsProtocol,
  rememberEmbedSession,
} from "./iframeSession.ts";

const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

test("embed session survives a refresh via sessionStorage", () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", {
    value: storage,
    configurable: true,
  });
  rememberEmbedSession(null);

  rememberEmbedSession(SESSION);
  assert.equal(storage.getItem("hbcdcagent_embed_session"), SESSION);

  // Refresh drops the module state. Re-import would, but the stored value is
  // what the next page load reads when memory is empty. Simulate that by
  // clearing memory through a rejected id after copying storage aside.
  const kept = storage.getItem("hbcdcagent_embed_session");
  rememberEmbedSession("not-a-session");
  assert.equal(embedSessionId(), null);
  storage.setItem("hbcdcagent_embed_session", kept ?? "");

  const headers = new Headers();
  applyEmbedSession(headers);
  assert.equal(headers.get("X-Hbcdcagent-Session"), SESSION);
  assert.equal(embedWsProtocol(), `hbcs.${SESSION}`);
  assert.equal(embedSessionId(), SESSION);

  rememberEmbedSession(null);
  assert.equal(storage.getItem("hbcdcagent_embed_session"), null);
  assert.equal(embedSessionId(), null);
});
