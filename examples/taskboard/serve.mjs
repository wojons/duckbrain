#!/usr/bin/env node
/**
 * Static file server for the task-board UI.
 *
 * It serves four files from ./public plus a generated /config.json, and it
 * writes nothing anywhere: all application data lives in DuckBrain, and the
 * page's fetches go straight to the daemon's table API from the browser.
 * (That is why the daemon needs the CORS/preflight middleware in
 * src/cli/http.ts to run before auth — see EXAMPLES.md.)
 *
 * Env:
 *   TASKBOARD_PORT        port for this static server        (default 8787)
 *   DUCKBRAIN_URL         daemon base URL                    (default http://127.0.0.1:28777)
 *   DUCKBRAIN_NAMESPACE   namespace the app writes to        (default taskboard)
 *   DUCKBRAIN_ADMIN_KEY   scratch admin token (demo bootstraps one)
 *   DUCKBRAIN_READER_KEY  scratch read-only token
 */
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const port = Number(process.env.TASKBOARD_PORT ?? 8787);
const host = process.env.TASKBOARD_HOST ?? "127.0.0.1";

const config = {
  baseUrl: process.env.DUCKBRAIN_URL ?? "http://127.0.0.1:28777",
  namespace: process.env.DUCKBRAIN_NAMESPACE ?? "taskboard",
  adminKey: process.env.DUCKBRAIN_ADMIN_KEY ?? "",
  readerKey: process.env.DUCKBRAIN_READER_KEY ?? "",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain" }).end("read-only server\n");
    return;
  }

  if (url.pathname === "/config.json") {
    res.writeHead(200, {
      "Content-Type": MIME[".json"],
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(config));
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const target = path.resolve(publicDir, relative);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden\n");
    return;
  }

  fs.readFile(target, (error, contents) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("not found\n");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : contents);
  });
});

server.listen(port, host, () => {
  console.log(`[taskboard] UI on http://${host}:${port}  -> daemon ${config.baseUrl} (ns: ${config.namespace})`);
});
