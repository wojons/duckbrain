import { describe, it, expect } from "vitest";
import { execSync } from "child_process";

/**
 * DB-GAP-059: assert no orphaned scratch daemons survive the test suite.
 * The host-side reaper (~/.hermes/scripts/stray-duckbrain-reaper.py) handles
 * daemon-shaped orphans, but this test catches test-infra leaks that the
 * host reaper skips (agent terminals inside hermes-gateway.service cgroup).
 */
describe("orphan reaper", () => {
  it("no orphaned duckbrain http processes after suite", () => {
    // Find duckbrain http processes that are NOT the managed systemd unit.
    // The managed unit runs as duckbrain-http.service; test-spawned daemons
    // are orphaned (PPID=1 or systemd --user) and NOT in that cgroup.
    let output: string;
    try {
      // pgrep -f matches cmdline; exclude the managed unit by checking cgroup.
      // A simpler heuristic: any `duckbrain http --port=` process whose PPID
      // is 1 (orphaned) or whose parent is not a test runner is suspect.
      output = execSync(
        `ps -eo pid,ppid,cmd | grep -E 'duckbrain.*http.*--port=' | grep -v grep || true`,
        { encoding: "utf-8" },
      ).trim();
    } catch {
      output = "";
    }

    if (!output) {
      // No duckbrain http processes at all — clean.
      expect(true).toBe(true);
      return;
    }

    // Parse each line: pid ppid cmd
    const lines = output.split("\n").filter(Boolean);
    const orphans: string[] = [];

    for (const line of lines) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, cmd] = match;

      // Check if this pid is the managed unit's main process.
      // The managed unit's MainPID is in /sys/fs/cgroup/system.slice/duckbrain-http.service/cgroup.procs
      // but a simpler check: if the process is in a user session (not a test
      // spawn), its cmdline won't have the test-specific env pins.
      // Heuristic: test-spawned daemons have DUCKBRAIN_EMBEDDING_PROVIDER=openai
      // in their env (set by helpers.ts). The managed unit doesn't.
      try {
        const env = execSync(`cat /proc/${pid}/environ 2>/dev/null || true`, {
          encoding: "utf-8",
        });
        // Test daemons pin DUCKBRAIN_EMBEDDING_PROVIDER=openai (helpers.ts:372).
        // The managed unit uses the real provider from config.
        if (env.includes("DUCKBRAIN_EMBEDDING_PROVIDER=openai")) {
          // This is a test-spawned daemon. Check if it's orphaned (PPID=1 or parent is systemd --user).
          // On systemd --user, orphaned daemons have PPID = systemd --user's PID.
          // A simpler check: if the parent is not a node/vitest process, it's orphaned.
          const parentCmd = execSync(
            `ps -o cmd= -p ${ppid} 2>/dev/null || echo ''`,
            { encoding: "utf-8" },
          ).trim();
          const isOrphaned =
            ppid === "1" ||
            !parentCmd ||
            (!parentCmd.includes("vitest") &&
              !parentCmd.includes("node") &&
              !parentCmd.includes("bash"));
          if (isOrphaned) {
            orphans.push(`pid ${pid} (ppid ${ppid}): ${cmd}`);
          }
        }
      } catch {
        // Process exited between ps and cat — not a leak.
      }
    }

    expect(
      orphans,
      `Orphaned test-spawned daemons found (should be reaped by helpers.ts killProcess or host reaper):\n${orphans.join("\n")}`,
    ).toHaveLength(0);
  });
});
