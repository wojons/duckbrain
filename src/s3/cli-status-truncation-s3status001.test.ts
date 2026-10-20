/**
 * S3-STATUS-001: `duckbrain s3 status` must never present a truncated
 * namespace list as if it were the whole population.
 *
 * Incident shape: the status loop was `resolved.slice(0, 20)` with no marker,
 * no aggregate and no way to ask for more — a namespace with 25 children
 * rendered 20 rows and looked complete, so the 21st..Nth namespaces were
 * silently invisible on their own status surface (the same class of blind
 * spot DF-0925-08 fixed for the registry/census union).
 *
 * What this suite pins:
 *   1. default: first STATUS_ROW_LIMIT rows + the TOTAL count + an explicit
 *      "... and N more (use --full to see all)" marker;
 *   2. `--full`: every namespace, no marker;
 *   3. `--json`: ONE machine-readable JSON document on stdout — valid JSON,
 *      complete list, no truncation, no human header lines;
 *   4. the flags actually route through the dispatcher (`s3 status --full`
 *      must not read `--full` as a namespace name), and an explicit namespace
 *      argument still wins;
 *   5. a failed remote listing stays valid JSON (`remote: null` + listError)
 *      rather than smuggling "?" into the machine-readable path.
 *
 * Isolation: temp config + temp namespaces root via env vars (snapshot and
 * restored per test) and ./client mocked, so no S3 request is ever made.
 * Env keys are restored individually so nothing leaks into a sibling file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Status, s3Command, STATUS_ROW_LIMIT } from "./cli";
import { DEFAULT_S3_CONFIG } from "./config";

// No network. Two objects per namespace so a remote count is observable, and
// one namespace ("bad-ns") that always fails its listing.
vi.mock("./client", () => ({
  buildClient: () => ({}),
  listRemoteObjects: async (_client: unknown, _bucket: string, prefix: string) => {
    if (prefix.includes("bad-ns")) throw new Error("AccessDenied");
    return new Map([
      ["a.jsonl", { key: "a.jsonl", size: 1 }],
      ["b.jsonl", { key: "b.jsonl", size: 1 }],
    ]);
  },
}));

const ENV_KEYS = [
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
  "DUCKBRAIN_HOME_ROOT",
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
] as const;

let envSnapshot: Record<string, string | undefined>;
let tmpDir: string;
let nsRoot: string;

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3status001-"));
  nsRoot = path.join(tmpDir, "namespaces");
  fs.mkdirSync(nsRoot, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = nsRoot;
  delete process.env.DUCKBRAIN_HOME_ROOT;
  process.env.AWS_ENDPOINT_URL_S3 = "https://probe.invalid";
  delete process.env.AWS_ENDPOINT_URL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write the temp config file and pin DUCKBRAIN_CONFIG_PATH at it. */
function writeConfig(namespaceMappings: Record<string, string> = {}): void {
  const cfgFile = path.join(tmpDir, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify(
      {
        s3: { ...DEFAULT_S3_CONFIG, enabled: true, bucket: "probe-bucket" },
        namespaceMappings,
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.env.DUCKBRAIN_CONFIG_PATH = cfgFile;
}

/** Create `count` namespace directories named ns-00 .. ns-(count-1). */
function seedNamespaces(count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `ns-${String(i).padStart(2, "0")}`;
    fs.mkdirSync(path.join(nsRoot, name), { recursive: true });
    names.push(name);
  }
  return names;
}

/** Capture everything s3Status writes to stdout as one text blob. */
async function captureStdout(
  run: () => Promise<void>,
): Promise<{ stdout: string; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await run();
  const lines = log.mock.calls.map((c) => c.map(String).join(" "));
  return { stdout: lines.join("\n"), lines };
}

/** The per-namespace rows (`  <ns>: local=…`). */
function rowsOf(lines: string[]): string[] {
  return lines.filter((l) => /^ {2}[^ ]+: local=/.test(l));
}

describe("S3-STATUS-001: s3 status never truncates silently", () => {
  it("caps at STATUS_ROW_LIMIT but prints the total and an explicit marker", async () => {
    writeConfig();
    const all = seedNamespaces(STATUS_ROW_LIMIT + 5); // 25

    const { lines } = await captureStdout(() => s3Status("."));
    const rows = rowsOf(lines);

    expect(rows).toHaveLength(STATUS_ROW_LIMIT);

    // The total population is stated…
    expect(lines).toContain(`Namespaces: ${all.length}`);

    // …and the omission is announced with the exact remedy.
    const marker = lines.find((l) => l.includes("more (use --full to see all)"));
    expect(marker).toBeDefined();
    expect(marker).toContain(`and ${all.length - STATUS_ROW_LIMIT} more`);

    // The rows shown are distinct members of the population (no phantom rows).
    const shown = rows.map((r) => /^ {2}([^ :]+): local=/.exec(r)![1]);
    expect(new Set(shown).size).toBe(shown.length);
    for (const name of shown) expect(all).toContain(name);
  });

  it("prints no marker when the population fits under the cap", async () => {
    writeConfig();
    const all = seedNamespaces(3);

    const { lines } = await captureStdout(() => s3Status("."));

    expect(rowsOf(lines)).toHaveLength(all.length);
    expect(lines.join("\n")).not.toContain("use --full");
  });

  it("--full shows every namespace and no truncation marker", async () => {
    writeConfig();
    const all = seedNamespaces(STATUS_ROW_LIMIT + 5);

    const { lines } = await captureStdout(() => s3Status(".", undefined, { full: true }));
    const rows = rowsOf(lines);

    expect(rows).toHaveLength(all.length);
    const shown = rows.map((r) => /^ {2}([^ :]+): local=/.exec(r)![1]);
    expect(new Set(shown)).toEqual(new Set(all));
    expect(lines.join("\n")).not.toContain("use --full");
    expect(lines).toContain(`Namespaces: ${all.length}`);

    // Remote counts are real, not the "?" failure sentinel.
    expect(rows[0]).toContain("remote=2");
  });

  it("--json emits one valid JSON document with the FULL list", async () => {
    writeConfig();
    const all = seedNamespaces(STATUS_ROW_LIMIT + 5);

    const { stdout, lines } = await captureStdout(() =>
      s3Status(".", undefined, { json: true }),
    );

    // Machine-readable: exactly one log call, and it parses.
    expect(lines).toHaveLength(1);
    expect(stdout).not.toContain("S3 config:");
    expect(stdout).not.toContain("use --full");

    const doc = JSON.parse(stdout) as {
      enabled: boolean;
      total: number;
      namespaces: Array<{ ns: string; local: number; remote: number | null; registered: boolean }>;
    };
    expect(doc.enabled).toBe(true);
    expect(doc.total).toBe(all.length);
    expect(doc.namespaces).toHaveLength(all.length); // NO truncation
    expect(new Set(doc.namespaces.map((r) => r.ns))).toEqual(new Set(all));
    expect(doc.namespaces[0].remote).toBe(2);
  });

  it("--json keeps a failed remote listing valid JSON (remote null + listError)", async () => {
    writeConfig();
    fs.mkdirSync(path.join(nsRoot, "bad-ns"), { recursive: true });
    fs.mkdirSync(path.join(nsRoot, "ok-ns"), { recursive: true });

    const { stdout } = await captureStdout(() =>
      s3Status(".", undefined, { json: true }),
    );
    const doc = JSON.parse(stdout) as {
      namespaces: Array<{ ns: string; remote: number | null; listError?: string }>;
    };

    const bad = doc.namespaces.find((r) => r.ns === "bad-ns")!;
    expect(bad.remote).toBeNull();
    expect(bad.listError).toContain("AccessDenied");
    const ok = doc.namespaces.find((r) => r.ns === "ok-ns")!;
    expect(ok.remote).toBe(2);
    expect(ok.listError).toBeUndefined();
  });
});

describe("S3-STATUS-001: the flags route through the s3 dispatcher", () => {
  it("`status --full` shows all — the flag is not read as a namespace name", async () => {
    writeConfig();
    const all = seedNamespaces(STATUS_ROW_LIMIT + 5);

    const { lines } = await captureStdout(() => s3Command(["status", "--full"], "."));
    const rows = rowsOf(lines);

    expect(rows).toHaveLength(all.length);
    // A pre-fix dispatcher passed args[1] as the namespace → one row called
    // literally "--full" and nothing else.
    expect(rows.some((r) => r.includes("--full"))).toBe(false);
  });

  it("`status --json` is parseable through the dispatcher", async () => {
    writeConfig();
    const all = seedNamespaces(STATUS_ROW_LIMIT + 5);

    const { stdout } = await captureStdout(() => s3Command(["status", "--json"], "."));

    const doc = JSON.parse(stdout) as { total: number };
    expect(doc.total).toBe(all.length);
  });

  it("an explicit namespace argument still resolves to just that namespace", async () => {
    writeConfig();
    seedNamespaces(STATUS_ROW_LIMIT + 5);

    const { lines } = await captureStdout(() =>
      s3Command(["status", "ns-07", "--full"], "."),
    );
    const rows = rowsOf(lines);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("ns-07:");
  });
});
