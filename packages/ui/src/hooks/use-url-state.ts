/**
 * URL State Sync Hook
 *
 * Synchronizes UI state with URL search params for shareable links.
 * Bidirectional sync: URL → Store on mount, Store → URL on change.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router'
import { useUIStore } from '../stores/ui-store'

interface UrlStateOptions {
  debounceMs?: number
}

/**
 * Hook to sync UI state with URL params
 * 
 * @param options - Configuration options
 * @returns Object with current URL state
 * 
 * Syncs:
 * - search → searchQuery in store
 * - memory → selectedMemory in store
 */
export function useUrlState(options: UrlStateOptions = {}) {
  const { debounceMs = 300 } = options
  const [searchParams, setSearchParams] = useSearchParams()
  const hasInitialized = useRef(false)

  // Store selectors
  const searchQuery = useUIStore((state) => state.searchQuery)
  const setSearchQuery = useUIStore((state) => state.setSearchQuery)
  const selectedMemory = useUIStore((state) => state.selectedMemory)
  const setSelectedMemory = useUIStore((state) => state.setSelectedMemory)

  // Sync FROM URL to Store on mount (only once)
  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true

    const search = searchParams.get('search')
    const memory = searchParams.get('memory')

    if (search !== null && search !== searchQuery) {
      setSearchQuery(search)
    }

    if (memory !== null && memory !== selectedMemory) {
      setSelectedMemory(memory)
    }
  }, [searchParams, setSearchQuery, setSelectedMemory, searchQuery, selectedMemory])

  // Sync FROM Store to URL (debounced)
  useEffect(() => {
    const timeout = setTimeout(() => {
      const newParams = new URLSearchParams(searchParams)

      // Update search param
      if (searchQuery) {
        newParams.set('search', searchQuery)
      } else {
        newParams.delete('search')
      }

      // Update memory param
      if (selectedMemory) {
        newParams.set('memory', selectedMemory)
      } else {
        newParams.delete('memory')
      }

      // Only update if params changed
      const currentParams = searchParams.toString()
      const newParamsString = newParams.toString()

      if (currentParams !== newParamsString) {
        setSearchParams(newParams, { replace: true })
      }
    }, debounceMs)

    return () => clearTimeout(timeout)
  }, [searchQuery, selectedMemory, searchParams, setSearchParams, debounceMs])

  // Helper to clear all URL params
  const clearUrlState = useCallback(() => {
    setSearchParams(new URLSearchParams(), { replace: true })
    setSearchQuery('')
    setSelectedMemory(null)
  }, [setSearchParams, setSearchQuery, setSelectedMemory])

  // Helper to update just the search
  const setUrlSearch = useCallback((query: string) => {
    setSearchQuery(query)
  }, [setSearchQuery])

  // Helper to update just the selected memory
  const setUrlMemory = useCallback((memoryId: string | null) => {
    setSelectedMemory(memoryId)
  }, [setSelectedMemory])

  return {
    searchQuery,
    selectedMemory,
    clearUrlState,
    setUrlSearch,
    setUrlMemory,
    hasSearchParam: searchParams.has('search'),
    hasMemoryParam: searchParams.has('memory'),
  }
}
