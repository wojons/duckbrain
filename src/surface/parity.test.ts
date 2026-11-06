/**
 * SURFACE-PARITY-001 — nothing prevents surface drift.
 *
 * These tests grade the real wiring, not a copy of it: the HTTP route set is
 * read from the app `createHttpServer()` actually builds, the MCP tool set from
 * the registrations that build made, and the CLI verb set from the command
 * switch in bin/duckbrain.ts. `src/surface/capabilities.ts` must agree with all
 * three in both directions.
 *
 * Cheap by construction (row criterion 3): the app is built in process and
 * never listens, no daemon is scraped, no port is opened.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { CAPABILITIES, type Capability } from "./capabilities";
import {
  observeHttpRoutes,
  observeInventory,
  readCliSubcommands,
  resolveRepoRoot,
  type SurfaceInventory,
} from "./inventory";
import { compareSurface, describeIssues } from "./parity";
import {
  GENERATED_BEGIN,
  GENERATED_END,
  pendingSurfaces,
  renderSurfaceMarkdown,
} from "./render";

const root = resolveRepoRoot();
let tmp: string;
let inventory: SurfaceInventory;
const previousEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "DUCKBRAIN_NAMESPACES_PATH",
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_UI_DIST_DIR",
];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-surface-parity-"));
  const nsRoot = path.join(tmp, "namespaces");
  const uiRoot = path.join(tmp, "ui"); // no index.html → the "UI not built" branch
  fs.mkdirSync(nsRoot, { recursive: true });
  fs.mkdirSync(uiRoot, { recursive: true });
  for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  process.env.DUCKBRAIN_CONFIG_PATH = path.join(tmp, "duckbrain.config.json");
  // Pin the build shape: which of `GET /` and `GET /*splat` exists depends on
  // packages/ui/dist being present, and a parity diff must not depend on
  // whether someone ran `pnpm build`.
  process.env.DUCKBRAIN_UI_DIST_DIR = uiRoot;

  inventory = observeInventory({
    httpOptions: { authConfig: { type: "none" }, namespacesPath: nsRoot },
  });

  // Sub-verb dispatchers the matrix points at are read from the code too.
  for (const cap of CAPABILITIES) {
    const cli = cap.cli;
    if (!cli?.dispatcher) continue;
    const key = `${cli.dispatcher.file}#${cli.dispatcher.fn}`;
    inventory.cli.subcommands[key] ??= readCliSubcommands(
      cli.dispatcher.file,
      cli.dispatcher.fn,
    );
  }
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function withMatrix(matrix: readonly Capability[]) {
  return compareSurface(inventory, {
    capabilities: matrix,
    subcommands: inventory.cli.subcommands,
  });
}

describe("SURFACE-PARITY-001: the matrix and the code agree in both directions", () => {
  it("the inventories were actually read (not silently empty)", () => {
    expect(inventory.http.length).toBeGreaterThan(30);
    expect(inventory.mcp.length).toBeGreaterThan(15);
    expect(inventory.cli.verbs.length).toBeGreaterThan(20);
    expect(inventory.http).toContain("POST /api/memories");
    expect(inventory.mcp).toContain("remember");
    expect(inventory.cli.verbs).toContain("s3");
  });

  it("every route, tool, verb and sub-verb is claimed, and every claim exists", () => {
    const report = compareSurface(inventory, {
      subcommands: inventory.cli.subcommands,
    });
    expect(describeIssues(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("every capability is implemented on at least one surface", () => {
    const orphaned = CAPABILITIES.filter(
      (cap) =>
        !cap.cli && !cap.http?.length && !cap.mcp?.length,
    ).map((cap) => cap.id);
    expect(orphaned).toEqual([]);
  });

  it("no HTTP route or MCP tool is claimed by two capabilities", () => {
    const report = compareSurface(inventory, {
      subcommands: inventory.cli.subcommands,
    });
    expect(report.issues.filter((issue) => issue.kind === "duplicate")).toEqual([]);
  });
});

describe("SURFACE-PARITY-001: the diff fails on a real deletion (control)", () => {
  it("a route mounted in the code but absent from the matrix is UNDECLARED", () => {
    const withoutRoute = CAPABILITIES.map((cap) =>
      cap.id === "s3.status" ? { ...cap, http: [] } : cap,
    );
    const lines = describeIssues(withMatrix(withoutRoute)).join("\n");
    expect(lines).toContain("UNDECLARED [http] GET /api/ops/s3/status");
  });

  it("an MCP tool registered in the code but absent from the matrix is UNDECLARED", () => {
    const withoutTool = CAPABILITIES.map((cap) =>
      cap.id === "memory.search" ? { ...cap, mcp: [] } : cap,
    );
    const lines = describeIssues(withMatrix(withoutTool)).join("\n");
    expect(lines).toContain("UNDECLARED [mcp] search");
  });

  it("a CLI verb dispatched in the switch but absent from the matrix is UNDECLARED", () => {
    const withoutVerb = CAPABILITIES.map((cap) =>
      cap.id === "server.status" ? { ...cap, cli: undefined } : cap,
    );
    const lines = describeIssues(withMatrix(withoutVerb)).join("\n");
    expect(lines).toContain("UNDECLARED [cli] status");
  });

  it("a sub-verb deleted from its dispatcher is MISSING and names the sub-verb", () => {
    const lines = describeIssues(
      compareSurface(inventory, {
        subcommands: { ...inventory.cli.subcommands, "src/s3/cli.ts#s3Command": ["status"] },
      }),
    ).join("\n");
    expect(lines).toContain("MISSING [cli-sub] src/s3/cli.ts#s3Command sync");
  });

  it("the SPA catch-all is allowed only because the matrix declares it", () => {
    // The other build shape: packages/ui/dist present. `GET /*splat` replaces
    // `GET /`, and the matrix lists BOTH under ops.ui — so the optional-route
    // allowance must keep the diff clean instead of reporting a phantom.
    const uiRoot = path.join(tmp, "ui-built");
    fs.mkdirSync(uiRoot, { recursive: true });
    fs.writeFileSync(path.join(uiRoot, "index.html"), "<!doctype html><title>t</title>");
    const prior = process.env.DUCKBRAIN_UI_DIST_DIR;
    process.env.DUCKBRAIN_UI_DIST_DIR = uiRoot;
    try {
      const withUi = observeHttpRoutes({
        authConfig: { type: "none" },
        namespacesPath: path.join(tmp, "namespaces"),
      });
      expect(withUi).toContain("GET /*splat");
      expect(withUi).not.toContain("GET /");
      const report = compareSurface(
        { ...inventory, http: withUi },
        { subcommands: inventory.cli.subcommands },
      );
      expect(describeIssues(report)).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.DUCKBRAIN_UI_DIST_DIR;
      else process.env.DUCKBRAIN_UI_DIST_DIR = prior;
    }
  });

  it("a capability row with no code behind it is MISSING", () => {
    const phantom: Capability[] = [
      ...CAPABILITIES,
      { id: "memory.phantom", summary: "not built", http: ["GET /api/phantom"] },
    ];
    expect(describeIssues(withMatrix(phantom)).join("\n")).toContain(
      "MISSING [http] GET /api/phantom",
    );
  });
});

describe("SURFACE-PARITY-001: the documented surface is generated from the matrix", () => {
  it("docs/api/surface-parity.md carries the current generated block", () => {
    const docPath = path.join(root, "docs", "api", "surface-parity.md");
    const doc = fs.readFileSync(docPath, "utf-8");
    const begin = doc.indexOf(GENERATED_BEGIN);
    const end = doc.indexOf(GENERATED_END);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);
    const committed = doc.slice(begin, end + GENERATED_END.length);
    expect(committed).toBe(renderSurfaceMarkdown());
  });

  it("the renderer states the pending surfaces, so the gap stays visible", () => {
    const rendered = renderSurfaceMarkdown();
    for (const cap of CAPABILITIES) {
      if (pendingSurfaces(cap).length === 0) continue;
      expect(rendered).toContain(`\`${cap.id}\` — missing `);
    }
  });
});
