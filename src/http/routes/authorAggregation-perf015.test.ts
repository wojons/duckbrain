/** PERF-015 — child-process author aggregation and fallback contract. */
import { describe, expect, it } from "vitest";
import express from "express";
import { execFileSync, spawn as spawnProcess, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { request } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAuthorsForNamespaces } from "./authorAggregation";
import { createUsersRouter } from "./users";

const CHILD_PATH = path.join(__dirname, "authorAggregationChild.ts");
/** tsc emits `dist/src/...` because rootDir is the repo root. */
const DIST_CHILD_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "dist",
  "src",
  "http",
  "routes",
  "authorAggregationChild.js",
);


type ResponseBody = { users: string[]; count: number };

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Build a throwaway repo with one commit per listed author. */
function makeAuthorRepo(root: string, authors: string[]): string {
  const repo = path.join(root, `repo-${authors.length}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  authors.forEach((author, index) => {
    const file = path.join(repo, `file-${index}.txt`);
    fs.writeFileSync(file, `${author}\n`);
    git(repo, "add", `file-${index}.txt`);
    git(
      repo,
      "-c",
      `user.name=${author}`,
      "-c",
      `user.email=${author.replace(/\s+/g, ".").toLowerCase()}@example.com`,
      "commit",
      "-m",
      `commit by ${author}`,
    );
  });
  return repo;
}

function getUsers(server: Server): Promise<ResponseBody> {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server is not listening");
  }
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port: address.port, path: "/users", method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body) as ResponseBody);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function namespaceListing(paths: string[]) {
  return async () => ({
    success: true as const,
    namespaces: paths.map((namespacePath, index) => ({
      name: `ns-${index}`,
      path: namespacePath,
      isDefault: index === 0,
    })),
    currentNamespace: paths.length > 0 ? "ns-0" : undefined,
  });
}

async function serveUsers(router: ReturnType<typeof createUsersRouter>): Promise<Server> {
  const app = express();
  app.use("/users", router);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function withServer(
  router: ReturnType<typeof createUsersRouter>,
  body: (server: Server) => Promise<void>,
): Promise<void> {
  const server = await serveUsers(router);
  try {
    await body(server);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("PERF-015 author aggregation child protocol", () => {
  it("returns the same author set as direct aggregation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-set-"));
    const repo = makeAuthorRepo(root, ["Ada Lovelace", "Grace Hopper"]);
    const namespaces = [{ path: repo }];
    const direct = await collectAuthorsForNamespaces(namespaces);

    await withServer(
      createUsersRouter({ listNamespaces: namespaceListing([repo]) }),
      async (server) => {
        const response = await getUsers(server);
        expect(new Set(response.users)).toEqual(new Set(direct));
        expect(new Set(response.users)).toEqual(
          new Set(["Ada Lovelace", "Grace Hopper"]),
        );
        expect(response.count).toBe(response.users.length);
      },
    );
  });

  it("pipes a JSON request through stdin and writes only JSON to stdout", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-proto-"));
    const repo = makeAuthorRepo(root, ["Karen Sparck Jones"]);
    const run = spawnSync(
      process.execPath,
      ["-r", require.resolve("tsx/cjs"), CHILD_PATH],
      {
        input: JSON.stringify({ namespacePaths: [repo] }),
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    const parsed = JSON.parse(run.stdout) as { authors: string[] };
    expect(Object.keys(parsed)).toEqual(["authors"]);
    expect(parsed.authors).toContain("Karen Sparck Jones");
  });

  it("trusts the child's output over in-process aggregation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-wiring-"));
    const repo = makeAuthorRepo(root, ["Repo Author"]);
    const stub = path.join(root, "stub-child.js");
    fs.writeFileSync(
      stub,
      'let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({authors:["Child Only"].concat(r.namespacePaths.length?[]:["no-paths"])}))});\n',
    );

    await withServer(
      createUsersRouter({
        childPath: stub,
        listNamespaces: namespaceListing([repo]),
      }),
      async (server) => {
        const response = await getUsers(server);
        expect(response.users).toEqual(["Child Only"]);
        expect(response.count).toBe(1);
      },
    );
  });

  it("resolves the TypeScript sibling and runs it through tsx in source mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-tsx-"));
    const repo = makeAuthorRepo(root, ["Tsx Author"]);
    const spawns: Array<{ command: string; args: string[] }> = [];
    const recordingSpawn = ((
      command: string,
      args: readonly string[],
      options?: unknown,
    ) => {
      spawns.push({ command, args: [...args] });
      return (spawnProcess as any)(command, args, options);
    }) as typeof spawnProcess;

    await withServer(
      createUsersRouter({
        spawn: recordingSpawn,
        listNamespaces: namespaceListing([repo]),
      }),
      async (server) => {
        const response = await getUsers(server);
        expect(response.users).toContain("Tsx Author");
      },
    );

    expect(spawns).toHaveLength(1);
    const [spawned] = spawns;
    expect(spawned.command).toBe(process.execPath);
    expect(spawned.args).toContain("--max-old-space-size=256");
    expect(spawned.args.some((arg) => arg.endsWith("authorAggregationChild.ts"))).toBe(true);
    expect(spawned.args).toContain(require.resolve("tsx/cjs"));

    // Prove the argv the route actually used yields the expected authors, so
    // the assertion above cannot be satisfied by a silent in-process fallback.
    const run = spawnSync(spawned.command, spawned.args, {
      input: JSON.stringify({ namespacePaths: [repo] }),
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout) as { authors: string[] };
    expect(parsed.authors).toContain("Tsx Author");
  });

  it("falls back to direct aggregation when the child cannot start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-fallback-"));
    const repo = makeAuthorRepo(root, ["Backup Author"]);
    const direct = await collectAuthorsForNamespaces([{ path: repo }]);

    await withServer(
      createUsersRouter({
        childPath: path.join(root, "does-not-exist-child.js"),
        listNamespaces: namespaceListing([repo]),
      }),
      async (server) => {
        const response = await getUsers(server);
        expect(response.users).toEqual(direct);
        expect(response.count).toBe(response.users.length);
      },
    );
  });
});

/**
 * The compiled child is only present after `npm run build:cli`. When a stale
 * or absent `dist/` is in the way this block skips rather than failing.
 */
describe.skipIf(!fs.existsSync(DIST_CHILD_PATH))(
  "PERF-015 compiled child",
  () => {
    it("runs the compiled entrypoint with the same stdin/stdout protocol", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "perf015-dist-"));
      const repo = makeAuthorRepo(root, ["Compiled Author"]);
      const direct = await collectAuthorsForNamespaces([{ path: repo }]);

      const run = spawnSync(process.execPath, [DIST_CHILD_PATH], {
        input: JSON.stringify({ namespacePaths: [repo] }),
        encoding: "utf8",
        timeout: 120_000,
      });

      expect(run.status).toBe(0);
      const parsed = JSON.parse(run.stdout) as { authors: string[] };
      expect(Object.keys(parsed)).toEqual(["authors"]);
      expect(new Set(parsed.authors)).toEqual(new Set(direct));
    });
  },
);
