/**
 * Bulk Action Bar Component
 *
 * Shows when rows are selected in the memory table.
 * Provides actions: Forget, Export, Cancel.
 */

import { useState } from 'react'
import { Trash2, Download, X, AlertTriangle, Loader2 } from 'lucide-react'
import { useForgetMemory } from '../hooks/use-memories'
import { useUIStore } from '../stores/ui-store'
import { MemoryResponse } from '../../../../src/http/types/api'

interface BulkActionBarProps {
  selectedRows: MemoryResponse[]
  onClearSelection: () => void
}

export function BulkActionBar({ selectedRows, onClearSelection }: BulkActionBarProps) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [isForgetting, setIsForgetting] = useState(false)
  const [progress, setProgress] = useState({ current: 0, total: 0 })
  const currentNamespace = useUIStore((state) => state.currentNamespace)
  const forgetMutation = useForgetMemory(currentNamespace)

  const selectedCount = selectedRows.length

  const handleExport = () => {
    const data = selectedRows.map((row) => ({
      id: row.id,
      key: row.key,
      domain: row.domain,
      action: row.action,
      timestamp: row.timestamp,
      author: row.author,
      content: row.content,
    }))

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `memories-${new Date().toISOString().split('T')[0]}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const handleForget = async () => {
    setIsForgetting(true)
    setProgress({ current: 0, total: selectedCount })

    try {
      // Process sequentially to avoid overwhelming the server
      for (let i = 0; i < selectedRows.length; i++) {
        const row = selectedRows[i]
        if (!row.isTombstone) {
          await forgetMutation.mutateAsync(row.id)
        }
        setProgress({ current: i + 1, total: selectedCount })
      }

      setShowConfirm(false)
      onClearSelection()
    } finally {
      setIsForgetting(false)
      setProgress({ current: 0, total: 0 })
    }
  }

  if (selectedCount === 0) return null

  return (
    <>
      {/* Bulk Action Bar */}
      <div
        className="fixed bottom-6 left-1/2 transform -translate-x-1/2 z-50
                   flex items-center gap-4 px-6 py-3 rounded-lg glass-panel
                   shadow-lg border animate-in slide-in-from-bottom-4"
        style={{ borderColor: 'var(--color-glass-border)' }}
      >
        {/* Selection Count */}
        <div className="flex items-center gap-2 pr-4 border-r" style={{ borderColor: 'var(--color-glass-border)' }}>
          <span className="text-sm font-medium" style={{ color: 'var(--color-pristine)' }}>
            {selectedCount} selected
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowConfirm(true)}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm
                       hover:bg-red-500/20 transition-colors"
            style={{ color: 'var(--color-error)' }}
          >
            <Trash2 className="w-4 h-4" />
            Forget
          </button>

          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm
                       hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-clinical)' }}
          >
            <Download className="w-4 h-4" />
            Export
          </button>

          <div className="w-px h-5 mx-2" style={{ backgroundColor: 'var(--color-glass-border)' }} />

          <button
            onClick={onClearSelection}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm
                       hover:bg-white/10 transition-colors"
            style={{ color: 'var(--color-clinical)' }}
          >
            <X className="w-4 h-4" />
            Cancel
          </button>
        </div>
      </div>

      {/* Confirm Dialog */}
      {showConfirm && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/50 z-[60]"
            onClick={() => !isForgetting && setShowConfirm(false)}
          />

          {/* Dialog */}
          <div
            className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2
                       z-[61] w-full max-w-md glass-panel rounded-lg overflow-hidden"
            style={{ borderColor: 'var(--color-glass-border)' }}
          >
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(255, 77, 77, 0.2)' }}
                >
                  <AlertTriangle className="w-5 h-5" style={{ color: 'var(--color-error)' }} />
                </div>
                <div>
                  <h3 className="text-lg font-semibold" style={{ color: 'var(--color-pristine)' }}>
                    Forget {selectedCount} memories?
                  </h3>
                  <p className="text-sm" style={{ color: 'var(--color-clinical)' }}>
                    This action cannot be undone.
                  </p>
                </div>
              </div>

              {isForgetting && (
                <div className="mb-4">
                  <div className="flex justify-between text-sm mb-2" style={{ color: 'var(--color-clinical)' }}>
                    <span>Forgetting...</span>
                    <span>
                      {progress.current} of {progress.total}
                    </span>
                  </div>
                  <div
                    className="h-2 rounded-full overflow-hidden"
                    style={{ backgroundColor: 'var(--color-glass-bg)' }}
                  >
                    <div
                      className="h-full transition-all duration-300 rounded-full"
                      style={{
                        width: `${(progress.current / progress.total) * 100}%`,
                        backgroundColor: 'var(--color-azure)',
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowConfirm(false)}
                  disabled={isForgetting}
                  className="px-4 py-2 rounded text-sm hover:bg-white/10 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ color: 'var(--color-clinical)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleForget}
                  disabled={isForgetting}
                  className="flex items-center gap-2 px-4 py-2 rounded text-sm
                           hover:bg-red-500/20 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ color: 'var(--color-error)' }}
                >
                  {isForgetting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Forget Memories
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
