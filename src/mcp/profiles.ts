/**
 * MCP connection profiles — tool-VISIBILITY state, never authorization.
 *
 * MCP-CONNECTION-PROFILES-001 (owner directive 2026-10-10): a connecting user
 * may select or be associated with multiple profiles. A profile describes
 * connection/session state — which tools are enabled and advertised to that
 * connection — and is NOT an access grant or permission. Agents can build
 * their own profiles precisely because profiles do not control authorization.
 *
 * THE HARD BOUNDARY (AC 3):
 *   - Profile selection filters `tools/list` output ONLY.
 *   - `tools/call` NEVER consults profiles. Authentication, namespace grants,
 *     role checks, and tool/runtime safeguards are evaluated exactly as
 *     before; a hidden-but-authorized tool call follows the EXISTING
 *     authorization contract, and a profile cannot make an otherwise
 *     unauthorized call succeed (a hidden tool the caller is not authorized
 *     for still fails on the same grant/role path as before).
 *
 * Composition is deterministic and ORDER-INDEPENDENT. For a selection
 * [A, B, ...] the composed visibility is the SET UNION of the per-profile
 * directives (selection order cannot change the outcome):
 *
 *   1. hidden:        tool is invisible in tools/list (removes, incl. the
 *                     built-in default visibility).
 *   2. exclusive:     tool visible ONLY if the selection also names it —
 *                     every other tool is dropped.
 *   3. default        (no directive): tool keeps its built-in visibility;
 *                     folding it is a no-op — a `default` never re-widens a
 *                     tool another selected profile hid.
 *
 * After folding all directives: if any directive was `exclusive`, the result
 * is exactly the union of exclusive-named sets MINUS the union of hidden
 * names; otherwise the result is the default set MINUS the hidden union.
 * Within one profile (or across profiles), `hidden` beats a same-name
 * `exclusive` (documented conflict rule: the negative directive always
 * wins). An `exclusive` tool that is also named `hidden` is therefore
 * invisible, never the reverse.
 *
 * Isolation: selections and profile definitions are per CONNECTION/session.
 * A selection set over HTTP is stored in a REQUEST-scoped slot (or a
 * connection slot when chosen via the select_profiles tool) and is never
 * shared with — or mutated by — another connection. Another user's state is
 * never mutated: profile definitions are additive, keyed by name+owner, and
 * overwriting a definition requires the same owner name.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";
import { resolveDuckbrainRoot } from "../config/index";

/** The built-in DuckBrain tools, always present (MCP-visible). */
export const BUILTIN_TOOL_NAMES = [
  "remember",
  "recall",
  "list_keys",
  "forget",
  "squash",
  "get_compaction_stats",
  "create_namespace",
  "list_namespaces",
  "switch_namespace",
  "delete_namespace",
  "server_status",
  "server_http_start",
  "list_profiles",
  "create_profile",
  "update_profile",
  "select_profiles",
] as const;

/** Per-tool visibility directive inside a profile. */
export const ToolDirectiveSchema = z
  .array(
    z.object({
      tool: z.string().min(1).describe("Tool name the directive applies to"),
      visibility: z
        .enum(["hidden", "exclusive", "default"])
        .describe(
          "hidden: not advertised in tools/list; exclusive: visible only " +
            "if the selection also names it; default: built-in visibility",
        ),
    }),
  )
  .default([]);

export type ToolDirective = z.infer<typeof ToolDirectiveSchema>;

/** A stored profile definition. */
export interface ConnectionProfile {
  name: string;
  /** Owner label (agent/user that created the profile) — identity only. */
  owner: string;
  description?: string;
  directives: ToolDirective;
  createdAt: string;
  updatedAt: string;
}

interface ProfileStoreFile {
  version: 1;
  profiles: ConnectionProfile[];
}

export const PROFILE_STORE_VERSION = 1;

/**
 * Connection-scoped selection state.
 *
 * Stored OUTSIDE the profile definitions and never persisted: a selection is
 * session state of exactly one MCP connection. `connection` is the
 * select_profiles-tool slot (a stdio process, or one logical MCP client
 * session); `request` is the per-HTTP-request slot set from the
 * X-DuckBrain-Profiles header.
 */
interface SelectionState {
  connection: string[] | undefined;
  request: string[] | undefined;
}

const selection: SelectionState = { connection: undefined, request: undefined };

/** Store file location: <duckbrain root>/.duckbrain/mcp-profiles.json. */
export function profileStorePath(root = resolveDuckbrainRoot()): string {
  return path.join(root, ".duckbrain", "mcp-profiles.json");
}

function emptyStore(): ProfileStoreFile {
  return { version: PROFILE_STORE_VERSION, profiles: [] };
}

/** Read the profile store. Missing file -> empty store (additive surface). */
export function readProfileStore(
  root = resolveDuckbrainRoot(),
): ProfileStoreFile {
  const file = profileStorePath(root);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const store = ProfileStoreFileSchema.safeParse(parsed);
    if (store.success) return store.data;
    // Corrupt/legacy store: fail soft to empty rather than breaking listing.
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

const ProfileEntrySchema = z.object({
  name: z.string().min(1),
  owner: z.string().min(1),
  description: z.string().optional(),
  directives: ToolDirectiveSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const ProfileStoreFileSchema = z.object({
  version: z.literal(PROFILE_STORE_VERSION),
  profiles: z.array(ProfileEntrySchema),
});

function writeProfileStore(store: ProfileStoreFile, root: string): void {
  const file = profileStorePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** List all stored profiles. */
export function listProfiles(
  root = resolveDuckbrainRoot(),
): ConnectionProfile[] {
  return readProfileStore(root).profiles;
}

/** Get one profile by name (exact match), or undefined. */
export function getProfile(
  name: string,
  root = resolveDuckbrainRoot(),
): ConnectionProfile | undefined {
  return readProfileStore(root).profiles.find((p) => p.name === name);
}

/**
 * Create a profile. Additive only: an existing name is never silently
 * overwritten (use update_profile). Because profiles do not control
 * authorization, creation requires no privilege — any connection may define
 * its own.
 */
export function createProfile(input: {
  name: string;
  owner: string;
  description?: string;
  directives?: ToolDirective;
  root?: string;
}): { success: boolean; profile?: ConnectionProfile; error?: string } {
  const root = input.root ?? resolveDuckbrainRoot();
  const store = readProfileStore(root);
  if (store.profiles.some((p) => p.name === input.name)) {
    return {
      success: false,
      error: `profile '${input.name}' already exists — use update_profile to change it`,
    };
  }
  const now = new Date().toISOString();
  const profile: ConnectionProfile = {
    name: input.name,
    owner: input.owner,
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    directives: input.directives ?? [],
    createdAt: now,
    updatedAt: now,
  };
  writeProfileStore(
    { version: PROFILE_STORE_VERSION, profiles: [...store.profiles, profile] },
    root,
  );
  return { success: true, profile };
}

/**
 * Update a profile. Overwriting another owner's definition is refused —
 * profiles are per-agent connection state; one agent must not mutate
 * another's (AC 1). Ownership is a labeling boundary for THIS additive
 * store, not an authorization primitive.
 */
export function updateProfile(input: {
  name: string;
  owner: string;
  description?: string;
  directives?: ToolDirective;
  root?: string;
}): { success: boolean; profile?: ConnectionProfile; error?: string } {
  const root = input.root ?? resolveDuckbrainRoot();
  const store = readProfileStore(root);
  const idx = store.profiles.findIndex((p) => p.name === input.name);
  if (idx === -1) {
    return {
      success: false,
      error: `profile '${input.name}' does not exist — use create_profile`,
    };
  }
  const existing = store.profiles[idx];
  if (existing.owner !== input.owner) {
    return {
      success: false,
      error: `profile '${input.name}' is owned by '${existing.owner}' — only the owner can update it`,
    };
  }
  const updated: ConnectionProfile = {
    ...existing,
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.directives !== undefined ? { directives: input.directives } : {}),
    updatedAt: new Date().toISOString(),
  };
  const next = [...store.profiles];
  next[idx] = updated;
  writeProfileStore({ version: PROFILE_STORE_VERSION, profiles: next }, root);
  return { success: true, profile: updated };
}

/** Resolve the active selection: request slot > connection slot > none. */
export function activeSelection(): string[] | undefined {
  if (selection.request !== undefined) return selection.request;
  if (selection.connection !== undefined) return selection.connection;
  return undefined;
}

/** Set/clear the connection-scoped selection (select_profiles tool). */
export function setConnectionSelection(names: string[] | undefined): void {
  selection.connection = names;
}

/** Set/clear the REQUEST-scoped selection (X-DuckBrain-Profiles header). */
export function setRequestSelection(names: string[] | undefined): void {
  selection.request = names;
}

/**
 * Parse the X-DuckBrain-Profiles header value: comma-separated profile
 * names, whitespace trimmed, empty entries dropped. Returns undefined when
 * the header is absent/blank (no selection).
 */
export function parseProfilesHeader(
  raw: string | string[] | undefined,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof value !== "string") return undefined;
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return names.length > 0 ? names : undefined;
}

export interface CompositionResult {
  /** Tool names VISIBLE in tools/list after composition. */
  visible: string[];
  /** Names referenced by the composition that do not exist in the store. */
  unknownProfiles: string[];
  /** Names in an `exclusive` directive of the selected profiles. */
  exclusiveNames: string[];
  /** Names in a `hidden` directive of the selected profiles. */
  hiddenNames: string[];
  /** Whether any selected profile carried an exclusive directive. */
  exclusiveActive: boolean;
}

/**
 * Deterministic composition — the single function both tools/list filtering
 * and the profile tools' preview call. Composition is the SET UNION of all
 * selected profiles' directives and is therefore independent of selection
 * order; for the same tool name, hidden beats exclusive regardless of which
 * profile (or directive) mentioned it first (documented conflict rule).
 */
export function composeVisibility(
  selectionNames: string[] | undefined,
  allTools: readonly string[],
  root = resolveDuckbrainRoot(),
): CompositionResult {
  const profiles = readProfileStore(root).profiles;
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const unknownProfiles: string[] = [];
  const exclusiveNames = new Set<string>();
  const hiddenNames = new Set<string>();
  let exclusiveActive = false;

  for (const name of selectionNames ?? []) {
    const profile = byName.get(name);
    if (!profile) {
      unknownProfiles.push(name);
      continue;
    }
    for (const directive of profile.directives) {
      if (directive.visibility === "exclusive") {
        exclusiveNames.add(directive.tool);
        exclusiveActive = true;
      } else if (directive.visibility === "hidden") {
        hiddenNames.add(directive.tool);
      }
      // "default" directives are no-ops; folding them keeps the merge
      // total (later profiles can only ever narrow via explicit
      // directives, never silently re-widen an earlier hidden).
    }
  }

  // Conflict rule: hidden ALWAYS wins over exclusive for the same tool,
  // independent of which profile (or directive order) mentioned it first.
  for (const hidden of hiddenNames) exclusiveNames.delete(hidden);

  const visible = allTools.filter((tool) => {
    if (hiddenNames.has(tool)) return false;
    if (exclusiveActive) return exclusiveNames.has(tool);
    return true;
  });

  return {
    visible,
    unknownProfiles,
    exclusiveNames: [...exclusiveNames],
    hiddenNames: [...hiddenNames],
    exclusiveActive,
  };
}

/**
 * Filter a tools/list payload by the ACTIVE selection. No selection (or a
 * selection consisting only of unknown profiles) returns the payload
 * unchanged — profiles narrow discovery only, they never add or rewrite
 * entries.
 */
export function filterToolsList<T extends { name: string }>(
  tools: T[],
): { tools: T[]; composition: CompositionResult } {
  const names = activeSelection();
  const allNames = tools.map((t) => t.name);
  const composition = composeVisibility(names, allNames);
  return {
    tools: tools.filter((t) => composition.visible.includes(t.name)),
    composition,
  };
}

/** Introspection payload shared by list_profiles and select_profiles. */
export function profileIntrospection(_root = resolveDuckbrainRoot()): {
  builtInTools: string[];
  registeredCustomTools: string[];
  activeSelection: string[] | undefined;
  note: string;
} {
  const custom = registeredCustomToolNames();
  return {
    builtInTools: [...BUILTIN_TOOL_NAMES],
    registeredCustomTools: custom,
    activeSelection: activeSelection(),
    note: CONNECTION_NOTE,
  };
}

/**
 * CONNECTION NOTE — the contract every profile surface echoes. Kept in one
 * place so the tool payloads and the docs cannot drift apart.
 */
export const CONNECTION_NOTE =
  "Profiles are visibility/configuration presets, NOT security boundaries. " +
  "Selection filters tools/list discovery only; every tools/call is still " +
  "subject to authentication, namespace grants, and runtime safeguards. " +
  "Composition across a multi-profile selection is the SET UNION of every " +
  "selected profile's directives (order-independent): a `hidden` directive " +
  "removes a tool from discovery; `exclusive` narrows discovery to exactly " +
  "the exclusive-named tools; for the same tool `hidden` always beats " +
  "`exclusive`. Selections are per connection/session and never mutate " +
  "another user's state.";

/**
 * Registered custom tools (MCP-CUSTOM-RUNTIME-001 surface) that are present
 * on THIS server instance. Read dynamically from the live registry so
 * profiles can reference custom tools "when present" without a build-time
 * coupling. Returns [] when the custom-runtime module is not installed.
 */
export function registeredCustomToolNames(): string[] {
  try {
    // Lazy require: the custom-runtime module may be absent entirely.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../custom-runtime/registry") as {
      listRegisteredTools?: () => Array<{ name: string }>;
    };
    return (mod.listRegisteredTools?.() ?? []).map((t) => t.name);
  } catch {
    // Module absent (MCP-CUSTOM-RUNTIME-001 not installed on this tree) —
    // no custom tools to reference.
    return [];
  }
}
