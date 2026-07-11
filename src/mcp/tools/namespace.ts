/**
 * Namespace MCP Tools
 *
 * Provides 4 MCP tools for namespace management:
 * - create_namespace: Create a new namespace
 * - list_namespaces: List all namespaces
 * - switch_namespace: Switch to a different namespace
 * - delete_namespace: Delete a namespace
 */

import { z } from 'zod';
import { getConfig, updateConfig, registerNamespace } from '../../config/index';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Create namespace tool input schema
 */
const CreateNamespaceInputSchema = z.object({
  /** Namespace name */
  name: z.string().describe('Namespace name (alphanumeric, lowercase)'),
  /** Set as default namespace */
  setDefault: z.boolean().optional().default(false).describe('Set as default namespace')
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
  }>;
  currentNamespace?: string;
  error?: string;
}

/**
 * Switch namespace tool input schema
 */
const SwitchNamespaceInputSchema = z.object({
  /** Namespace name to switch to */
  name: z.string().describe('Namespace name to switch to')
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
  name: z.string().describe('Namespace name to delete'),
  /** Confirmation flag (required) */
  confirm: z.boolean().describe('Must be true to confirm deletion')
});

type DeleteNamespaceInput = z.infer<typeof DeleteNamespaceInputSchema>;

/**
 * Delete namespace tool output
 */
interface DeleteNamespaceOutput {
  success: boolean;
  error?: string;
}

/**
 * Create a new namespace
 *
 * @param input - Namespace creation parameters
 * @returns Creation result with path
 */
export async function createNamespaceTool(
  input: CreateNamespaceInput
): Promise<CreateNamespaceOutput> {
  try {
    // Validate input
    CreateNamespaceInputSchema.parse(input);
    
    const config = getConfig('.');
    const nsPath = path.join(config.namespacesPath, input.name);
    
    // Check if namespace already exists
    if (fs.existsSync(nsPath)) {
      return {
        success: false,
        error: `Namespace '${input.name}' already exists at ${nsPath}`
      };
    }
    
    // Create namespace directory
    fs.mkdirSync(nsPath, { recursive: true });
    
    // Initialize git repo
    try {
      execSync('git init', { cwd: nsPath, stdio: 'pipe' });
    } catch (gitError) {
      console.warn(`Warning: Could not init git: ${(gitError as Error).message}`);
    }
    
    // Create initial manifest
    const manifestPath = path.join(nsPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, JSON.stringify({
        version: '1.0',
        createdAt: new Date().toISOString(),
        partitions: []
      }, null, 2) + '\n');
    }

    // Update config
    registerNamespace('.', input.name, nsPath);
    
    if (input.setDefault) {
      updateConfig('.', { defaultNamespace: input.name });
    }
    
    return {
      success: true,
      path: nsPath
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
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
  input: ListNamespacesInput
): Promise<ListNamespacesOutput> {
  try {
    // Validate input (empty schema)
    ListNamespacesInputSchema.parse(input);
    
    const config = getConfig('.');
    const namespaces = config.namespaceMappings || {};
    const currentNamespace = config.defaultNamespace;
    
    const namespaceList = Object.entries(namespaces).map(([name, nsPath]) => ({
      name,
      path: nsPath,
      isDefault: name === currentNamespace
    }));
    
    // Ensure default namespace is always listed
    if (!namespaceList.some(n => n.name === 'default')) {
      namespaceList.unshift({
        name: 'default',
        path: path.join(config.namespacesPath || './namespaces', 'default'),
        isDefault: currentNamespace === 'default'
      });
    }
    
    return {
      success: true,
      namespaces: namespaceList,
      currentNamespace
    };
  } catch (error) {
    return {
      success: false,
      namespaces: [],
      error: error instanceof Error ? error.message : 'Unknown error'
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
  input: SwitchNamespaceInput
): Promise<SwitchNamespaceOutput> {
  try {
    // Validate input
    SwitchNamespaceInputSchema.parse(input);
    
    const config = getConfig('.');
    const previous = config.defaultNamespace;
    
    // Validate namespace exists
    if (!config.namespaceMappings?.[input.name]) {
      return {
        success: false,
        error: `Namespace '${input.name}' not found. Use list_namespaces to see available namespaces.`
      };
    }
    
    // Update default namespace
    updateConfig('.', { defaultNamespace: input.name });
    
    return {
      success: true,
      previous,
      current: input.name
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Delete a namespace
 *
 * @param input - Namespace name and confirmation
 * @returns Deletion result
 */
export async function deleteNamespaceTool(
  input: DeleteNamespaceInput
): Promise<DeleteNamespaceOutput> {
  try {
    // Validate input
    DeleteNamespaceInputSchema.parse(input);
    
    // Require confirmation
    if (!input.confirm) {
      return {
        success: false,
        error: 'Confirmation required. Set confirm=true to delete namespace.'
      };
    }
    
    const config = getConfig('.');
    
    // Validate namespace exists
    if (!config.namespaceMappings?.[input.name]) {
      return {
        success: false,
        error: `Namespace '${input.name}' not found`
      };
    }
    
    // Prevent deleting default namespace
    if (input.name === 'default') {
      return {
        success: false,
        error: 'Cannot delete default namespace'
      };
    }
    
    // Prevent deleting current active namespace
    if (config.defaultNamespace === input.name) {
      return {
        success: false,
        error: 'Cannot delete currently active namespace. Switch to a different namespace first.'
      };
    }
    
    // Remove from config
    const { [input.name]: _, ...rest } = config.namespaceMappings || {};
    updateConfig('.', { namespaceMappings: rest });
    
    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Export for server registration
export {
  CreateNamespaceInputSchema,
  ListNamespacesInputSchema,
  SwitchNamespaceInputSchema,
  DeleteNamespaceInputSchema
};
