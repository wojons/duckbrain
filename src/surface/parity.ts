/**
 * SURFACE-PARITY-001 — diff the capability matrix against the code, and render
 * the document from the same source.
 *
 * Two directions, both required (row criterion 2):
 *   - UNDECLARED: something exists in the code that no capability row claims.
 *     This is how a new route/tool/verb gets noticed instead of drifting.
 *   - MISSING: a row claims a surface and the code no longer has it — a
 *     deletion or a rename that silently removed a capability.
 *
 * A surface with no key and no `na` reason is PENDING: legitimate, visible in
 * the generated doc, and never a test failure. Nothing about "we forgot".
 */

import {
  CAPABILITIES,
  OPTIONAL_HTTP_ROUTES,
  type Capability,
  type SurfaceName,
} from "./capabilities.js";
import type { SurfaceInventory } from "./inventory.js";

export type ParityIssueKind = "undeclared" | "missing" | "duplicate" | "unclaimed-sub";

export interface ParityIssue {
  kind: ParityIssueKind;
  surface: SurfaceName | "cli-sub";
  key: string;
  detail: string;
}

export interface ParityReport {
  issues: ParityIssue[];
  ok: boolean;
  /** Distinct keys the matrix claims per surface. */
  claimed: Record<SurfaceName, number>;
  /** Distinct keys the code exposes per surface. */
  observed: Record<SurfaceName, number>;
}

export interface CompareOptions {
  /** The matrix under test. Defaults to the shipped CAPABILITIES. */
  capabilities?: readonly Capability[];
  /** Dispatcher `case` labels, keyed `<file>#<fn>` (inventory.cli.subcommands). */
  subcommands?: Record<string, string[]>;
}

function declaredKeys(
  matrix: readonly Capability[],
  surface: SurfaceName,
): Map<string, string[]> {
  // key → capability ids that claim it (duplicates on http/mcp are a mistake:
  // two rows claiming one route hides whichever surface disappears first)
  const map = new Map<string, string[]>();
  for (const cap of matrix) {
    const keys =
      surface === "http"
        ? [...(cap.http ?? [])]
        : surface === "mcp"
          ? [...(cap.mcp ?? [])]
          : cap.cli
            ? [cap.cli.verb]
            : [];
    for (const key of keys) {
      const owners = map.get(key) ?? [];
      owners.push(cap.id);
      map.set(key, owners);
    }
  }
  return map;
}

export function compareSurface(
  inventory: SurfaceInventory,
  options: CompareOptions = {},
): ParityReport {
  const matrix = options.capabilities ?? CAPABILITIES;
  const subcommands = options.subcommands ?? inventory.cli.subcommands;
  const issues: ParityIssue[] = [];

  const surfaces: SurfaceName[] = ["cli", "http", "mcp"];
  const claimed: Record<SurfaceName, number> = { cli: 0, http: 0, mcp: 0 };
  const observed: Record<SurfaceName, number> = { cli: 0, http: 0, mcp: 0 };

  for (const surface of surfaces) {
    const declared = declaredKeys(matrix, surface);
    const inCode = new Set(
      surface === "cli" ? inventory.cli.verbs : inventory[surface],
    );
    claimed[surface] = declared.size;
    observed[surface] = inCode.size;

    for (const [key, owners] of declared) {
      if (!inCode.has(key) && !(surface === "http" && OPTIONAL_HTTP_ROUTES[key])) {
        issues.push({
          kind: "missing",
          surface,
          key,
          detail: `claimed by ${owners.join(", ")} but absent from the code`,
        });
      }
      if (surface !== "cli" && owners.length > 1) {
        issues.push({
          kind: "duplicate",
          surface,
          key,
          detail: `claimed by more than one capability: ${owners.join(", ")}`,
        });
      }
    }
    for (const key of inCode) {
      if (!declared.has(key)) {
        issues.push({
          kind: "undeclared",
          surface,
          key,
          detail:
            surface === "http"
              ? "route is mounted but no capability row claims it"
              : surface === "mcp"
                ? "tool is registered but no capability row claims it"
                : "CLI verb is dispatched but no capability row claims it",
        });
      }
    }
  }

  // Sub-verb dispatchers named in the matrix: the declared sub must exist, and
  // every sub the dispatcher handles must be claimed by some row.
  const dispatchers = new Map<string, { subs: Set<string>; capIds: string[] }>();
  for (const cap of matrix) {
    const cli = cap.cli;
    if (!cli?.dispatcher || !cli.sub) continue;
    const key = `${cli.dispatcher.file}#${cli.dispatcher.fn}`;
    const entry = dispatchers.get(key) ?? { subs: new Set<string>(), capIds: [] };
    entry.subs.add(cli.sub);
    entry.capIds.push(cap.id);
    dispatchers.set(key, entry);
  }
  for (const [key, entry] of dispatchers) {
    const inCode = new Set(subcommands[key] ?? []);
    for (const sub of entry.subs) {
      if (!inCode.has(sub)) {
        issues.push({
          kind: "missing",
          surface: "cli-sub",
          key: `${key} ${sub}`,
          detail: `${key} no longer dispatches '${sub}' (claimed by ${entry.capIds.join(", ")})`,
        });
      }
    }
    for (const sub of inCode) {
      if (!entry.subs.has(sub)) {
        issues.push({
          kind: "unclaimed-sub",
          surface: "cli-sub",
          key: `${key} ${sub}`,
          detail: `${key} dispatches '${sub}' but no capability row claims it`,
        });
      }
    }
  }

  return { issues, ok: issues.length === 0, claimed, observed };
}

/** One line per issue, the shape a failing test prints. */
export function describeIssues(report: ParityReport): string[] {
  if (report.ok) return [];
  return report.issues.map(
    (issue) => `${issue.kind.toUpperCase()} [${issue.surface}] ${issue.key} — ${issue.detail}`,
  );
}
