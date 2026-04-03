import { useQueries } from '@tanstack/react-query'
import { memoriesApi, keysApi } from '../lib/api-client'

export interface VitalsData {
  activeMemories: number
  gitQueueSize: number
  tombstoneRatio: number
  queryRate: number
}

// Query keys for vitals
const vitalsKeys = {
  all: ['vitals'] as const,
  list: (namespace?: string) => [...vitalsKeys.all, 'list', namespace] as const,
}

/**
 * Hook to fetch dashboard vitals
 *
 * Provides real-time statistics for the dashboard vital cards.
 * Uses parallel API calls for efficiency.
 */
export function useVitals(namespace?: string) {
  const results = useQueries({
    queries: [
      // Query 1: Get memory count (active memories)
      {
        queryKey: [...memoriesKeys.lists(), { namespace, limit: 1 }],
        queryFn: () => memoriesApi.list({ namespace, limit: 1 }),
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
      },
      // Query 2: Get sample memories for tombstone ratio calculation
      {
        queryKey: [...memoriesKeys.lists(), { namespace, limit: 100 }],
        queryFn: () => memoriesApi.list({ namespace, limit: 100 }),
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
      },
      // Query 3: Get key count
      {
        queryKey: [...keysKeys.lists(), { namespace }],
        queryFn: () => keysApi.list({ namespace }),
        staleTime: 30 * 1000,
        refetchOnWindowFocus: false,
      },
    ],
  })

  const [memoriesResult, sampleResult, keysResult] = results

  // Calculate loading state
  const isLoading = memoriesResult.isLoading || sampleResult.isLoading || keysResult.isLoading

  // Calculate error state
  const error = memoriesResult.error || sampleResult.error || keysResult.error

  // Calculate vitals data
  let data: VitalsData | undefined

  if (memoriesResult.data && keysResult.data) {
    // Calculate tombstone ratio from sample
    const sampleMemories = sampleResult.data?.items || []
    const totalSample = sampleMemories.length
    const tombstones = sampleMemories.filter((m) => m.isTombstone).length
    const ratio = totalSample > 0 ? (tombstones / totalSample) * 100 : 0

    data = {
      activeMemories: memoriesResult.data.total,
      gitQueueSize: 0, // Placeholder - no git queue API exposed yet
      tombstoneRatio: ratio,
      queryRate: keysResult.data.total,
    }
  }

  return { data, isLoading, error }
}

// Import query keys from use-memories
const memoriesKeys = {
  all: ['memories'] as const,
  lists: () => [...memoriesKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) =>
    [...memoriesKeys.lists(), filters] as const,
}

// Query keys for keys
const keysKeys = {
  all: ['keys'] as const,
  lists: () => [...keysKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) =>
    [...keysKeys.lists(), filters] as const,
}
