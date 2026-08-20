import { Buffer } from "node:buffer";
import type { IncomingMessage, ClientRequest } from "node:http";
import path from "path";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { parseMockUserCookie } from "./src/lib/platformUser.ts";

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

function gatewayProxy(ws = false): ProxyOptions {
  return {
    target: gatewayTarget,
    changeOrigin: true,
    ws,
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

export default defineConfig(({ command }) => ({
  base: command === "serve" ? "/" : "/_app/",
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
        server.middlewares.use((req, _res, next) => {
          if (req.url?.startsWith("/_app/")) {
            req.url = req.url.slice("/_app".length);
          }
          next();
        });
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
    proxy: {
      "/api": gatewayProxy(),
      "^/acp(?:\\?.*)?$": gatewayProxy(true),
      "/ws": gatewayProxy(true),
      "/admin": gatewayProxy(),
      "/health": gatewayProxy(),
      "/metrics": gatewayProxy(),
      // Exact-match the gateway pairing endpoints (/pair, /pair/code) so the
      // prefix doesn't swallow the client route /pairing — a bare "/pair" key
      // proxies /pairing to the gateway, which serves its own built UI and
      // breaks a refresh on the pairing page (same fix as the /acp regex above).
      "^/pair(?:/code)?(?:\\?.*)?$": gatewayProxy(),
      "/webhook": gatewayProxy(),
      "/whatsapp": gatewayProxy(),
      "/linq": gatewayProxy(),
      "/nextcloud-talk": gatewayProxy(),
      "/hooks": gatewayProxy(),
    },
  },
}));
