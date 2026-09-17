import type { ZodType } from "zod";
import { MemorySchema } from "../schema/memory";
import type { DeclaredColumn, RowShape } from "./schemaTypes.js";

/**
 * Per-namespace table schema registry. `memories` is built in for every
 * namespace; DB-SUPA-6 registers persistent `schema.json` declarations here
 * (see `schemaRegistry.ts`), which is what makes a restarted process
 * reconstruct the same validators, storage paths, keys, headers and table
 * versions without touching a data line.
 *
 * Two registration seams coexist:
 *   - `register(ns, table, schema)` — the SUPA-2 in-process seam (unchanged).
 *   - `registerDeclaration(...)`    — a durable DB-SUPA-6 declaration, which
 *     additionally carries the physical layout + key columns + version a
 *     generic read/write path needs.
 */
export interface RegisteredTableDeclaration {
  ns: string;
  table: string;
  /** Validator built from the declared columns (canonical transforms included). */
  schema: ZodType;
  /** Namespace-relative JSONL path the rows live in. */
  storagePath: string;
  rowShape: RowShape;
  keyColumns: string[];
  columns: DeclaredColumn[];
  schemaVersion: number;
  /** sha256 of the validated `schema.json` this declaration came from. */
  documentHash: string;
}

export class TableSchemaRegistry {
  private readonly schemas = new Map<string, ZodType>();
  private readonly declarations = new Map<string, RegisteredTableDeclaration>();

  register(ns: string, table: string, schema: ZodType): void {
    this.schemas.set(this.key(ns, table), schema);
  }

  /** Register (or replace) a durable DB-SUPA-6 declared table. */
  registerDeclaration(declaration: RegisteredTableDeclaration): void {
    const key = this.key(declaration.ns, declaration.table);
    this.declarations.set(key, declaration);
    this.schemas.set(key, declaration.schema);
  }

  getDeclaration(
    ns: string,
    table: string,
  ): RegisteredTableDeclaration | undefined {
    return this.declarations.get(this.key(ns, table));
  }

  listDeclarations(ns: string): RegisteredTableDeclaration[] {
    const out: RegisteredTableDeclaration[] = [];
    for (const declaration of this.declarations.values()) {
      if (declaration.ns === ns) out.push(declaration);
    }
    return out;
  }

  /** Forget every durable declaration for one namespace (schema.json removed). */
  clearDeclarations(ns: string): void {
    for (const [key, declaration] of [...this.declarations]) {
      if (declaration.ns !== ns) continue;
      this.declarations.delete(key);
      this.schemas.delete(key);
    }
  }

  clear(): void {
    this.schemas.clear();
    this.declarations.clear();
  }

  get(ns: string, table: string): ZodType | undefined {
    if (table === "memories") return MemorySchema;
    return this.schemas.get(this.key(ns, table));
  }

  private key(ns: string, table: string): string {
    return `${ns}\u0000${table}`;
  }
}

export const tableSchemaRegistry = new TableSchemaRegistry();
