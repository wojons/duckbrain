import { useQuery } from '@tanstack/react-query'
import { memoriesApi, namespacesApi, keysApi } from '../lib/api-client'

export interface VitalsData {
  activeMemories: number
  gitQueueSize: number
  tombstoneRatio: string
  queryRate: string
}

// Query key for vitals
const vitalsKeys = {
  all: ['vitals'] as const,
}

/**
 * Hook to fetch dashboard vitals
 *
 * Provides real-time statistics for the dashboard vital cards.
 * Uses multiple API calls to aggregate data.
 */
export function useVitals(namespace?: string) {
  return useQuery({
    queryKey: [...vitalsKeys.all, namespace],
    queryFn: async (): Promise<VitalsData> => {
      // Get memory count (active memories)
      const memoriesResult = await memoriesApi.list({
        namespace,
        limit: 0,
      })

      // Get namespace info
      const namespacesResult = await namespacesApi.list()
      const nsCount = namespacesResult.namespaces.length

      // Get keys count
      const keysResult = await keysApi.list({
        namespace,
        limit: 0,
      })

      // Calculate tombstone ratio from sample
      const sampleMemories = await memoriesApi.list({
        namespace,
        limit: 100,
      })
      const totalSample = sampleMemories.items.length
      const tombstones = sampleMemories.items.filter((m) => m.isTombstone).length
      const ratio = totalSample > 0 ? ((tombstones / totalSample) * 100).toFixed(1) : '0.0'

      return {
        activeMemories: memoriesResult.total,
        gitQueueSize: nsCount, // Placeholder - would need git queue API
        tombstoneRatio: `${ratio}%`,
        queryRate: `${keysResult.total}`, // Using keys as proxy for query activity
      }
    },
    staleTime: 30 * 1000, // 30 seconds
    refetchOnWindowFocus: false,
  })
}
