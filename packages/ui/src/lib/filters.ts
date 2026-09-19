/**
 * Shared memory-filter state and its mapping onto the REST query params the
 * backend list route parses (src/http/routes/memories.ts): domain, author,
 * after, before, as_of, prefix, allNamespaces.
 *
 * The header owns the controls; the memory table composes these params into
 * every memoriesApi.list request (UI-GAP-001: filters used to be header-local
 * state that never reached the wire).
 */

export interface MemoryFilters {
  domain: string;
  author: string;
  /** Preset window behind the date select; "" = all time. */
  dateRange: "" | "24h" | "7d" | "30d";
  /** Explicit temporal bounds — win over dateRange when set. */
  after: string;
  before: string;
  /** Point-in-time selector, sent as ?as_of= */
  asOf: string;
  /** Key-path prefix filter, sent as ?prefix= */
  prefix: string;
  /** RETR-007: search every manifest namespace in one request. */
  allNamespaces: boolean;
}

export const DEFAULT_FILTERS: MemoryFilters = {
  domain: "",
  author: "",
  dateRange: "",
  after: "",
  before: "",
  asOf: "",
  prefix: "",
  allNamespaces: false,
};

const RANGE_MS: Record<Exclude<MemoryFilters["dateRange"], "">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** The list-request subset the filter UI controls (no pagination/search). */
export interface MemoryListFilters {
  domain?: string;
  author?: string;
  prefix?: string;
  after?: string;
  before?: string;
  asOf?: string;
  allNamespaces?: boolean;
}

function rangeToAfter(range: MemoryFilters["dateRange"]): string {
  if (!range) return "";
  return new Date(Date.now() - RANGE_MS[range]).toISOString();
}

/**
 * Map the shared filter state onto memoriesApi.list params. Empty filters are
 * omitted so no blank params ride the wire and the react-query cache key
 * changes only when a filter actually has a value.
 */
export function filtersToQueryParams(
  filters: MemoryFilters,
): MemoryListFilters {
  const params: MemoryListFilters = {};
  if (filters.domain) params.domain = filters.domain;
  if (filters.author) params.author = filters.author;
  if (filters.prefix) params.prefix = filters.prefix;
  const after = filters.after || rangeToAfter(filters.dateRange);
  if (after) params.after = after;
  if (filters.before) params.before = filters.before;
  if (filters.asOf) params.asOf = filters.asOf;
  if (filters.allNamespaces) params.allNamespaces = true;
  return params;
}
