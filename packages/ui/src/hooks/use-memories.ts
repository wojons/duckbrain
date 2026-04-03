/**
 * Memories Hooks
 *
 * TanStack Query hooks for memory CRUD operations.
 * Provides caching, automatic refetching, and mutations.
 */

import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import { memoriesApi } from '../lib/api-client'
import {
  CreateMemoryRequest,
  UpdateMemoryRequest,
} from '../../../../src/http/types/api'

// Query keys for cache invalidation
const memoriesKeys = {
  all: ['memories'] as const,
  lists: () => [...memoriesKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) =>
    [...memoriesKeys.lists(), filters] as const,
  details: () => [...memoriesKeys.all, 'detail'] as const,
  detail: (id: string) => [...memoriesKeys.details(), 'by-id-v2', id] as const,  // Changed key to break old cache
}

// Query keys for key-based lookups
const memoryByKeyKeys = {
  all: ['memory-by-key'] as const,
  detail: (key: string) => [...memoryByKeyKeys.all, 'by-key', key] as const,
}

interface UseMemoriesParams {
  prefix?: string
  limit?: number
  offset?: number
  domain?: string
  author?: string
  query?: string
  namespace?: string
}

/**
 * Hook to fetch memories list with caching
 */
export function useMemories(params: UseMemoriesParams = {}) {
  const { prefix, limit, offset, domain, author, query, namespace } = params

  return useQuery({
    queryKey: memoriesKeys.list({
      prefix,
      limit,
      offset,
      domain,
      author,
      query,
      namespace,
    }),
    queryFn: () =>
      memoriesApi.list({
        prefix,
        limit,
        offset,
        domain,
        author,
        query,
        namespace,
      }),
    staleTime: 30 * 1000, // 30 seconds
    refetchOnWindowFocus: false,
  })
}

/**
 * Check if a string looks like a UUID
 */
function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

/**
 * Hook to fetch a single memory by ID (UUID only)
 */
export function useMemory(id: string, namespace?: string) {
  return useQuery({
    queryKey: memoriesKeys.detail(id),
    queryFn: () => memoriesApi.get(id, namespace),
    enabled: !!id && isUUID(id), // Only run if ID looks like a UUID
    staleTime: 60 * 1000, // 1 minute
  })
}

/**
 * Hook to fetch a single memory by key path (used by Tree)
 * Key path example: /test/batch-1
 */
export function useMemoryByKey(key: string, namespace?: string) {
  return useQuery({
    queryKey: memoryByKeyKeys.detail(key),
    queryFn: () => memoriesApi.getByKey(key, namespace),
    enabled: !!key && key.startsWith('/'), // Only run if key looks like a path
    staleTime: 60 * 1000, // 1 minute
  })
}

/**
 * Hook to create a new memory
 */
export function useCreateMemory(namespace?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: CreateMemoryRequest) =>
      memoriesApi.create(data, namespace),
    onSuccess: () => {
      // Invalidate memories list to refetch
      queryClient.invalidateQueries({ queryKey: memoriesKeys.lists() })
      // Also invalidate keys since a new key may have been added
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
}

/**
 * Hook to update an existing memory
 */
export function useUpdateMemory(namespace?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemoryRequest }) =>
      memoriesApi.update(id, data, namespace),
    onSuccess: (result) => {
      // Invalidate the specific memory
      queryClient.invalidateQueries({
        queryKey: memoriesKeys.detail(result.id),
      })
      // Invalidate memories list
      queryClient.invalidateQueries({ queryKey: memoriesKeys.lists() })
    },
  })
}

/**
 * Hook to delete (forget) a memory
 */
export function useForgetMemory(namespace?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => memoriesApi.delete(id, namespace),
    onSuccess: () => {
      // Invalidate all memory queries
      queryClient.invalidateQueries({ queryKey: memoriesKeys.all })
      // Invalidate keys since a memory was removed
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })
}

/**
 * Hook to fetch memory versions
 */
export function useMemoryVersions(id: string, namespace?: string) {
  return useQuery({
    queryKey: [...memoriesKeys.detail(id), 'versions'],
    queryFn: () => memoriesApi.getVersions(id, namespace),
    enabled: !!id,
  })
}
