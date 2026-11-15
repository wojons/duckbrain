/**
 * Fork-light author aggregation worker.
 *
 * The parent sends one JSON document over stdin. Keep stdout protocol-only;
 * diagnostics belong on stderr so callers can parse the response safely.
 */

import fs from "node:fs";
import { collectAuthorsForNamespaces } from "./authorAggregation";

interface ChildRequest {
  namespacePaths: string[];
}

function parseRequest(input: string): ChildRequest {
  const parsed: unknown = JSON.parse(input);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("namespacePaths" in parsed) ||
    !Array.isArray(parsed.namespacePaths) ||
    !parsed.namespacePaths.every((namespacePath) => typeof namespacePath === "string")
  ) {
    throw new Error("invalid author aggregation request");
  }
  return { namespacePaths: parsed.namespacePaths };
}

async function main(): Promise<void> {
  try {
    const request = parseRequest(fs.readFileSync(0, "utf8"));
    const authors = await collectAuthorsForNamespaces(
      request.namespacePaths.map((namespacePath) => ({ path: namespacePath })),
    );
    process.stdout.write(JSON.stringify({ authors }));
  } catch (error) {
    process.stderr.write(
      `author aggregation child failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}

void main();
