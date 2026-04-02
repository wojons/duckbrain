import { Search, Pause, Play, RefreshCw, LayoutGrid, List } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'

interface HeaderProps {
  view?: 'tree' | 'timeline'
  onViewChange?: (view: 'tree' | 'timeline') => void
}

/**
 * Header Component
 *
 * Top header with omnibar search, real-time controls, and view toggle.
 */
export function Header({ view = 'timeline', onViewChange }: HeaderProps) {
  const searchQuery = useUIStore((state) => state.searchQuery)
  const setSearchQuery = useUIStore((state) => state.setSearchQuery)
  const realtimeEnabled = useUIStore((state) => state.realtimeEnabled)
  const setRealtimeEnabled = useUIStore((state) => state.setRealtimeEnabled)

  return (
    <header className="glass-panel border-b px-4 py-3" style={{ borderColor: 'var(--color-glass-border)' }}>
      <div className="flex items-center justify-between gap-4">
        {/* Search Omnibar */}
        <div className="flex-1 max-w-2xl">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
              style={{ color: 'var(--color-clinical)' }}
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search memories..."
              className="w-full glass-input pl-10 pr-4 py-2 rounded-full text-sm"
            />
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          {/* Real-time Toggle */}
          <button
            onClick={() => setRealtimeEnabled(!realtimeEnabled)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              realtimeEnabled ? 'status-dot-active' : ''
            }`}
            style={{
              backgroundColor: realtimeEnabled
                ? 'rgba(0, 255, 102, 0.1)'
                : 'var(--color-glass)',
              color: realtimeEnabled
                ? 'var(--color-success)'
                : 'var(--color-clinical)',
              border: `1px solid ${realtimeEnabled ? 'rgba(0, 255, 102, 0.3)' : 'var(--color-glass-border)'}`,
            }}
          >
            {realtimeEnabled ? (
              <>
                <Pause className="w-3.5 h-3.5" />
                <span>Live</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5" />
                <span>Paused</span>
              </>
            )}
          </button>

          {/* Refresh Button */}
          <button
            className="p-2 glass-button rounded-lg"
            title="Refresh data"
          >
            <RefreshCw className="w-4 h-4" style={{ color: 'var(--color-clinical)' }} />
          </button>

          {/* View Toggle */}
          <div className="flex items-center glass-panel rounded-lg p-1">
            <button
              onClick={() => onViewChange?.('tree')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-all ${
                view === 'tree'
                  ? 'bg-white/10 text-white'
                  : 'text-[var(--color-clinical)] hover:text-white'
              }`}
            >
              <LayoutGrid className="w-4 h-4" />
              <span className="hidden sm:inline">Tree</span>
            </button>
            <button
              onClick={() => onViewChange?.('timeline')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-all ${
                view === 'timeline'
                  ? 'bg-white/10 text-white'
                  : 'text-[var(--color-clinical)] hover:text-white'
              }`}
            >
              <List className="w-4 h-4" />
              <span className="hidden sm:inline">Timeline</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
