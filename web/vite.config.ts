import { Buffer } from "node:buffer";
import type { IncomingMessage, ClientRequest } from "node:http";
import path from "path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parseMockUserCookie } from "./src/lib/platformUser.ts";
import {
  DEFAULT_WEB_PREFIX,
  normalizeWebPrefix,
  rewriteDevAppAssetUrl,
  stripWebPrefix,
} from "./src/lib/webPrefix.ts";

const gatewayHost = process.env.ZEROCLAW_GATEWAY_HOST ?? "127.0.0.1";
const gatewayPort = process.env.ZEROCLAW_GATEWAY_PORT ?? "42617";
const gatewayTarget = `http://${gatewayHost}:${gatewayPort}`;

// Extra Host header values the dev server will accept, comma-separated, e.g.
// ZEROCLAW_WEB_ALLOWED_HOSTS=my-box.internal,dev.example.com. Unset → Vite default.
const allowedHosts = process.env.ZEROCLAW_WEB_ALLOWED_HOSTS
  ?.split(",")
  .map((h) => h.trim())
  .filter(Boolean);

/** Local stand-in for the platform BFF secret. Must match the daemon env. */
const LOCAL_BFF_SECRET =
  process.env.ZEROCLAW_gateway__trusted_proxy_secret ?? "zeroclaw-local-bff-secret";

const IDENTITY_HEADERS = [
  "x-auth-secret",
  "x-user-id",
  "x-user-role",
  "x-user-region",
  "x-user-org",
] as const;

/** Default Vite public prefix. Empty `ZEROCLAW_WEB_BASE` opts back to `/`. */
function servePrefix(): string {
  const raw = process.env.ZEROCLAW_WEB_BASE;
  return normalizeWebPrefix(raw === undefined ? DEFAULT_WEB_PREFIX : raw);
}

function utf8Header(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

/** Strip client-supplied identity, then assert the mock-login cookie as BFF headers. */
function injectBffIdentity(proxyReq: ClientRequest, req: IncomingMessage): void {
  for (const name of IDENTITY_HEADERS) {
    proxyReq.removeHeader(name);
  }
  const user = parseMockUserCookie(req.headers.cookie);
  if (!user) return;
  proxyReq.setHeader("X-Auth-Secret", LOCAL_BFF_SECRET);
  proxyReq.setHeader("X-User-Id", utf8Header(user.userId));
  proxyReq.setHeader("X-User-Role", utf8Header(user.role));
  if (user.region) proxyReq.setHeader("X-User-Region", utf8Header(user.region));
  if (user.org) proxyReq.setHeader("X-User-Org", utf8Header(user.org));
}

function gatewayProxy(prefix: string, ws = false): ProxyOptions {
  return {
    target: gatewayTarget,
    changeOrigin: true,
    ws,
    rewrite: prefix
      ? (requestPath) => stripWebPrefix(requestPath, prefix)
      : undefined,
    configure(proxy) {
      proxy.on("proxyReq", (proxyReq, req) => {
        injectBffIdentity(proxyReq, req);
      });
      proxy.on("proxyReqWs", (proxyReq, req) => {
        injectBffIdentity(proxyReq, req);
      });
    },
  };
}

const GATEWAY_PROXY_KEYS: Array<{ key: string; ws?: boolean }> = [
  { key: "/api" },
  { key: "^/acp(?:\\?.*)?$", ws: true },
  { key: "/ws", ws: true },
  { key: "/admin" },
  { key: "/health" },
  { key: "/metrics" },
  // Exact-match pairing so `/pair` does not swallow the SPA route `/pairing`.
  { key: "^/pair(?:/code)?(?:\\?.*)?$" },
  { key: "/webhook" },
  { key: "/whatsapp" },
  { key: "/linq" },
  { key: "/nextcloud-talk" },
  { key: "/hooks" },
];

function prefixProxyKey(key: string, prefix: string): string {
  if (!prefix) return key;
  if (key.startsWith("^")) {
    return `^${prefix}${key.slice(1)}`;
  }
  return `${prefix}${key}`;
}

function buildProxy(prefix: string): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {};
  for (const { key, ws } of GATEWAY_PROXY_KEYS) {
    proxy[key] = gatewayProxy(prefix, Boolean(ws));
    if (prefix) {
      proxy[prefixProxyKey(key, prefix)] = gatewayProxy(prefix, Boolean(ws));
    }
  }
  return proxy;
}

const SPA_REDIRECT_PREFIXES = [
  "/workbench",
  "/dashboard",
  "/agents",
  "/agent",
  "/config",
  "/logs",
  "/doctor",
  "/pairing",
  "/quickstart",
  "/skills",
  "/sops",
  "/runs",
  "/tools",
  "/cron",
  "/integrations",
  "/canvas",
  "/acp-console",
  "/setup",
  "/memory",
];

export default defineConfig(({ command }) => {
  const prefix = command === "serve" ? servePrefix() : "";
  return {
    base: command === "serve" ? `${prefix || ""}/` : "/_app/",
    plugins: [
      react(),
      tailwindcss(),
      // Dev-only: the production gateway serves static assets under `/_app/*` by
      // stripping that prefix and reading from `web/dist/` (see
      // crates/zeroclaw-gateway/src/static_files.rs). Vite dev doesn't know about
      // that prefix and would 404 on `/_app/logo.png`, so mirror the gateway's
      // strip-prefix behaviour here. Keeps `${basePath}/_app/...` URLs in the SPA
      // working identically in dev and prod without copying assets into a
      // `public/_app/` mirror.
      {
        name: "zeroclaw-dev-app-prefix",
        apply: "serve",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const raw = req.url ?? "/";
            const qIndex = raw.indexOf("?");
            const pathname = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
            const search = qIndex >= 0 ? raw.slice(qIndex) : "";

            if (prefix) {
              if (pathname === "/" || pathname === "") {
                res.writeHead(302, { Location: `${prefix}/workbench${search}` });
                res.end();
                return;
              }
              if (
                !pathname.startsWith(`${prefix}/`) &&
                pathname !== prefix &&
                SPA_REDIRECT_PREFIXES.some(
                  (route) => pathname === route || pathname.startsWith(`${route}/`),
                )
              ) {
                res.writeHead(302, { Location: `${prefix}${pathname}${search}` });
                res.end();
                return;
              }
            }

            const rewritten = rewriteDevAppAssetUrl(req.url ?? "/", prefix);
            if (rewritten !== req.url) {
              req.url = rewritten;
            }
            next();
          });
        },
        transformIndexHtml(html) {
          if (!prefix) return html;
          const jsonPrefix = JSON.stringify(prefix);
          const withBase = html.replace(
            "<head>",
            `<head><script>window.__ZEROCLAW_BASE__=${jsonPrefix};</script>`,
          );
          return withBase.replaceAll('href="/_app/', `href="${prefix}/_app/`);
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      outDir: "dist",
      target: ["chrome111", "edge111", "firefox113", "safari16.2"],
    },
    server: {
      allowedHosts,
      proxy: buildProxy(prefix),
    },
  };
});
