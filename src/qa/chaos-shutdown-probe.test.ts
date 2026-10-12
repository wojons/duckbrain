import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const probePath = join(process.cwd(), '.qa/chaos-probes/shutdown.sh');

/**
 * QA-DUCKBRAIN-009 — the battery's chaos-shutdown cell failed on the SECOND
 * `docker compose up -d` of a run (UP=1|STOP=0|RESTART=0|KILL=0|...), because
 * the harness's own docker-deploy leg leaves the same compose project behind.
 * The project-owned probe must NORMALIZE before its first up, so these tests
 * assert the exact compose call ORDER, the flags (never `-v`), and the
 * exit-code contract — against a fake `docker` on PATH, so no daemon, image or
 * network is ever involved.
 */

// Fake `docker`: records every invocation and simulates ONE compose project's
// lifecycle state (running/stopped/killed/down) plus the two environment gaps
// the probe preflights (compose plugin missing, image not built).
const FAKE_DOCKER = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$CALLS_PATH"
if [ "$1" != compose ]; then
  if [ "$1" = image ] && [ "\${2:-}" = inspect ]; then
    if [ "\${FAKE_IMAGE_MISSING:-0}" = 1 ]; then
      echo "Error response from daemon: No such image: $3" >&2
      exit 1
    fi
    exit 0
  fi
  echo "fake docker: unexpected non-compose invocation: $*" >&2
  exit 64
fi
shift
case "$1" in
  version)
    if [ "\${FAKE_COMPOSE_MISSING:-0}" = 1 ]; then
      echo "docker: 'compose' is not a docker command." >&2
      exit 1
    fi
    exit 0
    ;;
  config)
    case "$*" in
      *--images*) printf 'duckbrain:qa\\n' ;;
    esac
    exit 0
    ;;
  down)  printf 'down' > "$STATE_PATH" ;;
  up)
    if [ "\${FAKE_PORT_COLLISION:-0}" = 1 ]; then
      echo "Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:3000 failed: port is already allocated" >&2
      exit 1
    fi
    printf 'running' > "$STATE_PATH"
    ;;
  stop)
    if [ "\${FAKE_STUCK_STOP:-0}" = 1 ]; then printf 'running' > "$STATE_PATH"
    else printf 'stopped' > "$STATE_PATH"
    fi
    ;;
  start) printf 'running' > "$STATE_PATH" ;;
  kill)
    if [ "\${FAKE_STUCK_KILL:-0}" = 1 ]; then printf 'running' > "$STATE_PATH"
    else printf 'killed' > "$STATE_PATH"
    fi
    ;;
  ps)
    state="$(cat "$STATE_PATH" 2>/dev/null || printf 'down')"
    case "$*" in
      *--all*) if [ "$state" != down ]; then printf 'fake-container-id\\n'; fi ;;
      *) if [ "$state" = running ]; then printf 'fake-container-id\\n'; fi ;;
    esac
    exit 0
    ;;
  *) echo "fake docker: unexpected compose verb: $*" >&2; exit 64 ;;
esac
`;

const LIFECYCLE_VERB = /^compose (up|down|stop|start|kill)(\s|$)/;
const VOLUME_REMOVAL = /(^|\s)(-v|--volumes)(\s|$)/;

const lifecycleVerbs = (calls: string[]): string[] => calls.filter((call) => LIFECYCLE_VERB.test(call));

interface Sandbox {
  statePath: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
  calls: () => string[];
}

function makeSandbox(): Sandbox {
  const sandbox = mkdtempSync(join(tmpdir(), 'duckbrain-shutdown-probe-'));
  const binPath = join(sandbox, 'bin');
  mkdirSync(binPath, { recursive: true });
  const dockerPath = join(binPath, 'docker');
  writeFileSync(dockerPath, FAKE_DOCKER, { mode: 0o755 });
  chmodSync(dockerPath, 0o755);
  const callsPath = join(sandbox, 'calls');
  const statePath = join(sandbox, 'state');
  return {
    statePath,
    env: (extra: Record<string, string> = {}) => ({
      ...process.env,
      PATH: `${binPath}:${process.env.PATH ?? ''}`,
      CALLS_PATH: callsPath,
      STATE_PATH: statePath,
      ...extra,
    }),
    calls: () =>
      existsSync(callsPath)
        ? readFileSync(callsPath, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
        : [],
  };
}

function runProbe(env: NodeJS.ProcessEnv): { status: number; stdout: string } {
  const result = spawnSync('bash', [probePath], { cwd: process.cwd(), env, encoding: 'utf8' });
  return { status: result.status ?? -1, stdout: String(result.stdout ?? '') };
}

describe('chaos-shutdown probe (.qa/chaos-probes/shutdown.sh)', () => {
  it('is committed executable and its bash syntax parses', () => {
    expect(statSync(probePath).mode & 0o111).toBeGreaterThan(0);
    const syntax = spawnSync('bash', ['-n', probePath], { encoding: 'utf8' });
    expect(syntax.status).toBe(0);
  });

  it('normalizes before the first up, keeps the data volume, and state-verifies every leg', () => {
    const box = makeSandbox();
    const { status, stdout } = runProbe(box.env());
    expect(status).toBe(0);
    expect(stdout).toContain('SHUTDOWN_PROBE=OK');

    const calls = box.calls();
    const verbs = lifecycleVerbs(calls);

    // (i) THE REGRESSION: a `down --remove-orphans` runs BEFORE the first up,
    //     so the second `up -d` of a battery cannot inherit a stranded stack.
    //     The full expected verb order is the contract: normalize -> up ->
    //     stop -> start -> kill -> start -> down -> up (the row's second up) ->
    //     down, plus the EXIT-trap teardown.
    expect(verbs).toEqual([
      'compose down --remove-orphans',
      'compose up -d',
      'compose stop',
      'compose start',
      'compose kill',
      'compose start',
      'compose down --remove-orphans',
      'compose up -d',
      'compose down --remove-orphans',
      'compose down --remove-orphans',
    ]);
    expect(verbs.indexOf('compose up -d')).toBeGreaterThan(verbs.indexOf('compose down --remove-orphans'));

    // (ii) the named data volume (duckbrain-data) must survive every leg.
    expect(calls.filter((call) => VOLUME_REMOVAL.test(call))).toEqual([]);

    // (iii) plain `up -d` only: the deploy leg builds, this probe must not.
    expect(calls.filter((call) => call.startsWith('compose up'))).toEqual(['compose up -d', 'compose up -d']);

    // every stop/kill leg is state-verified, not trusted from verb rc
    expect(stdout).toContain('SIGTERM_STOP=verified');
    expect(stdout).toContain('RESTART=verified');
    expect(stdout).toContain('SIGKILL_STOP=verified');
    expect(stdout).toContain('KILL_RECOVER=verified');
    expect(stdout).toContain('DOWN=verified');

    // the image preflight was consulted (auto-build would blow the budget)
    expect(calls).toContain('compose config --images');
    expect(calls).toContain('image inspect duckbrain:qa');

    expect(readFileSync(box.statePath, 'utf8')).toBe('down');
  });

  it('grades a container that survives stop as misbehavior (rc 1, not a hollow OK)', () => {
    const box = makeSandbox();
    const { status, stdout } = runProbe(box.env({ FAKE_STUCK_STOP: '1' }));
    expect(status).toBe(1);
    expect(stdout).toContain('SIGTERM stop NOT verified');
    // the chain aborted at the failed leg: no start/kill/second-up ran
    expect(lifecycleVerbs(box.calls())).toEqual([
      'compose down --remove-orphans',
      'compose up -d',
      'compose stop',
      'compose down --remove-orphans',
    ]);
  }, 30_000);

  it('exits 2 without running a compose lifecycle verb when the image is not built', () => {
    const box = makeSandbox();
    const { status, stdout } = runProbe(box.env({ FAKE_IMAGE_MISSING: '1' }));
    expect(status).toBe(2);
    expect(stdout).toContain('environment gap');
    expect(stdout).toContain('compose images not built');
    // gates run BEFORE the trap is installed: an environment gap never touches
    // the project (the safety property for hosts whose Docker context is not ours)
    expect(lifecycleVerbs(box.calls())).toEqual([]);
  });

  it('exits 2 when the compose plugin is unavailable', () => {
    const box = makeSandbox();
    const { status, stdout } = runProbe(box.env({ FAKE_COMPOSE_MISSING: '1' }));
    expect(status).toBe(2);
    expect(stdout).toContain('docker compose unavailable');
    expect(lifecycleVerbs(box.calls())).toEqual([]);
  });

  it('attributes a foreign port collision to the environment, not to shutdown logic', () => {
    const box = makeSandbox();
    const { status, stdout } = runProbe(box.env({ FAKE_PORT_COLLISION: '1' }));
    expect(status).toBe(2);
    expect(stdout).toContain('environment gap');
    expect(stdout).toContain('port is already allocated');
    // normalization ran, up collided on a foreign holder, the trap cleaned up —
    // and no stop/start/kill was graded against the repo.
    expect(lifecycleVerbs(box.calls())).toEqual([
      'compose down --remove-orphans',
      'compose up -d',
      'compose down --remove-orphans',
    ]);
  });
});
