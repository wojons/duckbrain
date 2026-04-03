/**
 * HTTP API Client
 *
 * Typed API client for DuckBrain backend.
 * Wraps fetch calls with error handling and TypeScript types.
 */

import {
  MemoryResponse,
  MemoryListResponse,
  KeyTreeResponse,
  NamespaceListResponse,
  NamespaceResponse,
  CreateMemoryRequest,
  UpdateMemoryRequest,
} from '../../../../src/http/types/api'
import {
  validateMemoryListResponse,
  validateKeyTreeResponse,
  validateNamespaceListResponse,
  validateMemoryResponse,
} from './validators'
import {
  logApiRequest,
  logApiResponse,
  debugLog,
} from './api-health'

const API_BASE = '/api'

// Validation flag - can be disabled in production for performance
const ENABLE_VALIDATION = import.meta.env?.VITE_VALIDATE_API !== 'false'

/**
 * Base fetch wrapper with error handling and validation
 */
async function apiFetch<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE}${endpoint}`
  const startTime = performance.now()

  // Log request in dev mode
  logApiRequest(options?.method || 'GET', endpoint, options?.body)

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }))
    debugLog('ERROR', `${endpoint} failed: ${error.error || `HTTP ${response.status}`}`)
    throw new Error(error.error || `HTTP ${response.status}`)
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T
  }

  const data = await response.json()
  const duration = Math.round(performance.now() - startTime)

  // Log response in dev mode
  logApiResponse(endpoint, data, duration)

  // Validate response shape if enabled
  if (ENABLE_VALIDATION) {
    validateResponse(endpoint, data)
  }

  return data
}

/**
 * Validate response based on endpoint
 */
function validateResponse(endpoint: string, data: unknown): void {
  if (endpoint.includes('/memories') && !endpoint.includes('/versions')) {
    if (endpoint.match(/\/memories\/[^\/]+$/)) {
      // Single memory
      const result = validateMemoryResponse(data)
      if (!result.valid) {
        console.warn(`[API Validation] ${endpoint}: ${result.error}`)
      }
    } else {
      // Memory list
      const result = validateMemoryListResponse(data)
      if (!result.valid) {
        console.warn(`[API Validation] ${endpoint}: ${result.error}`)
      }
    }
  } else if (endpoint.includes('/keys')) {
    const result = validateKeyTreeResponse(data)
    if (!result.valid) {
      console.warn(`[API Validation] ${endpoint}: ${result.error}`)
    }
  } else if (endpoint.includes('/namespaces')) {
    const result = validateNamespaceListResponse(data)
    if (!result.valid) {
      console.warn(`[API Validation] ${endpoint}: ${result.error}`)
    }
  }
}

/**
 * Query params builder
 */
function buildQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.append(key, String(value))
    }
  })
  const queryString = query.toString()
  return queryString ? `?${queryString}` : ''
}

/**
 * Memories API
 */
export const memoriesApi = {
  /**
   * List memories with optional filters
   */
  list: (params?: {
    prefix?: string
    limit?: number
    offset?: number
    domain?: string
    author?: string
    query?: string
    namespace?: string
  }): Promise<MemoryListResponse> => {
    return apiFetch<MemoryListResponse>(`/memories${buildQuery(params || {})}`)
  },

  /**
   * Get a single memory by ID
   */
  get: (id: string, namespace?: string): Promise<MemoryResponse> => {
    return apiFetch<MemoryResponse>(`/memories/${id}${buildQuery({ namespace })}`)
  },

  /**
   * Get a single memory by key path (used by Tree view)
   * Key should NOT have leading slash
   */
  getByKey: (key: string, namespace?: string): Promise<MemoryResponse> => {
    const cleanKey = key.startsWith('/') ? key.slice(1) : key
    return apiFetch<MemoryResponse>(`/memories/key/${encodeURIComponent(cleanKey)}${buildQuery({ namespace })}`)
  },

  /**
   * Create a new memory
   */
  create: (
    data: CreateMemoryRequest,
    namespace?: string
  ): Promise<MemoryResponse> => {
    return apiFetch<MemoryResponse>(`/memories${buildQuery({ namespace })}`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  },

  /**
   * Update an existing memory (forget + remember = new version)
   */
  update: (
    id: string,
    data: UpdateMemoryRequest,
    namespace?: string
  ): Promise<MemoryResponse> => {
    return apiFetch<MemoryResponse>(`/memories/${id}${buildQuery({ namespace })}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  },

  /**
   * Delete a memory (create tombstone)
   */
  delete: (id: string, namespace?: string): Promise<void> => {
    return apiFetch<void>(`/memories/${id}${buildQuery({ namespace })}`, {
      method: 'DELETE',
    })
  },

  /**
   * Get versions of a memory
   */
  getVersions: (id: string, namespace?: string): Promise<MemoryResponse[]> => {
    return apiFetch<MemoryResponse[]>(`/memories/${id}/versions${buildQuery({ namespace })}`)
  },
}

/**
 * Keys API
 */
export const keysApi = {
  /**
   * Get hierarchical key tree
   */
  list: (params?: {
    prefix?: string
    depth?: number
    limit?: number
    namespace?: string
  }): Promise<KeyTreeResponse> => {
    return apiFetch<KeyTreeResponse>(`/keys${buildQuery(params || {})}`)
  },

  /**
   * Get flat list of keys
   */
  listFlat: (params?: {
    prefix?: string
    limit?: number
    offset?: number
    namespace?: string
  }): Promise<{
    keys: string[]
    total: number
    hasMore: boolean
    nextOffset: number | null
    prefixes: string[]
  }> => {
    return apiFetch(`/keys/flat${buildQuery(params || {})}`)
  },
}

/**
 * Namespaces API
 */
export const namespacesApi = {
  /**
   * List all namespaces
   */
  list: (): Promise<NamespaceListResponse> => {
    return apiFetch<NamespaceListResponse>('/namespaces')
  },

  /**
   * Create a new namespace
   */
  create: (name: string, setDefault?: boolean): Promise<NamespaceResponse> => {
    return apiFetch<NamespaceResponse>('/namespaces', {
      method: 'POST',
      body: JSON.stringify({ name, setDefault }),
    })
  },

  /**
   * Switch to a namespace
   */
  switch: (name: string): Promise<{ success: boolean; namespace: string }> => {
    return apiFetch('/namespaces/switch', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },
}

/**
 * SSE Events API
 */
export const eventsApi = {
  /**
   * Create EventSource for real-time updates
   */
  connect: (namespace: string): EventSource => {
    return new EventSource(`${API_BASE}/events/${encodeURIComponent(namespace)}`)
  },
}
