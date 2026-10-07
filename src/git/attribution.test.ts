/**
 * CI-001 + GIT-IDENTITY-001 regression tests: author attribution.
 *
 * CI-001 (historical): on hosts without git user.email configured and
 * without GIT_AUTHOR_EMAIL set, getAuthorEmail() used to return a hardcoded
 * default. GIT-IDENTITY-001 removed that default entirely — resolution now
 * goes repo-local -> global -> DUCKBRAIN_GIT_AUTHOR_EMAIL and THROWS with an
 * actionable hint when nothing resolves. A memory row must never carry a
 * fabricated author ('DuckBrain <duckbrain@localhost.localdomain>').
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { execFileSync } from "child_process";

// Mock git unavailable — the git subprocess helpers throw like they do when
// user.email is unset
vi.mock("child_process", () => ({
  execSync: vi.fn(() => {
    throw new Error("git config user.email: command not found");
  }),
  execFileSync: vi.fn(() => {
    throw new Error("git config: not found");
  }),
}));

const emailSchema = z.string().email();

describe("GIT-IDENTITY-001: attribution has no synthetic fallback", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    // Simulate a host with no git config and no author env vars (CI runner)
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.DUCKBRAIN_GIT_AUTHOR_EMAIL;
    delete process.env.DUCKBRAIN_GIT_AUTHOR_NAME;
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("getAuthorEmail() THROWS with an actionable hint when nothing resolves", async () => {
    const { getAuthorEmail } = await import("./attribution.js");
    expect(() => getAuthorEmail()).toThrow(/No git author identity is configured/);
  });

  it("the thrown hint names the documented env override knobs", async () => {
    const { getAuthorEmail } = await import("./attribution.js");
    try {
      getAuthorEmail();
      expect.unreachable("getAuthorEmail must throw without identity");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("DUCKBRAIN_GIT_AUTHOR_EMAIL");
      expect(message).toContain("git config --global user.email");
    }
  });

  it("the DUCKBRAIN_GIT_AUTHOR_EMAIL env override is honored", async () => {
    process.env.DUCKBRAIN_GIT_AUTHOR_EMAIL = "env.author@example.com";
    const { getAuthorEmail } = await import("./attribution.js");
    const email = getAuthorEmail();

    expect(email).toBe("env.author@example.com");
    expect(emailSchema.safeParse(email).success).toBe(true);
  });

  it("no synthetic 'duckbrain@localhost' value can ever be returned", async () => {
    const { getAuthorEmail } = await import("./attribution.js");
    let email: string | null = null;
    try {
      email = getAuthorEmail();
    } catch {
      // Throwing is a valid outcome — the assertion below still holds.
    }
    if (email !== null) {
      expect(email).not.toContain("duckbrain@localhost");
    }
    expect(emailSchema.safeParse(email).success).toBe(false);
  });

  it("remember-tool style memory built from a resolved env author validates", async () => {
    process.env.DUCKBRAIN_GIT_AUTHOR_EMAIL = "ci.author@example.com";
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
 * user.email dogfood@localhost`) must not poison memory rows: the git value
 * passes a naive "non-empty string" check but fails MemorySchema's
 * `author: z.string().email()` (zod requires a dot in the domain).
 * resolveAuthorEmail() treats such values as unusable.
 */
describe("DF-0930-01: bare-host git email is treated as unset", () => {
  const OLD_ENV = { ...process.env };
  const mockedExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.DUCKBRAIN_GIT_AUTHOR_EMAIL;
    delete process.env.DUCKBRAIN_GIT_AUTHOR_NAME;
    mockedExecFileSync.mockReset();
  });

  afterEach(() => {
    process.env = { ...OLD_ENV };
  });

  it("git email dogfood@localhost (no dot in domain) is treated as unset", async () => {
    mockedExecFileSync.mockImplementation(((
      file: string | Buffer,
      args?: readonly string[],
    ) => {
      if (
        file === "git" &&
        args?.includes("user.email") &&
        args?.includes("--global")
      ) {
        return "dogfood@localhost\n";
      }
      throw new Error("unset");
    }) as typeof execFileSync);
    const { getAuthorEmail } = await import("./attribution.js");

    expect(() => getAuthorEmail()).toThrow(/No git author identity/);
  });

  it("git email root@box (no dot in domain) is treated as unset", async () => {
    mockedExecFileSync.mockImplementation(((
      file: string | Buffer,
      args?: readonly string[],
    ) => {
      if (
        file === "git" &&
        args?.includes("user.email") &&
        args?.includes("--global")
      ) {
        return "root@box\n";
      }
      throw new Error("unset");
    }) as typeof execFileSync);
    const { getAuthorEmail } = await import("./attribution.js");

    expect(() => getAuthorEmail()).toThrow(/No git author identity/);
  });

  it("valid git email test@example.com is used as-is", async () => {
    mockedExecFileSync.mockImplementation(((
      file: string | Buffer,
      args?: readonly string[],
    ) => {
      if (file === "git" && args?.includes("--global")) {
        return args.includes("user.email")
          ? "test@example.com\n"
          : "Test User\n";
      }
      throw new Error("unset");
    }) as typeof execFileSync);
    const { getAuthorEmail, getAuthorName } = await import("./attribution.js");

    expect(getAuthorEmail()).toBe("test@example.com");
    expect(getAuthorName()).toBe("Test User");
  });

  it("the bare-host value is rejected by the strict memory schema while a TLD email passes", async () => {
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
        author: "real.author@example.com",
        embedding_text: "TLD author is accepted",
        attributes: {},
        action: "add",
      }),
    );
    expect(accepted.success).toBe(true);
  });
});
