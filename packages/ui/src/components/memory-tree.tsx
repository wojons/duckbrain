import { useState } from 'react'
import { Folder, FolderOpen, FileJson, ChevronRight, ChevronDown } from 'lucide-react'
import { useKeys } from '../hooks/use-keys'
import { useUIStore } from '../stores/ui-store'
import { KeyNode } from '../../../../src/http/types/api'
import { SkeletonTree } from './ui/skeleton'
import { ErrorCard } from './ui/error-boundary'
import { EmptyState } from './ui/empty-state'

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
  const { data, isLoading, error, refetch } = useKeys({ namespace })
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const selectedMemory = useUIStore((state) => state.selectedMemory)

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
      <div className="h-full overflow-y-auto custom-scrollbar p-2">
        <SkeletonTree depth={3} itemsPerLevel={3} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto custom-scrollbar p-4">
        <ErrorCard
          title="Failed to load keys"
          error={error}
          onRetry={() => refetch()}
          retryLabel="Retry"
        />
      </div>
    )
  }

  const tree = data?.tree || []

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      {tree.length === 0 ? (
        <EmptyState
          variant="empty"
          title="No memories yet"
          description="Memories will appear here once you start using the system."
        />
      ) : (
        tree.map((node) => (
          <TreeNodeComponent
            key={node.id}
            node={node}
            depth={0}
            expandedNodes={expandedNodes}
            onToggle={toggleNode}
            onSelect={onSelectKey}
            selectedMemory={selectedMemory}
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
  selectedMemory: string | null
}

function TreeNodeComponent({
  node,
  depth,
  expandedNodes,
  onToggle,
  onSelect,
  selectedMemory,
}: TreeNodeComponentProps) {
  const isExpanded = expandedNodes.has(node.path)
  const hasChildren = node.children && node.children.length > 0
  const isFolder = node.type === 'folder' || hasChildren
  const setSelectedMemory = useUIStore((state) => state.setSelectedMemory)
  const setInspectorOpen = useUIStore((state) => state.setInspectorOpen)

  // Check if this node or any of its children is selected
  const isSelected = !isFolder && selectedMemory === node.id

  const handleSelectMemory = (e: React.MouseEvent) => {
    // Stop propagation to prevent parent handlers
    e.stopPropagation()
    if (!isFolder) {
      // Select this memory
      setSelectedMemory(node.id)
      setInspectorOpen(true)
      onSelect?.(node.path)
    }
  }

  const handleToggleFolder = (e: React.MouseEvent) => {
    // Stop propagation to prevent row click
    e.stopPropagation()
    if (isFolder) {
      onToggle(node.path)
    }
  }

  return (
    <div>
      <div
        className={`
          flex items-center gap-2 py-1.5 px-2 cursor-pointer 
          glass-panel-hover rounded transition-colors
          ${isSelected ? 'bg-white/10 border border-azure/30' : ''}
        `}
        style={{
          paddingLeft: `${depth * 12 + 8}px`,
          minWidth: 0,
          borderColor: isSelected ? 'var(--color-azure)' : undefined,
        }}
        onClick={handleSelectMemory}
      >
        {isFolder ? (
          <>
            {/**
             * Chevron button - ONLY this toggles the folder
             * Stops propagation to prevent row click
             */}
            <button
              onClick={handleToggleFolder}
              className="p-0.5 rounded hover:bg-white/10 flex-shrink-0"
              title={isExpanded ? 'Collapse folder' : 'Expand folder'}
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-clinical)' }} />
              ) : (
                <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-clinical)' }} />
              )}
            </button>
            
            {/**
             * Folder icon and name
             * For folders: clicking here opens the first memory in the folder
             * or we can make it just visual (no click action)
             */}
            <div
              className="flex items-center gap-2 flex-1 min-w-0"
              onClick={(e) => {
                // If clicking folder content, toggle folder
                // Don't open inspector for folders
                e.stopPropagation()
                onToggle(node.path)
              }}
            >
              {isExpanded ? (
                <FolderOpen className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-azure)' }} />
              ) : (
                <Folder className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-azure)' }} />
              )}
              <span
                className="text-sm truncate"
                style={{ color: 'var(--color-pristine)' }}
                title={node.name}
              >
                {node.name}
              </span>
            </div>
          </>
        ) : (
          <>
            {/**
             * Memory file (leaf node)
             * The entire row is clickable to open inspector
             */}
            <span className="w-5 flex-shrink-0" />
            <FileJson
              className="w-4 h-4 flex-shrink-0"
              style={{ color: 'var(--color-amber)' }}
            />
            <span
              className="text-sm truncate flex-1"
              style={{ color: 'var(--color-clinical)' }}
              title={node.name}
            >
              {node.name}
            </span>
          </>
        )}

        {(node.memoryCount || 0) > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 rounded glass-panel flex-shrink-0"
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
              selectedMemory={selectedMemory}
            />
          ))}
        </div>
      )}
    </div>
  )
}
