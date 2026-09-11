import type { ZodType } from "zod";
import { MemorySchema } from "../schema/memory";

/**
 * Per-namespace table schema registry. `memories` is built in for every
 * namespace; DB-SUPA-6 can explicitly register additional tables later.
 */
export class TableSchemaRegistry {
  private readonly schemas = new Map<string, ZodType>();

  register(ns: string, table: string, schema: ZodType): void {
    this.schemas.set(this.key(ns, table), schema);
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
