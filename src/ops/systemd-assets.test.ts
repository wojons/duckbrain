/**
 * OPS-015 — the shipped start-limit brake must live in a `[Unit]` drop-in.
 *
 * systemd >= 230 accepts `StartLimitIntervalSec` / `StartLimitBurst` ONLY in a
 * `[Unit]` section. Placed in `[Service]` (where they shipped before this row)
 * the manager logs `Unknown key 'StartLimitIntervalSec' in section [Service],
 * ignoring.` and keeps the 10s default window — measured on systemd 259:
 * `systemctl --user show -p StartLimitIntervalUSec` = `10s` for the `[Service]`
 * placement vs `5min` for the `[Unit]` drop-in. With `RestartSec=3` that turns
 * a crash loop into an unbraked 3s restart storm.
 *
 * These assertions pin the repo SHAPE, because the failure mode this row was
 * filed for is exactly "the live host was patched by hand, the repo still
 * shipped the defect, so the next redeploy re-introduced it". Delete the
 * drop-in or fold the keys back into the unit and these tests fail loudly.
 *
 * Reads are lazy on purpose: a missing file must surface as the ASSERTION that
 * names it ("no [Unit] drop-in"), not as a module-load ENOENT that hides which
 * property regressed.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const UNIT_PATH = path.join(ROOT, "ops", "systemd", "duckbrain-http.service");
const DROPIN_PATH = path.join(
  ROOT,
  "ops",
  "systemd",
  "duckbrain-http.service.d",
  "10-restart-brake.conf",
);
const DEPLOY_DOC = path.join(ROOT, "docs", "guide", "deployment.md");
const INSTALL_DOC = path.join(ROOT, "ops", "systemd", "INSTALL.md");

interface Ini {
  /** section name -> directive name -> value (comments/blanks dropped) */
  sections: Map<string, Map<string, string>>;
  /** every `Key=value` line with the section it appeared in */
  entries: { section: string; key: string; value: string }[];
}

/** Minimal systemd-unit reader: section headers, comments, Key=value. */
function parseUnit(text: string): Ini {
  const sections = new Map<string, Map<string, string>>();
  const entries: { section: string; key: string; value: string }[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections.get(section)?.set(key, value);
    entries.push({ section, key, value });
  }
  return { sections, entries };
}

/** Read a repo file, or "" when it is missing (absence is an assertion's job). */
function read(absolute: string): string {
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf-8") : "";
}

describe("OPS-015: start-limit brake ships in a [Unit] drop-in, not in [Service]", () => {
  it("keeps Restart=always / RestartSec=3 in the unit's [Service] block", () => {
    const service = parseUnit(read(UNIT_PATH)).sections.get("Service");
    expect(service, "duckbrain-http.service must have a [Service] section").toBeDefined();
    expect(service!.get("Restart")).toBe("always");
    expect(service!.get("RestartSec")).toBe("3");
  });

  it("carries NO StartLimit* key outside [Unit], and agrees with the drop-in", () => {
    const unit = parseUnit(read(UNIT_PATH));
    const offenders = unit.entries.filter(
      (e) => e.key.startsWith("StartLimit") && e.section !== "Unit",
    );
    expect(
      offenders.map((e) => `[${e.section}] ${e.key}=${e.value}`),
      "StartLimit* must not appear outside [Unit]: systemd >=230 ignores it there, " +
        "which is the defect OPS-015 fixed (live host measured " +
        "StartLimitIntervalUSec=10s for the [Service] shape vs 5min for the drop-in)",
    ).toEqual([]);
    // The base unit carries the brake in [Unit] (OPS-015 first landing) and the
    // shipped drop-in repeats the same values, so either install path brakes
    // RestartSec=3. The two must never drift apart.
    const unitApi = unit.sections.get("Unit");
    const dropinApi = parseUnit(read(DROPIN_PATH)).sections.get("Unit");
    if (unitApi?.has("StartLimitIntervalSec") || unitApi?.has("StartLimitBurst")) {
      expect(
        unitApi.get("StartLimitIntervalSec"),
        "the base unit's [Unit] brake must match the shipped drop-in",
      ).toBe(dropinApi?.get("StartLimitIntervalSec"));
      expect(unitApi.get("StartLimitBurst")).toBe(dropinApi?.get("StartLimitBurst"));
    }
  });

  it("ships the drop-in with a [Unit] section and the 300s/10 brake", () => {
    expect(
      fs.existsSync(DROPIN_PATH),
      "ops/systemd/duckbrain-http.service.d/10-restart-brake.conf must be shipped in the repo",
    ).toBe(true);
    const dropin = parseUnit(read(DROPIN_PATH));
    expect([...dropin.sections.keys()], "the drop-in must hold exactly a [Unit] section").toEqual([
      "Unit",
    ]);
    expect(dropin.sections.get("Unit")!.get("StartLimitIntervalSec")).toBe("300");
    expect(dropin.sections.get("Unit")!.get("StartLimitBurst")).toBe("10");
    // A [Service] block here would silently re-create the defect.
    expect(dropin.sections.has("Service")).toBe(false);
  });

  it("keeps the base unit's comment pointing at the drop-in", () => {
    // A stale comment claiming the keys live in this file is how the next
    // editor re-adds them; the pointer must name the drop-in file.
    expect(read(UNIT_PATH)).toMatch(/10-restart-brake\.conf/);
  });

  it("documents an install recipe that copies the drop-in directory", () => {
    // A plain `cp ops/systemd/*.service` ships the unit and drops the brake.
    // The documented recipe must be recursive AND name the .d directory.
    const deployDoc = read(DEPLOY_DOC);
    const installDoc = read(INSTALL_DOC);
    const cpLines = deployDoc
      .split("\n")
      .filter((l) => l.trim().startsWith("cp ") && l.includes("duckbrain-http"));
    expect(cpLines.length, "deployment.md must carry a cp recipe").toBeGreaterThan(0);
    const recursive = cpLines.filter((l) => /\bcp\s+-r\b/.test(l));
    expect(recursive.length, "the cp recipe must be recursive (cp -r)").toBeGreaterThan(0);
    expect(deployDoc).toContain("ops/systemd/duckbrain-http.service.d");
    expect(installDoc, "ops/systemd/INSTALL.md must be shipped").toContain(
      "duckbrain-http.service.d",
    );
    expect(installDoc).toContain("cp -r");
  });
});
