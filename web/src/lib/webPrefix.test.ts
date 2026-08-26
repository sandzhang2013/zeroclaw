import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_WEB_PREFIX,
  normalizeWebPrefix,
  prefixFromViteBaseUrl,
  rewriteDevAppAssetUrl,
  stripWebPrefix,
} from "./webPrefix.ts";

test("product prefix is /hbcdcagent", () => {
  assert.equal(DEFAULT_WEB_PREFIX, "/hbcdcagent");
  assert.equal(normalizeWebPrefix(DEFAULT_WEB_PREFIX), "/hbcdcagent");
});

test("normalizeWebPrefix trims slashes", () => {
  assert.equal(normalizeWebPrefix("/hbcdcagent/"), "/hbcdcagent");
  assert.equal(normalizeWebPrefix("hbcdcagent"), "/hbcdcagent");
  assert.equal(normalizeWebPrefix("/"), "");
  assert.equal(normalizeWebPrefix(""), "");
  assert.equal(normalizeWebPrefix(undefined), "");
});

test("prefixFromViteBaseUrl ignores production asset base", () => {
  assert.equal(prefixFromViteBaseUrl("/hbcdcagent/"), "/hbcdcagent");
  assert.equal(prefixFromViteBaseUrl("/_app/"), "");
  assert.equal(prefixFromViteBaseUrl("/"), "");
});

test("rewriteDevAppAssetUrl maps gateway /_app files onto Vite public URLs", () => {
  assert.equal(
    rewriteDevAppAssetUrl("/hbcdcagent/_app/logo.png", "/hbcdcagent"),
    "/hbcdcagent/logo.png",
  );
  assert.equal(
    rewriteDevAppAssetUrl("/hbcdcagent/_app/agent-avatar.png?v=1", "/hbcdcagent"),
    "/hbcdcagent/agent-avatar.png?v=1",
  );
  assert.equal(rewriteDevAppAssetUrl("/_app/logo.png", "/hbcdcagent"), "/hbcdcagent/logo.png");
  assert.equal(rewriteDevAppAssetUrl("/_app/logo.png", ""), "/logo.png");
  assert.equal(rewriteDevAppAssetUrl("/hbcdcagent/api/status", "/hbcdcagent"), "/hbcdcagent/api/status");
});

test("stripWebPrefix peels /hbcdcagent before the gateway sees the path", () => {
  assert.equal(
    stripWebPrefix("/hbcdcagent/api/agents/deepseek/workspace", "/hbcdcagent"),
    "/api/agents/deepseek/workspace",
  );
  assert.equal(stripWebPrefix("/hbcdcagent/ws/chat", "/hbcdcagent"), "/ws/chat");
  assert.equal(stripWebPrefix("/hbcdcagent", "/hbcdcagent"), "/");
  assert.equal(stripWebPrefix("/api/status", "/hbcdcagent"), "/api/status");
});
