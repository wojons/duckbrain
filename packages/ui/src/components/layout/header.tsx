import { Search, Pause, Play, RefreshCw, LayoutGrid, List, Filter, X, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { useUIStore } from '../../stores/ui-store'

interface HeaderProps {
  view?: 'tree' | 'timeline'
  onViewChange?: (view: 'tree' | 'timeline') => void
}

const DOMAINS = [
  { value: '', label: 'All Domains' },
  { value: 'config', label: 'Config' },
  { value: 'message', label: 'Message' },
  { value: 'concept', label: 'Concept' },
  { value: 'person', label: 'Person' },
  { value: 'project', label: 'Project' },
  { value: 'system', label: 'System' },
]

const DATE_RANGES = [
  { value: '', label: 'All Time' },
  { value: '24h', label: 'Last 24 Hours' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
]

/**
 * Header Component
 *
 * Top header with omnibar search, filters, real-time controls, and view toggle.
 */
export function Header({ view = 'timeline', onViewChange }: HeaderProps) {
  const searchQuery = useUIStore((state) => state.searchQuery)
  const setSearchQuery = useUIStore((state) => state.setSearchQuery)
  const realtimeEnabled = useUIStore((state) => state.realtimeEnabled)
  const setRealtimeEnabled = useUIStore((state) => state.setRealtimeEnabled)
  const [filtersOpen, setFiltersOpen] = useState(false)

  // Filter states (stored in component for now, could move to store)
  const [domainFilter, setDomainFilter] = useState('')
  const [authorFilter, setAuthorFilter] = useState('')
  const [dateFilter, setDateFilter] = useState('')

  const hasActiveFilters = domainFilter || authorFilter || dateFilter

  const clearFilters = () => {
    setDomainFilter('')
    setAuthorFilter('')
    setDateFilter('')
  }

  return (
    <header className="glass-panel border-b px-4 py-3" style={{ borderColor: 'var(--color-glass-border)' }}>
      <div className="flex flex-col gap-3">
        {/* Top Row - Search and Controls */}
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
            {/* Filter Toggle */}
            <button
              onClick={() => setFiltersOpen(!filtersOpen)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
                hasActiveFilters ? 'status-dot-active' : ''
              }`}
              style={{
                backgroundColor: hasActiveFilters
                  ? 'rgba(0, 212, 255, 0.1)'
                  : 'var(--color-glass)',
                color: hasActiveFilters
                  ? 'var(--color-azure)'
                  : 'var(--color-clinical)',
                border: `1px solid ${hasActiveFilters ? 'rgba(0, 212, 255, 0.3)' : 'var(--color-glass-border)'}`,
              }}
            >
              <Filter className="w-3.5 h-3.5" />
              <span>Filter</span>
              {hasActiveFilters && (
                <span
                  className="ml-1 px-1.5 py-0.5 text-xs rounded-full"
                  style={{
                    backgroundColor: 'var(--color-azure)',
                    color: 'var(--color-midnight)',
                  }}
                >
                  {[domainFilter, authorFilter, dateFilter].filter(Boolean).length}
                </span>
              )}
            </button>

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
              className="p-2 glass-button rounded-lg min-h-[36px] min-w-[36px]"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" style={{ color: 'var(--color-clinical)' }} />
            </button>

            {/* View Toggle */}
            <div className="flex items-center glass-panel rounded-lg p-1">
              <button
                onClick={() => onViewChange?.('tree')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-all min-h-[32px] ${
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
                className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-all min-h-[32px] ${
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

        {/* Filters Row - Collapsible */}
        {filtersOpen && (
          <div
            className="flex flex-wrap items-center gap-3 pt-2 border-t animate-in slide-in-from-top-2"
            style={{ borderColor: 'var(--color-glass-border)' }}
          >
            {/* Domain Filter */}
            <div className="relative">
              <select
                value={domainFilter}
                onChange={(e) => setDomainFilter(e.target.value)}
                className="glass-input pl-3 pr-8 py-1.5 rounded text-sm appearance-none min-w-[140px] min-h-[36px] cursor-pointer"
              >
                {DOMAINS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                style={{ color: 'var(--color-clinical)' }}
              />
            </div>

            {/* Author Filter */}
            <input
              type="text"
              value={authorFilter}
              onChange={(e) => setAuthorFilter(e.target.value)}
              placeholder="Filter by author..."
              className="glass-input px-3 py-1.5 rounded text-sm min-w-[160px] min-h-[36px]"
            />

            {/* Date Range Filter */}
            <div className="relative">
              <select
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="glass-input pl-3 pr-8 py-1.5 rounded text-sm appearance-none min-w-[140px] min-h-[36px] cursor-pointer"
              >
                {DATE_RANGES.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <ChevronDown
                className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
                style={{ color: 'var(--color-clinical)' }}
              />
            </div>

            {/* Clear Filters */}
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-2 py-1.5 text-sm hover:bg-white/10 rounded transition-colors min-h-[36px]"
                style={{ color: 'var(--color-clinical)' }}
              >
                <X className="w-3.5 h-3.5" />
                Clear
              </button>
            )}

            {/* Active Filter Chips */}
            {domainFilter && (
              <span
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{
                  backgroundColor: 'rgba(0, 212, 255, 0.1)',
                  color: 'var(--color-azure)',
                }}
              >
                Domain: {DOMAINS.find(d => d.value === domainFilter)?.label}
              </span>
            )}
            {authorFilter && (
              <span
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{
                  backgroundColor: 'rgba(0, 212, 255, 0.1)',
                  color: 'var(--color-azure)',
                }}
              >
                Author: {authorFilter}
              </span>
            )}
            {dateFilter && (
              <span
                className="flex items-center gap-1 px-2 py-1 rounded text-xs"
                style={{
                  backgroundColor: 'rgba(0, 212, 255, 0.1)',
                  color: 'var(--color-azure)',
                }}
              >
                {DATE_RANGES.find(d => d.value === dateFilter)?.label}
              </span>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
