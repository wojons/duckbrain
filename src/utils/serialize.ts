/**
 * Safe JSON serialization that handles BigInt values from DuckDB.
 *
 * DuckDB returns BigInt values for large integers. Native JSON.stringify
 * throws "TypeError: Do not know how to serialize a BigInt".
 * This replacer converts BigInt to string so serialization never fails.
 */

const bigIntReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return value;
};

/**
 * JSON.stringify with BigInt safety.
 * Use everywhere that serializes data that may originate from DuckDB queries.
 */
export function safeJsonStringify(
  value: unknown,
  space?: string | number
): string {
  return JSON.stringify(value, bigIntReplacer, space);
}
