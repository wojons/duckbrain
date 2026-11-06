#!/usr/bin/env node
/**
 * check-lockfile-lockstep.mjs — HARDEN-DUCKBRAIN-004, pnpm arm.
 *
 * The repository carries TWO lockfiles because it has two install paths:
 *   pnpm-lock.yaml    CI (.github/workflows/ci.yml) and local dev
 *                     (`pnpm install --frozen-lockfile`);
 *   package-lock.json the Dockerfile (`npm ci`, Dockerfile:8).
 * A dependency added to package.json and refreshed in only ONE of them
 * leaves the other install path broken. The npm side is covered by
 * scripts/ci/check-lockfile-sync.sh (SUP-CI-20261020-DB); THIS script is
 * the pnpm side, which nothing checked until now.
 *
 * What it checks, offline and with no child process:
 *   for every importer recorded in pnpm-lock.yaml's importers block
 *   (root ".", workspace "packages/ui", ...), the manifest at
 *   <root>/<importer>/package.json and the lockfile must agree —
 *     PNPM-MISSING   a declared dependency with no locked entry
 *                    (`pnpm install --frozen-lockfile` would die here);
 *     PNPM-SPECIFIER the declared range differs from the locked
 *                    `specifier` (same condition, different symptom);
 *     PNPM-STALE     a locked entry the manifest no longer declares;
 *     STALE IMPORTER a lockfile importer whose package.json is gone.
 *
 * pnpm 12 writes a MULTI-DOCUMENT lockfile: packageManagerDependencies
 * (pnpm managing itself) in a leading `---` document, then the real lock.
 * The parser therefore reads the LAST document that carries `importers:`,
 * which is what pnpm resolves against — a single-document-only parser
 * would report the real 6,598-line lockfile as empty and pass silently.
 *
 * Usage: node scripts/ci/check-lockfile-lockstep.mjs [--self-test] [--root DIR]
 * Exit:  0 in lockstep | 1 drift (offenders named) | 2 unreadable input.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, "..", "..");
const GROUPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function unquote(value) {
  const t = String(value).trim();
  if (t.length >= 2 && ((t[0] === "'" && t.endsWith("'")) || (t[0] === '"' && t.endsWith('"')))) {
    return t.slice(1, -1);
  }
  return t;
}

function readText(file, label) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(`LOCKSTEP: cannot read ${label} at ${file}: ${err.message}\n`);
    process.exit(2);
  }
}

/**
 * Split a pnpm lockfile into YAML documents (pnpm 12 emits more than one).
 * Whitespace-only documents are dropped so the count reflects real documents
 * (a leading "---" separator otherwise yields an empty first element).
 */
export function splitDocuments(text) {
  return text
    .split(/^---[ \t]*$/m)
    .filter((doc) => doc.trim().length > 0);
}

/** The document pnpm resolves against: the LAST one carrying importers. */
export function importersDocument(text) {
  const docs = splitDocuments(text);
  for (let i = docs.length - 1; i >= 0; i--) {
    if (/^importers:[ \t]*$/m.test(docs[i])) return docs[i];
  }
  return null;
}

/**
 * Parse the importers block into
 * Map<importerPath, Map<group, Map<name, {specifier, version}>>>.
 * Indentation is significant: importer 2, group 4, dependency 6, fields 8.
 */
export function parseImporters(docText) {
  const lines = docText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^importers:[ \t]*$/.test(line));
  if (start < 0) return null;
  const importers = new Map();
  let current = null;
  let group = null;
  let dep = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) break; // settings:/packages:/snapshots: end the block
    if (indent === 2 && body.endsWith(":")) {
      const name = unquote(body.slice(0, -1));
      current = { groups: new Map() };
      group = null;
      dep = null;
      importers.set(name, current);
    } else if (indent === 4 && body.endsWith(":")) {
      group = body.slice(0, -1);
      dep = null;
      if (current) current.groups.set(group, new Map());
    } else if (indent === 6 && body.endsWith(":") && current && group) {
      dep = unquote(body.slice(0, -1));
      current.groups.get(group).set(dep, {});
    } else if (indent >= 8 && current && group && dep) {
      const field = body.match(/^(specifier|version):[ \t]*(.*)$/);
      if (field) current.groups.get(group).get(dep)[field[1]] = unquote(field[2]);
    }
  }
  return importers;
}

/** Compare one importer's manifest against its locked entries. */
export function compareImporter(importer, manifest, locked) {
  const findings = [];
  const lockedGroups = locked ? locked.groups : new Map();
  for (const group of GROUPS) {
    const declared = manifest[group] ?? {};
    const lockedEntries = lockedGroups.get(group) ?? new Map();
    for (const [name, range] of Object.entries(declared)) {
      const entry = lockedEntries.get(name);
      if (!entry) {
        findings.push(
          `PNPM-MISSING: ${importer} ${group} ${name} is declared as "${range}" in package.json but has no entry in pnpm-lock.yaml`,
        );
        continue;
      }
      if (entry.specifier !== undefined && entry.specifier !== range) {
        findings.push(
          `PNPM-SPECIFIER: ${importer} ${group} ${name} declared as "${range}" but locked specifier is "${entry.specifier}" (regenerate with "pnpm install --lockfile-only")`,
        );
      }
    }
    for (const name of lockedEntries.keys()) {
      if (!(name in declared)) {
        findings.push(
          `PNPM-STALE: ${importer} ${group} ${name} is locked but no longer declared in package.json`,
        );
      }
    }
  }
  return findings;
}

export function check({ root }) {
  const lockPath = path.join(root, "pnpm-lock.yaml");
  const lockText = readText(lockPath, "pnpm lockfile");
  const doc = importersDocument(lockText);
  if (!doc) {
    process.stderr.write(
      `LOCKSTEP: ${lockPath} has no "importers:" block in any document — not a pnpm v9 lockfile.\n`,
    );
    process.exit(2);
  }
  const importers = parseImporters(doc);
  if (!importers || importers.size === 0) {
    process.stderr.write(`LOCKSTEP: ${lockPath} records zero importers — refusing to pass.\n`);
    process.exit(2);
  }

  const findings = [];
  let compared = 0;
  for (const [importer, locked] of importers) {
    const dir = importer === "." ? root : path.join(root, importer);
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) {
      findings.push(
        `STALE IMPORTER: pnpm-lock.yaml records importer "${importer}" but ${manifestPath} does not exist`,
      );
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      process.stderr.write(`LOCKSTEP: cannot parse ${manifestPath}: ${err.message}\n`);
      process.exit(2);
    }
    findings.push(...compareImporter(importer, manifest, locked));
    compared++;
  }

  if (findings.length === 0) {
    process.stdout.write(
      `LOCKSTEP: OK — ${compared} importer(s) agree with package.json in ${lockPath}\n`,
    );
    return 0;
  }
  for (const finding of findings) process.stderr.write(`LOCKSTEP: ${finding}\n`);
  process.stderr.write(
    `LOCKSTEP: ${findings.length} pnpm lockfile finding(s); regenerate with "pnpm install --lockfile-only" before committing.\n`,
  );
  return 1;
}

function selfTest() {
  const root = DEFAULT_ROOT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lockstep-selftest-"));
  const lockText = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  const docs = splitDocuments(lockText);
  const realDoc = importersDocument(lockText);
  if (!realDoc) {
    process.stderr.write("LOCKSTEP SELF-TEST FAIL: the real lockfile has no importers document\n");
    return 1;
  }
  const results = [];

  const build = (name, mutate) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, "packages", "ui"), { recursive: true });
    fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
    fs.copyFileSync(
      path.join(root, "packages", "ui", "package.json"),
      path.join(dir, "packages", "ui", "package.json"),
    );
    fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), mutate(lockText));
    return dir;
  };

  const staleDoc = realDoc.replace(
    /(^|\n)(      prom-client:\n        specifier: [^\n]*\n        version: [^\n]*\n)/,
    "$1",
  );
  const staledSpecifier = realDoc.replace(
    /(      prom-client:\n        specifier: )([^\n]*)/,
    "$1^0.0.1-staled",
  );
  const phantom = realDoc.replace(
    /(\n      zod:\n        specifier: \^4\.6\.7\n        version: 4\.6\.7\n)/,
    "$1      left-pad:\n        specifier: ^1.3.0\n        version: 1.3.0\n",
  );

  const arm = (name, mutate, expectedCode, expectedText) => {
    const dir = build(name, mutate);
    const code = check({ root: dir });
    const ok = code === expectedCode;
    results.push({ name, code, expectedCode, ok, expectedText, dir });
    return ok;
  };

  arm("green", (text) => text, 0, "");
  arm("red-missing", () => staleDoc, 1, null);
  arm("red-specifier", () => staledSpecifier, 1, null);
  arm("red-stale", () => phantom, 1, null);
  // pnpm 12's leading self-management document must not confuse the parser.
  arm("green-multidoc", (text) => `${docs[0]}\n---\n${realDoc}`, 0, "");

  const importers = parseImporters(realDoc);
  const green = results[0];
  const greenText = importers && importers.get(".")?.groups.get("dependencies")?.get("prom-client");
  const failures = [];
  if (!results.every((r) => r.ok)) {
    failures.push(
      `exit codes: ${results.map((r) => `${r.name}=${r.code}(want ${r.expectedCode})`).join(", ")}`,
    );
  }
  if (!greenText || !greenText.specifier) {
    failures.push("parser saw no prom-client entry in the real lockfile's root importer");
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (failures.length > 0) {
    process.stderr.write(`LOCKSTEP SELF-TEST FAIL: ${failures.join("; ")}\n`);
    return 1;
  }
  process.stdout.write(
    `LOCKSTEP SELF-TEST PASS — green, green-multidoc (${docs.length} documents), red-missing, red-specifier, red-stale\n`,
  );
  return 0;
}

export function main(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let self = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-test") self = true;
    else if (arg === "--root") root = path.resolve(argv[++i]);
    else if (arg.startsWith("--root=")) root = path.resolve(arg.slice("--root=".length));
    else {
      process.stderr.write(`LOCKSTEP: unknown argument "${arg}"\n`);
      return 2;
    }
  }
  if (self) return selfTest();
  return check({ root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
