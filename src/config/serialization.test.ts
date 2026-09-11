import { describe, expect, it } from "vitest";
import { DuckBrainConfigSchema, initializeConfig } from "./index";
import fs from "fs";
import os from "os";
import path from "path";

describe("SUPA-2 serialization configuration", () => {
  it("applies the exact default queue bounds", () => {
    const config = DuckBrainConfigSchema.parse({});
    expect(config.serialization).toEqual({
      maxPendingRows: 10_000,
      maxPendingBytes: 32 * 1024 * 1024,
    });
  });

  it("rejects non-positive and non-integer queue bounds", () => {
    expect(() =>
      DuckBrainConfigSchema.parse({ serialization: { maxPendingRows: 0 } }),
    ).toThrow();
    expect(() =>
      DuckBrainConfigSchema.parse({ serialization: { maxPendingBytes: 1.5 } }),
    ).toThrow();
  });

  it("writes serialization defaults during initialization", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-supa2-config-"),
    );
    const oldPath = process.env.DUCKBRAIN_CONFIG_PATH;
    const file = path.join(dir, "config.json");
    process.env.DUCKBRAIN_CONFIG_PATH = file;
    try {
      const config = initializeConfig(dir, "test@example.com");
      expect(config.serialization.maxPendingRows).toBe(10_000);
      expect(JSON.parse(fs.readFileSync(file, "utf-8")).serialization).toEqual({
        maxPendingRows: 10_000,
        maxPendingBytes: 32 * 1024 * 1024,
      });
    } finally {
      if (oldPath === undefined) delete process.env.DUCKBRAIN_CONFIG_PATH;
      else process.env.DUCKBRAIN_CONFIG_PATH = oldPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
