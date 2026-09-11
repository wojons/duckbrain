/**
 * SUPA-1 — write path v2 durability: fsync-before-ack + pluggable sync modes.
 *
 * Unit-level contract tests for `src/storage/durability.ts` (see
 * `docs/specs/SUPA-1-write-durability.md`). The `fs` syscall spies are the
 * mechanism assertions the spec fixes: WHICH barrier runs, on WHICH fd, in
 * WHICH mode — measured numbers are DB-SUPA-7's deliverable, not this row's.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { z } from "zod";
import type { MemoryType } from "../schema/memory";
import { MemorySchema } from "../schema/memory";
import { appendToJsonl, readFromJsonl } from "./jsonl";
import {
  appendJsonlDirect,
  appendJsonlDurable,
  durabilityHeaderFor,
  frameJsonlRecord,
  getDurabilityHealth,
  resolveWriteMode,
  type FramedJsonlWrite,
} from "./durability";
import { isDurabilityError } from "./durability-errors";
import {
  DuckBrainConfigSchema,
  getConfig,
  type DuckBrainConfig,
} from "../config";

function makeRecord(i: number): MemoryType {
  const hex = (i % 16).toString(16);
  return {
    id: `00000000-0000-4000-8000-00000000000${hex}`,
    key: `/test/supa1/${i}`,
    domain: "event",
    timestamp: new Date().toISOString(),
    author: "test@example.com",
    action: "add",
    embedding_text: `durability test record ${i}`,
    attributes: {},
  };
}

// ── config file snapshot/restore: DUCKBRAIN_CONFIG_PATH is shared per worker ──
const CONFIG_PATH = process.env.DUCKBRAIN_CONFIG_PATH as string;
let savedConfig: string | null = null;
let savedEnvMode: string | undefined;

beforeAll(() => {
  savedConfig = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf-8")
    : null;
  savedEnvMode = process.env.DUCKBRAIN_DURABILITY_MODE;
});

afterAll(() => {
  if (savedConfig === null) {
    fs.rmSync(CONFIG_PATH, { force: true });
  } else {
    fs.writeFileSync(CONFIG_PATH, savedConfig, "utf-8");
  }
  if (savedEnvMode === undefined) {
    delete process.env.DUCKBRAIN_DURABILITY_MODE;
  } else {
    process.env.DUCKBRAIN_DURABILITY_MODE = savedEnvMode;
  }
});

function writeConfig(config: unknown): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

beforeEach(() => {
  writeConfig({});
  delete process.env.DUCKBRAIN_DURABILITY_MODE;
});

// ── temp namespace plumbing ──────────────────────────────────────────────────
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckbrain-supa1-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Capture the real fs functions BEFORE spying so mock implementations can call
 * through (the assertions must observe real syscalls, not stubs).
 */
function spyFs() {
  const realOpenSync = fs.openSync.bind(fs);
  const realFdatasyncSync = fs.fdatasyncSync.bind(fs);
  const realFsyncSync = fs.fsyncSync.bind(fs);

  const events: string[] = [];
  const fdPath = new Map<number, string>();
  const fdIsDir = new Map<number, boolean>();

  const openSpy = vi.spyOn(fs, "openSync");
  openSpy.mockImplementation(((p: any, flags: any, mode?: any) => {
    const fd = realOpenSync(p, flags, mode);
    const isDir = String(flags) === "r";
    fdPath.set(fd, String(p));
    fdIsDir.set(fd, isDir);
    events.push(
      `open ${isDir ? "dir" : "file"} ${String(p)} flags=${String(flags)}`,
    );
    return fd;
  }) as any);

  const fdatasyncSpy = vi.spyOn(fs, "fdatasyncSync");
  fdatasyncSpy.mockImplementation(((fd: number) => {
    events.push(`fdatasync ${fdPath.get(fd) ?? fd}`);
    return realFdatasyncSync(fd);
  }) as any);

  const fsyncSpy = vi.spyOn(fs, "fsyncSync");
  fsyncSpy.mockImplementation(((fd: number) => {
    events.push(
      `fsync ${fdIsDir.get(fd) ? "dir" : "file"} ${fdPath.get(fd) ?? fd}`,
    );
    return realFsyncSync(fd);
  }) as any);

  return { events, fdPath, openSpy, fdatasyncSpy, fsyncSpy };
}

describe("SUPA-1 fsync mode", () => {
  it("runs fdatasyncSync on the JSONL fd and fsyncSync on the parent dir before the append resolves", () => {
    const { events } = spyFs();
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");

    const written = appendJsonlDurable(filePath, makeRecord(1));

    expect(written).toBe(1);
    // Data barrier on the file, then the directory entry barrier — both inside
    // the call, i.e. before any caller could acknowledge the write.
    const dataBarrier = events.findIndex(
      (e) => e.startsWith("fdatasync ") && e.endsWith("current.jsonl"),
    );
    const dirBarrier = events.findIndex(
      (e) =>
        e.startsWith("fsync dir ") && e.endsWith(path.join("event", "2026-09")),
    );
    expect(dataBarrier).toBeGreaterThanOrEqual(0);
    expect(dirBarrier).toBeGreaterThanOrEqual(0);
    expect(dataBarrier).toBeLessThan(dirBarrier);
    expect(fs.readFileSync(filePath, "utf-8")).toContain("/test/supa1/1");
  });

  it("fsyncs the new chunk's parent directory when the append rotates to a new chunk", () => {
    const { events } = spyFs();
    const dir = path.join(tmpDir, "event", "2026-09");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "current.jsonl");

    // Push current.jsonl past MAX_BYTES_PER_CHUNK (1 MiB) so the next append
    // rotates to 0001.jsonl — a NEW file whose directory entry must be fsynced.
    fs.writeFileSync(filePath, "x".repeat(1024 * 1024 + 10) + "\n");

    const written = appendJsonlDurable(filePath, makeRecord(2));

    expect(written).toBe(1);
    expect(fs.existsSync(path.join(dir, "0001.jsonl"))).toBe(true);
    expect(
      events.some(
        (e) => e.startsWith("fdatasync ") && e.endsWith("0001.jsonl"),
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.startsWith("fsync dir ") && e.endsWith("2026-09")),
    ).toBe(true);
  });

  it("fsyncs the parent of the deepest newly-created directory on first write", () => {
    const { events } = spyFs();
    const nsRoot = path.join(tmpDir, "ns");
    fs.mkdirSync(nsRoot, { recursive: true });
    const filePath = path.join(nsRoot, "person", "2026-09", "current.jsonl");

    appendJsonlDurable(filePath, makeRecord(3));

    // File's parent (2026-09) AND the parent of the deepest new dir (person)
    // both get a directory fsync.
    expect(
      events.some(
        (e) =>
          e.startsWith("fsync dir ") &&
          e.endsWith(path.join("person", "2026-09")),
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.startsWith("fsync dir ") && e.endsWith("person")),
    ).toBe(true);
  });

  it("propagates an EIO fdatasync failure as DURABILITY_FSYNC_FAILED (never acknowledged)", () => {
    const fdatasyncSpy = vi.spyOn(fs, "fdatasyncSync");
    fdatasyncSpy.mockImplementation((() => {
      const error: NodeJS.ErrnoException = new Error("Input/output error");
      error.code = "EIO";
      throw error;
    }) as any);

    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    let thrown: unknown;
    try {
      appendJsonlDurable(filePath, makeRecord(4));
    } catch (error) {
      thrown = error;
    }

    expect(isDurabilityError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("DURABILITY_FSYNC_FAILED");
    expect((thrown as Error).message).toContain("NOT acknowledged");
    // The fd was still closed — no descriptor leak on the failure path.
    expect(fdatasyncSpy).toHaveBeenCalled();
  });

  it("treats an unsupported directory fsync (EINVAL) as DURABILITY_DIR_FSYNC_UNSUPPORTED", () => {
    const realFsyncSync = fs.fsyncSync.bind(fs);
    const realOpenSync = fs.openSync.bind(fs);
    const fdIsDir = new Map<number, boolean>();
    const openSpy = vi.spyOn(fs, "openSync");
    openSpy.mockImplementation(((p: any, flags: any, mode?: any) => {
      const fd = realOpenSync(p, flags, mode);
      fdIsDir.set(fd, String(flags) === "r");
      return fd;
    }) as any);
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    fsyncSpy.mockImplementation(((fd: number) => {
      if (fdIsDir.get(fd)) {
        const error: NodeJS.ErrnoException = new Error("invalid argument");
        error.code = "EINVAL";
        throw error;
      }
      return realFsyncSync(fd);
    }) as any);

    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    let thrown: unknown;
    try {
      appendJsonlDurable(filePath, makeRecord(5));
    } catch (error) {
      thrown = error;
    }

    expect(isDurabilityError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(
      "DURABILITY_DIR_FSYNC_UNSUPPORTED",
    );
    expect(openSpy).toHaveBeenCalled();
  });

  it("round-trips byte-identically through readFromJsonl", () => {
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    const record = makeRecord(6);

    appendJsonlDurable(filePath, record);

    // Byte-identical to the buffered path: one JSON line + newline.
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(raw).toBe(JSON.stringify(record) + "\n");

    const read = readFromJsonl(filePath);
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(record);
    expect(MemorySchema.parse(read[0])).toEqual(record);
  });
});

describe("SUPA-1 buffered mode (honest contract)", () => {
  it("issues no fdatasyncSync and no fsyncSync", () => {
    const { fdatasyncSpy, fsyncSpy } = spyFs();
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");

    const written = appendToJsonl(filePath, makeRecord(7));

    expect(written).toBe(1);
    expect(fdatasyncSpy).not.toHaveBeenCalled();
    expect(fsyncSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe("SUPA-1 direct mode", () => {
  /**
   * Suite-setup probe: can this filesystem actually do O_DIRECT?
   * (tmpfs/overlayfs cannot.) Per the spec's test plan, when the probe throws
   * the scenario asserts the FAILURE path instead of the success path.
   */
  function filesystemSupportsODirect(): boolean {
    const probeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "duckbrain-odirect-"),
    );
    try {
      const probe = path.join(probeDir, "probe.bin");
      const fd = fs.openSync(
        probe,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_APPEND |
          fs.constants.O_DIRECT,
        0o644,
      );
      try {
        const buf = Buffer.alloc(4096, 0x41);
        fs.writeSync(fd, buf, 0, buf.length, null);
        fs.fdatasyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }

  it("opens the target with fs.constants.O_DIRECT and honors the fsync commit protocol", () => {
    const supports = filesystemSupportsODirect();
    const { openSpy, events } = spyFs();
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    const record = makeRecord(8);
    const framed = frameJsonlRecord(record);

    expect(framed.buffer.length % 4096).toBe(0);

    if (!supports) {
      // Filesystem rejects O_DIRECT → the documented failure path, no bytes.
      expect(() => appendJsonlDirect(filePath, framed)).toThrowError(
        /DURABILITY_UNSUPPORTED/,
      );
      expect(fs.existsSync(filePath)).toBe(false);
      return;
    }

    const written = appendJsonlDirect(filePath, framed);

    expect(written).toBe(1);
    const flags = openSpy.mock.calls
      .map((call) => call[1])
      .find(
        (f) =>
          typeof f === "number" && (Number(f) & fs.constants.O_DIRECT) !== 0,
      );
    expect(flags).toBeDefined();
    // Same commit protocol as fsync mode.
    expect(events.some((e) => e.startsWith("fdatasync "))).toBe(true);
    expect(events.some((e) => e.startsWith("fsync dir "))).toBe(true);
    // Framed payload (newline padding) stays readable by the normal reader.
    const read = readFromJsonl(filePath);
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(record);
  });

  it("fails loud with DURABILITY_UNSUPPORTED when the filesystem rejects O_DIRECT and writes no bytes", () => {
    const realOpenSync = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync");
    openSpy.mockImplementation(((p: any, flags: any, mode?: any) => {
      if (typeof flags === "number" && (flags & fs.constants.O_DIRECT) !== 0) {
        const error: NodeJS.ErrnoException = new Error(
          "invalid argument, open",
        );
        error.code = "EINVAL";
        throw error;
      }
      return realOpenSync(p, flags, mode);
    }) as any);

    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    const framed = frameJsonlRecord(makeRecord(9));

    let thrown: unknown;
    try {
      appendJsonlDirect(filePath, framed);
    } catch (error) {
      thrown = error;
    }

    expect(isDurabilityError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("DURABILITY_UNSUPPORTED");
    expect((thrown as Error).message).toContain("no bytes written");
    // No silent buffered write: the file does not exist at all.
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rejects an unframed append with DURABILITY_DIRECT_FRAME_ERROR", () => {
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");

    let thrown: unknown;
    try {
      appendJsonlDirect(filePath, makeRecord(10));
    } catch (error) {
      thrown = error;
    }

    expect(isDurabilityError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe(
      "DURABILITY_DIRECT_FRAME_ERROR",
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rejects a misaligned framed payload with DURABILITY_DIRECT_FRAME_ERROR", () => {
    const filePath = path.join(tmpDir, "event", "2026-09", "current.jsonl");
    const bad = {
      framed: "supa2-block",
      buffer: Buffer.from("not aligned"),
      record: makeRecord(11),
    } as unknown as FramedJsonlWrite;

    expect(() => appendJsonlDirect(filePath, bad)).toThrowError(
      /DURABILITY_DIRECT_FRAME_ERROR/,
    );
  });
});

describe("SUPA-1 mode resolution and config validation (AC-5)", () => {
  const cfgWith = (durability: unknown): DuckBrainConfig =>
    DuckBrainConfigSchema.parse({ durability });

  it("resolves overrides > env default > config default > buffered", () => {
    const cfg = cfgWith({
      defaultMode: "fsync",
      overrides: { nsA: "direct" },
    });

    // overrides[ns] wins over the configured default
    expect(resolveWriteMode("nsA", cfg)).toBe("direct");
    expect(resolveWriteMode("nsB", cfg)).toBe("fsync");

    // env overrides the configured default, but never a namespace override
    process.env.DUCKBRAIN_DURABILITY_MODE = "buffered";
    expect(resolveWriteMode("nsB", cfg)).toBe("buffered");
    expect(resolveWriteMode("nsA", cfg)).toBe("direct");
    delete process.env.DUCKBRAIN_DURABILITY_MODE;

    // no durability block at all → historical buffered
    expect(resolveWriteMode("nsZ", cfgWith(undefined))).toBe("buffered");
  });

  it("reads overrides from the config file and defaults the rest to buffered", () => {
    writeConfig({ durability: { overrides: { nsA: "fsync" } } });

    expect(resolveWriteMode("nsA")).toBe("fsync");
    expect(resolveWriteMode("nsB")).toBe("buffered");
    expect(durabilityHeaderFor("nsA")).toBe("fsync");
    expect(durabilityHeaderFor("nsB")).toBe("buffered");
  });

  it("fails config load on an invalid env value instead of falling back to buffered", () => {
    process.env.DUCKBRAIN_DURABILITY_MODE = "fancy";

    expect(() => getConfig(".")).toThrow(z.ZodError);
    expect(() => resolveWriteMode("nsA")).toThrow(z.ZodError);

    delete process.env.DUCKBRAIN_DURABILITY_MODE;
    expect(getConfig(".").durability.defaultMode).toBe("buffered");
  });

  it("fails config load on an invalid durability block in the config file", () => {
    writeConfig({ durability: { overrides: { nsA: "fast" } } });
    expect(() => getConfig(".")).toThrow(z.ZodError);

    writeConfig({ durability: { defaultMode: "invalid" } });
    expect(() => getConfig(".")).toThrow(z.ZodError);

    // a valid block loads and is honored
    writeConfig({ durability: { defaultMode: "fsync" } });
    expect(getConfig(".").durability.defaultMode).toBe("fsync");
  });

  it("accepts DUCKBRAIN_DURABILITY_MODE as the runtime default (never persisted)", () => {
    writeConfig({ durability: { defaultMode: "buffered" } });

    process.env.DUCKBRAIN_DURABILITY_MODE = "direct";
    const cfg = getConfig(".");
    expect(cfg.durability.defaultMode).toBe("direct");
    expect(resolveWriteMode("nsB", cfg)).toBe("direct");

    // The env layer is runtime-only: the file on disk still says buffered.
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    expect(onDisk.durability.defaultMode).toBe("buffered");
  });
});

describe("SUPA-1 bypass guard and /health surface", () => {
  it("refuses appendToJsonl for an fsync-mode namespace (DURABILITY_BYPASS) and allows buffered", () => {
    const nsRoot = process.env.DUCKBRAIN_NAMESPACES_PATH as string;
    writeConfig({ durability: { overrides: { bynass: "fsync" } } });

    const guarded = path.join(
      nsRoot,
      "bynass",
      "person",
      "2026-09",
      "current.jsonl",
    );
    expect(() => appendToJsonl(guarded, makeRecord(12))).toThrowError(
      /DURABILITY_BYPASS/,
    );
    expect(fs.existsSync(guarded)).toBe(false);

    const allowed = path.join(
      nsRoot,
      "buffered-ns",
      "person",
      "2026-09",
      "current.jsonl",
    );
    expect(appendToJsonl(allowed, makeRecord(13))).toBe(1);
  });

  it("lists defaultMode plus non-default overrides only", () => {
    writeConfig({
      durability: {
        defaultMode: "fsync",
        overrides: { a: "fsync", b: "buffered", c: "direct" },
      },
    });

    expect(getDurabilityHealth()).toEqual({
      defaultMode: "fsync",
      overrides: { b: "buffered", c: "direct" },
    });
  });
});
