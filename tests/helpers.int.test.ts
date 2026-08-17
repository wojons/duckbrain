import { describe, it, expect } from "vitest";
import { createStderrTail, waitForUrl, getChildState } from "./helpers";

/**
 * INT-CI-002: unit coverage for the hardened wait helpers.
 *
 * createStderrTail is the rolling stderr capture startDuckbrainHttp uses so
 * waitForUrl timeouts can surface the daemon's last words; waitForUrl's
 * timeout path is exercised against a refusing port (fast-fail curl) with
 * a small cap so the tests stay in the milliseconds.
 */
describe("helpers: createStderrTail (INT-CI-002)", () => {
  it("joins chunks split mid-line into whole lines", () => {
    const tail = createStderrTail();
    tail.push("line1\nli");
    tail.push("ne2\nline3\n");
    expect(tail.value()).toBe("line1\nline2\nline3");
  });

  it("keeps only the last maxLines lines", () => {
    const tail = createStderrTail(2);
    tail.push("a\nb\nc\nd\n");
    expect(tail.value()).toBe("c\nd");
  });

  it("exposes an unterminated trailing line", () => {
    const tail = createStderrTail();
    tail.push("boot\nstill writing");
    expect(tail.value()).toBe("boot\nstill writing");
  });

  it("handles empty input and CRLF line endings", () => {
    const empty = createStderrTail();
    empty.push("");
    expect(empty.value()).toBe("");

    const crlf = createStderrTail();
    crlf.push("one\r\ntwo\r\n");
    expect(crlf.value()).toBe("one\ntwo");
  });
});

describe("helpers: waitForUrl timeout diagnostics (INT-CI-002)", () => {
  it("surfaces the child stderr tail when a wait times out", async () => {
    // Port 1 on localhost refuses connections instantly — the poll loop
    // burns the 700ms cap without ever succeeding.
    const child = { stderrTail: "boom\nfailed to start" } as any;
    await expect(
      waitForUrl("http://127.0.0.1:1/health", 700, child),
    ).rejects.toThrow(
      /Timed out waiting for http:\/\/127\.0\.0\.1:1\/health after 700ms/,
    );
    await expect(
      waitForUrl("http://127.0.0.1:1/health", 700, child),
    ).rejects.toThrow(/child stderr tail[\s\S]*boom\nfailed to start/);
  });

  it("omits the stderr section when no child is known", async () => {
    await expect(waitForUrl("http://127.0.0.1:1/health", 700)).rejects.toThrow(
      /Timed out waiting for http:\/\/127\.0\.0\.1:1\/health after 700ms/,
    );
    await expect(
      waitForUrl("http://127.0.0.1:1/health", 700),
    ).rejects.not.toThrow(/child stderr tail/);
  });
});

describe("helpers: getChildState (INT-CI-003)", () => {
  it("reports a live child with its ps stat", () => {
    // process.pid is always alive inside the test worker.
    const state = getChildState({ pid: process.pid } as any);
    expect(state).toMatch(new RegExp(`pid ${process.pid}: \\S+\\s+\\d`));
  });

  it("reports (exited) for a dead pid", () => {
    const state = getChildState({ pid: 2147483647 } as any);
    expect(state).toBe("pid 2147483647: (exited)");
  });

  it("returns '' when no pid is known", () => {
    expect(getChildState()).toBe("");
    expect(getChildState({} as any)).toBe("");
  });
});
