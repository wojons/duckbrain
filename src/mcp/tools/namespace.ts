/**
 * Namespace MCP Tools
 *
 * Provides 4 MCP tools for namespace management:
 * - create_namespace: Create a new namespace
 * - list_namespaces: List all namespaces
 * - switch_namespace: Switch to a different namespace
 * - delete_namespace: Delete a namespace
 */

import { z } from "zod";
import {
  getConfig,
  registerNamespace,
  resolveDuckbrainRoot,
  resolveNamespacesPath,
  updateConfig,
} from "../../config/index";
import { runGitAsync } from "../../git/exec";
import fs from "fs";
import path from "path";
import { deleteNamespace } from "../../namespaces/delete";
import { censusOnDiskNamespaces } from "../../namespaces/census";

/**
 * Create namespace tool input schema
 */
const CreateNamespaceInputSchema = z.object({
  /** Namespace name */
  name: z.string().describe("Namespace name (alphanumeric, lowercase)"),
  /** Set as default namespace */
  setDefault: z
    .boolean()
    .optional()
    .default(false)
    .describe("Set as default namespace"),
});

type CreateNamespaceInput = z.infer<typeof CreateNamespaceInputSchema>;

/**
 * Create namespace tool output
 */
interface CreateNamespaceOutput {
  success: boolean;
  path?: string;
  error?: string;
}

/**
 * List namespaces tool input schema (empty)
 */
const ListNamespacesInputSchema = z.object({});

type ListNamespacesInput = z.infer<typeof ListNamespacesInputSchema>;

/**
 * List namespaces tool output
 */
interface ListNamespacesOutput {
  success: boolean;
  namespaces: Array<{
    name: string;
    path: string;
    isDefault: boolean;
    /**
     * DF-0924-06: true when the namespace exists ONLY as a directory under
     * the namespaces root (no config mapping) — surfaced so callers can see
     * registry/disk drift instead of silently losing the row.
     */
    onDiskOnly?: boolean;
  }>;
  currentNamespace?: string;
  error?: string;
}

/**
 * Switch namespace tool input schema
 */
const SwitchNamespaceInputSchema = z.object({
  /** Namespace name to switch to */
  name: z.string().describe("Namespace name to switch to"),
});

type SwitchNamespaceInput = z.infer<typeof SwitchNamespaceInputSchema>;

/**
 * Switch namespace tool output
 */
interface SwitchNamespaceOutput {
  success: boolean;
  previous?: string;
  current?: string;
  error?: string;
}

/**
 * Delete namespace tool input schema
 */
const DeleteNamespaceInputSchema = z.object({
  /** Namespace name to delete */
  name: z.string().describe("Namespace name to delete"),
  /** Confirmation flag (required) */
  confirm: z.boolean().describe("Must be true to confirm deletion"),
});

type DeleteNamespaceInput = z.infer<typeof DeleteNamespaceInputSchema>;

/**
 * Delete namespace tool output
 */
interface DeleteNamespaceOutput {
  success: boolean;
  /** Absolute path of the directory that was removed (only on success) */
  path?: string;
  error?: string;
}

/**
 * Create a new namespace
 *
 * @param input - Namespace creation parameters
 * @returns Creation result with path
 */
export async function createNamespaceTool(
  input: CreateNamespaceInput,
): Promise<CreateNamespaceOutput> {
  try {
    // Validate input
    CreateNamespaceInputSchema.parse(input);

    // GAP-062: the namespace root comes from the config file's own directory,
    // never the caller's cwd — a create from an unrelated checkout must not
    // mkdir `<cwd>/namespaces/<name>`.
    const nsRoot = resolveNamespacesPath();
    const nsPath = path.join(nsRoot, input.name);

    // DB-GAP-057: the REGISTRY seam is the duckbrain ROOT — the directory
    // owning `duckbrain.config.json`, the same file every read path
    // (getConfig(".") → resolveDuckbrainRoot()) consults — never the
    // namespaces root. be129bc (GAP-062) passed `nsRoot` here, which
    // registerNamespace treats as a CONFIG DIRECTORY: HTTP + MCP creates
    // materialized a stray `<nsRoot>/duckbrain.config.json` and the mapping
    // never reached the root config, so GET /api/namespaces (which reads the
    // root) never saw the namespace. GAP-062's DIRECTORY placement above is
    // untouched — only the registry write target changes.
    const cfgRoot = resolveDuckbrainRoot();

    // Check if namespace already exists
    if (fs.existsSync(nsPath)) {
      return {
        success: false,
        error: `Namespace '${input.name}' already exists at ${nsPath}`,
      };
    }

    // Create namespace directory
    fs.mkdirSync(nsPath, { recursive: true });

    // Initialize git repo.
    //
    // OPS-007: bounded ASYNC spawn (src/git/exec.ts) — this ran through
    // `execSync` on the POST /api/namespaces path, so a slow or wedged
    // `git init` parked the event loop for every other route, /health
    // included. Best-effort semantics are unchanged: a failing or timed-out
    // init still warns and the namespace is still created.
    try {
      await runGitAsync(["init"], nsPath, {
        // Finite per-git bound; a fresh-dir init is milliseconds.
        timeoutMs: 10_000,
        maxBufferBytes: 1024 * 1024,
      });
    } catch (gitError) {
      console.warn(
        `Warning: Could not init git: ${(gitError as Error).message}`,
      );
    }

    // Create initial manifest
    const manifestPath = path.join(nsPath, "manifest.json");
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          {
            version: "1.0",
            createdAt: new Date().toISOString(),
            partitions: [],
          },
          null,
          2,
        ) + "\n",
      );
    }

    // Register against the ROOT config (DB-GAP-057 — see the seam comment
    // above; never the namespaces root, never `<cwd>/duckbrain.config.json`).
    registerNamespace(cfgRoot, input.name, nsPath);

    if (input.setDefault) {
      // DB-GAP-057: same seam as the register write — the default-namespace
      // marker belongs in the config file the switch/list paths read.
      updateConfig(cfgRoot, { defaultNamespace: input.name });
    }

    return {
      success: true,
      path: nsPath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * List all namespaces
 *
 * @param input - Empty input
 * @returns List of namespaces with metadata
 */
export async function listNamespacesTool(
  input: ListNamespacesInput,
): Promise<ListNamespacesOutput> {
  try {
    // Validate input (empty schema)
    ListNamespacesInputSchema.parse(input);

    const config = getConfig(".");
    const namespaces = config.namespaceMappings || {};
    const currentNamespace = config.defaultNamespace;

    // DF-0924-06: explicitly typed — census-union rows below push the
    // optional onDiskOnly flag, which the inferred map-element type lacks.
    const namespaceList: ListNamespacesOutput["namespaces"] = Object.entries(
      namespaces,
    ).map(([name, nsPath]) => ({
      name,
      path: nsPath,
      isDefault: name === currentNamespace,
    }));

    // DF-0924-06: the registry is not the whole truth — directories can
    // exist under the namespaces root with NO mapping (the be129bc
    // split-brain shape). Share THE SAME census the HTTP GET route unions
    // (src/namespaces/census.ts) so every surface agrees about what
    // exists. Union: census rows absent from the registry become onDiskOnly
    // rows; census failure yields an empty census and the registry half is
    // still served (a listing must not 500 because a storage dir vanished).
    //
    // The synthetic-default unshift below stays: the registry still lists
    // the (implicit) default namespace — but ONLY when it exists as a
    // directory under the namespaces root. A phantom `default` row for a
    // namespace that was never created (no mapping, no directory) told
    // callers a namespace existed that did not; the old unshift could not
    // even be silenced by creating+registering other namespaces.
    const listedNames = new Set(namespaceList.map((ns) => ns.name));
    const onDisk = censusOnDiskNamespaces(resolveNamespacesPath());
    for (const [name, nsPath] of onDisk) {
      if (listedNames.has(name)) continue;
      listedNames.add(name);
      namespaceList.push({
        name,
        path: nsPath,
        isDefault: name === currentNamespace,
        onDiskOnly: true,
      });
    }

    // Ensure default namespace is always listed — but never as a phantom:
    // the default namespace must EXIST on disk (directory under the
    // namespaces root) or be registered. GAP-062: report the absolute,
    // root-derived path (the same one the create/write paths use), not a
    // cwd-relative string.
    if (!listedNames.has("default") && !onDisk.has("default")) {
      if (fs.existsSync(path.join(resolveNamespacesPath(), "default"))) {
        // Unreadable-census edge: the directory exists but the census
        // yielded an empty map — fall back to a direct existence check so
        // a real default directory is still represented.
        namespaceList.unshift({
          name: "default",
          path: path.join(resolveNamespacesPath(), "default"),
          isDefault: currentNamespace === "default",
          onDiskOnly: true,
        });
      }
    }

    return {
      success: true,
      namespaces: namespaceList,
      currentNamespace,
    };
  } catch (error) {
    return {
      success: false,
      namespaces: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Switch to a different namespace
 *
 * @param input - Namespace name to switch to
 * @returns Switch result with previous/current namespace
 */
export async function switchNamespaceTool(
  input: SwitchNamespaceInput,
): Promise<SwitchNamespaceOutput> {
  try {
    // Validate input
    SwitchNamespaceInputSchema.parse(input);

    const config = getConfig(".");
    const previous = config.defaultNamespace;

    // DF-0924-06: validate against REALITY, not the mapping table alone —
    // the same directory-aware census the list surfaces use. Three cases:
    //   1. Registered mapping          → switch (registering is redundant;
    //                                    the mapping already agrees).
    //   2. Directory present, no map   → REGISTER the mapping, then switch.
    //                                    This is the write path's own
    //                                    reconciliation rule (create =
    //                                    mkdir + registerNamespace), so
    //                                    listing and switching can never
    //                                    disagree about what exists — the
    //                                    split-brain shape (be129bc) made
    //                                    these namespaces visible-but-
    //                                    unswitchable.
    //   3. Exists nowhere              → accurate failure naming the
    //                                    namespace.
    if (!config.namespaceMappings?.[input.name]) {
      const nsRoot = resolveNamespacesPath();
      const onDiskPath = censusOnDiskNamespaces(nsRoot).get(input.name);
      if (!onDiskPath) {
        return {
          success: false,
          error: `Namespace '${input.name}' not found. Use list_namespaces to see available namespaces.`,
        };
      }
      registerNamespace(".", input.name, onDiskPath);
    }

    // Update default namespace
    updateConfig(".", { defaultNamespace: input.name });

    return {
      success: true,
      previous,
      current: input.name,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Delete a namespace
 *
 * Delegates to the shared deletion core (src/namespaces/delete.ts, DB-GAP-032)
 * so the MCP tool and the REST route (DELETE /api/namespaces/:name) share the
 * exact same guards and behavior. The schema parse + confirmation requirement
 * mirror the pre-refactor tool contract exactly (DOGFOOD-004).
 *
 * @param input - Namespace name and confirmation
 * @returns Deletion result
 */
export async function deleteNamespaceTool(
  input: DeleteNamespaceInput,
): Promise<DeleteNamespaceOutput> {
  try {
    // Validate input
    DeleteNamespaceInputSchema.parse(input);

    return deleteNamespace(input.name, input.confirm);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// Export for server registration
export {
  CreateNamespaceInputSchema,
  ListNamespacesInputSchema,
  SwitchNamespaceInputSchema,
  DeleteNamespaceInputSchema,
};
