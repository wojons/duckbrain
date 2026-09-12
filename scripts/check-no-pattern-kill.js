/**
 * OPS-001 guard: package.json scripts must not contain pattern-kill
 * commands, and the scoped-stop implementation must be the only stop path.
 *
 * Run with: node scripts/check-no-pattern-kill.js
 * Fails (exit 1) if pkill/killall/pattern-based kills appear in any package
 * script — the exact failure class that let a repository-wide pattern kill
 * ship as `pnpm stop` before OPS-001.
 */

const fs = require("fs");
const path = require("path");

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
);

const PATTERN = /\bpkill\b|\bkillall\b|\bkill\b\s+-\s*\d|\bkill\s+-9\b/;
const offenders = [];

for (const [name, command] of Object.entries(pkg.scripts || {})) {
  if (typeof command === "string" && PATTERN.test(command)) {
    offenders.push(`  ${name}: ${command}`);
  }
}

if (offenders.length > 0) {
  console.error(
    [
      "check-no-pattern-kill: FAILED — package scripts contain pattern or numeric kills:",
      ...offenders,
      "",
      "Stopping daemons must go through scripts/scoped-stop.js (pidfile-proven,",
      "single-instance SIGTERM only). See ops/systemd/ and docs/guide/deployment.md.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  "check-no-pattern-kill: OK — no pkill/killall/pattern kills in package scripts.",
);
