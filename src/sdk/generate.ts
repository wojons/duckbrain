/**
 * SDK-PARITY-001: the client generator.
 *
 * Input  — the namespace OpenAPI 3.1 document, produced by the SERVER
 *          (`generateOpenApi()` in src/http/routes/tables.ts) for the fixed
 *          fixture namespace in ./fixture.ts. No hand-written operation list:
 *          the document is the only source of paths, parameters and shapes.
 * Output — packages/sdk/spec/duckbrain.openapi.json (the captured document)
 *          and packages/sdk/src/generated.ts (types + operation map + client).
 *
 * `pnpm sdk:gen` writes both; `pnpm sdk:check` (and the drift test in
 * src/sdk/drift.test.ts) recompute both in memory and fail on any difference,
 * so a route that gains or renames an operation cannot leave the client stale.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateOpenApi } from "../http/routes/tables.js";
import { FIXTURE_NAMESPACE, FIXTURE_TABLES } from "./fixture.js";

/** Paths of the generated artefacts, relative to the repository root. */
export const SDK_SPEC_PATH = "packages/sdk/spec/duckbrain.openapi.json";
export const SDK_CLIENT_PATH = "packages/sdk/src/generated.ts";

type JsonSchema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
};

type Parameter = {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
};

type Operation = {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: JsonSchema }> }
  >;
};

export type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, JsonSchema> };
};

/** The document the client is generated from — no disk, no daemon, no data. */
export function buildSpecDocument(): OpenApiDocument {
  return generateOpenApi(
    FIXTURE_NAMESPACE,
    FIXTURE_TABLES,
  ) as unknown as OpenApiDocument;
}

/** Deterministic JSON: object keys sorted, 2-space indent, trailing newline. */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const METHOD_ORDER = ["get", "post", "put", "patch", "delete"] as const;

type CollectedOperation = {
  id: string;
  method: string;
  path: string;
  pathParams: Parameter[];
  queryParams: Parameter[];
  body?: JsonSchema;
  bodyRequired: boolean;
  response?: JsonSchema;
  responseKind: "json" | "none" | "stream";
  summary?: string;
};

/** Every path/method in the document, with a REQUIRED operationId. */
export function collectOperations(spec: OpenApiDocument): CollectedOperation[] {
  const collected: CollectedOperation[] = [];
  for (const path of Object.keys(spec.paths).sort()) {
    const item = spec.paths[path];
    for (const method of METHOD_ORDER) {
      const op = item[method];
      if (!op) continue;
      if (!op.operationId) {
        throw new Error(
          `OpenAPI path ${method.toUpperCase()} ${path} has no operationId — the client cannot be generated from it`,
        );
      }
      const parameters = op.parameters ?? [];
      const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
      const okCode = Object.keys(op.responses ?? {}).find((code) =>
        code.startsWith("2"),
      );
      const okResponse = okCode ? op.responses?.[okCode] : undefined;
      const streamResponse = okResponse?.content?.["text/event-stream"];
      const jsonResponse = okResponse?.content?.["application/json"]?.schema;
      collected.push({
        id: op.operationId,
        method,
        path,
        pathParams: parameters.filter((p) => p.in === "path"),
        queryParams: parameters.filter((p) => p.in === "query"),
        body: bodySchema,
        bodyRequired: op.requestBody?.required === true,
        response: jsonResponse,
        responseKind: streamResponse
          ? "stream"
          : okCode === "204" || !jsonResponse
            ? "none"
            : "json",
        summary: op.summary,
      });
    }
  }
  canonicalOperationIds(collected);
  return collected;
}

function canonicalOperationIds(ops: CollectedOperation[]): void {
  const seen = new Set<string>();
  for (const op of ops) {
    const key = op.id.replace(/[^A-Za-z0-9_$]/g, "_");
    if (seen.has(key)) {
      throw new Error(`Duplicate operationId '${op.id}' in the OpenAPI document`);
    }
    seen.add(key);
    op.id = key;
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → TypeScript
// ---------------------------------------------------------------------------

function tsType(schema: JsonSchema | undefined, depth = 0): string {
  if (!schema) return "unknown";
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    return name ? schemaRefName(name) : "unknown";
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (schema.oneOf || schema.anyOf) {
    const variants = (schema.oneOf ?? schema.anyOf ?? []).map((variant) =>
      tsType(variant, depth + 1),
    );
    return [...new Set(variants)].join(" | ");
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length > 1) {
    return types.map((type) => tsType({ ...schema, type }, depth + 1)).join(" | ");
  }
  const type = types[0];
  switch (type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${tsType(schema.items, depth + 1)}>`;
    case "object":
    case undefined: {
      if (schema.additionalProperties === true && !schema.properties) {
        return "Record<string, unknown>";
      }
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const entries = Object.keys(properties).map((name) => {
        const optional = required.has(name) ? "" : "?";
        return `${name}${optional}: ${tsType(properties[name], depth + 1)}`;
      });
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        entries.push(`[key: string]: ${tsType(schema.additionalProperties, depth + 1)}`);
      } else if (schema.additionalProperties === true) {
        entries.push("[key: string]: unknown");
      }
      return entries.length === 0 ? "Record<string, unknown>" : `{ ${entries.join("; ")} }`;
    }
    default:
      return "unknown";
  }
}

function schemaRefName(ref: string): string {
  return ref.replace(/[^A-Za-z0-9_$]/g, "_");
}

function pascal(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

function propertyKey(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** packages/sdk/spec/duckbrain.openapi.json */
export function renderSpec(spec: OpenApiDocument = buildSpecDocument()): string {
  return stableJson(spec);
}

/** packages/sdk/src/generated.ts */
export function renderClient(spec: OpenApiDocument = buildSpecDocument()): string {
  const operations = collectOperations(spec);
  const lines: string[] = [];
  const push = (...next: string[]): void => {
    lines.push(...next);
  };

  push(
    "// AUTO-GENERATED FILE — do not edit. Regenerate with `pnpm sdk:gen`.",
    "//",
    `// Source: the namespace OpenAPI 3.1 document (${SDK_SPEC_PATH}),`,
    `// captured from generateOpenApi() for the fixture namespace`,
    `// "${FIXTURE_NAMESPACE}" (src/sdk/fixture.ts). Every path, parameter and`,
    "// shape below is derived from that document; `pnpm sdk:check` and",
    "// src/sdk/drift.test.ts fail when the two disagree.",
    'import { DuckBrainClientBase, type ClientOptions } from "./runtime.js";',
    "",
  );

  // 1. Component schemas → interfaces.
  push("// ---------------------------------------------------------------------------", "// Document schemas", "// ---------------------------------------------------------------------------", "");
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    const iface = schemaInterfaceName(name);
    const description = schema.description ? [`/** ${schema.description} */`] : [];
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});
    if (properties.length === 0) {
      push(...description, `export type ${iface} = Record<string, unknown>;`, "");
      continue;
    }
    push(...description, `export interface ${iface} {`);
    for (const [prop, propSchema] of properties) {
      if (propSchema.description) push(`  /** ${propSchema.description} */`);
      push(
        `  ${propertyKey(prop)}${required.has(prop) ? "" : "?"}: ${tsType(propSchema, 1)};`,
      );
    }
    if (schema.additionalProperties === true) push("  [key: string]: unknown;");
    push("}", "");
  }

  // 2. Per-operation args + the Specs map.
  push("// ---------------------------------------------------------------------------", "// Operations", "// ---------------------------------------------------------------------------", "");
  for (const op of operations) {
    if (op.summary) push(`/** ${op.summary} */`);
    push(`export interface ${argsTypeName(op)} {`);
    if (op.pathParams.length > 0) {
      push("  path: {");
      for (const param of op.pathParams) {
        push(
          `    ${propertyKey(param.name)}${param.required === false ? "?" : ""}: ${tsType(param.schema, 2)};`,
        );
      }
      push("  };");
    }
    if (op.queryParams.length > 0) {
      push("  query?: {");
      for (const param of op.queryParams) {
        if (param.description) push(`    /** ${param.description} */`);
        push(
          `    ${propertyKey(param.name)}${param.required === true ? "" : "?"}: ${tsType(param.schema, 2)};`,
        );
      }
      push("  };");
    }
    if (op.body) {
      push(`  body${op.bodyRequired ? "" : "?"}: ${tsType(op.body, 1)};`);
    }
    push("}", "");
  }

  push(
    "/**",
    " * operationId → transport + argument + response types. The only thing the",
    " * client trusts; a document change that is not regenerated shows up here.",
    " */",
    "export type Specs = {",
  );
  for (const op of operations) {
    push(`  ${op.id}: {`);
    push(`    method: ${JSON.stringify(op.method)};`);
    push(`    path: ${JSON.stringify(op.path)};`);
    push(`    args: ${argsTypeName(op)};`);
    push(`    response: ${responseType(op)};`);
    push("  };");
  }
  push("}", "");

  push(
    "/**",
    " * The namespace these paths were captured for. `NamespaceClient` rewrites",
    " * this prefix onto the `namespace` option, so one generated client serves",
    " * every namespace (the document itself is per-namespace by design).",
    " */",
    `export const DOCUMENT_NAMESPACE = ${JSON.stringify(FIXTURE_NAMESPACE)};`,
    "",
  );
  push(
    "/** Runtime metadata for every operation (method + path template). */",
    "export const operations = {",
  );
  for (const op of operations) {
    push(`  ${op.id}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)} },`);
  }
  push("} as const;", "");

  // 3. The client.
  push(
    "/**",
    " * Typed client for one DuckBrain namespace document.",
    " *",
    " * Errors are never re-worded: a refusal surfaces as DuckBrainApiError with",
    " * the server's `error` string, `code` and `fields` verbatim (table_grant,",
    " * VALIDATION_ERROR, policy …), so a caller sees WHY, not just 400.",
    " */",
    "export class NamespaceClient extends DuckBrainClientBase<Specs> {",
    "  protected readonly ops = operations;",
    "",
    "  constructor(options: ClientOptions) {",
    "    super(options, DOCUMENT_NAMESPACE);",
    "  }",
    "",
  );
  for (const op of operations) {
    if (op.summary) push(`  /** ${op.summary} */`);
    if (op.responseKind === "stream") {
      push(
        `  ${op.id}(args?: Specs[${JSON.stringify(op.id)}]["args"]): AsyncGenerator<Record<string, unknown>> {`,
        `    return this.stream(${JSON.stringify(op.id)}, args);`,
        "  }",
        "",
      );
      continue;
    }
    push(
      `  ${op.id}(args?: Specs[${JSON.stringify(op.id)}]["args"]): Promise<Specs[${JSON.stringify(op.id)}]["response"]> {`,
      `    return this.call(${JSON.stringify(op.id)}, args);`,
      "  }",
      "",
    );
  }
  push("}", "");

  return lines.join("\n");
}

function responseType(op: CollectedOperation): string {
  if (op.responseKind === "stream") return "AsyncGenerator<Record<string, unknown>>";
  if (op.responseKind === "none") return "void";
  return tsType(op.response);
}

function argsTypeName(op: CollectedOperation): string {
  return `${pascal(op.id)}Args`;
}

function schemaInterfaceName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `S_${cleaned}`;
}

// ---------------------------------------------------------------------------
// Write / check
// ---------------------------------------------------------------------------

function readIfPresent(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Files whose committed contents disagree with a fresh generation. */
export function driftedFiles(repoRoot: string, spec = buildSpecDocument()): string[] {
  const expected: Array<[string, string]> = [
    [SDK_SPEC_PATH, renderSpec(spec)],
    [SDK_CLIENT_PATH, renderClient(spec)],
  ];
  const drifted: string[] = [];
  for (const [relative, contents] of expected) {
    const current = readIfPresent(join(repoRoot, relative));
    if (current !== contents) drifted.push(relative);
  }
  return drifted;
}

/** Writes both artefacts; returns the paths written. */
export function writeGenerated(repoRoot: string, spec = buildSpecDocument()): string[] {
  const written: string[] = [];
  for (const [relative, contents] of [
    [SDK_SPEC_PATH, renderSpec(spec)],
    [SDK_CLIENT_PATH, renderClient(spec)],
  ] as Array<[string, string]>) {
    const target = join(repoRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
    written.push(relative);
  }
  return written;
}
