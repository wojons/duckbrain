/**
 * Empty State Component
 *
 * Reusable empty state with illustration and helpful copy.
 * Variations: no data, no search results, no filtered results.
 */

import { ReactNode } from 'react'
import { Search, FolderOpen, Filter, Database, Plus } from 'lucide-react'

interface EmptyStateProps {
  /**
   * Visual style of the empty state
   * - 'empty': No data exists yet
   * - 'search': Search returned no results
   * - 'filter': Filters returned no results
   * - 'error': Error state
   */
  variant: 'empty' | 'search' | 'filter' | 'error'
  /** Override default title */
  title?: string
  /** Override default description */
  description?: string
  /** Custom action button */
  action?: {
    label: string
    onClick: () => void
    icon?: ReactNode
  }
}

const variantConfig = {
  empty: {
    icon: Database,
    defaultTitle: 'No memories yet',
    defaultDescription: 'Memories will appear here once you start using the system.',
  },
  search: {
    icon: Search,
    defaultTitle: 'No memories found',
    defaultDescription: 'Try adjusting your search terms to find what you\'re looking for.',
  },
  filter: {
    icon: Filter,
    defaultTitle: 'No memories match',
    defaultDescription: 'Try clearing some filters to see more results.',
  },
  error: {
    icon: FolderOpen,
    defaultTitle: 'Something went wrong',
    defaultDescription: 'We couldn\'t load the data. Please try again.',
  },
}

/**
 * EmptyState component for displaying empty or error states
 * 
 * @example
 * // No data exists
 * <EmptyState variant="empty" />
 * 
 * @example
 * // Search with no results
 * <EmptyState
 *   variant="search"
 *   action={{ label: 'Clear Search', onClick: () => setSearch('') }}
 * />
 * 
 * @example
 * // Custom message
 * <EmptyState
 *   variant="empty"
 *   title="No keys found"
 *   description="This namespace doesn't have any keys yet."
 * />
 */
export function EmptyState({
  variant,
  title,
  description,
  action,
}: EmptyStateProps) {
  const config = variantConfig[variant]
  const Icon = config.icon

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center min-h-[200px]">
      {/* Icon */}
      <div
        className="w-16 h-16 mb-4 rounded-2xl flex items-center justify-center"
        style={{
          backgroundColor: 'var(--color-glass-bg)',
          border: '1px solid var(--color-glass-border)',
        }}
      >
        <Icon
          className="w-8 h-8"
          style={{ color: 'var(--color-clinical)', opacity: 0.7 }}
        />
      </div>

      {/* Title */}
      <h3
        className="text-lg font-medium mb-2"
        style={{ color: 'var(--color-pristine)' }}
      >
        {title ?? config.defaultTitle}
      </h3>

      {/* Description */}
      <p
        className="text-sm mb-6 max-w-md"
        style={{ color: 'var(--color-clinical)', opacity: 0.8 }}
      >
        {description ?? config.defaultDescription}
      </p>

      {/* Action Button */}
      {action && (
        <button
          onClick={action.onClick}
          className="glass-button flex items-center gap-2 px-4 py-2 text-sm"
        >
          {action.icon ?? <Plus className="w-4 h-4" />}
          {action.label}
        </button>
      )}
    </div>
  )
}

/**
 * Empty state specifically for table searches
 */
export function EmptySearchState({
  query,
  onClear,
}: {
  query: string
  onClear: () => void
}) {
  return (
    <EmptyState
      variant="search"
      title={`No memories found for "${query}"`}
      description="Try different search terms or check your spelling."
      action={{
        label: 'Clear Search',
        onClick: onClear,
        icon: <Search className="w-4 h-4" />,
      }}
    />
  )
}

/**
 * Empty state for filtered results
 */
export function EmptyFilterState({
  filterCount,
  onClear,
}: {
  filterCount: number
  onClear: () => void
}) {
  return (
    <EmptyState
      variant="filter"
      title={`No memories match ${filterCount} filter${filterCount > 1 ? 's' : ''}`}
      description="Try adjusting your filters to see more results."
      action={{
        label: 'Clear Filters',
        onClick: onClear,
        icon: <Filter className="w-4 h-4" />,
      }}
    />
  )
}

/**
 * Empty state for initial data load
 */
export function EmptyDataState({
  onCreate,
}: {
  onCreate?: () => void
}) {
  return (
    <EmptyState
      variant="empty"
      action={
        onCreate
          ? {
              label: 'Create Memory',
              onClick: onCreate,
              icon: <Plus className="w-4 h-4" />,
            }
          : undefined
      }
    />
  )
}
