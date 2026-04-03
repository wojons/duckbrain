/**
 * Context Menu Component
 *
 * Right-click context menu for memory operations.
 * Positioned at click coordinates with glassmorphism styling.
 */

import { useEffect, useRef, useCallback } from 'react'
import { Eye, Copy, FileJson, Trash2 } from 'lucide-react'

export interface ContextMenuItem {
  id: string
  label: string
  icon?: React.ReactNode
  onClick: () => void
  disabled?: boolean
  separator?: boolean
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  position: { x: number; y: number } | null
  onClose: () => void
}

/**
 * Context Menu component
 *
 * @example
 * const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null)
 *
 * const handleContextMenu = (e: React.MouseEvent) => {
 *   e.preventDefault()
 *   setMenuPosition({ x: e.clientX, y: e.clientY })
 * }
 *
 * return (
 *   <div onContextMenu={handleContextMenu}>
 *     <ContextMenu
 *       items={[
 *         { id: 'open', label: 'Open', onClick: () => {} },
 *         { id: 'copy', label: 'Copy', onClick: () => {} },
 *         { id: 'sep', label: '', separator: true, onClick: () => {} },
 *         { id: 'delete', label: 'Delete', onClick: () => {} },
 *       ]}
 *       position={menuPosition}
 *       onClose={() => setMenuPosition(null)}
 *     />
 *   </div>
 * )
 */
export function ContextMenu({ items, position, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    if (!position) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [position, onClose])

  // Calculate position to keep menu within viewport
  const getMenuPosition = useCallback(() => {
    if (!position) return { display: 'none' }

    const menuWidth = 200
    const menuHeight = items.length * 40 + 16

    let x = position.x
    let y = position.y

    // Adjust if off-screen
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8
    }

    return {
      position: 'fixed' as const,
      left: x,
      top: y,
      zIndex: 100,
    }
  }, [position, items.length])

  if (!position) return null

  return (
    <div
      ref={menuRef}
      className="py-2 min-w-[180px] rounded-lg glass-panel shadow-lg"
      style={{
        ...getMenuPosition(),
        borderColor: 'var(--color-glass-border)',
        backgroundColor: 'rgba(11, 16, 30, 0.98)',
      }}
    >
      {items.map((item, index) => {
        if (item.separator) {
          return (
            <div
              key={item.id || `sep-${index}`}
              className="my-1 mx-2 h-px"
              style={{ backgroundColor: 'var(--color-glass-border)' }}
            />
          )
        }

        return (
          <button
            key={item.id}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
            className="w-full flex items-center gap-3 px-4 py-2 text-left text-sm
                     hover:bg-white/10 transition-colors
                     disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: item.id === 'forget' ? 'var(--color-error)' : 'var(--color-clinical)' }}
          >
            {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
            <span>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Hook to manage context menu state
 */
export function useContextMenu() {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [selectedItem, setSelectedItem] = useState<unknown>(null)

  const open = useCallback((e: React.MouseEvent, item: unknown) => {
    e.preventDefault()
    setPosition({ x: e.clientX, y: e.clientY })
    setSelectedItem(item)
  }, [])

  const close = useCallback(() => {
    setPosition(null)
    setSelectedItem(null)
  }, [])

  return {
    position,
    selectedItem,
    open,
    close,
    isOpen: position !== null,
  }
}

// Import React
import { useState } from 'react'

/**
 * Default context menu items for memory operations
 */
export function createMemoryContextMenuItems(
  _memory: { id: string; key: string; content?: unknown },
  handlers: {
    onOpen: () => void
    onCopyKey: () => void
    onCopyJson: () => void
    onForget: () => void
  }
): ContextMenuItem[] {
  return [
    {
      id: 'open',
      label: 'Open in Inspector',
      icon: <Eye className="w-4 h-4" />,
      onClick: handlers.onOpen,
    },
    {
      id: 'copy-key',
      label: 'Copy Key Path',
      icon: <Copy className="w-4 h-4" />,
      onClick: handlers.onCopyKey,
    },
    {
      id: 'copy-json',
      label: 'Copy JSON',
      icon: <FileJson className="w-4 h-4" />,
      onClick: handlers.onCopyJson,
    },
    {
      id: 'separator',
      label: '',
      separator: true,
      onClick: () => {},
    },
    {
      id: 'forget',
      label: 'Forget Memory',
      icon: <Trash2 className="w-4 h-4" />,
      onClick: handlers.onForget,
    },
  ]
}
