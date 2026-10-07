/**
 * OPS-SCHED-UNTRACKED-001 — ops-inventory drift-guard tests.
 *
 * Two layers:
 *  1. fixture-pinned behaviour of scripts/ops/check-ops-inventory.sh:
 *     the green arm (intact schedule surface -> exit 0) and the red arm
 *     (a scheduled surface entry removed -> exit 1) both run against
 *     fixture files through the guard's documented OPS_INVENTORY_* env
 *     seams, so the LIVE crontab / systemd / hermes cron surfaces are
 *     never touched by CI;
 *  2. repo guards: the inventory doc exists, carries >= 13 rows across
 *     its two inventory sections, its scheduled rows name a schedule
 *     surface on all three surfaces, every row declares its secrets
 *     posture, and the guard script hardcodes no live schedule ids and
 *     reads no state databases (surfaces come only from live commands
 *     or the env fixtures).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileP = promisify(execFile);

const ROOT = path.resolve(__dirname, "..", "..");
const GUARD = path.join(ROOT, "scripts", "ops", "check-ops-inventory.sh");
const DOC = path.join(ROOT, "docs", "ops-scheduled-scripts.md");

interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runGuard(env: Record<string, string>): Promise<GuardResult> {
  try {
    const { stdout, stderr } = await execFileP("bash", [GUARD], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      timeout: 15_000,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

interface Fixture {
  dir: string;
  docPath: string;
  hermesPath: string;
}

function writeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-inventory-fixture-"));
  const docPath = path.join(dir, "doc.md");
  const hermesPath = path.join(dir, "hermes.txt");
  const scriptPath = path.join(dir, "watchdog-x.sh");
  const helperPath = path.join(dir, "helper-y.sh");
  fs.writeFileSync(scriptPath, "#!/bin/sh\n# fixture\n");
  fs.writeFileSync(helperPath, "#!/bin/sh\n# fixture\n");
  const rows = [
    "## Scheduled fixtures",
    "",
    "| Script | Host path | Schedule surface | Schedule | Purpose | Tracked? | Secrets? |",
    "|---|---|---|---|---|---|---|",
    `| watchdog-x.sh | ${scriptPath} | hermes-cron aabbccddeeff | daily 08:00 | fixture watchdog | no | no |`,
    `| helper-y.sh | ${helperPath} | helper (unscheduled) | — | fixture helper | no | no |`,
  ].join("\n");
  fs.writeFileSync(docPath, rows + "\n");
  fs.writeFileSync(
    hermesPath,
    "  aabbccddeeff [active]\n    Name:      fixture-watchdog\n    Script:    watchdog-x.sh\n",
  );
  return { dir, docPath, hermesPath };
}

describe("check-ops-inventory.sh (fixture-pinned)", () => {
  let fx: Fixture;

  beforeAll(() => {
    fx = writeFixture();
  });

  afterAll(() => {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  it("green arm: intact surface -> exit 0 with a row summary", async () => {
    const res = await runGuard({
      OPS_INVENTORY_DOC: fx.docPath,
      OPS_INVENTORY_HERMES_FILE: fx.hermesPath,
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("2 rows");
    expect(res.stdout).toContain("0 scheduled-surface drifts");
  });

  it("red arm: scheduled surface entry removed -> exit 1 naming the drift", async () => {
    // Overwrite the hermes fixture WITHOUT the scheduled cron id: the
    // watchdog row's surface entry has "disappeared".
    const drifted = path.join(fx.dir, "hermes-drifted.txt");
    fs.writeFileSync(
      drifted,
      "  112233445566 [active]\n    Name:      something-else\n",
    );
    const res = await runGuard({
      OPS_INVENTORY_DOC: fx.docPath,
      OPS_INVENTORY_HERMES_FILE: drifted,
    });
    expect(res.code).toBe(1);
    // Guard contract: drift warnings go to STDERR (clean deliverable stdout).
    expect(res.stderr).toContain("aabbccddeeff no longer listed");
  });

  it("missing inventory doc -> exit 2", async () => {
    const res = await runGuard({
      OPS_INVENTORY_DOC: path.join(fx.dir, "no-such-doc.md"),
      OPS_INVENTORY_HERMES_FILE: fx.hermesPath,
    });
    expect(res.code).toBe(2);
  });
});

/**
 * Parse ONLY the two inventory tables (under "## Scheduled..." and
 * "## Untracked..."). Other sections (drift log, evidence) carry tables
 * with different column shapes and MUST NOT be counted as inventory rows.
 * Columns are mapped by the header row's names, so cosmetic column-count
 * drift does not silently shift the mapping.
 */
function parseInventoryRows(doc: string): Array<Record<string, string>> {
  const rows: Array<Record<string, string>> = [];
  let header: string[] | null = null;
  let inInventory = false;
  for (const raw of doc.split(/\r?\n/)) {
    if (raw.startsWith("## ")) {
      inInventory = /^(Scheduled|Untracked)/.test(raw.slice(3).trim());
      header = null;
      continue;
    }
    if (!inInventory || !raw.startsWith("|")) continue;
    const cells = raw
      .split("|")
      .map((c) => c.trim())
      .slice(1, -1);
    if (!header) {
      if (cells[0] === "Script") header = cells;
      continue;
    }
    const name = cells[0] ?? "";
    if (name === "" || name.startsWith("-")) continue; // separator row
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

describe("ops inventory doc contract", () => {
  const doc = fs.readFileSync(DOC, "utf8");
  const rows = parseInventoryRows(doc);
  const scheduled = rows.filter((r) =>
    /(hermes-cron|crontab|systemd)/.test(r["Schedule surface"] ?? ""),
  );

  it("inventory covers at least 13 scripts", () => {
    expect(rows.length).toBeGreaterThanOrEqual(13);
  });

  it("covers 11 scheduled rows across all three surfaces", () => {
    // 6 hermes-cron + 1 crontab + 4 systemd --user (live-verified 2026-10-07).
    expect(scheduled.length).toBe(11);
    expect(scheduled.some((r) => (r["Schedule surface"] ?? "").includes("hermes-cron"))).toBe(true);
    expect(scheduled.some((r) => (r["Schedule surface"] ?? "").includes("crontab"))).toBe(true);
    expect(scheduled.some((r) => (r["Schedule surface"] ?? "").includes("systemd"))).toBe(true);
  });

  it("every scheduled hermes-cron row carries a 12-hex cron id", () => {
    for (const r of scheduled) {
      if (!(r["Schedule surface"] ?? "").includes("hermes-cron")) continue;
      expect(r["Schedule surface"]).toMatch(/[0-9a-f]{12}/);
    }
  });

  it("every row declares its secrets posture as 'no'", () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r["Secrets?"]).toBe("no");
    }
  });

  it("documents the drift-check command and the same-PR inventory rule", () => {
    expect(doc).toContain("sha256sum");
    expect(doc).toMatch(/MUST\s+add\s+an\s+inventory\s+row/);
  });
});

describe("guard script hygiene", () => {
  const guardSrc = fs.readFileSync(GUARD, "utf8");

  it("hardcodes no live schedule identifiers", () => {
    expect(guardSrc).not.toMatch(/3541777ce883|2ee8eaa9612c|1229f45f3ea4/);
  });

  it("never reads hermes state databases (surfaces come from commands or env fixtures)", () => {
    expect(guardSrc).not.toContain("state.db");
    expect(guardSrc).not.toContain("sqlite3");
  });

  it("is safe to run anywhere: unavailable surfaces degrade to WARN, never FAIL", () => {
    expect(guardSrc).toContain("OPS_INVENTORY_HERMES_FILE");
    expect(guardSrc).toContain("OPS_INVENTORY_CRONTAB_FILE");
    expect(guardSrc).toContain("OPS_INVENTORY_TIMERS_FILE");
    expect(guardSrc).toContain("surface unavailable here");
  });
});
