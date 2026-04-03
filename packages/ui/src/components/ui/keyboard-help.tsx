/**
 * Keyboard Help Modal
 *
 * Displays keyboard shortcuts help overlay with glassmorphism styling.
 */

import { X, Command } from 'lucide-react'

interface KeyboardHelpProps {
  isOpen: boolean
  onClose: () => void
}

interface ShortcutGroup {
  title: string
  shortcuts: { key: string; description: string }[]
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: 'Global Shortcuts',
    shortcuts: [
      { key: '?', description: 'Show this help dialog' },
      { key: 'Esc', description: 'Close inspector / modals / this dialog' },
      { key: 'r', description: 'Refresh current data' },
      { key: '/', description: 'Focus search input' },
    ],
  },
  {
    title: 'Table Navigation',
    shortcuts: [
      { key: '↑ / ↓', description: 'Navigate between rows' },
      { key: 'Enter', description: 'Open selected memory in inspector' },
      { key: 'Space', description: 'Toggle row selection' },
    ],
  },
  {
    title: 'Inspector',
    shortcuts: [
      { key: 'Esc', description: 'Close inspector' },
      { key: 'c', description: 'Copy JSON to clipboard' },
      { key: 'd / Delete', description: 'Forget memory (with confirmation)' },
    ],
  },
]

export function KeyboardHelp({ isOpen, onClose }: KeyboardHelpProps) {
  if (!isOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-[100]"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2
                   z-[101] w-full max-w-lg glass-panel rounded-lg overflow-hidden"
        style={{
          borderColor: 'var(--color-glass-border)',
          backgroundColor: 'rgba(11, 16, 30, 0.98)',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between p-4 border-b"
          style={{ borderColor: 'var(--color-glass-border)' }}
        >
          <div className="flex items-center gap-3">
            <Command className="w-5 h-5" style={{ color: 'var(--color-azure)' }} />
            <h2 className="text-lg font-semibold" style={{ color: 'var(--color-pristine)' }}>
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 glass-panel-hover rounded-lg transition-colors"
          >
            <X className="w-5 h-5" style={{ color: 'var(--color-clinical)' }} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {shortcutGroups.map((group) => (
            <div key={group.title} className="mb-6 last:mb-0">
              <h3
                className="text-xs font-medium uppercase tracking-wider mb-3"
                style={{ color: 'var(--color-clinical)' }}
              >
                {group.title}
              </h3>
              <div className="space-y-2">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.key}
                    className="flex items-center justify-between py-2 px-3 rounded glass-panel"
                  >
                    <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>
                      {shortcut.description}
                    </span>
                    <kbd
                      className="px-2 py-1 rounded text-xs font-mono font-medium"
                      style={{
                        color: 'var(--color-pristine)',
                        backgroundColor: 'var(--color-glass-bg)',
                        border: '1px solid var(--color-glass-border)',
                      }}
                    >
                      {shortcut.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          className="p-4 border-t text-center"
          style={{ borderColor: 'var(--color-glass-border)' }}
        >
          <p className="text-xs" style={{ color: 'var(--color-clinical)' }}>
            Press <kbd className="px-1 rounded" style={{ backgroundColor: 'var(--color-glass-bg)' }}>Esc</kbd> to close
          </p>
        </div>
      </div>
    </>
  )
}
