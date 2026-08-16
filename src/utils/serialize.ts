/**
 * Safe JSON serialization that handles BigInt values from DuckDB.
 *
 * DuckDB returns BigInt values for large integers. Native JSON.stringify
 * throws "TypeError: Do not know how to serialize a BigInt".
 * This replacer converts BigInt to number (safe range) or string (large values)
 * so serialization never fails.
 */

const bigIntReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : value.toString();
  }
  return value;
};

/**
 * Recursively convert BigInt values in an object to safe JSON values.
 *
 * Walks through nested objects, arrays, and primitive values, converting
 * any BigInt to a Number (if within safe integer range) or String (for
 * values outside Number.MAX_SAFE_INTEGER).
 *
 * Use this on DuckDB query results before they flow into JSON.stringify,
 * res.json(), or any serialization path. Safe to call on non-BigInt data
 * (no-op for values without BigInt).
 *
 * @param value - Any value potentially containing BigInt
 * @returns Deep copy with BigInts converted to Number or String
 */
export function deepConvertBigInts<T>(value: T): T {
  if (typeof value === "bigint") {
    const num = Number(value);
    return (Number.isSafeInteger(num) ? num : value.toString()) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(deepConvertBigInts) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepConvertBigInts(v);
    }
    return result as unknown as T;
  }
  return value;
}

/**
 * JSON.stringify with BigInt safety.
 * Use everywhere that serializes data that may originate from DuckDB queries.
 */
export function safeJsonStringify(
  value: unknown,
  space?: string | number,
): string {
  return JSON.stringify(value, bigIntReplacer, space);
}

/**
 * Normalize an attributes object before it is persisted (DOGFOOD-010).
 *
 * JS objects cannot hold duplicate keys — JSON.parse collapses them — so the
 * in-process write paths physically cannot produce the duplicate-key rows
 * that crash DuckDB's MAP conversion. What they CAN do is carry non-JSON
 * values (undefined, NaN, BigInt, Dates, class instances) into the JSONL.
 * A JSON round-trip canonicalizes the object so the row written to disk is
 * exactly what the reader will parse back, and any exotic value is coerced
 * to plain JSON (undefined/function keys dropped, NaN → null, Date → string)
 * instead of being serialized in a shape DuckDB's JSON reader must guess at.
 *
 * @param attributes - Validated attributes object (zod guarantees a record)
 * @returns Canonical plain-object copy; non-objects coerce to {}
 */
export function normalizeAttributes(
  attributes: unknown,
): Record<string, unknown> {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return {};
  }
  try {
    const canonical = JSON.parse(JSON.stringify(attributes));
    if (canonical && typeof canonical === "object" && !Array.isArray(canonical)) {
      return canonical as Record<string, unknown>;
    }
    return {};
  } catch {
    // Circular references or otherwise non-serializable — persist nothing
    // rather than writing a row that cannot be represented in JSONL.
    return {};
  }
}
