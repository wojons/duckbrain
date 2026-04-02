import { useState } from 'react'
import {
  Database,
  ChevronLeft,
  ChevronRight,
  Settings,
  FolderTree,
  Plus,
} from 'lucide-react'
import { MemoryTree } from '../memory-tree'
import { useNamespaces, useCurrentNamespace, useSwitchNamespace } from '../../hooks/use-namespaces'
import { useUIStore } from '../../stores/ui-store'

interface SidebarProps {
  namespace?: string
  onNamespaceChange?: (namespace: string) => void
}

/**
 * Sidebar Component
 *
 * Left sidebar with namespace selector and memory tree.
 * Fixed 256px width, collapsible on mobile.
 */
export function Sidebar({ namespace }: SidebarProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false)
  const sidebarCollapsed = useUIStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUIStore((state) => state.toggleSidebar)

  const { data: namespacesData } = useNamespaces()
  const currentNamespace = useCurrentNamespace()
  const switchNamespace = useSwitchNamespace()

  const namespaces = namespacesData?.namespaces || []

  const handleNamespaceChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newNamespace = e.target.value
    switchNamespace.mutate(newNamespace)
  }

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setIsMobileOpen(!isMobileOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 glass-panel rounded-lg"
      >
        {isMobileOpen ? (
          <ChevronLeft className="w-5 h-5" style={{ color: 'var(--color-pristine)' }} />
        ) : (
          <FolderTree className="w-5 h-5" style={{ color: 'var(--color-pristine)' }} />
        )}
      </button>

      {/* Sidebar */}
      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-40
          w-64 h-full
          glass-panel border-r
          transform transition-transform duration-300 ease-out
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          ${sidebarCollapsed ? 'lg:w-16 lg:overflow-hidden' : 'lg:w-64'}
        `}
        style={{ borderColor: 'var(--color-glass-border)' }}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-4 border-b" style={{ borderColor: 'var(--color-glass-border)' }}>
            <div className="flex items-center gap-2 mb-4">
              <Database className="w-6 h-6" style={{ color: 'var(--color-azure)' }} />
              {!sidebarCollapsed && (
                <span className="font-semibold" style={{ color: 'var(--color-pristine)' }}>
                  DuckBrain
                </span>
              )}
            </div>

            {/* Collapse button (desktop only) */}
            <button
              onClick={toggleSidebar}
              className="hidden lg:flex absolute -right-3 top-6 w-6 h-6 glass-panel rounded-full items-center justify-center"
            >
              {sidebarCollapsed ? (
                <ChevronRight className="w-3 h-3" />
              ) : (
                <ChevronLeft className="w-3 h-3" />
              )}
            </button>
          </div>

          {/* Namespace Selector */}
          {!sidebarCollapsed && (
            <div className="p-3 border-b" style={{ borderColor: 'var(--color-glass-border)' }}>
              <label className="text-xs mb-1.5 block" style={{ color: 'var(--color-clinical)' }}>
                Namespace
              </label>
              <div className="flex gap-2">
                <select
                  value={currentNamespace}
                  onChange={handleNamespaceChange}
                  className="flex-1 glass-input text-sm py-1.5 px-2"
                >
                  {namespaces.map((ns) => (
                    <option key={ns.name} value={ns.name}>
                      {ns.name}
                    </option>
                  ))}
                </select>
                <button
                  className="p-1.5 glass-button rounded"
                  title="Create new namespace"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* Memory Tree */}
          <div className="flex-1 overflow-hidden py-2">
            {!sidebarCollapsed && (
              <div className="px-3 pb-2">
                <span
                  className="text-xs font-medium uppercase tracking-wider"
                  style={{ color: 'var(--color-clinical)' }}
                >
                  Memory Tree
                </span>
              </div>
            )}
            <MemoryTree namespace={namespace} />
          </div>

          {/* Settings Button */}
          <div className="p-3 border-t" style={{ borderColor: 'var(--color-glass-border)' }}>
            <button className="flex items-center gap-2 w-full py-2 px-3 rounded glass-panel-hover">
              <Settings className="w-4 h-4" style={{ color: 'var(--color-clinical)' }} />
              {!sidebarCollapsed && (
                <span className="text-sm" style={{ color: 'var(--color-pristine)' }}>
                  Settings
                </span>
              )}
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {isMobileOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-30"
          onClick={() => setIsMobileOpen(false)}
        />
      )}
    </>
  )
}
