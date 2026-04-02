import { useState } from 'react'
import { Database, GitCommit, Layers, Activity } from 'lucide-react'
import { Sidebar } from '../components/layout/sidebar'
import { Header } from '../components/layout/header'
import { InspectorPanel } from '../components/layout/inspector'
import { MemoryTree } from '../components/memory-tree'
import { MemoryTable } from '../components/memory-table'
import { useSSE } from '../hooks/use-sse'
import { useCurrentNamespace } from '../hooks/use-namespaces'

/**
 * Tree View Page
 *
 * Hierarchical tree view of memory keys.
 * Shows MemoryTree in main content area with inspector panel.
 */
export default function TreePage() {
  const currentNamespace = useCurrentNamespace()
  const [view, setView] = useState<'tree' | 'timeline'>('tree')

  // Connect to SSE for real-time updates
  useSSE({ namespace: currentNamespace })

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: 'var(--color-midnight)' }}>
      <Sidebar namespace={currentNamespace} />

      <div className="flex-1 flex flex-col min-w-0">
        <Header view={view} onViewChange={setView} />

        <main className="flex-1 p-4 overflow-auto">
          <div className="space-y-4">
            {/* Vitals Row */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <VitalCard
                icon={<Database className="w-5 h-5" style={{ color: 'var(--color-azure)' }} />}
                label="Active Memories"
                value="—"
              />
              <VitalCard
                icon={<GitCommit className="w-5 h-5" style={{ color: 'var(--color-amber)' }} />}
                label="Git Queue"
                value="—"
              />
              <VitalCard
                icon={<Layers className="w-5 h-5" style={{ color: 'var(--color-pristine)' }} />}
                label="Tombstone Ratio"
                value="—"
              />
              <VitalCard
                icon={<Activity className="w-5 h-5" style={{ color: 'var(--color-success)' }} />}
                label="Query Rate"
                value="—"
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
        </main>
      </div>

      <InspectorPanel namespace={currentNamespace} />
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
