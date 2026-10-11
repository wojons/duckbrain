/**
 * MCP profile management tools — MCP-CONNECTION-PROFILES-001.
 *
 * Four tools, all VISIBLE-ONLY surfaces:
 *   list_profiles    — inspect available profiles + active selection
 *   create_profile   — an agent defines its own profile (no privilege: not auth)
 *   update_profile   — the owner edits its profile's tool-visibility state
 *   select_profiles  — choose the ACTIVE selection for this connection
 *
 * None of these grant, revoke, or broaden authority. They manipulate the
 * tools/list filter and an additive JSON store of profile definitions.
 */

import { z } from "zod";
import {
  ToolDirectiveSchema,
  BUILTIN_TOOL_NAMES,
  CONNECTION_NOTE,
  composeVisibility,
  createProfile,
  listProfiles,
  profileIntrospection,
  registeredCustomToolNames,
  setConnectionSelection,
  updateProfile,
} from "../profiles";
import { resolveDuckbrainRoot } from "../../config/index";

const ProfileOwnerSchema = z
  .string()
  .min(1)
  .describe(
    "Owner label for this profile (the agent/user that defines it). " +
      "Only the owner can later update the definition.",
  );

const ListProfilesInputSchema = z.object({});

const CreateProfileInputSchema = z.object({
  name: z.string().min(1).describe("Profile name (unique)"),
  owner: ProfileOwnerSchema,
  description: z.string().optional().describe("Human-readable purpose"),
  directives: ToolDirectiveSchema.describe(
    "Per-tool visibility directives (hidden | exclusive | default)",
  ),
});

const UpdateProfileInputSchema = z.object({
  name: z.string().min(1).describe("Profile name to update"),
  owner: ProfileOwnerSchema,
  description: z.string().optional().describe("New description"),
  directives: ToolDirectiveSchema.describe(
    "Replacement directive list (full replacement, not a merge)",
  ),
});

const SelectProfilesInputSchema = z.object({
  profiles: z
    .array(z.string().min(1))
    .describe(
      "Profile names to activate on THIS connection. Composition is the " +
        "set union of every selected profile's directives " +
        "(order-independent). Empty array clears the selection.",
    ),
});

/** Owner label for a connection that did not pass one: the principal name. */
function defaultOwner(): string {
  // Local stdio / auth=none: the operator IS the owner label.
  return "local";
}

function previewFor(
  names: string[],
  root: string,
): {
  visibleTools: string[];
  hiddenTools: string[];
  unknownProfiles: string[];
} {
  const all = [...BUILTIN_TOOL_NAMES, ...registeredCustomToolNames()];
  const composition = composeVisibility(names, all, root);
  return {
    visibleTools: composition.visible,
    hiddenTools: all.filter((t) => !composition.visible.includes(t)),
    unknownProfiles: composition.unknownProfiles,
  };
}

/** list_profiles — inspect available profiles and the active selection. */
export async function listProfilesTool(_input: unknown) {
  const root = resolveDuckbrainRoot();
  const profiles = listProfiles(root);
  return {
    success: true,
    profiles: profiles.map((p) => ({
      name: p.name,
      owner: p.owner,
      ...(p.description !== undefined ? { description: p.description } : {}),
      directives: p.directives,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    ...profileIntrospection(root),
    note: CONNECTION_NOTE,
  };
}

/** create_profile — an agent defines its own tool-visibility profile. */
export async function createProfileTool(input: {
  name: string;
  owner: string;
  description?: string;
  directives?: z.infer<typeof ToolDirectiveSchema>;
}) {
  const root = resolveDuckbrainRoot();
  const result = createProfile({
    name: input.name,
    owner: input.owner || defaultOwner(),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.directives !== undefined ? { directives: input.directives } : {}),
    root,
  });
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    profile: {
      name: result.profile!.name,
      owner: result.profile!.owner,
      ...(result.profile!.description !== undefined
        ? { description: result.profile!.description }
        : {}),
      directives: result.profile!.directives,
      createdAt: result.profile!.createdAt,
      updatedAt: result.profile!.updatedAt,
    },
    preview: previewFor([input.name], root),
    note: CONNECTION_NOTE,
  };
}

/** update_profile — the owner edits its profile's tool-visibility state. */
export async function updateProfileTool(input: {
  name: string;
  owner: string;
  description?: string;
  directives?: z.infer<typeof ToolDirectiveSchema>;
}) {
  const root = resolveDuckbrainRoot();
  const result = updateProfile({
    name: input.name,
    owner: input.owner || defaultOwner(),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.directives !== undefined ? { directives: input.directives } : {}),
    root,
  });
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    profile: {
      name: result.profile!.name,
      owner: result.profile!.owner,
      ...(result.profile!.description !== undefined
        ? { description: result.profile!.description }
        : {}),
      directives: result.profile!.directives,
      createdAt: result.profile!.createdAt,
      updatedAt: result.profile!.updatedAt,
    },
    preview: previewFor([input.name], root),
    note: CONNECTION_NOTE,
  };
}

/**
 * select_profiles — activate a selection for THIS connection only. The
 * selection is connection/session state: it lives in a module slot owned by
 * this MCP session and is never visible to (or mutated by) another
 * connection. No authorization semantics attach to it.
 */
export async function selectProfilesTool(input: { profiles: string[] }) {
  const root = resolveDuckbrainRoot();
  setConnectionSelection(input.profiles);
  return {
    success: true,
    selected: input.profiles,
    scope: "connection",
    preview: previewFor(input.profiles, root),
    note: CONNECTION_NOTE,
  };
}

export const listProfilesToolDef = {
  name: "list_profiles",
  title: "List Connection Profiles",
  description:
    "Inspect available connection profiles (tool-visibility presets) and " +
    "the active selection for this connection. Profiles shape tools/list " +
    "discovery only — they are NOT access grants.",
  inputSchema: ListProfilesInputSchema,
  handler: listProfilesTool,
};

export const createProfileToolDef = {
  name: "create_profile",
  title: "Create Connection Profile",
  description:
    "Create a named profile of tool-visibility directives (hidden / " +
    "exclusive / default per tool) that connections can select. Profiles " +
    "affect tools/list discovery only and never grant or restrict " +
    "authority.",
  inputSchema: CreateProfileInputSchema,
  handler: createProfileTool,
};

export const updateProfileToolDef = {
  name: "update_profile",
  title: "Update Connection Profile",
  description:
    "Update a profile you own (full replacement of its directives). " +
    "Visibility-only: changes alter tools/list advertising, never " +
    "authorization.",
  inputSchema: UpdateProfileInputSchema,
  handler: updateProfileTool,
};

export const selectProfilesToolDef = {
  name: "select_profiles",
  title: "Select Connection Profiles",
  description:
    "Activate one or more profiles for THIS connection/session. " +
    "Composition is the set union of every selected profile's directives " +
    "(order-independent; hidden beats exclusive on the same tool). " +
    "Affects tools/list visibility only — never authorization.",
  inputSchema: SelectProfilesInputSchema,
  handler: selectProfilesTool,
};
