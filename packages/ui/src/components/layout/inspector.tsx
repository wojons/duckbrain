import { X, Copy, Trash2, Clock, User, Tag, FileJson } from 'lucide-react'
import { useUIStore } from '../../stores/ui-store'
import { useMemory, useMemoryByKey } from '../../hooks/use-memories'
import { useForgetMemory } from '../../hooks/use-memories'

interface InspectorPanelProps {
  namespace?: string
}



/**
 * Inspector Panel Component
 *
 * Slide-out panel showing memory details and JSON viewer.
 * Fixed 450px width, slides from right.
 */
export function InspectorPanel({ namespace }: InspectorPanelProps) {
  const selectedMemory = useUIStore((state) => state.selectedMemory)
  const inspectorOpen = useUIStore((state) => state.inspectorOpen)
  const setInspectorOpen = useUIStore((state) => state.setInspectorOpen)
  const setSelectedMemory = useUIStore((state) => state.setSelectedMemory)

  // Determine if selectedMemory is a UUID or a key path
  const isKeyPath = selectedMemory?.startsWith('/')
  
  // Fetch by ID (UUID) or by key path
  const { data: memoryById, isLoading: isLoadingById } = useMemory(
    !isKeyPath ? selectedMemory || '' : '',
    namespace
  )
  const { data: memoryByKey, isLoading: isLoadingByKey } = useMemoryByKey(
    isKeyPath ? selectedMemory || '' : '',
    namespace
  )
  
  // Use the appropriate data
  const memory = isKeyPath ? memoryByKey : memoryById
  const isLoading = isKeyPath ? isLoadingByKey : isLoadingById
  
  const forgetMutation = useForgetMemory(namespace)

  const handleClose = () => {
    setInspectorOpen(false)
    setSelectedMemory(null)
  }

  const handleCopyJson = () => {
    if (memory) {
      navigator.clipboard.writeText(JSON.stringify(memory, null, 2))
    }
  }

  const handleForget = async () => {
    if (memory && confirm('Are you sure you want to forget this memory?')) {
      await forgetMutation.mutateAsync(memory.id)
      handleClose()
    }
  }

  return (
    <>
      {/* Overlay for mobile */}
      {inspectorOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-40"
          onClick={handleClose}
        />
      )}

      {/* Inspector Panel - Fixed position, slides in from right */}
      <aside
        className={`
          fixed inset-y-0 z-50
          w-[450px] h-full
          glass-panel border-l
          transform transition-all duration-300 ease-out
          flex flex-col
        `}
        style={{
          right: inspectorOpen ? '0' : '-450px',
          borderColor: 'var(--color-glass-border)',
          backgroundColor: 'rgba(11, 16, 30, 0.95)',
        }}
      >
        {!selectedMemory ? (
          <div className="flex-1 flex items-center justify-center p-6 text-center">
            <div>
              <FileJson
                className="w-12 h-12 mx-auto mb-4"
                style={{ color: 'var(--color-clinical)' }}
              />
              <p style={{ color: 'var(--color-clinical)' }}>
                Select a memory to view details
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="animate-spin w-6 h-6 border-2 border-azure border-t-transparent rounded-full" />
          </div>
        ) : memory ? (
          <>
            {/* Header */}
            <div
              className="flex items-center justify-between p-4 border-b"
              style={{ borderColor: 'var(--color-glass-border)' }}
            >
              <h2
                className="text-lg font-semibold"
                style={{ color: 'var(--color-pristine)' }}
              >
                Memory Inspector
              </h2>
              <button
                onClick={handleClose}
                className="p-2 glass-panel-hover rounded-lg"
              >
                <X className="w-5 h-5" style={{ color: 'var(--color-clinical)' }} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6">
              {/* Key Path */}
              <div>
                <label
                  className="text-xs font-medium uppercase tracking-wider mb-2 block"
                  style={{ color: 'var(--color-clinical)' }}
                >
                  Key Path
                </label>
                <div
                  className="font-mono text-sm p-3 rounded glass-panel break-all"
                  style={{
                    color: 'var(--color-azure)',
                    backgroundColor: 'rgba(0, 212, 255, 0.05)',
                  }}
                >
                  {memory.key}
                </div>
              </div>

              {/* Details Grid */}
              <div className="grid grid-cols-2 gap-4">
                <div className="glass-panel p-3 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <Tag className="w-3.5 h-3.5" style={{ color: 'var(--color-amber)' }} />
                    <span
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--color-clinical)' }}
                    >
                      Domain
                    </span>
                  </div>
                  <span
                    className="text-sm font-medium"
                    style={{ color: 'var(--color-pristine)' }}
                  >
                    {memory.domain}
                  </span>
                </div>

                <div className="glass-panel p-3 rounded-lg">
                  <div className="flex items-center gap-2 mb-1">
                    <User className="w-3.5 h-3.5" style={{ color: 'var(--color-success)' }} />
                    <span
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--color-clinical)' }}
                    >
                      Author
                    </span>
                  </div>
                  <span
                    className="text-sm font-medium truncate"
                    style={{ color: 'var(--color-pristine)' }}
                  >
                    {memory.author}
                  </span>
                </div>

                <div className="glass-panel p-3 rounded-lg col-span-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Clock className="w-3.5 h-3.5" style={{ color: 'var(--color-azure)' }} />
                    <span
                      className="text-xs uppercase tracking-wider"
                      style={{ color: 'var(--color-clinical)' }}
                    >
                      Timestamp
                    </span>
                  </div>
                  <span
                    className="text-sm font-medium"
                    style={{ color: 'var(--color-pristine)' }}
                  >
                    {new Date(memory.timestamp).toLocaleString()}
                  </span>
                </div>

                {memory.isTombstone && (
                  <div
                    className="col-span-2 p-3 rounded-lg border"
                    style={{
                      borderColor: 'var(--color-error)',
                      backgroundColor: 'rgba(255, 68, 68, 0.1)',
                    }}
                  >
                    <span
                      className="text-sm font-medium"
                      style={{ color: 'var(--color-error)' }}
                    >
                      ⚠️ This memory is a tombstone (deleted)
                    </span>
                  </div>
                )}
              </div>

              {/* Content Preview */}
              <div>
                <label
                  className="text-xs font-medium uppercase tracking-wider mb-2 block"
                  style={{ color: 'var(--color-clinical)' }}
                >
                  Content
                </label>
                <div
                  className="p-3 rounded glass-panel text-sm leading-relaxed"
                  style={{ color: 'var(--color-pristine)' }}
                >
                  {memory.content}
                </div>
              </div>

              {/* Attributes */}
              {memory.attributes &&
                Object.keys(memory.attributes).length > 0 && (
                  <div>
                    <label
                      className="text-xs font-medium uppercase tracking-wider mb-2 block"
                      style={{ color: 'var(--color-clinical)' }}
                    >
                      Attributes
                    </label>
                    <div className="glass-panel p-3 rounded-lg">
                      {Object.entries(memory.attributes).map(([key, value]) => (
                        <div
                          key={key}
                          className="flex justify-between py-1 border-b last:border-0"
                          style={{ borderColor: 'var(--color-glass-border)' }}
                        >
                          <span
                            className="text-sm"
                            style={{ color: 'var(--color-azure)' }}
                          >
                            {key}
                          </span>
                          <span
                            className="text-sm font-mono"
                            style={{ color: 'var(--color-clinical)' }}
                          >
                            {JSON.stringify(value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* JSON Viewer */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label
                    className="text-xs font-medium uppercase tracking-wider"
                    style={{ color: 'var(--color-clinical)' }}
                  >
                    Raw JSON
                  </label>
                  <button
                    onClick={handleCopyJson}
                    className="flex items-center gap-1.5 text-xs glass-button px-2 py-1 rounded"
                  >
                    <Copy className="w-3 h-3" />
                    Copy
                  </button>
                </div>
                <pre
                  className="p-3 rounded text-xs font-mono overflow-x-auto glass-panel"
                  style={{
                    backgroundColor: '#060913',
                    color: 'var(--color-clinical)',
                  }}
                >
                  <code>{JSON.stringify(memory, null, 2)}</code>
                </pre>
              </div>
            </div>

            {/* Footer Actions */}
            <div
              className="p-4 border-t flex gap-2"
              style={{ borderColor: 'var(--color-glass-border)' }}
            >
              <button
                onClick={handleCopyJson}
                className="flex-1 flex items-center justify-center gap-2 glass-button py-2.5 rounded-lg text-sm"
              >
                <Copy className="w-4 h-4" />
                Copy JSON
              </button>
              <button
                onClick={handleForget}
                disabled={forgetMutation.isPending}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm transition-colors"
                style={{
                  backgroundColor: 'rgba(255, 68, 68, 0.1)',
                  color: 'var(--color-error)',
                  border: '1px solid rgba(255, 68, 68, 0.3)',
                }}
              >
                <Trash2 className="w-4 h-4" />
                {forgetMutation.isPending ? 'Forgetting...' : 'Forget'}
              </button>
            </div>
          </>
        ) : null}
      </aside>
    </>
  )
}
