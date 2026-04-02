import { useState } from 'react'
import { Folder, FolderOpen, FileJson, ChevronRight, ChevronDown } from 'lucide-react'
import { useKeys } from '../hooks/use-keys'
import { useUIStore } from '../stores/ui-store'
import { KeyNode } from '../../../../src/http/types/api'

interface MemoryTreeProps {
  namespace?: string
  onSelectKey?: (key: string) => void
}

/**
 * Memory Tree Component
 *
 * Hierarchical file-explorer-style tree for memory keys.
 * Supports lazy loading and expand/collapse.
 */
export function MemoryTree({ namespace, onSelectKey }: MemoryTreeProps) {
  const { data, isLoading, error } = useKeys({ namespace })
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  const toggleNode = (path: string) => {
    const newExpanded = new Set(expandedNodes)
    if (newExpanded.has(path)) {
      newExpanded.delete(path)
    } else {
      newExpanded.add(path)
    }
    setExpandedNodes(newExpanded)
  }

  if (isLoading) {
    return (
      <div className="p-4 text-sm" style={{ color: 'var(--color-clinical)' }}>
        Loading keys...
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-4 text-sm" style={{ color: 'var(--color-error)' }}>
        Error loading keys: {error.message}
      </div>
    )
  }

  const tree = data?.tree || []

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      {tree.length === 0 ? (
        <div className="p-4 text-sm" style={{ color: 'var(--color-clinical)' }}>
          No memories yet.
        </div>
      ) : (
        tree.map((node) => (
          <TreeNodeComponent
            key={node.id}
            node={node}
            depth={0}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
            onSelect={onSelectKey}
          />
        ))
      )}
    </div>
  )
}

interface TreeNodeComponentProps {
  node: KeyNode
  depth: number
  expandedNodes: Set<string>
  onToggle: (path: string) => void
  onSelect?: (key: string) => void
}

function TreeNodeComponent({
  node,
  depth,
  expandedNodes,
  onToggle,
  onSelect,
}: TreeNodeComponentProps) {
  const isExpanded = expandedNodes.has(node.path)
  const hasChildren = node.children && node.children.length > 0
  const isFolder = node.type === 'folder' || hasChildren
  const setSelectedMemory = useUIStore((state) => state.setSelectedMemory)
  const setInspectorOpen = useUIStore((state) => state.setInspectorOpen)

  const handleClick = () => {
    if (isFolder) {
      onToggle(node.path)
    } else {
      // Select this memory
      setSelectedMemory(node.id)
      setInspectorOpen(true)
      onSelect?.(node.path)
    }
  }

  return (
    <div>
      <div
        onClick={handleClick}
        className="flex items-center gap-2 py-1.5 px-2 cursor-pointer glass-panel-hover rounded"
        style={{
          paddingLeft: `${depth * 12 + 8}px`,
          minWidth: 0,
        }}
      >
        {isFolder ? (
          <>
            <button
              onClick={(e) => {
                e.stopPropagation()
                onToggle(node.path)
              }}
              className="p-0.5 rounded hover:bg-white/10"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-clinical)' }} />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-clinical)' }} />
              )}
            </button>
            {isExpanded ? (
              <FolderOpen className="w-4 h-4" style={{ color: 'var(--color-azure)' }} />
            ) : (
              <Folder className="w-4 h-4" style={{ color: 'var(--color-azure)' }} />
            )}
          </>
        ) : (
          <>
            <span className="w-5" />
            <FileJson className="w-4 h-4" style={{ color: 'var(--color-amber)' }} />
          </>
        )}

        <span
          className="text-sm truncate flex-1"
          style={{
            color: isFolder ? 'var(--color-pristine)' : 'var(--color-clinical)',
          }}
          title={node.name}
        >
          {node.name}
        </span>

        {(node.memoryCount || 0) > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 rounded glass-panel"
            style={{ color: 'var(--color-clinical)' }}
          >
            {node.memoryCount}
          </span>
        )}
      </div>

      {isExpanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeComponent
              key={child.id}
              node={child}
              depth={depth + 1}
              expandedNodes={expandedNodes}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  )
}
