/**
 * Keys Hooks
 *
 * TanStack Query hooks for key tree operations.
 */

import { useQuery } from '@tanstack/react-query'
import { keysApi } from '../lib/api-client'

// Query keys
const keysKeys = {
  all: ['keys'] as const,
  tree: (prefix?: string) =>
    prefix ? ([...keysKeys.all, 'tree', prefix] as const) : [...keysKeys.all, 'tree'] as const,
  flat: (prefix?: string) =>
    prefix ? ([...keysKeys.all, 'flat', prefix] as const) : [...keysKeys.all, 'flat'] as const,
}

interface UseKeysParams {
  prefix?: string
  depth?: number
  limit?: number
  namespace?: string
}

/**
 * Hook to fetch hierarchical key tree
 */
export function useKeys(params: UseKeysParams = {}) {
  const { prefix, depth, limit, namespace } = params

  return useQuery({
    queryKey: keysKeys.tree(prefix),
    queryFn: () => keysApi.list({ prefix, depth, limit, namespace }),
    staleTime: 60 * 1000, // 1 minute - keys don't change often
    refetchOnWindowFocus: false,
  })
}

/**
 * Hook to fetch flat list of keys
 */
export function useKeysFlat(params: UseKeysParams & { offset?: number } = {}) {
  const { prefix, limit, offset, namespace } = params

  return useQuery({
    queryKey: [...keysKeys.flat(prefix), { limit, offset }],
    queryFn: () => keysApi.listFlat({ prefix, limit, offset, namespace }),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  })
}
