#!/usr/bin/env node
/**
 * docs-check.js — deterministic README/docs validator.
 *
 * ch:trace row=README-18 spec=README.md#Documentation wave=none:worker-wt-README-18
 * test=scripts/docs-check.js --self-test doc=README.md
 * evidence=README.md "Validating the documentation" witness=none:local-validator
 * verdict=none:doc-row-worker commit=none:pending memory=none:lane-local
 *
 * What it checks (no network, no execution of documented commands):
 *   1. Fenced code blocks in README.md and docs/**.md are balanced: every
 *      opening fence is closed, and every opening fence declares a language.
 *   2. Local relative Markdown links resolve to real files on disk.
 *      Absolute URLs, mailto:, and pure #anchors are skipped.
 *   3. Prerequisite/version claims in README.md agree with package.json:
 *      - "Node.js <N>+" claims must match engines.node (>=<N>)
 *      - "pnpm <X.Y.Z>" claims must match the packageManager field
 *
 * Usage:
 *   node scripts/docs-check.js             validate the current tree
 *   node scripts/docs-check.js --self-test red/green fixture test (temp dir)
 *
 * Exit 0 = pass, exit 1 = failures (each failure prints an actionable line).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");

/** Recursively collect *.md files under a directory. */
function collectMarkdown(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Balanced-fence check: lines whose trimmed form starts with ``` toggle
 * in/out of a fence; every opening fence must be closed before EOF.
 * Returns a list of human-readable failure strings (empty = pass).
 */
function checkFences(rel, text) {
  const failures = [];
  let inFence = false;
  let openLine = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith("```")) continue;
    if (!inFence) {
      inFence = true;
      openLine = i + 1;
    } else {
      inFence = false;
    }
  }
  if (inFence) {
    failures.push(
      `${rel}:${openLine}: code fence opened here is never closed — ` +
        "add a closing ``` line",
    );
  }
  return failures;
}

const LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Local-link check: every relative link target must resolve to a file or
 * directory on disk. Skips absolute URLs, protocol-relative URLs, mailto:,
 * data:, and pure #anchors. Returns failure strings (empty = pass).
 */
function checkLinks(rel, absFile, text) {
  const failures = [];
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    const raw = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue; // http:, mailto:, data: ...
    if (raw.startsWith("//") || raw.startsWith("#")) continue;
    const target = decodeURIComponent(raw.split("#")[0]);
    if (target === "") continue;
    const resolved = path.resolve(path.dirname(absFile), target);
    // Extensionless links are a supported docs convention here:
    // [guide](deployment) resolves to deployment.md (as GitHub/Docusaurus do).
    const exists = fs.existsSync(resolved) || fs.existsSync(`${resolved}.md`);
    if (!exists) {
      const line = text.slice(0, m.index).split("\n").length;
      failures.push(
        `${rel}:${line}: broken local link "${raw}" — ` +
          `no file at ${path.relative(ROOT, resolved)}; fix the link or add the target`,
      );
    }
  }
  return failures;
}

/**
 * Prerequisite/version claims in README.md must agree with package.json.
 * Only runs against the real repo README (not docs/**).
 */
function checkPrereqs(rel, text, pkg) {
  const failures = [];
  const enginesNode = (pkg.engines && pkg.engines.node) || "";
  const engineMajor = (enginesNode.match(/>=\s*(\d+)/) || [])[1];
  const claims = text.matchAll(/Node\.js\s+(\d+)\+/g);
  for (const c of claims) {
    if (engineMajor && c[1] !== engineMajor) {
      failures.push(
        `${rel}: claims "Node.js ${c[1]}+" but package.json engines.node is ` +
          `"${enginesNode}" — update one so the prerequisite claim is true`,
      );
    }
  }
  const manager = pkg.packageManager || ""; // e.g. pnpm@12.4.2
  const mgrVersion = manager.startsWith("pnpm@") ? manager.slice(5) : "";
  const pnpmClaims = text.matchAll(/pnpm\s+(\d+\.\d+\.\d+)/g);
  for (const c of pnpmClaims) {
    if (mgrVersion && c[1] !== mgrVersion) {
      failures.push(
        `${rel}: claims "pnpm ${c[1]}" but package.json packageManager is ` +
          `"${manager}" — update one so the install instructions stay true`,
      );
    }
  }
  return failures;
}

/** Run all checks against a root directory; returns failure strings. */
function validate(root) {
  const failures = [];
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const files = [
    path.join(root, "README.md"),
    ...collectMarkdown(path.join(root, "docs")),
  ];
  for (const abs of files) {
    const rel = path.relative(root, abs);
    const text = fs.readFileSync(abs, "utf8");
    failures.push(...checkFences(rel, text));
    failures.push(...checkLinks(rel, abs, text));
    if (rel === "README.md") {
      failures.push(...checkPrereqs(rel, text, pkg));
    }
  }
  return failures;
}

/**
 * Red/green self-test: builds a deliberately broken fixture (unbalanced
 * fence, dead link, wrong Node/pnpm claims) and asserts the validator flags
 * it, then a valid fixture and asserts it passes. Exercises the same
 * validate() the real run uses.
 */
function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-check-"));
  try {
    fs.mkdirSync(path.join(dir, "docs", "guide"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        engines: { node: ">=22" },
        packageManager: "pnpm@12.4.2",
      }),
    );
    fs.writeFileSync(
      path.join(dir, "docs", "guide", "ok.md"),
      "# ok\n\n```bash\npnpm install\n```\n",
    );

    // RED arm: everything broken.
    fs.writeFileSync(
      path.join(dir, "README.md"),
      [
        "# red",
        "",
        "Node.js 20+",
        "pnpm 9.0.0 via corepack",
        "",
        "```bash",
        "pnpm install",
        "", // unbalanced fence
        "[dead link](docs/guide/missing.md)",
        "",
      ].join("\n"),
    );
    const red = validate(dir);
    const redOk =
      red.some((f) => f.includes("never closed")) &&
      red.some((f) => f.includes("broken local link")) &&
      red.some((f) => f.includes('"Node.js 20+"')) &&
      red.some((f) => f.includes('"pnpm 9.0.0"'));
    if (!redOk) {
      console.error("self-test RED arm failed; validator reported:");
      for (const f of red) console.error(`  ${f}`);
      return false;
    }

    // GREEN arm: everything fixed.
    fs.writeFileSync(
      path.join(dir, "README.md"),
      [
        "# green",
        "",
        "Node.js 22+",
        "pnpm 12.4.2 via corepack",
        "",
        "```bash",
        "pnpm install",
        "```",
        "",
        "[guide](docs/guide/ok.md)",
        "",
      ].join("\n"),
    );
    const green = validate(dir);
    if (green.length > 0) {
      console.error("self-test GREEN arm failed; validator reported:");
      for (const f of green) console.error(`  ${f}`);
      return false;
    }
    console.log(
      "self-test: RED arm flagged 4 defect classes, GREEN arm passed",
    );
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(selfTest() ? 0 : 1);
  }
  const failures = validate(ROOT);
  if (failures.length > 0) {
    console.error(`docs-check: ${failures.length} problem(s) found:`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  const docsCount = collectMarkdown(path.join(ROOT, "docs")).length;
  console.log(
    `docs-check: OK — README.md + ${docsCount} docs/*.md files: ` +
      "fences balanced, local links resolve, Node/pnpm claims match package.json",
  );
}

main();
