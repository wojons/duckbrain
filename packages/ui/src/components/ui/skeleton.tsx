/**
 * Skeleton Components
 *
 * Glassmorphism-styled loading skeletons for async states.
 * Uses animate-pulse with shimmer effect.
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import * as React from 'react'

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

interface SkeletonProps {
  className?: string
  shimmer?: boolean
}

/**
 * Base Skeleton component with glassmorphism styling
 */
export function Skeleton({ className, shimmer = true }: SkeletonProps) {
  return (
    <div
      className={cn(
        'rounded-md bg-white/5 animate-pulse',
        shimmer && 'relative overflow-hidden',
        className
      )}
    >
      {shimmer && (
        <div
          className="absolute inset-0 -translate-x-full animate-shimmer"
          style={{
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)',
          }}
        />
      )}
    </div>
  )
}

/**
 * Skeleton Card for card-like content loading
 */
export function SkeletonCard() {
  return (
    <div className="glass-panel p-4 space-y-3">
      <div className="flex items-center gap-3">
        <Skeleton className="w-10 h-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  )
}

/**
 * Skeleton Table for table content loading
 */
interface SkeletonTableProps {
  rows?: number
  columns?: number
}

export function SkeletonTable({ rows = 10, columns = 6 }: SkeletonTableProps) {
  return (
    <div className="glass-panel overflow-hidden">
      {/* Header */}
      <div
        className="grid gap-4 px-4 py-3 border-b"
        style={{
          borderColor: 'var(--color-glass-border)',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
        }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <Skeleton key={`header-${i}`} className="h-4" />
        ))}
      </div>

      {/* Rows */}
      <div className="divide-y" style={{ borderColor: 'var(--color-glass-border)' }}>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div
            key={`row-${rowIndex}`}
            className="grid gap-4 px-4 py-3 items-center"
            style={{
              gridTemplateColumns: `repeat(${columns}, 1fr)`,
            }}
          >
            {Array.from({ length: columns }).map((_, colIndex) => (
              <Skeleton
                key={`cell-${rowIndex}-${colIndex}`}
                className={cn(
                  'h-4',
                  colIndex === 0 && 'w-8',
                  colIndex === columns - 1 && 'w-24'
                )}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Skeleton Tree for tree view loading
 */
interface SkeletonTreeProps {
  depth?: number
  itemsPerLevel?: number
}

export function SkeletonTree({ depth = 3, itemsPerLevel = 4 }: SkeletonTreeProps) {
  const renderLevel = (currentDepth: number, maxDepth: number): React.ReactNode[] => {
    if (currentDepth > maxDepth) return []

    return Array.from({ length: itemsPerLevel }).map((_, i) => (
      <div key={`${currentDepth}-${i}`}>
        <div
          className="flex items-center gap-2 py-2 px-2"
          style={{ paddingLeft: `${currentDepth * 16 + 8}px` }}
        >
          <Skeleton className="w-4 h-4 rounded" />
          <Skeleton className="w-4 h-4 rounded" />
          <Skeleton className="h-4 flex-1 max-w-[200px]" />
        </div>
        {currentDepth < maxDepth && renderLevel(currentDepth + 1, maxDepth)}
      </div>
    ))
  }

  return (
    <div className="glass-panel p-2">
      {renderLevel(0, depth - 1)}
    </div>
  )
}

/**
 * Skeleton List for simple list loading
 */
interface SkeletonListProps {
  items?: number
}

export function SkeletonList({ items = 5 }: SkeletonListProps) {
  return (
    <div className="space-y-2">
      {Array.from({ length: items }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <Skeleton className="w-8 h-8 rounded" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}
