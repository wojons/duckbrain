/**
 * Data Validators
 *
 * Runtime type validation for API responses.
 * Prevents malformed data from breaking the UI.
 */

import {
  MemoryResponse,
  KeyNode,
  NamespaceResponse,
  MemoryListResponse,
  KeyTreeResponse,
  NamespaceListResponse,
} from '../../../../src/http/types/api'

/**
 * Validate a MemoryResponse object
 */
export function isValidMemoryResponse(data: unknown): data is MemoryResponse {
  if (!data || typeof data !== 'object') return false

  const memory = data as Record<string, unknown>

  // Required fields
  if (typeof memory.id !== 'string') return false
  if (typeof memory.key !== 'string') return false
  if (typeof memory.domain !== 'string') return false
  if (typeof memory.content !== 'string') return false
  if (typeof memory.timestamp !== 'string') return false
  if (typeof memory.author !== 'string') return false
  if (typeof memory.isTombstone !== 'boolean') return false
  if (typeof memory.action !== 'string') return false

  // Attributes must be an object
  if (memory.attributes !== undefined && typeof memory.attributes !== 'object') {
    return false
  }

  return true
}

/**
 * Validate a KeyNode object
 */
export function isValidKeyNode(data: unknown): data is KeyNode {
  if (!data || typeof data !== 'object') return false

  const node = data as Record<string, unknown>

  // Required fields
  if (typeof node.id !== 'string') return false
  if (typeof node.name !== 'string') return false
  if (typeof node.path !== 'string') return false
  if (typeof node.type !== 'string') return false
  if (!['folder', 'memory'].includes(node.type as string)) return false

  // Optional fields validation
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) return false
    // Recursively validate children (limit depth to prevent stack overflow)
    // Only validate first level here
  }

  if (node.memoryCount !== undefined && typeof node.memoryCount !== 'number') {
    return false
  }

  return true
}

/**
 * Validate a NamespaceResponse object
 */
export function isValidNamespaceResponse(data: unknown): data is NamespaceResponse {
  if (!data || typeof data !== 'object') return false

  const ns = data as Record<string, unknown>

  // Required fields
  if (typeof ns.name !== 'string') return false
  if (typeof ns.path !== 'string') return false
  if (typeof ns.isDefault !== 'boolean') return false

  // Optional fields
  if (ns.memoryCount !== undefined && typeof ns.memoryCount !== 'number') {
    return false
  }

  return true
}

/**
 * Validate a MemoryListResponse object
 */
export function isValidMemoryListResponse(data: unknown): data is MemoryListResponse {
  if (!data || typeof data !== 'object') return false

  const response = data as Record<string, unknown>

  // Required fields
  if (!Array.isArray(response.items)) return false
  if (typeof response.total !== 'number') return false
  if (typeof response.offset !== 'number') return false
  if (typeof response.limit !== 'number') return false
  if (typeof response.hasMore !== 'boolean') return false

  // Validate each item
  for (const item of response.items) {
    if (!isValidMemoryResponse(item)) return false
  }

  // Validate prefixes if present
  if (response.prefixes !== undefined) {
    if (typeof response.prefixes !== 'object') return false
  }

  return true
}

/**
 * Validate a KeyTreeResponse object
 */
export function isValidKeyTreeResponse(data: unknown): data is KeyTreeResponse {
  if (!data || typeof data !== 'object') return false

  const response = data as Record<string, unknown>

  // Required fields
  if (!Array.isArray(response.tree)) return false
  if (typeof response.total !== 'number') return false

  // Validate each tree node
  for (const node of response.tree) {
    if (!isValidKeyNode(node)) return false
  }

  return true
}

/**
 * Validate a NamespaceListResponse object
 */
export function isValidNamespaceListResponse(data: unknown): data is NamespaceListResponse {
  if (!data || typeof data !== 'object') return false

  const response = data as Record<string, unknown>

  // Required fields
  if (!Array.isArray(response.namespaces)) return false
  if (typeof response.currentNamespace !== 'string') return false

  // Validate each namespace
  for (const ns of response.namespaces) {
    if (!isValidNamespaceResponse(ns)) return false
  }

  return true
}

/**
 * Validation result with error details
 */
export interface ValidationResult<T> {
  valid: boolean
  data?: T
  error?: string
}

/**
 * Validate data with detailed error message
 */
export function validateMemoryResponse(data: unknown): ValidationResult<MemoryResponse> {
  if (isValidMemoryResponse(data)) {
    return { valid: true, data }
  }
  return {
    valid: false,
    error: 'Invalid MemoryResponse: missing or invalid required fields',
  }
}

/**
 * Validate data with detailed error message
 */
export function validateMemoryListResponse(data: unknown): ValidationResult<MemoryListResponse> {
  if (isValidMemoryListResponse(data)) {
    return { valid: true, data }
  }
  return {
    valid: false,
    error: 'Invalid MemoryListResponse: malformed response from server',
  }
}

/**
 * Validate data with detailed error message
 */
export function validateKeyTreeResponse(data: unknown): ValidationResult<KeyTreeResponse> {
  if (isValidKeyTreeResponse(data)) {
    return { valid: true, data }
  }
  return {
    valid: false,
    error: 'Invalid KeyTreeResponse: malformed tree structure from server',
  }
}

/**
 * Validate data with detailed error message
 */
export function validateNamespaceListResponse(data: unknown): ValidationResult<NamespaceListResponse> {
  if (isValidNamespaceListResponse(data)) {
    return { valid: true, data }
  }
  return {
    valid: false,
    error: 'Invalid NamespaceListResponse: malformed namespaces list from server',
  }
}

/**
 * Safe array validator - validates an array of items
 */
export function validateArray<T>(
  data: unknown,
  itemValidator: (item: unknown) => item is T
): ValidationResult<T[]> {
  if (!Array.isArray(data)) {
    return { valid: false, error: 'Expected array' }
  }

  const validItems: T[] = []
  const errors: string[] = []

  for (let i = 0; i < data.length; i++) {
    if (itemValidator(data[i])) {
      validItems.push(data[i])
    } else {
      errors.push(`Item at index ${i} is invalid`)
    }
  }

  // If we have any valid items, return them with warnings
  if (validItems.length > 0) {
    return {
      valid: true,
      data: validItems,
      error: errors.length > 0 ? errors.join('; ') : undefined,
    }
  }

  return {
    valid: false,
    error: errors.length > 0 ? errors.join('; ') : 'All items invalid',
  }
}
