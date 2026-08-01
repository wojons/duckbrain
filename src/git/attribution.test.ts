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
    const { createMemory, safeValidateMemory } = await import(
      "../schema/memory.js"
    );

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
