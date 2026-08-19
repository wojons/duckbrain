/**
 * RETR-009 Regression Tests: CLI `query` command wiring.
 *
 * Guards src/cli/query.ts + runHumanCLI routing:
 *   - the SQL positional is forwarded to runReadOnlyQuery with the resolved
 *     namespace path (--namespace=X and bare --namespace X forms)
 *   - --template resolves the saved template SQL + its default namespace
 *   - unknown templates / template+SQL mix / invalid --limit exit loudly
 *   - --help lists the flag surface
 *   - results print columns/rows; the auto-cap note goes to stderr
 *
 * runReadOnlyQuery is mocked so the tests exercise the CLI wiring only (the
 * query surface itself is covered by query-surface-retr009.test.ts); the
 * template registry is kept real (pure, no DB).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { runHumanCLI } from "./human";
import { resolveNamespacePath } from "../mcp/tools/shared";
import {
  runReadOnlyQuery,
  resolveQueryTemplate,
  QUERY_MAX_ROWS,
  QUERY_PRINT_ROWS,
} from "../duckdb/query-surface";

vi.mock("../duckdb/query-surface", async () => {
  const actual = await vi.importActual<
    typeof import("../duckdb/query-surface")
  >("../duckdb/query-surface");
  return {
    ...actual,
    runReadOnlyQuery: vi.fn(),
  };
});

afterEach(() => {
  vi.mocked(runReadOnlyQuery).mockReset();
  vi.mocked(runReadOnlyQuery).mockResolvedValue({
    columns: ["key"],
    rows: [{ key: "/projects/alpha/status" }],
    count: 1,
    truncated: false,
  });
});

/** Capture console.log/console.error for the duration of fn; swallows the
 * process.exit(1) throw (surfaces as a vitest throw) and records it. */
async function capture(
  fn: () => Promise<void>,
): Promise<{ logs: string[]; errors: string[]; rejected: boolean }> {
  const logs: string[] = [];
  const errors: string[] = [];
  let rejected = false;
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: any[]) => logs.push(a.map(String).join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: any[]) => errors.push(a.map(String).join(" ")));
  try {
    await fn();
  } catch {
    rejected = true;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { logs, errors, rejected };
}

describe("RETR-009: CLI query wiring", () => {
  it("forwards the SQL and resolved namespace path", async () => {
    await capture(() =>
      runHumanCLI("query", [
        "SELECT",
        "key",
        "FROM",
        "memories",
        "WHERE",
        "key",
        "LIKE",
        "'/projects/%'",
        "--namespace=test-ns",
      ]),
    );

    expect(runReadOnlyQuery).toHaveBeenCalledTimes(1);
    const [ns, sql, cap] = vi.mocked(runReadOnlyQuery).mock.calls[0]!;
    expect(ns).toBe(resolveNamespacePath("test-ns"));
    expect(sql).toBe("SELECT key FROM memories WHERE key LIKE '/projects/%'");
    expect(cap).toBe(QUERY_MAX_ROWS);
  });

  it("accepts the bare `--namespace <name>` form", async () => {
    await capture(() =>
      runHumanCLI("query", ["SELECT", "1", "--namespace", "test-ns"]),
    );
    const [ns, sql] = vi.mocked(runReadOnlyQuery).mock.calls[0]!;
    expect(ns).toBe(resolveNamespacePath("test-ns"));
    expect(sql).toBe("SELECT 1");
  });

  it("--template resolves the template SQL and its default namespace", async () => {
    await capture(() => runHumanCLI("query", ["--template=cost-series"]));

    const template = resolveQueryTemplate("cost-series");
    expect(runReadOnlyQuery).toHaveBeenCalledTimes(1);
    const [ns, sql] = vi.mocked(runReadOnlyQuery).mock.calls[0]!;
    expect(ns).toBe(resolveNamespacePath(template.defaultNamespace));
    expect(sql).toBe(template.sql);
  });

  it("--template respects an explicit --namespace override", async () => {
    await capture(() =>
      runHumanCLI("query", [
        "--template",
        "per-project-status",
        "--namespace",
        "test-ns",
      ]),
    );
    const [ns] = vi.mocked(runReadOnlyQuery).mock.calls[0]!;
    expect(ns).toBe(resolveNamespacePath("test-ns"));
  });

  it("unknown template exits with the available list", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("query", ["--template=bogus"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("Unknown template 'bogus'");
    expect(errors.join("\n")).toContain("incidents-by-day");
  });

  it("--template with an inline SQL statement exits with a usage error", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("query", ["SELECT", "1", "--template=incidents-by-day"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("mutually exclusive");
  });

  it("missing SQL and template exits with a usage error", async () => {
    const { errors, rejected } = await capture(() => runHumanCLI("query", []));
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("Usage: duckbrain query");
  });

  it("--limit forwards a smaller cap and clamps oversized values", async () => {
    await capture(() => runHumanCLI("query", ["SELECT", "1", "--limit=42"]));
    expect(vi.mocked(runReadOnlyQuery).mock.calls[0]![2]).toBe(42);

    await capture(() => runHumanCLI("query", ["SELECT", "1", "--limit=5000"]));
    expect(vi.mocked(runReadOnlyQuery).mock.calls[1]![2]).toBe(QUERY_MAX_ROWS);
  });

  it("negative and non-numeric --limit exit loudly", async () => {
    const { errors, rejected } = await capture(() =>
      runHumanCLI("query", ["SELECT", "1", "--limit=-1"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("--limit");

    const bad = await capture(() =>
      runHumanCLI("query", ["SELECT", "1", "--limit=abc"]),
    );
    expect(bad.rejected).toBe(true);
    expect(bad.errors.join("\n")).toContain("--limit");
  });

  it("prints columns and rows; surfaces the auto-cap note on stderr", async () => {
    vi.mocked(runReadOnlyQuery).mockResolvedValue({
      columns: ["key", "domain"],
      rows: [
        { key: "/a", domain: "config" },
        { key: "/b", domain: "config" },
      ],
      count: 2,
      truncated: true,
    });

    const { logs, errors } = await capture(() =>
      runHumanCLI("query", ["SELECT", "key", "FROM", "memories"]),
    );
    expect(logs.join("\n")).toContain("columns: key, domain");
    expect(logs.join("\n")).toContain('{"key":"/a","domain":"config"}');
    expect(errors.join("\n")).toContain("auto-capped");
  });

  it("elides rows beyond QUERY_PRINT_ROWS with a ... N more line", async () => {
    const rows = Array.from({ length: QUERY_PRINT_ROWS + 7 }, (_, i) => ({
      key: `/k/${i}`,
    }));
    vi.mocked(runReadOnlyQuery).mockResolvedValue({
      columns: ["key"],
      rows,
      count: rows.length,
      truncated: true,
    });

    const { logs } = await capture(() =>
      runHumanCLI("query", ["SELECT", "key", "FROM", "memories"]),
    );
    expect(logs.join("\n")).toContain(
      `... ${rows.length - QUERY_PRINT_ROWS} more`,
    );
  });

  it("read-only rejections from the surface exit with the ✗ message", async () => {
    const { ReadOnlyQueryError } = await import("../duckdb/query-surface.js");
    vi.mocked(runReadOnlyQuery).mockRejectedValue(
      new ReadOnlyQueryError(
        "Statement rejected: it contains a keyword that can mutate state.",
      ),
    );

    const { errors, rejected } = await capture(() =>
      runHumanCLI("query", ["DELETE", "FROM", "memories"]),
    );
    expect(rejected).toBe(true);
    expect(errors.join("\n")).toContain("✗ Statement rejected");
  });

  it("--help lists --template, --namespace, and --limit", async () => {
    const { logs } = await capture(() => runHumanCLI("query", ["--help"]));
    const help = logs.join("\n");
    expect(help).toContain("--template");
    expect(help).toContain("--namespace");
    expect(help).toContain("--limit");
    expect(help).toContain("cost-series");
    expect(help).toContain("incidents-by-day");
    expect(help).toContain("per-project-status");
  });
});
