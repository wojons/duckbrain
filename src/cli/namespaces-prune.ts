/**
 * DB-GAP-065 — `duckbrain namespaces prune` CLI verb.
 *
 * SAFE BY DEFAULT: `duckbrain namespaces prune` is a DRY RUN. It prints the
 * dead mappings it would remove (and the count) and exits 0 without touching
 * disk. Only `--apply` writes. `--dry-run` explicitly wins when both flags are
 * passed, so an accidental `--apply --dry-run` can never mutate the registry.
 *
 * Exit codes:
 *   0  dry-run completed, or apply removed its dead set (0 rows included)
 *   1  at least one dead mapping was REFUSED by the path-safety guard
 *      (escapes the namespaces root) — the rest of the dead set was applied
 *   2  aborted without writing: concurrent config write, or a write failure
 *
 * The core (plan/apply) lives in src/namespaces/prune.ts; this module owns only
 * argument semantics and the human-readable report.
 */

import {
  applyNamespacePrune,
  planNamespacePrune,
} from "../namespaces/prune";
import type {
  NamespacePruneApplyResult,
  NamespacePrunePlan,
} from "../namespaces/prune";

export interface NamespacesPruneRunOptions {
  /** True = report only (the default for the CLI verb). */
  dryRun: boolean;
  /** Output sinks — tests capture these; the CLI defaults to stdout/stderr. */
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export interface NamespacesPruneRunResult {
  exitCode: number;
  plan: NamespacePrunePlan;
  /** Present only when the plan was applied (dryRun === false). */
  applied?: NamespacePruneApplyResult;
}

/**
 * Run the prune verb and report. Never calls process.exit — the caller owns
 * that, so the same function is safe to drive from tests.
 *
 * The dead set is printed in FULL (no truncation): AC-1 asks for the set of
 * mappings that would be removed, and an operator must be able to pipe/eyeball
 * every row before applying. A 15k-row registry prints 15k lines; that is the
 * registry's own size, not a formatting choice.
 */
export function runNamespacesPrune(
  opts: NamespacesPruneRunOptions,
): NamespacesPruneRunResult {
  const out = opts.out ?? ((line: string) => console.log(line));
  const err = opts.err ?? ((line: string) => console.error(line));

  const plan = planNamespacePrune();

  out(
    `Namespace registry: ${plan.live.length + plan.dead.length + plan.refused.length} mapping(s), ` +
      `${plan.bytesBefore} bytes`,
  );
  out(
    `  live: ${plan.live.length}  dead: ${plan.dead.length}  refused: ${plan.refused.length}`,
  );

  if (plan.dead.length > 0) {
    out(
      opts.dryRun
        ? `DRY RUN — would remove ${plan.dead.length} dead mapping(s):`
        : `Removing ${plan.dead.length} dead mapping(s):`,
    );
    for (const row of plan.dead) {
      out(`  - ${row.name} -> ${row.path}`);
    }
  }

  if (plan.refused.length > 0) {
    err(
      `Error: refusing to prune ${plan.refused.length} dead mapping(s) whose path escapes the namespaces root (${plan.namespacesRoot}):`,
    );
    for (const row of plan.refused) {
      err(`  - ${row.name} -> ${row.resolvedPath}`);
    }
    err("Remove those mappings by hand after checking what they point at.");
  }

  if (opts.dryRun) {
    if (plan.dead.length === 0) {
      out("Nothing to prune — every registered mapping has a directory on disk.");
    } else {
      out(
        "Nothing written (dry run). Re-run with 'duckbrain namespaces prune --apply' to remove them.",
      );
    }
    return { exitCode: plan.refused.length > 0 ? 1 : 0, plan };
  }

  let applied: NamespacePruneApplyResult;
  try {
    applied = applyNamespacePrune(plan);
  } catch (error) {
    err(
      `Error: ${error instanceof Error ? error.message : String(error)} — nothing was written.`,
    );
    return { exitCode: 2, plan };
  }

  if (applied.removed.length === 0) {
    out("Nothing to prune — every registered mapping has a directory on disk.");
  } else {
    out(
      `Removed ${applied.removed.length} dead mapping(s); config ${applied.bytesBefore} -> ${applied.bytesAfter} bytes`,
    );
    out(
      `  S3 sync manifests pruned: ${applied.manifestsPruned.length}` +
        (applied.manifestsPruned.length > 0
          ? ` (${applied.manifestsPruned.join(", ")})`
          : ""),
    );
  }

  return {
    exitCode: plan.refused.length > 0 ? 1 : 0,
    plan,
    applied,
  };
}
