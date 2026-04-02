/**
 * Error Handling Middleware
 *
 * Express middleware for handling errors and returning structured JSON responses.
 * Follows centralized architecture: converts errors to API-friendly format.
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/**
 * Custom API error class with status code
 */
export class ApiError extends Error {
  public status: number;
  public code?: string;

  constructor(message: string, status: number = 500, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Not found error (404)
 */
export class NotFoundError extends ApiError {
  constructor(resource: string, id?: string) {
    const message = id 
      ? `${resource} '${id}' not found` 
      : `${resource} not found`;
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

/**
 * Validation error (400)
 */
export class ValidationError extends ApiError {
  public fields?: Record<string, string>;

  constructor(message: string, fields?: Record<string, string>) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
    this.fields = fields;
  }
}

/**
 * Format Zod validation errors into field map
 */
function formatZodErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  
  for (const issue of error.issues) {
    const path = issue.path.join('.');
    fields[path || 'general'] = issue.message;
  }
  
  return fields;
}

/**
 * Error handler middleware
 * 
 * Catches all errors and returns structured JSON response.
 * Must be registered last in middleware chain (after all routes).
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Log error for debugging
  console.error('[API Error]', {
    path: req.path,
    method: req.method,
    error: err.message,
    stack: err.stack?.split('\n').slice(0, 5)
  });

  // Handle specific error types
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: err.message,
      code: err.code,
      ...(err instanceof ValidationError && err.fields ? { fields: err.fields } : {})
    });
    return;
  }

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    const fields = formatZodErrors(err);
    res.status(400).json({
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      fields
    });
    return;
  }

  // Handle syntax errors (malformed JSON)
  if (err.name === 'SyntaxError' && 'body' in err) {
    res.status(400).json({
      error: 'Invalid JSON in request body',
      code: 'INVALID_JSON'
    });
    return;
  }

  // Generic server error (don't leak internal details)
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR'
  });
}

/**
 * 404 Not Found handler
 * 
 * Catches requests to undefined routes.
 * Must be registered after all valid routes.
 */
export function notFoundHandler(
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  res.status(404).json({
    error: `Route ${req.method} ${req.path} not found`,
    code: 'ROUTE_NOT_FOUND'
  });
}

/**
 * Async handler wrapper
 * 
 * Wraps async route handlers to catch errors automatically.
 * Usage: router.get('/', asyncHandler(async (req, res) => { ... }))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
