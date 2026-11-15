/**
 * Users API Routes
 *
 * Extracts unique authors from namespace git commit history.
 * Falls back to DuckDB memory queries if git is unavailable.
 */

import { Router, Request, Response } from "express";
import { spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { listNamespacesTool } from "../../mcp/tools/namespace";
import { asyncHandler } from "../middleware/errorHandler";
import { getPrincipal } from "../../auth/middleware";
import {
  collectAuthorsForNamespaces,
  type AuthorNamespace,
} from "./authorAggregation";

export { collectAuthorsForNamespaces } from "./authorAggregation";
export type {
  AuthorAggregationOptions,
  AuthorLookup,
  AuthorNamespace,
} from "./authorAggregation";

type Spawn = typeof spawnProcess;

export interface UsersRouteOptions {
  /** Override the child path in tests or alternate distributions. */
  childPath?: string;
  /** Override process spawning to exercise the failure fallback. */
  spawn?: Spawn;
  /** Inject the already grant-filtered namespace listing in route tests. */
  listNamespaces?: typeof listNamespacesTool;
}

const AUTHOR_CHILD_TIMEOUT_MS = 120_000;
const AUTHOR_CHILD_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * Resolve the shipped child beside this route. Source-mode test runners use
 * tsx to execute the TypeScript sibling; compiled distributions use the JS
 * sibling emitted by tsc.
 */
function resolveAuthorChildPath(): string {
  const compiledPath = path.join(__dirname, "authorAggregationChild.js");
  if (fs.existsSync(compiledPath)) return compiledPath;
  return path.join(__dirname, "authorAggregationChild.ts");
}

function childArguments(childPath: string): string[] {
  if (childPath.endsWith(".ts")) {
    return ["--max-old-space-size=256", "-r", require.resolve("tsx/cjs"), childPath];
  }
  return ["--max-old-space-size=256", childPath];
}

/** Run the child protocol, returning null for every failure mode. */
function collectAuthorsInChild(
  namespaces: AuthorNamespace[],
  childPath: string,
  spawn: Spawn,
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (authors: string[] | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(authors);
    };

    try {
      child = spawn(process.execPath, childArguments(childPath), {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, AUTHOR_CHILD_TIMEOUT_MS);

    child.on("error", () => finish(null));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.byteLength(chunk);
      outputBytes += bytes;
      if (outputBytes > AUTHOR_CHILD_MAX_BUFFER_BYTES) {
        child.kill("SIGKILL");
        finish(null);
        return;
      }
      stdout += chunk.toString();
    });
    // Drain stderr so a chatty child cannot block on a full pipe. The child
    // writes diagnostics there only; nothing on stderr reaches the response.
    child.stderr?.on("data", () => undefined);
    child.stderr?.on("error", () => undefined);
    child.stdin?.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(stdout);
        if (
          !parsed ||
          typeof parsed !== "object" ||
          !("authors" in parsed) ||
          !Array.isArray(parsed.authors) ||
          !parsed.authors.every((author): author is string => typeof author === "string")
        ) {
          finish(null);
          return;
        }
        finish(parsed.authors);
      } catch {
        finish(null);
      }
    });

    child.stdin?.end(JSON.stringify({
      namespacePaths: namespaces.map((namespace) => namespace.path),
    }));
  });
}

function createUsersRouter(options: UsersRouteOptions = {}): Router {
  const router: Router = Router();
  const childPath = options.childPath ?? resolveAuthorChildPath();
  const spawn = options.spawn ?? spawnProcess;
  const listNamespaces = options.listNamespaces ?? listNamespacesTool;

  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const namespacesResult = await listNamespaces(
        {},
        { principal: getPrincipal(req) },
      );

      if (!namespacesResult.success) {
        res.json({ users: [] });
        return;
      }

      const childAuthors = await collectAuthorsInChild(
        namespacesResult.namespaces,
        childPath,
        spawn,
      );
      const users =
        childAuthors === null
          ? await collectAuthorsForNamespaces(namespacesResult.namespaces)
          : [...new Set(childAuthors)].sort();
      res.json({ users, count: users.length });
    }),
  );

  return router;
}

// Keep the existing mount surface for production callers while exposing a
// factory for tests that need to force child startup failures.
export const createUsersRoutes = createUsersRouter();
export { createUsersRouter };
export default createUsersRoutes;
