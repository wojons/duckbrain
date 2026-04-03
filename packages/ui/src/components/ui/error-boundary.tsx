/**
 * Error Boundary Components
 *
 * React Error Boundaries for catching and displaying errors.
 * Includes retry functionality with glassmorphism styling.
 */

import * as React from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  fallback?: React.ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  onRetry?: () => void
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * Error Boundary class component for catching React errors
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
    this.props.onRetry?.()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorCard
          title="Something went wrong"
          error={this.state.error}
          onRetry={this.handleRetry}
        />
      )
    }

    return this.props.children
  }
}

interface ErrorCardProps {
  title: string
  error?: Error | null
  message?: string
  onRetry?: () => void
  retryLabel?: string
}

/**
 * Error Card component for displaying errors with retry
 */
export function ErrorCard({
  title,
  error,
  message,
  onRetry,
  retryLabel = 'Try Again',
}: ErrorCardProps) {
  return (
    <div
      className="glass-panel p-6 space-y-4"
      style={{ borderColor: 'var(--color-error)', borderWidth: '1px' }}
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          className="w-6 h-6 flex-shrink-0 mt-0.5"
          style={{ color: 'var(--color-error)' }}
        />
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-base" style={{ color: 'var(--color-pristine)' }}>
            {title}
          </h3>
          
          {message && (
            <p className="mt-1 text-sm" style={{ color: 'var(--color-clinical)' }}>
              {message}
            </p>
          )}
          
          {error && (
            <div
              className="mt-3 p-3 rounded bg-black/20 font-mono text-xs overflow-x-auto"
              style={{ color: 'var(--color-error)' }}
            >
              <code>{error.message}</code>
            </div>
          )}
        </div>
      </div>

      {onRetry && (
        <button
          onClick={onRetry}
          className="glass-button flex items-center gap-2 px-4 py-2 text-sm"
        >
          <RefreshCw className="w-4 h-4" />
          {retryLabel}
        </button>
      )}
    </div>
  )
}

interface AsyncErrorBoundaryProps extends Omit<ErrorBoundaryProps, 'onRetry'> {
  queryKey?: string[]
}

/**
 * Async Error Boundary with automatic retry for data fetching
 * 
 * @deprecated Use ErrorBoundary with ErrorCard for manual retry instead
 */
export class AsyncErrorBoundary extends React.Component<
  AsyncErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: AsyncErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('AsyncErrorBoundary caught an error:', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
    // Force re-render which will re-run data fetching
    this.forceUpdate()
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <ErrorCard
          title="Failed to load data"
          error={this.state.error}
          onRetry={this.handleRetry}
          retryLabel="Retry"
        />
      )
    }

    return this.props.children
  }
}
