import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const helper = path.resolve("ops/lane-scratch.sh");
const tempDirs: string[] = [];

function run(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", `source "$HELPER"; ${script}`], {
    encoding: "utf8",
    env: { ...process.env, ...env, HELPER: helper },
  });
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-lane-scratch-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("dogfood lane scratch ownership", () => {
  it("allocates distinct per-run roots and ports and names live-state collisions", () => {
    const base = sandbox();
    const ports = path.join(base, "locks");
    const result = run(
      `a=$(lane_scratch_allocate duckbrain dogfood tick-a agent-a "$BASE"); ar=$(basename "$a"); ap=$(lane_scratch_allocate_port "$a" "$ar" agent-a); b=$(lane_scratch_allocate duckbrain dogfood tick-b agent-b "$BASE"); br=$(basename "$b"); bp=$(lane_scratch_allocate_port "$b" "$br" agent-b); echo "lane-a:$a:$ap"; echo "lane-b:$b:$bp"; lane_scratch_assert_owner "$a" "$br" agent-b`,
      { BASE: base, LANE_PORT_LOCK_DIR: ports },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("scratch collision:");
    expect(result.stderr).toContain("existing_run=duckbrain-dogfood-tick-a-");
    const allocations = result.stdout.trim().split("\n");
    expect(allocations).toHaveLength(2);
    const [rootA, portA] = allocations[0].split(":").slice(1);
    const [rootB, portB] = allocations[1].split(":").slice(1);
    expect(rootA).not.toBe(rootB);
    expect(portA).not.toBe(portB);
  });

  it("refuses teardown when an agent tag belongs to another run or agent", () => {
    const base = sandbox();
    const result = run(
      'root=$(lane_scratch_allocate duckbrain dogfood tick-a owner-a "$BASE"); id=$(basename "$root"); lane_scratch_claim_agent "$root" "$id" owner-a 4242; if lane_scratch_teardown_agent "$root" "$id" owner-b 4242; then exit 9; else test -f "$root/agents/owner-a/4242/ownership.tag"; fi',
      { BASE: base, LANE_PORT_LOCK_DIR: path.join(base, "locks") },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("agent teardown refused:");
    expect(result.stderr).toContain("tagged_agent=owner-a");
    expect(result.stdout).toBe("");
  });
});
