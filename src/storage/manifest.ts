/**
 * DuckBrain Manifest Management
 *
 * Lightweight index file tracking active partition paths.
 * Enables efficient DuckDB glob queries without scanning entire namespace.
 *
 * Atomic writes: write to .tmp, then rename (prevents corruption on crash).
 */

import fs from 'fs';
import path from 'path';

/**
 * Manifest file structure
 */
export interface Manifest {
  /** Array of active partition paths relative to namespace root */
  partitions: string[];
  /** ISO-8601 timestamp of last update */
  lastUpdated: string;
}

/**
 * Manifest file name
 */
const MANIFEST_FILENAME = 'manifest.json';

/**
 * Get manifest file path for a namespace
 *
 * @param namespacePath - Absolute or relative path to namespace directory
 * @returns Full path to manifest.json
 */
function getManifestPath(namespacePath: string): string {
  return path.join(namespacePath, MANIFEST_FILENAME);
}

/**
 * Get or create manifest for namespace
 *
 * @param namespacePath - Path to namespace directory
 * @returns Existing manifest or new default manifest
 */
export function getManifest(namespacePath: string): Manifest {
  const manifestPath = getManifestPath(namespacePath);

  if (!fs.existsSync(manifestPath)) {
    // Create default manifest
    return {
      partitions: [],
      lastUpdated: new Date().toISOString()
    };
  }

  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    return JSON.parse(content) as Manifest;
  } catch (error) {
    // Corrupted manifest - return default
    console.warn(
      `Warning: Could not parse manifest at ${manifestPath}, creating new one`
    );
    return {
      partitions: [],
      lastUpdated: new Date().toISOString()
    };
  }
}

/**
 * Write manifest atomically
 *
 * Writes to .tmp file first, then renames to prevent corruption
 * if process crashes mid-write.
 *
 * @param namespacePath - Path to namespace directory
 * @param manifest - Manifest to write
 */
function writeManifestAtomic(namespacePath: string, manifest: Manifest): void {
  const manifestPath = getManifestPath(namespacePath);
  const tmpPath = path.join(namespacePath, `${MANIFEST_FILENAME}.tmp`);

  // Ensure namespace directory exists
  if (!fs.existsSync(namespacePath)) {
    fs.mkdirSync(namespacePath, { recursive: true });
  }

  // Write to temp file
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Atomic rename
  fs.renameSync(tmpPath, manifestPath);
}

/**
 * Add partition to manifest
 *
 * @param namespacePath - Path to namespace directory
 * @param partitionPath - Partition path to add (relative to namespace)
 */
export function addPartition(
  namespacePath: string,
  partitionPath: string
): void {
  const manifest = getManifest(namespacePath);

  // Normalize path separators for consistent comparison
  const normalizedPartition = partitionPath.replace(/\\/g, '/');

  // Add if not already present
  if (!manifest.partitions.includes(normalizedPartition)) {
    manifest.partitions.push(normalizedPartition);
    manifest.lastUpdated = new Date().toISOString();
    writeManifestAtomic(namespacePath, manifest);
  }
}

/**
 * Remove partition from manifest
 *
 * Used for cleanup operations (not tombstones - those are for memory records).
 *
 * @param namespacePath - Path to namespace directory
 * @param partitionPath - Partition path to remove
 */
export function removePartition(
  namespacePath: string,
  partitionPath: string
): void {
  const manifest = getManifest(namespacePath);

  // Normalize path separators
  const normalizedPartition = partitionPath.replace(/\\/g, '/');

  const index = manifest.partitions.indexOf(normalizedPartition);
  if (index !== -1) {
    manifest.partitions.splice(index, 1);
    manifest.lastUpdated = new Date().toISOString();
    writeManifestAtomic(namespacePath, manifest);
  }
}

/**
 * Get partitions filtered by domain prefix
 *
 * Optimizes DuckDB queries by targeting only relevant partitions.
 *
 * @param namespacePath - Path to namespace directory
 * @param domain - Domain to filter by (e.g., 'person', 'event')
 * @returns Array of partition paths starting with domain
 */
export function getPartitionsForDomain(
  namespacePath: string,
  domain: string
): string[] {
  const manifest = getManifest(namespacePath);

  // Partitions follow pattern: domain/... or domain/subdomain/...
  // Match partitions that start with the domain
  return manifest.partitions.filter(p => {
    const parts = p.split('/');
    return parts[0] === domain;
  });
}

/**
 * Get all partition paths as absolute paths
 *
 * @param namespacePath - Path to namespace directory
 * @returns Array of absolute partition paths
 */
export function getAllPartitionPaths(namespacePath: string): string[] {
  const manifest = getManifest(namespacePath);

  return manifest.partitions.map(p => path.join(namespacePath, p));
}

/**
 * Initialize namespace with manifest
 *
 * Creates namespace directory and initializes empty manifest.
 *
 * @param namespacePath - Path to namespace directory
 * @returns Initialized manifest
 */
export function initializeNamespace(namespacePath: string): Manifest {
  // Create namespace directory
  if (!fs.existsSync(namespacePath)) {
    fs.mkdirSync(namespacePath, { recursive: true });
  }

  // Create initial manifest
  const manifest: Manifest = {
    partitions: [],
    lastUpdated: new Date().toISOString()
  };

  writeManifestAtomic(namespacePath, manifest);
  return manifest;
}
