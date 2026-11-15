import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";

// Clicking 配置 loads Config.tsx as a dynamic import. That page pulls the
// markdown editor, which Vite serves from its prebundle. A long-lived dev
// server whose prebundle files are gone answers those URLs with 504, and the
// browser reports the failure against Config.tsx. This walks a fresh server's
// module graph, including those prebundled files, with its own cache so it
// does not touch the dev server already listening on 5173.

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
// transformRequest wants the root URL. The browser asks for the same file
// under the /hbcdcagent base; Vite resolves that from this path.
const ENTRY = "/src/pages/Config.tsx";
const IMPORT_RE = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;
const REQUIRED = ["rehype-highlight", "react-codemirror", "lang-markdown"];

function shouldFollow(fromUrl: string, spec: string): boolean {
  if (spec.includes("${") || spec.includes(" ") || spec.startsWith("data:")) return false;
  // Prebundled files contain sample import strings in comments. The browser
  // does not fetch those, and neither does this walk.
  const fromDeps = fromUrl.includes("/.vite/deps/") || fromUrl.includes("/@fs/");
  if (spec.startsWith(".")) return !fromDeps && fromUrl.includes("/src/");
  if (spec.startsWith("/hbcdcagent/src/") || spec.startsWith("/src/")) return true;
  // Default cache URLs contain `/.vite/deps/`. An isolated cache uses `/@fs/<dir>/deps/`.
  if (/\/deps\/[^"'?/]+\.(js|css)(\?|$)/.test(spec)) return true;
  if (
    spec.startsWith("/hbcdcagent/@vite/") ||
    spec.startsWith("/@vite/") ||
    spec.startsWith("/hbcdcagent/@react-refresh") ||
    spec.startsWith("/@react-refresh")
  ) {
    return true;
  }
  return false;
}

function resolveSpec(fromUrl: string, spec: string): string {
  if (spec.startsWith("/")) return spec;
  const base = fromUrl.split("?", 1)[0] ?? fromUrl;
  const dir = base.slice(0, base.lastIndexOf("/") + 1);
  const joined = path.posix.normalize(dir + spec);
  return joined.startsWith("/") ? joined : `/${joined}`;
}

/** Browser URLs include the dev base. transformRequest is rooted at `/`. */
function requestUrl(url: string): string {
  const prefix = "/hbcdcagent";
  return url.startsWith(`${prefix}/`) ? url.slice(prefix.length) : url;
}

test("the config page module graph includes its prebundled editor deps", { timeout: 180_000 }, async () => {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "zc-config-graph-"));
  let server: ViteDevServer | undefined;
  try {
    server = await createServer({
      configFile: path.join(webRoot, "vite.config.ts"),
      root: webRoot,
      cacheDir,
      server: { middlewareMode: true },
    });

    const seen = new Map<string, string>();
    const pending = [ENTRY];
    const failures: string[] = [];

    while (pending.length > 0) {
      const url = pending.pop()!;
      if (seen.has(url)) continue;
      let code = "";
      try {
        const result = await server.transformRequest(requestUrl(url));
        code = result?.code ?? "";
      } catch (error) {
        failures.push(`${url} ${error instanceof Error ? error.message : String(error)}`);
        seen.set(url, "");
        continue;
      }
      if (!code) {
        failures.push(`${url} empty`);
        seen.set(url, "");
        continue;
      }
      seen.set(url, code);
      const base = url.split("?", 1)[0] ?? url;
      if (!/\.(tsx?|jsx?|mjs|css)$/.test(base) && !/\/deps\/[^/]+\.(js|css)$/.test(base)) continue;
      for (const line of code.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (!trimmed.startsWith("import ") && !trimmed.startsWith("export ")) continue;
        for (const match of trimmed.matchAll(IMPORT_RE)) {
          const spec = match[1];
          if (!spec || !shouldFollow(url, spec)) continue;
          const next = resolveSpec(url, spec);
          if (!seen.has(next)) pending.push(next);
        }
      }
    }

    assert.equal(failures.length, 0, failures.join("\n"));
    const urls = [...seen.keys()].join("\n");
    for (const needle of REQUIRED) {
      assert.match(urls, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.ok(seen.size > 10, `graph too small: ${seen.size}`);
  } finally {
    await Promise.race([
      server?.close(),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
