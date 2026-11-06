/**
 * SURFACE-PARITY-001 — read the three surfaces out of the code itself.
 *
 * No daemon, no HTTP probe, no listen(): this module builds the production
 * Express app in-process, records what it mounted, and reads the MCP tool
 * registry the same build populated. That keeps the parity test cheap enough
 * for the default suite (row criterion 3) while still grading the REAL wiring
 * rather than a second copy of it.
 *
 * Why each surface is read the way it is:
 *   - HTTP: Express 5 keeps a sub-router's mount prefix out of the layer
 *     (`layer.path`/`layer.regexp` are gone; the prefix survives only inside a
 *     matcher closure), so the prefixes are recorded by wrapping
 *     `express.application.use` for the duration of one `createHttpServer()`
 *     call and the verbs are read from each mounted router's own stack.
 *     Nothing is re-declared: delete a route and it disappears from the
 *     inventory, which is what makes the falsifier work.
 *   - MCP: the SDK's server object holds the registrations
 *     (`_registeredTools`); `createHttpServer()` registers them once per
 *     process, so the inventory reads them after the build. If a future SDK
 *     renames that field the reader throws instead of returning an empty list
 *     (an empty list would silently "pass" every matrix row).
 *   - CLI: `bin/duckbrain.ts` runs `main()` at import time and can never be
 *     imported, so its top-level verb set is read from the `switch (command)`
 *     block's `case` labels. Sub-verb dispatchers declared in the matrix are
 *     read the same way, from the named function's `case` labels.
 */

import fs from "fs";
import path from "path";
import express from "express";
import { findRepoRoot } from "./repoRoot.js";
import { createHttpServer } from "../cli/http.js";
import type { HttpServerOptions } from "../cli/http.js";
import { server } from "../mcp/server.js";

export interface SurfaceInventory {
  cli: {
    verbs: string[];
    /** `"<file>#<fn>"` → the `case` labels found in that dispatcher. */
    subcommands: Record<string, string[]>;
  };
  http: string[];
  mcp: string[];
}

/** Repo root: walk up from this file until `bin/duckbrain.ts` is found. */
export const resolveRepoRoot = findRepoRoot;

/** Return the `{...}` block that starts at the first `{` at/after `from`. */
function braceBlock(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) throw new Error("no opening brace found");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces");
}

function caseLabels(block: string): string[] {
  const labels: string[] = [];
  const re = /\bcase\s+"([^"]+)"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) labels.push(m[1]);
  return labels;
}

/** Top-level CLI verbs, read from the command switch in bin/duckbrain.ts. */
export function readCliVerbs(root = resolveRepoRoot()): string[] {
  const source = fs.readFileSync(path.join(root, "bin", "duckbrain.ts"), "utf-8");
  const at = source.indexOf("switch (command)");
  if (at < 0) throw new Error("bin/duckbrain.ts no longer has `switch (command)`");
  return [...new Set(caseLabels(braceBlock(source, at)))].sort();
}

/** `case` labels inside `<file>`'s `<fn>` (a sub-verb dispatcher). */
export function readCliSubcommands(
  file: string,
  fn: string,
  root = resolveRepoRoot(),
): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf-8");
  const at = source.search(new RegExp(`function\\s+${fn}\\s*\\(`));
  if (at < 0) throw new Error(`${file} no longer declares function ${fn}`);
  return [...new Set(caseLabels(braceBlock(source, at)))].sort();
}

interface MountRecord {
  prefix: string;
  handler: unknown;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/**
 * Build the production app once, recording every mount path and app-level
 * route. The Express application prototype is restored in `finally`; callers
 * that run this concurrently with another build in the same process would
 * interleave records, so the parity test runs it exactly once.
 */
export function observeHttpRoutes(
  options: HttpServerOptions = {},
): string[] {
  const appProto = (express as unknown as { application: Record<string, unknown> })
    .application;
  const routes: string[] = [];
  const mounts: MountRecord[] = [];
  const saved = new Map<string, unknown>();

  const restore = (): void => {
    for (const [key, value] of saved) appProto[key] = value;
    saved.clear();
  };

  try {
    const savedUse = appProto.use;
    saved.set("use", savedUse);
    appProto.use = function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === "string" && args.length >= 2) {
        mounts.push({ prefix: args[0], handler: args[1] });
      }
      return (savedUse as (...a: unknown[]) => unknown).apply(this, args);
    };

    for (const method of HTTP_METHODS) {
      const savedMethod = appProto[method];
      saved.set(method, savedMethod);
      appProto[method] = function (this: unknown, routePath: unknown, ...rest: unknown[]) {
        routes.push(`${method.toUpperCase()} ${String(routePath)}`);
        return (savedMethod as (...a: unknown[]) => unknown).call(
          this,
          routePath,
          ...rest,
        );
      };
    }

    createHttpServer(options);
  } finally {
    restore();
  }

  const all: string[] = [...routes];
  const walk = (stack: unknown[], prefix: string): void => {
    for (const layer of stack as Array<Record<string, any>>) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods ?? {}) as string[];
        for (const method of methods) {
          all.push(`${method.toUpperCase()} ${joinPath(prefix, layer.route.path)}`);
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        // Express 5 does not expose a nested mount's prefix. Surface it as an
        // undeclared key instead of guessing: the diff fails loudly and the
        // matrix gains an explicit entry.
        all.push(`NESTED-ROUTER-UNREADABLE ${prefix}`);
      }
    }
  };

  for (const mount of mounts) {
    const handler = mount.handler as { stack?: unknown[] };
    if (!handler?.stack) continue;
    walk(handler.stack, mount.prefix);
  }

  return [...new Set(all)].sort();
}

function joinPath(prefix: string, routePath: string): string {
  const left = prefix === "/" ? "" : prefix.replace(/\/$/, "");
  const right = routePath === "/" ? "" : routePath;
  const joined = `${left}${right}`;
  return joined === "" ? "/" : joined;
}

/** MCP tool names as registered on the singleton server. */
export function observeMcpTools(): string[] {
  const registry = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (!registry || typeof registry !== "object") {
    throw new Error(
      "MCP tool registry is not introspectable on this @modelcontextprotocol/sdk build " +
        "(expected the server's _registeredTools map) — refusing to report an empty surface",
    );
  }
  return Object.keys(registry).sort();
}

export interface ObserveOptions {
  /** Passed straight to createHttpServer (auth/namespace overrides for tests). */
  httpOptions?: HttpServerOptions;
  root?: string;
}

/** Full inventory. Build order matters: the HTTP build registers the MCP tools. */
export function observeInventory(options: ObserveOptions = {}): SurfaceInventory {
  const root = options.root ?? resolveRepoRoot();
  const http = observeHttpRoutes(options.httpOptions ?? {});
  const mcp = observeMcpTools();
  return {
    cli: { verbs: readCliVerbs(root), subcommands: {} },
    http,
    mcp,
  };
}
