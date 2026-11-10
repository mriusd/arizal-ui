import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const docsRoot = path.resolve(rootDir, "public/docs");
const landingRoot = path.resolve(rootDir, "public/landing");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function requestHost(req: Connect.IncomingMessage): string {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  const forwarded = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim()
    .split(":")[0]
    .toLowerCase();
  return forwarded || host;
}

function resolveStaticFile(root: string, urlPath: string): string | null {
  let rel = decodeURIComponent(urlPath.split("?")[0] || "/");
  if (rel === "/" || rel === "") rel = "/index.html";
  if (rel.endsWith("/")) rel = `${rel}index.html`;

  const candidates = [rel];
  if (!path.extname(rel)) {
    candidates.push(`${rel}.html`, `${rel}/index.html`);
  }

  for (const candidate of candidates) {
    const file = path.resolve(root, `.${candidate}`);
    if (!file.startsWith(root + path.sep) && file !== root) continue;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/** Looks like an exchange market path (SPA deep link) — send apex traffic to the app host. */
function looksLikeMarketPath(urlPath: string): boolean {
  const p = decodeURIComponent(urlPath.split("?")[0] || "/").replace(/^\/+|\/+$/g, "");
  if (!p || p.includes(".")) return false;
  return /^(btc|eth)-/i.test(p) || p.length > 24;
}

function sendFile(res: Connect.ServerResponse, file: string) {
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}

/**
 * Host routing on one Vite process:
 * - arizal.xyz / www → public/landing
 * - docs.arizal.xyz → public/docs
 * - app.arizal.xyz / localhost → SPA exchange
 */
function hostSitesPlugin(): Plugin {
  const mount = (middlewares: Connect.Server) => {
    middlewares.use((req, res, next) => {
      const host = requestHost(req);
      const url = req.url || "/";

      if (host === "docs.arizal.xyz") {
        const file = resolveStaticFile(docsRoot, url);
        if (!file) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }
        sendFile(res, file);
        return;
      }

      if (host === "arizal.xyz" || host === "www.arizal.xyz") {
        if (looksLikeMarketPath(url)) {
          const dest = new URL(url, "https://app.arizal.xyz");
          res.statusCode = 302;
          res.setHeader("Location", dest.toString());
          res.end();
          return;
        }
        const file = resolveStaticFile(landingRoot, url);
        if (!file) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }
        sendFile(res, file);
        return;
      }

      next();
    });
  };

  return {
    name: "host-sites",
    configureServer(server) {
      mount(server.middlewares);
    },
    configurePreviewServer(server) {
      mount(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [react(), hostSitesPlugin()],
  appType: "spa",
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    allowedHosts: ["arizal.xyz", "www.arizal.xyz", "app.arizal.xyz", "docs.arizal.xyz"],
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true,
      },
      // Same-origin JSON-RPC so https://app.arizal.xyz does not hit loopback (PNA prompt).
      "/rpc": {
        target: "http://127.0.0.1:8545",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("wagmi") || id.includes("viem") || id.includes("@tanstack")) {
            return "web3";
          }
          if (id.includes("react-dom") || id.includes("/react/") || id.includes("\\react\\")) {
            return "react";
          }
        },
      },
    },
  },
});
