/**
 * DB-GAP-057: on-disk census of the namespaces root.
 *
 * DF-0924-06: the implementation moved to src/namespaces/census.ts so the
 * MCP tools (list_namespaces, switch_namespace) share THE SAME
 * directory-aware census with the HTTP route instead of duplicating it.
 * This file re-exports it in place; the HTTP route import below is
 * unchanged, and the vitest vi.mock("./namespace-census") in
 * namespaces.test.ts keeps working because the module id is untouched.
 */

export { censusOnDiskNamespaces } from "../../namespaces/census";
