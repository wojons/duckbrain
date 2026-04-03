/**
 * Keyboard Shortcuts Hook
 *
 * Global keyboard shortcut management with scope-aware registration.
 * Provides help modal integration and conflict prevention.
 */

import { useEffect, useCallback, useRef } from 'react'

type ShortcutScope = 'global' | 'search' | 'table' | 'inspector' | 'modal'

interface Shortcut {
  key: string
  scope: ShortcutScope
  handler: (e: KeyboardEvent) => void
  description: string
}

interface RegisteredShortcut extends Shortcut {
  id: string
}

// Global registry for shortcuts
const shortcutRegistry = new Map<string, RegisteredShortcut>()
let isListening = false

/**
 * Start listening to keyboard events
 */
function startListening() {
  if (isListening) return
  isListening = true

  const handleKeyDown = (e: KeyboardEvent) => {
    // Check if any input is focused (exclude shortcuts with modifiers)
    const target = e.target as HTMLElement
    const isInputFocused = target instanceof HTMLInputElement || 
                          target instanceof HTMLTextAreaElement ||
                          target instanceof HTMLSelectElement ||
                          target?.getAttribute?.('contenteditable') === 'true'

    // Build key string from event
    let keyString = ''
    if (e.ctrlKey || e.metaKey) keyString += 'ctrl+'
    if (e.altKey) keyString += 'alt+'
    if (e.shiftKey) keyString += 'shift+'
    keyString += e.key.toLowerCase()

    // Check for matching shortcuts
    const matchingShortcuts: RegisteredShortcut[] = []
    shortcutRegistry.forEach((shortcut) => {
      const shortcutKey = shortcut.key.toLowerCase()
      if (shortcutKey === keyString || shortcutKey === e.key.toLowerCase()) {
        matchingShortcuts.push(shortcut)
      }
    })

    if (matchingShortcuts.length === 0) return

    // Sort by scope priority (modal > inspector > table > search > global)
    const scopePriority: Record<ShortcutScope, number> = {
      modal: 5,
      inspector: 4,
      table: 3,
      search: 2,
      global: 1,
    }

    matchingShortcuts.sort((a, b) => scopePriority[b.scope] - scopePriority[a.scope])

    // Find highest priority shortcut that should trigger
    for (const shortcut of matchingShortcuts) {
      // Global shortcuts work even when input is focused (unless they conflict)
      if (isInputFocused && shortcut.scope !== 'global') {
        // Search scope shortcuts only work in search
        if (shortcut.scope === 'search' && !target.closest('[data-search="true"]')) {
          continue
        }
        // Other scoped shortcuts don't work in inputs
        continue
      }

      // Execute the handler
      shortcut.handler(e)
      
      // Prevent default for most shortcuts
      if (!e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        e.stopPropagation()
      }
      break
    }
  }

  document.addEventListener('keydown', handleKeyDown, { capture: true })

  // Return cleanup function
  return () => {
    document.removeEventListener('keydown', handleKeyDown, { capture: true })
    isListening = false
  }
}

/**
 * Hook to register keyboard shortcuts
 */
export function useKeyboard() {
  const shortcutsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const cleanup = startListening()
    return cleanup
  }, [])

  const register = useCallback((shortcut: Shortcut): (() => void) => {
    const id = `${shortcut.scope}:${shortcut.key}:${Date.now()}`
    const registered: RegisteredShortcut = { ...shortcut, id }
    shortcutRegistry.set(id, registered)
    shortcutsRef.current.add(id)

    // Return unregister function
    return () => {
      shortcutRegistry.delete(id)
      shortcutsRef.current.delete(id)
    }
  }, [])

  const unregister = useCallback((id: string) => {
    shortcutRegistry.delete(id)
    shortcutsRef.current.delete(id)
  }, [])

  const unregisterAll = useCallback(() => {
    shortcutsRef.current.forEach((id) => {
      shortcutRegistry.delete(id)
    })
    shortcutsRef.current.clear()
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      unregisterAll()
    }
  }, [unregisterAll])

  return { register, unregister, unregisterAll }
}

/**
 * Get all registered shortcuts (for help modal)
 */
export function getRegisteredShortcuts(): Shortcut[] {
  const shortcuts: Shortcut[] = []
  shortcutRegistry.forEach((shortcut) => {
    shortcuts.push({
      key: shortcut.key,
      scope: shortcut.scope,
      handler: shortcut.handler,
      description: shortcut.description,
    })
  })
  return shortcuts
}

/**
 * Common keyboard shortcuts configuration
 */
export const commonShortcuts = {
  global: {
    help: { key: '?', description: 'Show keyboard shortcuts help' },
    close: { key: 'Escape', description: 'Close inspector/modals' },
    refresh: { key: 'r', description: 'Refresh data' },
    search: { key: '/', description: 'Focus search input' },
  },
  table: {
    navigateUp: { key: 'ArrowUp', description: 'Navigate to previous row' },
    navigateDown: { key: 'ArrowDown', description: 'Navigate to next row' },
    select: { key: 'Enter', description: 'Open selected in inspector' },
    toggleSelection: { key: ' ', description: 'Toggle row selection' },
  },
  inspector: {
    close: { key: 'Escape', description: 'Close inspector' },
    copyJson: { key: 'c', description: 'Copy JSON to clipboard' },
    forget: { key: 'Delete', description: 'Forget memory' },
  },
} as const

export type { ShortcutScope, Shortcut }
