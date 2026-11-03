# Dogfood scratch, port, and agent ownership

Dogfood executions must isolate state by run, not by project/date. Use
`ops/lane-scratch.sh` from every dogfood entrypoint that allocates scratch,
TCP ports, or child agents. Do not use shared names such as
`/tmp/df-<project>-<date>` or fixed ports.

## Helper contract

Source `ops/lane-scratch.sh`, then call:

- `lane_scratch_allocate <project> <lane> <tick-label> <agent-id> [base-dir]`
  creates a mode-0700 randomized directory such as
  `/tmp/duckbrain-dogfood-<tick-label>-<random>/` and prints its path. The
  mode-0600 `run.state` records `run_id`, `agent_id`, and the root. The run ID
  is the directory basename.
- `lane_scratch_allocate_port <root> <run-id> <agent-id>` atomically claims a
  previously unclaimed port lock in the configured range, checks that the port
  is not listening, appends it to `run.state`, and prints it. Port locks are
  held until `lane_scratch_release_ports` is called during cleanup. Set
  `LANE_PORT_LOCK_DIR` to override the shared lock directory.
- `lane_scratch_claim_agent <root> <run-id> <agent-id> <pid>` writes a tag
  under `agents/<agent-id>/<pid>/ownership.tag` after verifying run ownership.
- `lane_scratch_teardown_agent <root> <run-id> <agent-id> <pid>` removes only
  that PID's tag/directory if run and agent IDs match. Callers must perform
  teardown validation before killing or removing the corresponding agent.
- `lane_scratch_assert_owner <root> <run-id> <agent-id>` is the required
  pre-spawn/adoption check. Missing state or mismatched ownership returns
  nonzero; a mismatch names the path, requested run/agent, and existing run/
  agent on stderr. A lane must stop on that failure, never reuse the path.

The lock-file port reservation prevents concurrent helper allocations from
selecting the same port. As with any local TCP allocation, another process that
does not use these locks could bind a port after the helper's listening probe;
startup must still handle bind failure as an error.

## Entrypoint and cleanup rules

`ops/dogfood-e2e.sh` allocates its root and each daemon port through the helper;
`ops/dogfood-phase8-s3gate.sh` uses the same allocator for its canary daemon.
Every spawned daemon is tagged by PID. Cleanup validates the exact tag before
killing a daemon and releases only this run's port locks. Never recursively
remove a root or agent path until its run/agent ownership has been verified.

## Verification

Run `pnpm exec vitest run src/ops/lane-scratch.test.ts` for the regression tests.
Run `ops/test-lane-scratch-deconfliction.sh [evidence-path]` for the two-lane
host-local dry run. It records lane A's root/port/agent tag and evidence file,
lane B's distinct allocation, a forced collision naming both runs, and a final
proof that lane A's evidence is intact.
