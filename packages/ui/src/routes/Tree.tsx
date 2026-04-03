import { useState } from 'react'
import { Database, GitCommit, Layers, Activity } from 'lucide-react'
import { Sidebar } from '../components/layout/sidebar'
import { Header } from '../components/layout/header'
import { InspectorPanel } from '../components/layout/inspector'
import { MemoryTree } from '../components/memory-tree'
import { MemoryTable } from '../components/memory-table'
import { useSSE } from '../hooks/use-sse'
import { useCurrentNamespace } from '../hooks/use-namespaces'
import { useUIStore } from '../stores/ui-store'
import { useVitals } from '../hooks/use-vitals'
import { ErrorBoundary, ErrorCard } from '../components/ui/error-boundary'

/**
 * Tree View Page
 *
 * Hierarchical tree view of memory keys.
 * Shows MemoryTree in main content area with inspector panel.
 * Inspector pushes content when open (not overlay).
 */
export default function TreePage() {
  const currentNamespace = useCurrentNamespace()
  const [view, setView] = useState<'tree' | 'timeline'>('tree')
  const inspectorOpen = useUIStore((state) => state.inspectorOpen)

  // Connect to SSE for real-time updates
  useSSE({ namespace: currentNamespace })

  // Fetch vitals data
  const { data: vitals } = useVitals(currentNamespace)

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--color-midnight)' }}>
      <Sidebar namespace={currentNamespace} />

      <div className="flex-1 flex flex-col min-w-0">
        <Header view={view} onViewChange={setView} />

        <main className="flex-1 flex overflow-hidden">
          {/* Middle Content Area - shrinks when inspector is open */}
          <ErrorBoundary
            fallback={
              <div className="flex-1 flex items-center justify-center p-8">
                <ErrorCard
                  title="Tree view failed to load"
                  message="There was an error rendering the tree view"
                  onRetry={() => window.location.reload()}
                  retryLabel="Retry"
                />
              </div>
            }
          >
            <div 
              className="flex-1 flex flex-col p-4 overflow-hidden transition-all duration-300"
              style={{ marginRight: inspectorOpen ? '450px' : '0' }}
            >
              <div className="space-y-4 overflow-auto">
                {/* Vitals Row */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <VitalCard
                    icon={<Database className="w-5 h-5" style={{ color: 'var(--color-azure)' }} />}
                    label="Active Memories"
                    value={vitals?.activeMemories?.toLocaleString() ?? '—'}
                  />
                  <VitalCard
                    icon={<GitCommit className="w-5 h-5" style={{ color: 'var(--color-amber)' }} />}
                    label="Git Queue"
                    value={vitals?.gitQueueSize?.toString() ?? '—'}
                  />
                  <VitalCard
                    icon={<Layers className="w-5 h-5" style={{ color: 'var(--color-pristine)' }} />}
                    label="Tombstone Ratio"
                    value={vitals?.tombstoneRatio ?? '—'}
                  />
                  <VitalCard
                    icon={<Activity className="w-5 h-5" style={{ color: 'var(--color-success)' }} />}
                    label="Key Count"
                    value={vitals?.queryRate?.toLocaleString() ?? '—'}
                  />
                </div>

                {/* Tree View */}
                <div className="glass-panel p-4">
                  <div className="mb-4">
                    <h2
                      className="text-lg font-semibold"
                      style={{ color: 'var(--color-pristine)' }}
                    >
                      Memory Tree
                    </h2>
                    <p className="text-sm" style={{ color: 'var(--color-clinical)' }}>
                      Browse memories hierarchically by key path
                    </p>
                  </div>

                  <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--color-glass-border)' }}>
                    <MemoryTree namespace={currentNamespace} />
                  </div>
                </div>

                {/* Optional: Show table below tree */}
                <div className="glass-panel p-4">
                  <div className="mb-4">
                    <h2
                      className="text-lg font-semibold"
                      style={{ color: 'var(--color-pristine)' }}
                    >
                      Recent Memories
                    </h2>
                  </div>
                  <MemoryTable namespace={currentNamespace} />
                </div>
              </div>
            </div>
          </ErrorBoundary>

          {/* Inspector Panel - slides in from right, pushing content */}
          <InspectorPanel namespace={currentNamespace} />
        </main>
      </div>
    </div>
  )
}

function VitalCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="glass-panel p-4 glass-panel-hover">
      <div className="flex items-center gap-3 mb-2">
        {icon}
        <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>
          {label}
        </span>
      </div>
      <div
        className="text-2xl font-semibold"
        style={{ color: 'var(--color-pristine)' }}
      >
        {value}
      </div>
    </div>
  )
}
