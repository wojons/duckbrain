import { useMemo, useState, useRef } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
  HeaderGroup,
  Header,
  Cell,
} from '@tanstack/react-table'
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual'
import { useMemories } from '../hooks/use-memories'
import { useUIStore } from '../stores/ui-store'
import { MemoryResponse } from '../../../../src/http/types/api'

interface MemoryTableProps {
  namespace?: string
}

const columnHelper = createColumnHelper<MemoryResponse>()

/**
 * Memory Table Component
 *
 * TanStack Table with virtual scrolling for large datasets.
 * Shows memory list with state, key, domain, action, timestamp.
 */
export function MemoryTable({ namespace }: MemoryTableProps) {
  const searchQuery = useUIStore((state) => state.searchQuery)
  const setSelectedMemory = useUIStore((state) => state.setSelectedMemory)
  const setInspectorOpen = useUIStore((state) => state.setInspectorOpen)

  const { data, isLoading, error } = useMemories({
    namespace,
    query: searchQuery || undefined,
    limit: 100,
  })

  const [rowSelection, setRowSelection] = useState({})

  const memories = useMemo(() => {
    return data?.items || []
  }, [data])

  const columns = useMemo(
    () => [
      columnHelper.accessor('isTombstone', {
        header: 'State',
        cell: (info: { getValue: () => boolean }) => {
          const isTombstone = info.getValue()
          return (
            <div className="flex items-center justify-center">
              <div
                className={`w-2.5 h-2.5 rounded-full ${
                  isTombstone ? 'bg-red-500/50' : 'bg-green-500'
                }`}
                style={{
                  boxShadow: isTombstone
                    ? 'none'
                    : '0 0 8px rgba(0, 255, 102, 0.6)',
                }}
              />
            </div>
          )
        },
        size: 60,
      }),
      columnHelper.accessor('key', {
        header: 'Key Path',
        cell: (info: { getValue: () => string; row: { original: MemoryResponse } }) => {
          const isTombstone = info.row.original.isTombstone
          return (
            <span
              className={`font-mono text-sm ${
                isTombstone ? 'line-through opacity-40' : ''
              }`}
              style={{ color: 'var(--color-azure)' }}
            >
              {info.getValue()}
            </span>
          )
        },
        size: 300,
      }),
      columnHelper.accessor('domain', {
        header: 'Domain',
        cell: (info: { getValue: () => string }) => {
          const domain = info.getValue()
          const colors: Record<string, string> = {
            config: 'var(--color-azure)',
            message: 'var(--color-amber)',
            concept: 'var(--color-success)',
            person: 'var(--color-pristine)',
            project: 'var(--color-clinical)',
            system: 'var(--color-error)',
          }
          return (
            <span
              className="text-xs px-2 py-1 rounded-full"
              style={{
                backgroundColor: `${colors[domain] || 'var(--color-clinical)'}20`,
                color: colors[domain] || 'var(--color-clinical)',
              }}
            >
              {domain}
            </span>
          )
        },
        size: 100,
      }),
      columnHelper.accessor('action', {
        header: 'Action',
        cell: (info: { getValue: () => string }) => {
          const action = info.getValue()
          const colors: Record<string, string> = {
            add: 'var(--color-success)',
            update: 'var(--color-amber)',
            tombstone: 'var(--color-error)',
          }
          return (
            <span
              className="text-xs px-2 py-1 rounded-full capitalize"
              style={{
                backgroundColor: `${colors[action] || 'var(--color-clinical)'}20`,
                color: colors[action] || 'var(--color-clinical)',
              }}
            >
              {action}
            </span>
          )
        },
        size: 100,
      }),
      columnHelper.accessor('timestamp', {
        header: 'Timestamp',
        cell: (info: { getValue: () => string }) => {
          const date = new Date(info.getValue())
          return (
            <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>
              {date.toLocaleString()}
            </span>
          )
        },
        size: 180,
      }),
      columnHelper.accessor('author', {
        header: 'Author',
        cell: (info: { getValue: () => string }) => (
          <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>
            {info.getValue()}
          </span>
        ),
        size: 150,
      }),
    ],
    []
  )

  const table = useReactTable({
    data: memories,
    columns,
    getCoreRowModel: getCoreRowModel(),
    state: {
      rowSelection,
    },
    onRowSelectionChange: setRowSelection,
  })

  const { rows } = table.getRowModel()

  // Virtual scrolling setup
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  })

  const handleRowClick = (memory: MemoryResponse) => {
    setSelectedMemory(memory.id)
    setInspectorOpen(true)
  }

  if (isLoading) {
    return (
      <div className="glass-panel p-8 text-center">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-azure border-t-transparent rounded-full" />
        <p className="mt-4 text-sm" style={{ color: 'var(--color-clinical)' }}>
          Loading memories...
        </p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="glass-panel p-8 text-center">
        <p style={{ color: 'var(--color-error)' }}>
          Error loading memories: {error.message}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={parentRef}
      className="glass-panel overflow-auto"
      style={{ height: 'calc(100vh - 280px)' }}
    >
      <table className="w-full">
        <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map((headerGroup: HeaderGroup<MemoryResponse>) => (
            <tr
              key={headerGroup.id}
              className="border-b"
              style={{ borderColor: 'var(--color-glass-border)' }}
            >
              {headerGroup.headers.map((header: Header<MemoryResponse, unknown>) => (
                <th
                  key={header.id}
                  className="text-left px-4 py-3 text-xs font-medium uppercase tracking-wider"
                  style={{
                    color: 'var(--color-clinical)',
                    width: header.getSize(),
                    backgroundColor: 'var(--color-midnight)',
                  }}
                >
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow: VirtualItem) => {
            const row = rows[virtualRow.index]
            const memory = row.original

            return (
              <tr
                key={row.id}
                onClick={() => handleRowClick(memory)}
                className="cursor-pointer glass-panel-hover border-b last:border-0"
                style={{
                  borderColor: 'var(--color-glass-border)',
                  transform: `translateY(${virtualRow.start}px)`,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                }}
              >
                {row.getVisibleCells().map((cell: Cell<MemoryResponse, unknown>) => (
                  <td
                    key={cell.id}
                    className="px-4 py-3 whitespace-nowrap overflow-hidden text-ellipsis"
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
