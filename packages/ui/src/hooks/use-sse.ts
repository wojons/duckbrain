import { useEffect, useRef, useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useUIStore } from '../stores/ui-store'

interface UseSSEOptions {
  namespace: string
  onMessage?: (event: MessageEvent) => void
  enabled?: boolean
}

interface UseSSEReturn {
  isPaused: boolean
  pause: () => void
  resume: () => void
  isConnected: boolean
}

/**
 * SSE Hook
 *
 * Manages EventSource connection for real-time updates.
 * Integrates with TanStack Query for cache invalidation.
 */
export function useSSE({ namespace, onMessage, enabled = true }: UseSSEOptions): UseSSEReturn {
  const queryClient = useQueryClient()
  const realtimeEnabled = useUIStore((state) => state.realtimeEnabled)
  const [isPaused, setIsPaused] = useState(!enabled || !realtimeEnabled)
  const [isConnected, setIsConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttempts = useRef(0)
  const maxReconnectAttempts = 5

  const connect = useCallback(() => {
    if (isPaused || eventSourceRef.current) return

    try {
      const eventSource = new EventSource(`/api/events/${encodeURIComponent(namespace)}`)
      eventSourceRef.current = eventSource

      eventSource.onopen = () => {
        setIsConnected(true)
        reconnectAttempts.current = 0
      }

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          // Invalidate queries based on event type
          switch (data.type) {
            case 'memory.created':
            case 'memory.updated':
            case 'memory.deleted':
              queryClient.invalidateQueries({ queryKey: ['memories'] })
              queryClient.invalidateQueries({ queryKey: ['keys'] })
              break
            case 'namespace.changed':
              queryClient.invalidateQueries()
              break
          }

          // Call custom handler if provided
          onMessage?.(event)
        } catch (err) {
          console.error('Failed to parse SSE message:', err)
        }
      }

      eventSource.onerror = () => {
        setIsConnected(false)
        eventSource.close()
        eventSourceRef.current = null

        // Exponential backoff reconnection
        if (reconnectAttempts.current < maxReconnectAttempts && !isPaused) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000)
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++
            connect()
          }, delay)
        }
      }
    } catch (err) {
      console.error('Failed to connect to SSE:', err)
    }
  }, [namespace, isPaused, onMessage, queryClient])

  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    setIsConnected(false)
  }, [])

  const pause = useCallback(() => {
    setIsPaused(true)
    disconnect()
  }, [disconnect])

  const resume = useCallback(() => {
    setIsPaused(false)
    reconnectAttempts.current = 0
    connect()
  }, [connect])

  // Connect when enabled and not paused
  useEffect(() => {
    if (enabled && !isPaused) {
      connect()
    } else {
      disconnect()
    }

    return () => {
      disconnect()
    }
  }, [enabled, isPaused, connect, disconnect])

  // Sync with global realtime state
  useEffect(() => {
    if (realtimeEnabled && isPaused) {
      resume()
    } else if (!realtimeEnabled && !isPaused) {
      pause()
    }
  }, [realtimeEnabled, isPaused, pause, resume])

  return {
    isPaused,
    pause,
    resume,
    isConnected,
  }
}
