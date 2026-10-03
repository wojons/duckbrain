/**
 * CI-001 Regression Test: Fallback author email must be schema-valid
 *
 * On hosts without git user.email configured and without GIT_AUTHOR_EMAIL
 * set (e.g. GitHub Actions runners), getAuthorEmail() returns its hardcoded
 * default. That default must pass Zod's z.string().email() validation —
 * otherwise every memory write fails with "Memory validation failed:
 * Invalid email address" (CI red since tick #126 until fixed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { execSync } from "child_process";

// Mock git unavailable — execSync throws like it does when user.email is unset
vi.mock("child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("git config user.email: command not found");
  }),
}));

const emailSchema = z.string().email();

describe("CI-001: fallback author email is schema-valid", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    // Simulate a host with no git config and no author env vars (CI runner)
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("getAuthorEmail() default fallback passes Zod email validation", async () => {
    const { getAuthorEmail } = await import("./attribution.js");
    const email = getAuthorEmail();

    expect(email).toBe("duckbrain@localhost.localdomain");
    expect(emailSchema.safeParse(email).success).toBe(true);
  });

  it("remember-tool style memory with fallback author validates", async () => {
    const { getAuthorEmail } = await import("./attribution.js");
    const { createMemory, safeValidateMemory } =
      await import("../schema/memory.js");

    const memory = createMemory({
      key: "/test/ci-001-fallback",
      domain: "raw_note",
      author: getAuthorEmail(),
      embedding_text: "CI-001 regression test",
      attributes: {},
      action: "add",
    });

    const result = safeValidateMemory(memory);
    expect(result.success).toBe(true);
  });
});

/**
 * DF-0930-01 Regression Tests: bare-host git email must not reach the schema
 *
 * A fresh install with a bare-host git identity (e.g. `git config --global
 * user.email dogfood@localhost`) makes every memory write 500: the git value
 * passes getGitConfig()'s "non-empty string" check but fails
 * MemorySchema's `author: z.string().email()` (zod requires a dot in the
 * domain). getAuthorEmail() must treat such values as unusable and fall back
 * to the TLD-valid default — the schema stays strict.
 */
describe("DF-0930-01: bare-host git email falls back to the default", () => {
  const OLD_ENV = { ...process.env };
  const mockedExecSync = vi.mocked(execSync);

  beforeEach(() => {
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
    mockedExecSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("git email dogfood@localhost (no dot in domain) falls back to the default", async () => {
    mockedExecSync.mockImplementation(((cmd: string | Buffer) => {
      return cmd === "git config user.email" ? "dogfood@localhost\n" : "";
    }) as typeof execSync);
    const { getAuthorEmail } = await import("./attribution.js");

    const email = getAuthorEmail();

    expect(email).toBe("duckbrain@localhost.localdomain");
    expect(z.string().email().safeParse(email).success).toBe(true);
  });

  it("git email root@box (no dot in domain) falls back to the default", async () => {
    mockedExecSync.mockImplementation(((cmd: string | Buffer) => {
      return cmd === "git config user.email" ? "root@box\n" : "";
    }) as typeof execSync);
    const { getAuthorEmail } = await import("./attribution.js");

    const email = getAuthorEmail();

    expect(email).toBe("duckbrain@localhost.localdomain");
    expect(z.string().email().safeParse(email).success).toBe(true);
  });

  it("valid git email test@example.com is used as-is", async () => {
    mockedExecSync.mockImplementation(((cmd: string | Buffer) => {
      return cmd === "git config user.email"
        ? "test@example.com\n"
        : "Test User\n";
    }) as typeof execSync);
    const { getAuthorEmail, getAuthorName } = await import("./attribution.js");

    expect(getAuthorEmail()).toBe("test@example.com");
    expect(getAuthorName()).toBe("Test User");
  });

  it("schema validation of a full memory accepts the default but rejects the bare-host value", async () => {
    // Pins the fixture contract: the bare-host email is exactly what the
    // strict schema rejects, and the default is what it accepts.
    const { safeValidateMemory, createMemory } =
      await import("../schema/memory.js");

    const rejected = safeValidateMemory(
      createMemory({
        key: "/test/df-0930-01",
        domain: "raw_note",
        author: "dogfood@localhost",
        embedding_text: "bare-host author must be rejected by the schema",
        attributes: {},
        action: "add",
      }),
    );
    expect(rejected.success).toBe(false);

    const accepted = safeValidateMemory(
      createMemory({
        key: "/test/df-0930-01",
        domain: "raw_note",
        author: "duckbrain@localhost.localdomain",
        embedding_text: "default author validates",
        attributes: {},
        action: "add",
      }),
    );
    expect(accepted.success).toBe(true);
  });
});
