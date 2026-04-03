/**
 * API Health Check
 *
 * Utilities for checking API health and debugging data flow issues.
 * Provides runtime diagnostics for production debugging.
 */

import { memoriesApi, namespacesApi, keysApi } from './api-client'

export interface ApiHealthStatus {
  healthy: boolean
  memoryCount?: number
  namespace?: string
  namespacesCount?: number
  keysCount?: number
  latencyMs?: number
  error?: string
}

/**
 * Check API health by making test requests
 */
export async function checkApiHealth(namespace?: string): Promise<ApiHealthStatus> {
  const startTime = performance.now()

  try {
    // Test 1: List namespaces (lightweight)
    const namespacesResult = await namespacesApi.list()
    const namespacesCount = namespacesResult.namespaces.length
    const currentNs = namespace || namespacesResult.currentNamespace

    // Test 2: Get memory count
    const memoriesResult = await memoriesApi.list({
      namespace: currentNs,
      limit: 0, // Just get count, no items
    })
    const memoryCount = memoriesResult.total

    // Test 3: Get key tree (smoke test)
    const keysResult = await keysApi.list({ namespace: currentNs, limit: 1 })
    const keysCount = keysResult.total

    const latencyMs = Math.round(performance.now() - startTime)

    return {
      healthy: true,
      memoryCount,
      namespace: currentNs,
      namespacesCount,
      keysCount,
      latencyMs,
    }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - startTime)
    return {
      healthy: false,
      error: err instanceof Error ? err.message : 'Unknown error',
      latencyMs,
    }
  }
}

/**
 * Quick health check - just checks if API is reachable
 */
export async function isApiReachable(): Promise<boolean> {
  try {
    await namespacesApi.list()
    return true
  } catch {
    return false
  }
}

/**
 * Get diagnostic information for debugging
 */
export async function getApiDiagnostics(): Promise<{
  apiReachable: boolean
  namespace?: string
  memoryCount?: number
  keysCount?: number
  lastError?: string
}> {
  const diagnostics: {
    apiReachable: boolean
    namespace?: string
    memoryCount?: number
    keysCount?: number
    lastError?: string
  } = {
    apiReachable: false,
  }

  try {
    // Check namespaces
    const nsResult = await namespacesApi.list()
    diagnostics.apiReachable = true
    diagnostics.namespace = nsResult.currentNamespace

    // Check memories
    const memResult = await memoriesApi.list({ limit: 0 })
    diagnostics.memoryCount = memResult.total

    // Check keys
    const keysResult = await keysApi.list({ limit: 0 })
    diagnostics.keysCount = keysResult.total
  } catch (err) {
    diagnostics.lastError = err instanceof Error ? err.message : 'Unknown error'
  }

  return diagnostics
}

/**
 * Debug logger controlled by environment
 */
const isDev = import.meta.env?.DEV ?? false
const debugEnabled = import.meta.env?.VITE_DEBUG_API === 'true' || isDev

export function debugLog(category: string, message: string, data?: unknown): void {
  if (!debugEnabled) return

  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [API:${category}]`

  if (data !== undefined) {
    console.log(prefix, message, data)
  } else {
    console.log(prefix, message)
  }
}

/**
 * Log API request for debugging
 */
export function logApiRequest(method: string, endpoint: string, body?: unknown): void {
  debugLog('REQUEST', `${method} ${endpoint}`, body)
}

/**
 * Log API response for debugging
 */
export function logApiResponse(endpoint: string, response: unknown, durationMs?: number): void {
  const duration = durationMs ? ` (${durationMs}ms)` : ''
  debugLog('RESPONSE', `${endpoint}${duration}`, response)
}

/**
 * Log cache operation for debugging
 */
export function logCacheOperation(operation: 'hit' | 'miss' | 'invalidate', key: string): void {
  debugLog('CACHE', `${operation.toUpperCase()}: ${key}`)
}

/**
 * Log SSE event for debugging
 */
export function logSseEvent(eventType: string, data?: unknown): void {
  debugLog('SSE', `Received: ${eventType}`, data)
}
