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
