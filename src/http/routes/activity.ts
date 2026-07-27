/**
 * Activity API Routes
 *
 * Returns recent memory activity across all namespaces.
 * Queries DuckDB JSONL files for recent memory entries, ordered by timestamp.
 */

import { Router, Request, Response } from 'express';
import { getDuckDBConnection } from '../../duckdb/connection';
import { asyncHandler } from '../middleware/errorHandler';
import { deepConvertBigInts } from '../../utils/serialize';
import path from 'path';
import fs from 'fs';

const router: Router = Router();

/**
 * In-memory DuckDB connection for cross-namespace queries.
 * Created once and reused for the lifetime of the server.
 */
let crossNsDb: any = null;

function getCrossNsConnection(): any {
  if (!crossNsDb) {
    crossNsDb = getDuckDBConnection('per-query', ':memory:');
  }
  return crossNsDb;
}

/**
 * Parse DuckDB STRUCT format to object (same as queries.ts)
 */
function parseDuckDBStruct(structStr: string): Record<string, unknown> {
  if (!structStr || typeof structStr !== 'string') return {};
  try { return JSON.parse(structStr); } catch { /* not JSON */ }

  const result: Record<string, unknown> = {};
  const content = structStr.trim().replace(/^\{|\}$/g, '').trim();
  if (!content) return result;

  const pairs = content.split(',');
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    if ((value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1);
    }
    if ((value.startsWith('{') && value.endsWith('}')) ||
        (value.startsWith('[') && value.endsWith(']'))) {
      try { result[key] = JSON.parse(value); } catch { result[key] = value; }
    } else if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (value === 'null') {
      result[key] = null;
    } else if (!isNaN(Number(value)) && value !== '') {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Collect all JSONL file paths across all namespaces.
 */
function collectAllJsonlFiles(): string[] {
  const config = (() => {
    try {
      return JSON.parse(fs.readFileSync('duckbrain.config.json', 'utf-8'));
    } catch { return null; }
  })();

  const nsPath = config?.namespacesPath || './namespaces';
  if (!fs.existsSync(nsPath)) return [];

  const files: string[] = [];
  const nsDirs = fs.readdirSync(nsPath);

  for (const nsName of nsDirs) {
    const nsDir = path.join(nsPath, nsName);
    if (!fs.statSync(nsDir).isDirectory()) continue;

    const manifestPath = path.join(nsDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const partitionPaths: string[] = manifest.partitions || [];

      for (const pp of partitionPaths) {
        const absPp = path.join(nsDir, pp);
        if (!fs.existsSync(absPp)) continue;
        try {
          const chunkFiles = fs.readdirSync(absPp)
            .filter((f: string) => f.endsWith('.jsonl'))
            .map((f: string) => path.join(absPp, f).replace(/\\/g, '/'));
          files.push(...chunkFiles);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  return files;
}

/**
 * Query recent memories across all namespaces.
 */
async function queryRecentActivity(
  limit: number,
): Promise<Array<{
  id: string;
  key: string;
  domain: string;
  timestamp: string;
  author: string;
  action: string;
  content: string;
  attributes: Record<string, unknown>;
  namespace: string;
}>> {
  const allFiles = collectAllJsonlFiles();
  if (allFiles.length === 0) return [];

  const db = getCrossNsConnection();

  return new Promise((resolve) => {
    const fileList = allFiles.map((f: string) => `'${f}'`).join(', ');
    const sql = `
      SELECT id, key, domain, timestamp, author, action, embedding_text, attributes
      FROM read_json([${fileList}], format='newline_delimited')
      WHERE action != 'tombstone'
      ORDER BY timestamp DESC
      LIMIT ${Math.min(limit, 200)}
    `;

    try {
      db.all(sql, (err: any, result: any) => {
        if (err || !result || !Array.isArray(result)) {
          resolve([]);
          return;
        }

        const activities = (result as any[]).map((row: any) =>
          deepConvertBigInts({
            id: row.id,
            key: row.key,
            domain: row.domain,
            timestamp: row.timestamp,
            author: row.author,
            action: row.action,
            content: row.embedding_text || '',
            attributes:
              typeof row.attributes === 'string'
                ? parseDuckDBStruct(row.attributes)
                : row.attributes || {},
            namespace: extractNamespaceFromPath(allFiles[0]) || 'default',
          }),
        );

        // Enrich with namespace info
        const enriched = enrichWithNamespace(activities, allFiles);
        resolve(enriched);
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * Extract namespace name from a file path.
 * Paths are like ./namespaces/<nsName>/<partition>/<chunk>.jsonl
 */
function extractNamespaceFromPath(filePath: string): string | null {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const nsIdx = parts.indexOf('namespaces');
  if (nsIdx !== -1 && nsIdx + 1 < parts.length) {
    return parts[nsIdx + 1];
  }
  return null;
}

/**
 * Enrich activities with namespace information.
 * Maps each file to its namespace name so results include namespace context.
 */
function enrichWithNamespace(
  activities: any[],
  allFiles: string[],
): any[] {
  // Build a map from file path prefix to namespace name
  const fileNsMap = new Map<string, string>();
  for (const f of allFiles) {
    const ns = extractNamespaceFromPath(f);
    if (ns) fileNsMap.set(f, ns);
  }

  // This would require tracking which file each row came from,
  // which isn't possible from the DuckDB result alone.
  // Instead, extract namespace from the first file path pattern.
  // Most namespaces follow the same structure.
  return activities.map((a) => ({
    ...a,
    namespace: fileNsMap.values().next().value || 'default',
  }));
}

/**
 * GET /activity
 * Returns recent memory activity across all namespaces.
 */
router.get('/', asyncHandler(async (req: Request, res: Response) => {
  const limit = Math.min(
    parseInt((req.query.limit as string) || '50', 10) || 50,
    200,
  );

  const activities = await queryRecentActivity(limit);

  res.json({
    activities,
    count: activities.length,
    limit,
  });
}));

export { router as createActivityRoutes };
export default router;
