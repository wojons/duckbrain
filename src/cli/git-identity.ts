/**
 * GIT-IDENTITY-001 — `duckbrain git repair-identity` CLI.
 *
 * Scans the namespaces root, removes ONLY synthetic local git identity pins
 * (user.name "DuckBrain" + user.email "duckbrain at localhost*"), prints the
 * list of repaired repos, and never touches history. Idempotent: a second
 * run finds no pins and changes nothing. Falls back to the doctor-style
 * health report when no action subcommand is given.
 */

import { resolveNamespacesPath } from "../config";
import {
  checkGitIdentityHealth,
  repairNamespaceGitIdentities,
} from "../git/identity";

export async function runGitIdentityCLI(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "";

  if (subcommand === "repair-identity") {
    const namespacesPath = resolveNamespacesPath();
    console.log(`Scanning namespaces root: ${namespacesPath}`);
    const { scanned, repaired } =
      repairNamespaceGitIdentities(namespacesPath);

    console.log(
      `Scanned ${scanned.length} namespace repo(s): ${
        scanned.length > 0 ? scanned.join(", ") : "(none)"
      }`,
    );
    if (repaired.length === 0) {
      console.log("No synthetic git identity pins found — nothing to repair.");
      return;
    }
    console.log(
      `Repaired ${repaired.length} repo(s) (removed local user.name/user.email pins):`,
    );
    for (const repo of repaired) console.log(`  - ${repo}`);
    return;
  }

  // No recognized subcommand — doctor-style identity health report.
  const health = checkGitIdentityHealth(resolveNamespacesPath());
  console.log(health.message);
  if (!health.ok) process.exitCode = 1;
}
