/**
 * Offline Banner Component
 *
 * Fixed position banner shown when connection is lost.
 * Glassmorphism styling with amber/yellow accent.
 */

import { WifiOff, RefreshCw } from 'lucide-react'
import { useOnlineStatus } from '../../hooks/use-online-status'

/**
 * Offline Banner
 *
 * Shows when navigator.onLine is false.
 * Includes retry button to check connection.
 * Fixed at top of viewport.
 */
export function OfflineBanner() {
  const { isOnline } = useOnlineStatus()

  if (isOnline) return null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[200] px-4 py-3"
      style={{
        backgroundColor: 'rgba(251, 191, 36, 0.1)',
        borderBottom: '1px solid rgba(251, 191, 36, 0.3)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(251, 191, 36, 0.2)' }}
          >
            <WifiOff className="w-4 h-4" style={{ color: 'var(--color-amber)' }} />
          </div>
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--color-amber)' }}>
              You are offline
            </p>
            <p className="text-xs" style={{ color: 'var(--color-clinical)', opacity: 0.8 }}>
              Changes will sync when you reconnect.
            </p>
          </div>
        </div>

        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-2 px-3 py-1.5 rounded text-sm
                     hover:bg-white/10 transition-colors"
          style={{ color: 'var(--color-amber)' }}
        >
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    </div>
  )
}

/**
 * Online indicator dot
 * Shows small dot that changes color based on online status
 */
export function OnlineIndicator() {
  const { isOnline } = useOnlineStatus()

  return (
    <div
      className="w-2.5 h-2.5 rounded-full"
      style={{
        backgroundColor: isOnline ? 'var(--color-success)' : 'var(--color-amber)',
        boxShadow: isOnline
          ? '0 0 8px rgba(0, 255, 102, 0.6)'
          : '0 0 8px rgba(251, 191, 36, 0.6)',
        transition: 'all 0.3s ease',
      }}
      title={isOnline ? 'Online' : 'Offline'}
    />
  )
}
