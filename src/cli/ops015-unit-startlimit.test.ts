/**
 * OPS-015 regression: the duckbrain-http crash-loop brake must ship as a
 * [Unit]-section drop-in, and nowhere else.
 *
 * StartLimitIntervalSec / StartLimitBurst are [Unit] keys. systemd ignores them
 * inside [Service] ("Unknown key name ... ignoring") and falls back to the
 * 10s/5-attempt defaults, so an auto-restarting unit can trip the brake in
 * ~15s instead of the intended 300s/10 burst — the defect OPS-015 fixed on the
 * live host on 2026-11-18.
 *
 * Because the brake lives in a drop-in, a fresh deploy only gets it if the repo
 * ships `ops/systemd/duckbrain-http.service.d/` AND the documented install step
 * copies that directory. Both are asserted here, so the inert-brake regression
 * cannot come back through either path.
 *
 * Hermetic: reads the repo's ops/systemd assets and the deployment guide, no
 * systemd, no network, no daemon.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(__dirname, "../..");
const OPS_SYSTEMD_DIR = path.join(REPO_ROOT, "ops/systemd");
const DROPIN_DIR = path.join(OPS_SYSTEMD_DIR, "duckbrain-http.service.d");
const DROPIN_FILE = path.join(DROPIN_DIR, "10-restart-brake.conf");
const BASE_UNIT = path.join(OPS_SYSTEMD_DIR, "duckbrain-http.service");
const DEPLOYMENT_GUIDE = path.join(REPO_ROOT, "docs/guide/deployment.md");
const START_LIMIT_KEYS = ["StartLimitIntervalSec", "StartLimitBurst"];

type ParsedUnit = {
  unitKeys: Record<string, string>;
  misplaced: string[];
  anywhere: string[];
};

export function parseStartLimitPlacement(contents: string): ParsedUnit {
  const unitKeys: Record<string, string> = {};
  const misplaced: string[] = [];
  const anywhere: string[] = [];
  let section = "";
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      section = line;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!START_LIMIT_KEYS.includes(key)) continue;
    anywhere.push(`${section || "(no section)"} ${line}`);
    if (section === "[Unit]") unitKeys[key] = value.trim();
    else misplaced.push(`${section || "(no section)"} ${line}`);
  }
  return { unitKeys, misplaced, anywhere };
}

function unitFiles(): string[] {
  if (!fs.existsSync(OPS_SYSTEMD_DIR)) return [];
  return fs
    .readdirSync(OPS_SYSTEMD_DIR)
    .filter((name) => name.endsWith(".service") || name.endsWith(".timer"))
    .sort();
}

describe("OPS-015 shipped systemd assets: crash-loop brake", () => {
  it("ships the brake as a [Unit] drop-in with 300s / 10", () => {
    expect(fs.existsSync(DROPIN_FILE)).toBe(true);
    const { unitKeys, misplaced } = parseStartLimitPlacement(
      fs.readFileSync(DROPIN_FILE, "utf8"),
    );
    expect(misplaced).toEqual([]);
    expect(unitKeys.StartLimitIntervalSec).toBe("300");
    expect(unitKeys.StartLimitBurst).toBe("10");
  });

  it("keeps the base unit free of StartLimit* (it lives in the drop-in)", () => {
    const { anywhere } = parseStartLimitPlacement(
      fs.readFileSync(BASE_UNIT, "utf8"),
    );
    expect(anywhere).toEqual([]);
  });

  it("never places a StartLimit key outside [Unit] in any shipped unit", () => {
    const offenders = unitFiles().flatMap((name) => {
      const { misplaced } = parseStartLimitPlacement(
        fs.readFileSync(path.join(OPS_SYSTEMD_DIR, name), "utf8"),
      );
      return misplaced.map((entry) => `${name}: ${entry}`);
    });
    expect(offenders).toEqual([]);
  });

  it("documents both the [Unit] requirement and the drop-in install step", () => {
    const guide = fs.readFileSync(DEPLOYMENT_GUIDE, "utf8");
    expect(guide).toMatch(/`\[Unit\]` keys/);
    expect(guide).toContain("duckbrain-http.service.d/10-restart-brake.conf");
    expect(guide).toContain("duckbrain-http.service.d/");
  });
});
