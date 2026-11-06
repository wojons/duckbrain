/**
 * SDK-PARITY-001: @duckbrain/sdk — a typed client for the DuckBrain HTTP API.
 *
 * The surface is generated from the server's own OpenAPI document
 * (`packages/sdk/spec/duckbrain.openapi.json`), so it cannot describe an
 * endpoint the server does not serve. Regenerate with `pnpm sdk:gen`.
 *
 *   import { NamespaceClient } from "@duckbrain/sdk";
 *
 *   const client = new NamespaceClient({ baseUrl, apiKey });
 *   const { memories } = await client.listMemories({ query: { namespace: "hermes", limit: 5 } });
 */
export * from "./generated.js";
export { DuckBrainApiError, type DuckBrainApiErrorInit } from "./errors.js";
export { parseEventStream } from "./events.js";
export {
  DuckBrainClientBase,
  type ClientOptions,
  type Method,
  type OpShape,
} from "./runtime.js";
