/**
 * DOGFOOD-003 Regression Tests: `remember` content/body handling.
 *
 * Before this fix, `duckbrain remember <key>` had no way to store a real
 * memory body — unknown flags (like `--content=...`) were silently dropped by
 * parseArgs, stdin was ignored, and the KEY was stored as embedding_text. These
 * tests guard the five acceptance criteria:
 *
 *  (a) --content sets embedding_text to the provided body (not the key)
 *  (b) --text works as an alias for --content
 *  (c) a piped stdin body is used when no --content/--text flag is given
 *  (d) an unknown flag (e.g. --conent typo) is rejected loudly, not ignored
 *  (e) no flag + no stdin falls back to the key (existing behaviour preserved)
 *
 * The tests target the pure CLI-layer resolution (`resolveRememberBody` for
 * body precedence, `runHumanCLI("remember", ...)` for flag validation) so they
 * don't require a live DuckDB/embedding backend. The body-resolution helper is
 * exported for exactly this reason; the flag-rejection path exits via
 * process.exit(1), which vitest converts into a throw.
 */

import { describe, it, expect } from "vitest";
import { resolveRememberBody, runHumanCLI } from "./human";

/**
 * Minimal fake stdin implementing the StdinLike surface readStdinBody reads.
 * Lets tests simulate a piped body, an empty pipe, or a TTY (no pipe).
 */
function fakeStdin(opts: {
  isTTY?: boolean;
  chunks?: string[];
  end?: boolean;
}): {
  isTTY?: boolean;
  once: (ev: string, cb: (...a: any[]) => void) => unknown;
} {
  // Collect listeners; flush the stream lifecycle (all 'data' chunks, then
  // 'end') on a single macrotask AFTER readStdinBody finishes attaching all its
  // listeners — mirroring real stream emission order (data before end).
  const listeners: Record<string, ((...a: any[]) => void)[]> = {};
  let flushed = false;
  const flush = () => {
    if (flushed || opts.isTTY) return;
    flushed = true;
    setTimeout(() => {
      for (const c of opts.chunks ?? []) {
        listeners["data"]?.forEach((cb) => cb(c));
      }
      if (opts.end !== false) {
        listeners["end"]?.forEach((cb) => cb());
      }
    }, 0);
  };
  const reader = {
    isTTY: opts.isTTY,
    once(event: string, cb: (...a: any[]) => void) {
      (listeners[event] ||= []).push(cb);
      // Kick off the flush on the first listener registration.
      flush();
      return reader;
    },
  };
  return reader;
}

describe("DOGFOOD-003: remember content/body handling", () => {
  const KEY = "/scratch/project/alpha";

  it("(a) --content sets embedding_text to the provided body, not the key", async () => {
    const body = await resolveRememberBody({ content: "real body text" }, KEY);
    expect(body).toBe("real body text");
    expect(body).not.toBe(KEY);
  });

  it("(b) --text works as an alias for --content", async () => {
    const body = await resolveRememberBody({ text: "alias body" }, KEY);
    expect(body).toBe("alias body");
  });

  it("(c) stdin body is used when no --content/--text flag is given", async () => {
    const reader = fakeStdin({ isTTY: false, chunks: ["piped stdin body"] });
    const body = await resolveRememberBody({}, KEY, reader);
    expect(body).toBe("piped stdin body");
  });

  it("(e) no flag + no stdin (TTY) falls back to the key", async () => {
    const reader = fakeStdin({ isTTY: true });
    const body = await resolveRememberBody({}, KEY, reader);
    expect(body).toBe(KEY);
  });

  it("(e-variant) no flag + empty stdin pipe falls back to the key", async () => {
    const reader = fakeStdin({ isTTY: false, chunks: ["   \n  "] });
    const body = await resolveRememberBody({}, KEY, reader);
    // whitespace-only body trims to empty -> key fallback
    expect(body).toBe(KEY);
  });

  it("content flag takes precedence over piped stdin", async () => {
    const reader = fakeStdin({ isTTY: false, chunks: ["stdin body"] });
    const body = await resolveRememberBody(
      { content: "flag wins" },
      KEY,
      reader,
    );
    expect(body).toBe("flag wins");
  });

  it("(d) unknown flag --conent (typo) is rejected loudly, not silently ignored", async () => {
    // process.exit(1) is converted to a throw by vitest, so rejects.toThrow
    // captures the unknown-flag rejection.
    await expect(
      runHumanCLI("remember", [KEY, "--domain=raw_note", "--conent=oops"]),
    ).rejects.toThrow(/process\.exit/);
  });

  it("(d) unknown flag rejection does not fire for a valid --content flag", async () => {
    // --content is valid, so the only exit path would be the tool call itself
    // failing (DB/backend). We assert it does NOT throw the unknown-flag exit;
    // a tool failure would surface a different message. Use a domain outside
    // DomainEnum so the tool returns success:false (printed) rather than the
    // unknown-flag exit. The unknown-flag guard must NOT trigger here.
    // We expect either success log OR a tool error — but NOT the unknown-flag
    // exit message. Wrap to distinguish.
    let sawUnknownFlagExit = false;
    const origError = console.error;
    console.error = (...a: any[]) => {
      if (a.join(" ").includes("unknown flag")) sawUnknownFlagExit = true;
      origError(...a);
    };
    try {
      await runHumanCLI("remember", [
        KEY,
        "--domain=raw_note",
        "--content=real body text",
      ]);
    } catch {
      // process.exit from tool-failure path is acceptable; unknown-flag is not.
    } finally {
      console.error = origError;
    }
    expect(sawUnknownFlagExit).toBe(false);
  });
});
