#!/usr/bin/env node
/**
 * TESTQ-2026-10-29-1: the CI step "Run bin CLI E2E" must invoke a Vitest
 * config that can actually DISCOVER the bin E2E file.
 *
 * Red baseline (GitHub run 40857806554, SHA 5d6b0f6b): the step ran
 *   pnpm exec vitest run --config vitest.integration.config.ts tests/cli-bin-e2e-df012.test.ts
 * The integration config's include list holds only the .int.test.ts pattern,
 * which cannot match a plain .test.ts path, so Vitest answered
 *   "No test files found, exiting with code 1"
 * after setup, lint, type check and the CLI build had all passed. Run
 * 40856208413 failed the same step the same way.
 *
 * The step now names its own config (vitest.cli-e2e.config.ts). This guard
 * fails fast (seconds, offline) if the step and its config ever drift apart
 * again — for example the step drops --config and falls back to
 * vitest.config.ts (whose include only covers src), or the dedicated config
 * loses the E2E file from its include list. Both produce the same empty-set
 * red.
 *
 * The oracle is Vitest's OWN discovery (`vitest list --filesOnly`), never a
 * private re-implementation of glob matching — and never the exit code:
 * `vitest list` exits 0 with empty stdout when a config discovers nothing, so
 * the assertion is on the printed file list. A non-vacuous guard is the whole
 * point; a guard that trusted the exit status would have passed on the exact
 * bug it exists to catch.
 *
 * Usage: node scripts/ci/check-cli-e2e-config.js   (exit 0 = discoverable)
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..");
// CI_YML_PATH exists so this guard's own red/green arms can point at fixtures
// (the historical broken step, a step with no --config) without editing the
// tracked workflow. Production and CI always read the real ci.yml.
const CI_PATH = process.env.CI_YML_PATH
  ? path.resolve(process.env.CI_YML_PATH)
  : path.join(repoRoot, ".github", "workflows", "ci.yml");
const STEP_NAME = "Run bin CLI E2E";
const E2E_FILE = "tests/cli-bin-e2e-df012.test.ts";

function fail(message) {
  console.error(`TESTQ-2026-10-29-1: ${message}`);
  process.exit(1);
}

/** Slice the YAML block belonging to one `- name:` step. */
function stepBlock(yaml, name) {
  const lines = yaml.split("\n");
  const header = new RegExp(`^(\\s*)- name:\\s*${name}\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    fail(
      `ci.yml has no step named "${name}" — retarget this guard at whatever ` +
        "step now runs the bin CLI E2E.",
    );
  }
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*$/.test(line)) {
      block.push(line);
      continue;
    }
    const lineIndent = line.match(/^\s*/)[0].length;
    // A sibling step at the same indent, or any line dedented out of the
    // steps list, ends this block.
    if (lineIndent <= indent) break;
    block.push(line);
  }
  return block.join("\n");
}

function main() {
  if (!fs.existsSync(CI_PATH)) fail(`${CI_PATH} not found`);

  const block = stepBlock(fs.readFileSync(CI_PATH, "utf8"), STEP_NAME);
  // Strip YAML comments first: this workflow's own explanatory comments quote
  // the tokens this guard looks for ("--config cannot discover ..."), and a
  // grep over raw text happily matches prose. The lesson that produced this
  // guard is the same one: assert on what the step EXECUTES.
  const commands = block
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  if (!/vitest/.test(commands)) {
    fail(`the "${STEP_NAME}" step no longer invokes Vitest — retarget this guard.`);
  }

  const vitestCall = commands.match(/vitest\s+(?:run|list)\b[^\n]*/);
  const match = vitestCall && vitestCall[0].match(/--config\s+([^\s'"\\]+)/);
  if (!match) {
    fail(
      `the "${STEP_NAME}" step does not pass --config to its vitest invocation. ` +
        "Without it Vitest falls back to vitest.config.ts, whose include covers " +
        'src only, so the bin E2E file is never collected ("No test files ' +
        'found", exit 1).',
    );
  }
  const config = match[1];
  const configPath = path.join(repoRoot, config);
  if (!fs.existsSync(configPath)) {
    fail(`the "${STEP_NAME}" step names --config ${config}, which does not exist.`);
  }
  if (!fs.existsSync(path.join(repoRoot, E2E_FILE))) {
    fail(
      `${E2E_FILE} is missing. If it was renamed, update E2E_FILE in ` +
        "scripts/ci/check-cli-e2e-config.js in the same commit.",
    );
  }

  const probe = spawnSync(
    "pnpm",
    ["exec", "vitest", "list", "--config", config, "--filesOnly"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
  if (probe.error) fail(`could not run vitest list: ${probe.error.message}`);
  const stdout = (probe.stdout || "").replace(/\u001b\[[0-9;]*[mK]/g, "");
  const discovered = stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter(Boolean);

  if (probe.status !== 0 && discovered.length === 0) {
    fail(
      `vitest list failed for --config ${config} (exit ${probe.status}):\n` +
        `${(probe.stderr || "").trim()}`,
    );
  }
  if (discovered.length === 0) {
    fail(
      `--config ${config} discovers ZERO test files. This is the red baseline of ` +
        "run 40857806554 wearing a different hat: the step would run and exit 1 " +
        'with "No test files found".',
    );
  }
  if (!discovered.includes(E2E_FILE)) {
    const shown = discovered.slice(0, 8);
    const rest = discovered.length - shown.length;
    fail(
      `--config ${config} discovers ${discovered.length} file(s) but not ${E2E_FILE}:\n` +
        shown.map((file) => `  - ${file}`).join("\n") +
        (rest > 0 ? `\n  ... and ${rest} more` : "") +
        "\nFix the config's include list (or point the step at the config that " +
        "covers the file).",
    );
  }

  console.log(
    `TESTQ-2026-10-29-1: "${STEP_NAME}" config ${config} discovers ${E2E_FILE} ` +
      `(${discovered.length} file(s) total).`,
  );
}

main();
