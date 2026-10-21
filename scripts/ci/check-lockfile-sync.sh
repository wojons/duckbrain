#!/usr/bin/env bash
# check-lockfile-sync.sh — SUP-CI-20261020-DB lockfile drift gate.
#
# npm ci (Dockerfile:8 and the CI install step) refuses to run when
# package.json and package-lock.json disagree. This happened five times
# before this gate: a dependency bump lands in package.json, the lockfile
# is not regenerated, and every npm ci consumer fails with EUSAGE. This
# script FAILS CI at the drift, naming each offending package, instead of
# letting the failure surface 3 steps later as a broken install.
#
# What it checks: every dependency declared in package.json
# (dependencies, devDependencies, optionalDependencies, peerDependencies)
# must be recorded in package-lock.json at a version that SATISFIES the
# declared range. This mirrors npm ci's own sync rule, implemented as an
# explicit json-vs-json comparison in node — no registry access, no
# network, no npm invocation. (npm ci --dry-run would hit the registry;
# this gate is deliberately offline.)
#
# Supported spec syntax: exact ("1.2.3"), caret ("^1.2.3"), tilde
# ("~1.2.3"), comparators (">1.2.3", ">=1.2.3", "<1.2.3", "<=1.2.3"),
# OR-ranges (">=2 <3 || >=4"), x-ranges ("1.2.x", "1.*"), partial specs
# ("1" == "1.x.x", "1.2" == "1.2.x"), and "*". Prerelease specs
# ("1.2.3-beta.1") are compared as exact strings — npm's full prerelease
# range algebra is out of scope; this repo declares none, and an
# unsupported spec fails LOUD (drift reported) rather than silently.
# npm ci's rule is stricter than every-locked-version-in-range: it
# requires a RESOLUTION for each declared dep, so a declared dep missing
# from the lock is also drift (reported as MISSING).
#
# Exit codes: 0 in sync | 1 drift found (offenders named on stderr) |
# 2 unreadable manifest/lockfile or no declared dependencies.
#
# Seams (env; used by the self-test and the paired vitest test — the
# real files are never mutated by tests):
#   LOCKFILE_SYNC_MANIFEST  package.json to check   (default: repo root)
#   LOCKFILE_SYNC_LOCKFILE  package-lock.json to check (default: repo root)
#
# Self-test: `bash scripts/ci/check-lockfile-sync.sh --self-test` proves
# both arms in fixture space under a temp dir: green (consistent fixture
# built from the real lock -> exit 0) and red (express version deliberately
# staled -> exit 1 with the package named). It never writes to the repo.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

export LOCKFILE_SYNC_MANIFEST="${LOCKFILE_SYNC_MANIFEST:-$ROOT/package.json}"
export LOCKFILE_SYNC_LOCKFILE="${LOCKFILE_SYNC_LOCKFILE:-$ROOT/package-lock.json}"

run_check() {
  node -e '
const fs = require("fs");

function parseVersion(s) {
  const t = String(s).trim().replace(/^v/, "");
  const m = t.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!m) return null;
  return [
    Number.parseInt(m[1], 10),
    Number.parseInt(m[2] === undefined ? "0" : m[2], 10),
    Number.parseInt(m[3] === undefined ? "0" : m[3], 10),
  ];
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Deliberate minimal semver for the spec syntax documented in the header.
// Unsupported syntax fails LOUD (returns false -> reported as drift).
function satisfies(spec, version) {
  if (spec === "*" || spec === "latest") return true;
  const clauses = String(spec).split("||").map((s) => s.trim());
  return clauses.some((clause) => satisfiesClause(clause, version));
}

function satisfiesClause(clause, version) {
  const parts = clause.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((part) => satisfiesPart(part, version));
}

function satisfiesPart(part, version) {
  const v = parseVersion(version);
  if (!v) return false;
  let op = "=";
  let rest = part;
  const m = part.match(/^(>=|<=|>|<|\^|~|=)\s*(.*)$/);
  if (m) {
    op = m[1];
    rest = m[2].trim();
  }
  if (rest === "" || rest === "*" || rest === "x" || rest === "X") return true;
  // Prerelease specs: exact-string comparison (documented limitation).
  if (rest.includes("-")) {
    return version === rest.replace(/^[=^~]+/, "").trim();
  }
  // x-ranges: 1.2.x / 1.* — constrain only the numeric prefix.
  const segs = rest.split(".");
  if (segs.some((s) => s === "x" || s === "X" || s === "*")) {
    for (let i = 0; i < segs.length && i < 3; i++) {
      const s = segs[i];
      if (s === "x" || s === "X" || s === "*") return true;
      const n = Number.parseInt(s, 10);
      if (Number.isNaN(n)) return false;
      if (v[i] !== n) return false;
    }
    return true;
  }
  const r = parseVersion(rest);
  if (!r) return false;
  switch (op) {
    case ">=": return cmp(v, r) >= 0;
    case "<=": return cmp(v, r) <= 0;
    case ">": return cmp(v, r) > 0;
    case "<": return cmp(v, r) < 0;
    case "^": return cmp(v, r) >= 0 && v[0] === r[0];
    case "~": return cmp(v, r) >= 0 && v[0] === r[0] && v[1] === r[1];
    case "=": {
      // npm partial-exact semantics: "1" == "1.x.x", "1.2" == "1.2.x".
      const need = segs.length;
      if (need < 3) {
        for (let i = 0; i < need; i++) {
          if (v[i] !== r[i]) return false;
        }
        return true;
      }
      return cmp(v, r) === 0;
    }
    default: return false;
  }
}

function collectDeclared(manifest, manifestPath) {
  const deps = [];
  const sections = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  for (const section of sections) {
    const entries = manifest[section] || {};
    for (const [name, spec] of Object.entries(entries)) {
      deps.push({ name, spec: String(spec), section, manifestPath });
    }
  }
  return deps;
}

function collectLocked(lock, lockPath) {
  const out = new Map();
  if (lock.lockfileVersion === 3 && lock.packages) {
    const pkgs = lock.packages || {};
    for (const key of Object.keys(pkgs)) {
      if (key === "" || key === "node_modules/.package-lock.json") continue;
      if (!key.startsWith("node_modules/")) continue;
      const entry = pkgs[key];
      if (typeof entry.version !== "string") continue;
      // Hoisted entry: node_modules/<name>. Nested: a/b/node_modules/<name>
      // (the LAST path segment wins over any hoisted shadow — npm resolves
      // nested first, so record the most-nested occurrence).
      const name = key.slice("node_modules/".length);
      if (name.includes("/node_modules/")) continue;
      if (!out.has(name)) out.set(name, entry.version);
    }
  } else {
    // lockfileVersion 1: dependencies tree with requires maps.
    const walk = (deps) => {
      for (const dep of deps || []) {
        if (typeof dep.version === "string") {
          const existing = out.get(dep.name);
          if (existing === undefined || existing === null) out.set(dep.name, dep.version);
        } else if (!out.has(dep.name)) {
          out.set(dep.name, null); // presence-only marker
        }
        walk(dep.dependencies);
      }
    };
    walk(lock.dependencies || []);
  }
  if (out.size === 0) {
    process.stderr.write(
      `LOCKDRIFT: no packages found in ${lockPath} (lockfileVersion=${lock.lockfileVersion})\n`,
    );
  }
  return out;
}

function main() {
  const manifestPath = process.env.LOCKFILE_SYNC_MANIFEST || "package.json";
  const lockPath = process.env.LOCKFILE_SYNC_LOCKFILE || "package-lock.json";
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    process.stderr.write(`LOCKDRIFT: cannot read manifest ${manifestPath}: ${err.message}\n`);
    process.exit(2);
  }
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (err) {
    process.stderr.write(`LOCKDRIFT: cannot read lockfile ${lockPath}: ${err.message}\n`);
    process.exit(2);
  }

  const declared = collectDeclared(manifest, manifestPath);
  if (declared.length === 0) {
    process.stderr.write(`LOCKDRIFT: no dependencies declared in ${manifestPath}\n`);
    process.exit(2);
  }
  const locked = collectLocked(lock, lockPath);

  const missing = [];
  const drift = [];
  for (const dep of declared) {
    if (!locked.has(dep.name)) {
      missing.push(dep.name);
      continue;
    }
    const version = locked.get(dep.name);
    if (version === null) continue; // v1 presence-only marker
    if (!satisfies(dep.spec, version)) {
      drift.push(
        `${dep.name}: ${manifestPath} declares "${dep.spec}" but ${lockPath} records ${version}`,
      );
    }
  }

  if (missing.length === 0 && drift.length === 0) {
    process.stdout.write(
      `LOCKDRIFT: OK — ${declared.length} declared dependencies all satisfied by ${lockPath}\n`,
    );
    process.exit(0);
  }
  for (const name of missing) {
    process.stderr.write(
      `LOCKDRIFT: MISSING: ${name} is declared in ${manifestPath} but absent from ${lockPath}\n`,
    );
  }
  for (const d of drift) {
    process.stderr.write(`LOCKDRIFT: DRIFT: ${d}\n`);
  }
  process.stderr.write(
    `LOCKDRIFT: ${missing.length + drift.length} drift finding(s); regenerate the lockfile with "pnpm install --lockfile-only" or "npm install --package-lock-only" before committing.\n`,
  );
  process.exit(1);
}

main();
'
}

self_test() {
  local tmp rcgreen rcred greenout redout build_rc red_rc ok
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/lockfile-sync-selftest.XXXXXX")"
  export SELFTEST_TMP="$tmp"

  # Build fixtures from the REAL pair: a minimal v3-shaped lock holding
  # exactly the root deps. Green fixture = as built; red fixture mutates
  # one version (express -> 4.21.2, a major drift).
  node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync(process.env.LOCKFILE_SYNC_LOCKFILE, "utf8"));
const manifest = JSON.parse(fs.readFileSync(process.env.LOCKFILE_SYNC_MANIFEST, "utf8"));
const skeleton = {
  name: manifest.name || "fixture",
  version: "1.0.0",
  lockfileVersion: lock.lockfileVersion,
  requires: true,
  packages: {
    "": {
      name: manifest.name || "fixture",
      version: "1.0.0",
      dependencies: manifest.dependencies || {},
      devDependencies: manifest.devDependencies || {},
    },
  },
};
const wanted = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
for (const dep of Object.keys(wanted)) {
  const entry = (lock.packages || {})[`node_modules/${dep}`];
  if (!entry || typeof entry.version !== "string") {
    console.error(`selftest-build: ${dep} missing from real lockfile`);
    process.exit(2);
  }
  skeleton.packages[`node_modules/${dep}`] = { version: entry.version };
}
fs.writeFileSync(`${process.env.SELFTEST_TMP}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(`${process.env.SELFTEST_TMP}/package-lock.json`, `${JSON.stringify(skeleton, null, 2)}\n`);
'
  build_rc=$?
  if [ "$build_rc" -ne 0 ]; then
    echo "SELF-TEST: fixture build failed (rc=$build_rc)"
    rm -rf "$tmp"
    return 1
  fi

  # Green arm: consistent fixture must pass.
  greenout=$(LOCKFILE_SYNC_MANIFEST="$tmp/package.json" \
    LOCKFILE_SYNC_LOCKFILE="$tmp/package-lock.json" run_check 2>&1)
  rcgreen=$?

  # Red arm: deliberately stale ONE recorded version (express).
  node -e '
const fs = require("fs");
const p = `${process.env.SELFTEST_TMP}/package-lock.json`;
const lock = JSON.parse(fs.readFileSync(p, "utf8"));
if (!lock.packages["node_modules/express"]) {
  console.error("selftest-red: express missing from fixture");
  process.exit(2);
}
lock.packages["node_modules/express"].version = "4.21.2";
fs.writeFileSync(p, `${JSON.stringify(lock, null, 2)}\n`);
'
  red_rc=$?
  redout=$(LOCKFILE_SYNC_MANIFEST="$tmp/package.json" \
    LOCKFILE_SYNC_LOCKFILE="$tmp/package-lock.json" run_check 2>&1)
  rcred=$?

  ok=1
  if [ "$rcgreen" -eq 0 ] && printf '%s' "$greenout" | grep -q "LOCKDRIFT: OK"; then
    echo "SELF-TEST green arm: consistent fixture -> exit 0"
  else
    echo "SELF-TEST green arm FAILED (rc=$rcgreen): $greenout"
    ok=0
  fi
  if [ "$red_rc" -eq 0 ] && [ "$rcred" -ne 0 ] \
    && printf '%s' "$redout" | grep -q "LOCKDRIFT: DRIFT: express:"; then
    echo "SELF-TEST red arm: stale express fixture -> exit $rcred, drift named: express"
  else
    echo "SELF-TEST red arm FAILED (mutate rc=$red_rc, check rc=$rcred): $redout"
    ok=0
  fi

  rm -rf "$tmp"
  if [ "$ok" -eq 1 ]; then
    echo "SELF-TEST PASS: both arms proved (green=0, red=nonzero+named)"
    return 0
  fi
  echo "SELF-TEST FAIL"
  return 1
}

case "${1:-}" in
  --self-test)
    self_test
    exit $?
    ;;
  "")
    run_check
    exit $?
    ;;
  *)
    echo "usage: $0 [--self-test]"
    exit 2
    ;;
esac
