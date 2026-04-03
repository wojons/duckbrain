import { useMemo, useState, useRef, useCallback } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
  HeaderGroup,
  Header,
  Cell,
  SortingState,

} from '@tanstack/react-table'
import { useVirtualizer, VirtualItem } from '@tanstack/react-virtual'
import { ChevronDown, Loader2, ArrowUp, ArrowDown } from 'lucide-react'
import { useInfiniteMemories } from '../hooks/use-memories'
import { useUIStore } from '../stores/ui-store'
import { MemoryResponse } from '../../../../src/http/types/api'
import { SkeletonTable } from './ui/skeleton'
import { ErrorCard } from './ui/error-boundary'
import { BulkActionBar } from './bulk-action-bar'

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
  const selectedMemory = useUIStore((state) => state.selectedMemory)

  const { 
    data, 
    isLoading, 
    error, 
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage
  } = useInfiniteMemories({
    namespace,
    query: searchQuery || undefined,
    limit: 50,
  })

  const [rowSelection, setRowSelection] = useState<Record<string, boolean>>({})
  const [sorting, setSorting] = useState<SortingState>([])

  // Flatten paginated data
  const memories = useMemo(() => {
    return data?.pages.flatMap(page => page.items) || []
  }, [data])

  // Detect when user scrolls near bottom and load more
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget
    const { scrollTop, scrollHeight, clientHeight } = target
    const scrollBottom = scrollHeight - scrollTop - clientHeight
    
    // Load more when within 200px of bottom
    if (scrollBottom < 200 && hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'select',
        header: ({ table }) => (
          <div className="flex items-center justify-center">
            <input
              type="checkbox"
              checked={table.getIsAllRowsSelected()}
              onChange={table.getToggleAllRowsSelectedHandler()}
              className="w-4 h-4 rounded border-gray-400 bg-transparent cursor-pointer"
            />
          </div>
        ),
        cell: ({ row }) => (
          <div className="flex items-center justify-center">
            <input
              type="checkbox"
              checked={row.getIsSelected()}
              onChange={row.getToggleSelectedHandler()}
              onClick={(e) => e.stopPropagation()}
              className="w-4 h-4 rounded border-gray-400 bg-transparent cursor-pointer"
            />
          </div>
        ),
        size: 48,
        enableSorting: false,
      }),
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
        enableSorting: false,
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
        enableSorting: true,
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
        enableSorting: true,
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
        enableSorting: true,
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
        enableSorting: true,
      }),
      columnHelper.accessor('author', {
        header: 'Author',
        cell: (info: { getValue: () => string }) => (
          <span className="text-sm" style={{ color: 'var(--color-clinical)' }}>
            {info.getValue()}
          </span>
        ),
        size: 150,
        enableSorting: true,
      }),
    ],
    []
  )

  const table = useReactTable({
    data: memories,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
    state: {
      rowSelection,
      sorting,
    },
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
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

  const handleRowClick = (e: React.MouseEvent, memory: MemoryResponse) => {
    // Stop propagation to prevent parent handlers
    e.stopPropagation()
    e.preventDefault()
    
    if (memory.id) {
      setSelectedMemory(memory.id)
      setInspectorOpen(true)
    }
  }

  if (isLoading) {
    return (
      <div className="p-4">
        <SkeletonTable rows={10} columns={6} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-8">
        <ErrorCard
          title="Failed to load memories"
          error={error}
          onRetry={() => refetch()}
          retryLabel="Retry"
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div
        ref={parentRef}
        className="glass-panel overflow-auto flex-1"
        style={{ height: 'calc(100vh - 340px)' }}
        onScroll={handleScroll}
      >
        <table className="w-full">
          <thead className="sticky top-0 z-10">
          {table.getHeaderGroups().map((headerGroup: HeaderGroup<MemoryResponse>) => (
            <tr
              key={headerGroup.id}
              className="border-b"
              style={{ borderColor: 'var(--color-glass-border)' }}
            >
              {headerGroup.headers.map((header: Header<MemoryResponse, unknown>) => {
                const isSortable = header.column.getCanSort()
                const sortDirection = header.column.getIsSorted()
                
                return (
                  <th
                    key={header.id}
                    className={`
                      text-left px-4 py-3 text-xs font-medium uppercase tracking-wider
                      ${isSortable ? 'cursor-pointer select-none hover:bg-white/5' : ''}
                    `}
                    style={{
                      color: 'var(--color-clinical)',
                      width: header.getSize(),
                      backgroundColor: 'var(--color-midnight)',
                    }}
                    onClick={isSortable ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <div className="flex items-center gap-2">
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                      {isSortable && sortDirection && (
                        sortDirection === 'asc' ? (
                          <ArrowUp className="w-3 h-3" style={{ color: 'var(--color-azure)' }} />
                        ) : (
                          <ArrowDown className="w-3 h-3" style={{ color: 'var(--color-azure)' }} />
                        )
                      )}
                    </div>
                  </th>
                )
              })}
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
              const isSelected = selectedMemory === memory.id

              return (
                <tr
                  key={row.id}
                  onClick={(e) => handleRowClick(e, memory)}
                  className={`
                    cursor-pointer glass-panel-hover border-b last:border-0
                    transition-colors
                    ${isSelected ? 'bg-white/10 border-azure/30' : ''}
                  `}
                  style={{
                    borderColor: isSelected ? 'var(--color-azure)' : 'var(--color-glass-border)',
                    transform: `translateY(${virtualRow.start}px)`,
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: `${virtualRow.size}px`,
                    backgroundColor: isSelected ? 'rgba(0, 212, 255, 0.05)' : undefined,
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
      
      {/* Load More Button */}
      {hasNextPage && (
        <div className="py-3 border-t flex justify-center" style={{ borderColor: 'var(--color-glass-border)' }}>
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="glass-button flex items-center gap-2 px-6 py-2 text-sm"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading...
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4" />
                Load More
              </>
            )}
          </button>
        </div>
      )}

      {/* Bulk Action Bar */}
      <BulkActionBar
        selectedRows={table.getSelectedRowModel().rows.map(row => row.original)}
        onClearSelection={() => setRowSelection({})}
      />
    </div>
  )
}
