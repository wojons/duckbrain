/**
 * Online Status Hook
 *
 * Monitors navigator.onLine API to detect online/offline state.
 * Provides reactive state for offline banner and queue behavior.
 */

import { useState, useEffect } from 'react'

interface OnlineStatus {
  isOnline: boolean
  wasOffline: boolean
  lastChecked: Date
}

/**
 * Hook to monitor online/offline status
 * 
 * @example
 * function App() {
 *   const { isOnline } = useOnlineStatus()
 *   
 *   return (
 *     <>
 *       {!isOnline && <OfflineBanner />}
 *       <AppContent />
 *     </>
 *   )
 * }
 */
export function useOnlineStatus(): OnlineStatus {
  const [isOnline, setIsOnline] = useState(() => {
    // Safe SSR - only check on client
    if (typeof navigator !== 'undefined') {
      return navigator.onLine
    }
    return true
  })
  const [wasOffline, setWasOffline] = useState(false)
  const [lastChecked, setLastChecked] = useState(() => new Date())

  useEffect(() => {
    // Only run on client
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      setIsOnline(true)
      setWasOffline(true) // We were offline before
      setLastChecked(new Date())
    }

    const handleOffline = () => {
      setIsOnline(false)
      setLastChecked(new Date())
    }

    // Listen for browser online/offline events
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    // Initial check
    setIsOnline(navigator.onLine)
    setLastChecked(new Date())

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return {
    isOnline,
    wasOffline,
    lastChecked,
  }
}

/**
 * Hook to track if app should retry connections
 * Implements exponential backoff
 */
export function useRetryDelay(isOnline: boolean, attempt: number): number {
  const [delay, setDelay] = useState(1000)

  useEffect(() => {
    if (isOnline) {
      setDelay(1000) // Reset to 1 second when online
    } else {
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s... max 60s
      const newDelay = Math.min(1000 * Math.pow(2, attempt), 60000)
      setDelay(newDelay)
    }
  }, [isOnline, attempt])

  return delay
}
