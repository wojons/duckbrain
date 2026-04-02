/**
 * Namespaces Hooks
 *
 * TanStack Query hooks for namespace operations.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { namespacesApi } from '../lib/api-client'
import { useUIStore } from '../stores/ui-store'

// Query keys
const namespaceKeys = {
  all: ['namespaces'] as const,
  list: () => [...namespaceKeys.all, 'list'] as const,
  current: () => [...namespaceKeys.all, 'current'] as const,
}

/**
 * Hook to fetch all namespaces
 */
export function useNamespaces() {
  return useQuery({
    queryKey: namespaceKeys.list(),
    queryFn: () => namespacesApi.list(),
    staleTime: 5 * 60 * 1000, // 5 minutes
  })
}

/**
 * Hook to get current namespace from Zustand store
 */
export function useCurrentNamespace() {
  return useUIStore((state) => state.currentNamespace)
}

/**
 * Hook to switch namespace
 */
export function useSwitchNamespace() {
  const queryClient = useQueryClient()
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace)

  return useMutation({
    mutationFn: (name: string) => namespacesApi.switch(name),
    onSuccess: (result) => {
      // Update Zustand store
      setCurrentNamespace(result.namespace)
      // Invalidate all queries since namespace changed
      queryClient.invalidateQueries()
    },
  })
}

/**
 * Hook to create a new namespace
 */
export function useCreateNamespace() {
  const queryClient = useQueryClient()
  const setCurrentNamespace = useUIStore((state) => state.setCurrentNamespace)

  return useMutation({
    mutationFn: ({ name, setDefault }: { name: string; setDefault?: boolean }) =>
      namespacesApi.create(name, setDefault),
    onSuccess: (result, variables) => {
      // Invalidate namespaces list
      queryClient.invalidateQueries({ queryKey: namespaceKeys.list() })
      // If set as default, update current namespace
      if (variables.setDefault) {
        setCurrentNamespace(result.name)
      }
    },
  })
}
