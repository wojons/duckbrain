import React from 'react'
import { Folder, FileText, ChevronRight } from 'lucide-react'

export default function Tree() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold mb-1" style={{ color: 'var(--color-pristine)' }}>
            Memory Tree
          </h2>
          <p style={{ color: 'var(--color-clinical)' }}>
            Hierarchical view of all memory keys
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Search keys..."
            className="glass-input px-4 py-2 text-sm w-64"
          />
        </div>
      </div>

      <div className="glass-panel p-4">
        <div className="flex items-center gap-2 mb-4 pb-3 border-b" style={{ borderColor: 'var(--color-glass-border)' }}>
          <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>Root</span>
          <ChevronRight className="w-4 h-4" style={{ color: 'var(--color-clinical)' }} />
          <span className="text-sm" style={{ color: 'var(--color-pristine)' }}>/</span>
        </div>

        <div className="space-y-1">
          <TreeItem
            name="chat"
            type="folder"
            children={[
              { name: 'sessions', type: 'folder', count: 3 },
              { name: 'archived', type: 'folder', count: 0 },
            ]}
          />
          <TreeItem
            name="config"
            type="folder"
            children={[
              { name: 'settings', type: 'file' },
              { name: 'preferences', type: 'file' },
            ]}
          />
          <TreeItem
            name="concepts"
            type="folder"
            children={[
              { name: 'architecture', type: 'folder', count: 5 },
              { name: 'patterns', type: 'folder', count: 12 },
            ]}
          />
          <TreeItem
            name="events"
            type="folder"
            expanded={false}
          />
          <TreeItem
            name="people"
            type="folder"
            expanded={false}
          />
          <TreeItem
            name="projects"
            type="folder"
            children={[
              { name: 'mcp', type: 'folder', count: 8 },
              { name: 'memory-system', type: 'folder', count: 42 },
              { name: 'ui', type: 'folder', count: 3 },
            ]}
          />
          <TreeItem
            name="system"
            type="folder"
            children={[
              { name: 'status', type: 'file' },
              { name: 'metrics', type: 'file' },
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="glass-panel p-4 text-center">
          <div className="text-2xl font-semibold mb-1" style={{ color: 'var(--color-azure)' }}>6</div>
          <div className="text-sm" style={{ color: 'var(--color-clinical)' }}>Top-level domains</div>
        </div>
        <div className="glass-panel p-4 text-center">
          <div className="text-2xl font-semibold mb-1" style={{ color: 'var(--color-amber)' }}>12</div>
          <div className="text-sm" style={{ color: 'var(--color-clinical)' }}>Subdirectories</div>
        </div>
        <div className="glass-panel p-4 text-center">
          <div className="text-2xl font-semibold mb-1" style={{ color: 'var(--color-success)' }}>73</div>
          <div className="text-sm" style={{ color: 'var(--color-clinical)' }}>Total memories</div>
        </div>
      </div>
    </div>
  )
}

interface TreeItemProps {
  name: string
  type: 'folder' | 'file'
  expanded?: boolean
  children?: { name: string; type: 'folder' | 'file'; count?: number }[]
}

function TreeItem({ name, type, expanded = true, children }: TreeItemProps) {
  return (
    <div>
      <div className="flex items-center gap-2 py-2 px-3 rounded-lg cursor-pointer glass-panel-hover">
        {type === 'folder' ? (
          <React.Fragment>
            <ChevronRight
              className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
              style={{ color: 'var(--color-clinical)' }}
            />
            <Folder className="w-4 h-4" style={{ color: 'var(--color-azure)' }} />
          </React.Fragment>
        ) : (
          <FileText className="w-4 h-4" style={{ color: 'var(--color-amber)' }} />
        )}
        <span className="text-sm flex-1" style={{ color: 'var(--color-pristine)' }}>{name}</span>
        
        {children && children.length > 0 && (
          <span className="text-xs px-2 py-0.5 rounded glass-panel" style={{ color: 'var(--color-clinical)' }}>
            {children.reduce((acc, child) => acc + (child.count || 1), 0)}
          </span>
        )}
      </div>
      
      {expanded && children && children.length > 0 && (
        <div className="ml-6 mt-1 space-y-1 border-l pl-3" style={{ borderColor: 'var(--color-glass-border)' }}>
          {children.map((child) => (
            <div
              key={child.name}
              className="flex items-center gap-2 py-1.5 px-3 rounded cursor-pointer glass-panel-hover"
            >
              {child.type === 'folder' ? (
                <React.Fragment>
                  <ChevronRight className="w-3 h-3" style={{ color: 'var(--color-clinical)' }} />
                  <Folder className="w-3.5 h-3.5" style={{ color: 'var(--color-azure)' }} />
                </React.Fragment>
              ) : (
                <FileText className="w-3.5 h-3.5" style={{ color: 'var(--color-amber)' }} />
              )}
              <span className="text-sm flex-1" style={{ color: 'var(--color-clinical)' }}>{child.name}</span>
              
              {child.count !== undefined && child.count > 0 && (
                <span className="text-xs px-2 py-0.5 rounded glass-panel" style={{ color: 'var(--color-clinical)' }}>
                  {child.count}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
