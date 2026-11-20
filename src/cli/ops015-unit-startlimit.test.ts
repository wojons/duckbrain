/**
 * OPS-015 regression: StartLimitIntervalSec / StartLimitBurst are [Unit] keys.
 * systemd ignores them inside [Service] ("Unknown key name ... ignoring") and
 * falls back to the 10s/5-attempt defaults, so an auto-restarting unit can trip
 * the brake in ~15s instead of the intended 300s/10 burst. The shipped deploy
 * asset must therefore keep them under [Unit]; otherwise a fresh deploy from
 * this repo re-introduces the inert brake that OPS-015 fixed on the live host.
 *
 * Hermetic: reads the repo's ops/systemd assets, no systemd, no sockets.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const OPS_SYSTEMD_DIR = path.resolve(__dirname, "../../ops/systemd");
const START_LIMIT_KEYS = ["StartLimitIntervalSec", "StartLimitBurst"];

type ParsedUnit = {
  unitKeys: Record<string, string>;
  misplaced: string[];
};

export function parseStartLimitPlacement(contents: string): ParsedUnit {
  const unitKeys: Record<string, string> = {};
  const misplaced: string[] = [];
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
    if (section === "[Unit]") unitKeys[key] = value.trim();
    else misplaced.push(`${section || "(no section)"} ${line}`);
  }
  return { unitKeys, misplaced };
}

function unitFiles(): string[] {
  if (!fs.existsSync(OPS_SYSTEMD_DIR)) return [];
  return fs
    .readdirSync(OPS_SYSTEMD_DIR)
    .filter((name) => name.endsWith(".service") || name.endsWith(".timer"))
    .sort();
}

describe("OPS-015 shipped systemd assets: StartLimit* placement", () => {
  it("ships the http unit with StartLimit* under [Unit]", () => {
    const unitPath = path.join(OPS_SYSTEMD_DIR, "duckbrain-http.service");
    const { unitKeys, misplaced } = parseStartLimitPlacement(
      fs.readFileSync(unitPath, "utf8"),
    );
    expect(misplaced).toEqual([]);
    expect(unitKeys.StartLimitIntervalSec).toBe("300");
    expect(unitKeys.StartLimitBurst).toBe("10");
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

  it("documents the [Unit] requirement in the deployment guide", () => {
    const guide = fs.readFileSync(
      path.resolve(__dirname, "../../docs/guide/deployment.md"),
      "utf8",
    );
    expect(guide).toMatch(/`\[Unit\]` keys/);
  });
});
