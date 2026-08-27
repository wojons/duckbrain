/**
 * DOGFOOD-030 regression tests: `duckbrain s3 status` endpoint display and
 * buildClient must reflect the EFFECTIVE endpoint — AWS_ENDPOINT_URL_S3 env
 * wins over AWS_ENDPOINT_URL env, which wins over the config value.
 *
 * The status display previously printed the config endpoint even when the
 * ecosystem synced via AWS_ENDPOINT_URL env (git-remote-s3 push path,
 * duckbrain-s3-push.sh), misleading operators auditing which store is in use.
 *
 * Isolation: DUCKBRAIN_CONFIG_PATH points at a temp config file with a known
 * s3 block, and DUCKBRAIN_NAMESPACES_PATH points at an EMPTY temp dir so
 * s3Status has no namespaces to list — the endpoint line is printed before
 * any listing, and with zero namespaces no network call is ever attempted.
 * Env vars are snapshotted in beforeEach and restored in afterEach so no
 * leakage survives into other test files (tier1 re-runs the suite).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { s3Status } from "./cli";
import { buildClient } from "./client";
import { DEFAULT_S3_CONFIG, type S3Config } from "./config";

const ENV_KEYS = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_ENDPOINT_URL",
  "DUCKBRAIN_CONFIG_PATH",
  "DUCKBRAIN_NAMESPACES_PATH",
] as const;

let envSnapshot: Record<string, string | undefined>;
let tmpDir: string;

beforeEach(() => {
  envSnapshot = Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]]),
  ) as Record<string, string | undefined>;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood030-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(s3: Partial<S3Config>): string {
  const cfgFile = path.join(tmpDir, "duckbrain.config.json");
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ s3: { ...DEFAULT_S3_CONFIG, ...s3 } }, null, 2),
    "utf-8",
  );
  return cfgFile;
}

function cfgWithEndpoint(endpoint?: string): S3Config {
  return { ...DEFAULT_S3_CONFIG, enabled: true, endpoint };
}

/** Run s3Status with the given config + env, returning the captured endpoint line. */
async function statusEndpointLine(
  s3: Partial<S3Config>,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  process.env.DUCKBRAIN_CONFIG_PATH = writeConfig(s3);
  // Empty namespaces dir → s3Status lists nothing → no network calls.
  const emptyNs = path.join(tmpDir, "empty-ns");
  fs.mkdirSync(emptyNs, { recursive: true });
  process.env.DUCKBRAIN_NAMESPACES_PATH = emptyNs;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await s3Status(".");
  const line = log.mock.calls
    .map((c) => c.join(" "))
    .find((s) => s.startsWith("  endpoint:"));
  return line;
}

describe("s3Status endpoint display (DOGFOOD-030)", () => {
  it("prints the config endpoint when no env override is set", async () => {
    const line = await statusEndpointLine(
      { enabled: true, endpoint: "https://config.example.com" },
      { AWS_ENDPOINT_URL: undefined, AWS_ENDPOINT_URL_S3: undefined },
    );
    expect(line).toBe("  endpoint: https://config.example.com");
  });

  it("prints AWS_ENDPOINT_URL when set (env wins over config)", async () => {
    const line = await statusEndpointLine(
      { enabled: true, endpoint: "https://config.example.com" },
      { AWS_ENDPOINT_URL: "https://env.example.com" },
    );
    expect(line).toBe("  endpoint: https://env.example.com");
  });

  it("prints AWS_ENDPOINT_URL_S3 when set (wins over AWS_ENDPOINT_URL)", async () => {
    const line = await statusEndpointLine(
      { enabled: true, endpoint: "https://config.example.com" },
      {
        AWS_ENDPOINT_URL: "https://generic.example.com",
        AWS_ENDPOINT_URL_S3: "https://s3-specific.example.com",
      },
    );
    expect(line).toBe("  endpoint: https://s3-specific.example.com");
  });

  it('prints "(AWS default)" when neither config nor env has an endpoint', async () => {
    const line = await statusEndpointLine(
      { enabled: true, endpoint: undefined },
      { AWS_ENDPOINT_URL: undefined, AWS_ENDPOINT_URL_S3: undefined },
    );
    expect(line).toBe("  endpoint: (AWS default)");
  });
});

describe("buildClient endpoint resolution (DOGFOOD-030)", () => {
  it("passes the env override endpoint to the client (wins over config)", async () => {
    process.env.AWS_ENDPOINT_URL = "https://env.example.com";
    delete process.env.AWS_ENDPOINT_URL_S3;
    const client = buildClient(cfgWithEndpoint("https://config.example.com"));
    const ep = client.config.endpoint as unknown as () => Promise<{
      hostname: string;
      protocol: string;
    }>;
    const resolved = await ep();
    expect(resolved.hostname).toBe("env.example.com");
    expect(resolved.protocol).toBe("https:");
    // forcePathStyle semantics preserved when an endpoint is in effect.
    expect(client.config.forcePathStyle).toBe(true);
  });

  it("uses the config endpoint when no env override is set", async () => {
    delete process.env.AWS_ENDPOINT_URL;
    delete process.env.AWS_ENDPOINT_URL_S3;
    const client = buildClient(cfgWithEndpoint("https://config.example.com"));
    const ep = client.config.endpoint as unknown as () => Promise<{
      hostname: string;
    }>;
    expect((await ep()).hostname).toBe("config.example.com");
  });
});
