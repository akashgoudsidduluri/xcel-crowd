/**
 * ============================================================================
 * ERROR HANDLER MIDDLEWARE
 * ============================================================================
 *
 * Centralized error handling with domain-aware, structured responses.
 * 
 * Handles:
 * - AppError (unified production errors)
 * - Legacy custom errors (backward compatibility)
 * - PostgreSQL errors (constraint violations)
 * - Unknown errors (safe 500 fallback)
 */

import { Request, Response, NextFunction } from 'express';
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  DatabaseError,
  StateTransitionError
} from '../errors';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log the error for debugging with full context
  const errorContext = {
    method: req.method,
    path: req.path,
    timestamp: new Date().toISOString(),
    ...(err instanceof Error && { stack: err.stack }),
  };
  console.error('[ERROR]', JSON.stringify(errorContext), err);

  // PRIORITY 1: Handle unified AppError (production errors with domain codes)
  if (err instanceof AppError) {
    const response: any = {
      error: err.code,
      message: err.message,
    };
    if (err.details) {
      response.details = err.details;
    }
    res.status(err.statusCode).json(response);
    return;
  }

  // PRIORITY 2: Handle legacy custom errors (backward compatibility)
  if (err instanceof ValidationError) {
    res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: err.message,
      details: err.details,
    });
    return;
  }

  if (err instanceof NotFoundError) {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: err.message,
    });
    return;
  }

  if (err instanceof ConflictError) {
    res.status(409).json({
      error: 'CONFLICT',
      message: err.message,
    });
    return;
  }

  if (err instanceof StateTransitionError) {
    res.status(400).json({
      error: 'INVALID_TRANSITION',
      message: err.message,
    });
    return;
  }

  if (err instanceof DatabaseError) {
    res.status(500).json({
      error: 'DATABASE_ERROR',
      message: 'Internal database error occurred',
    });
    return;
  }

  // PRIORITY 3: Handle PostgreSQL errors
  if ('code' in err) {
    const pgError = err as any;

    // Unique constraint violation
    if (pgError.code === '23505') {
      res.status(409).json({
        error: 'DUPLICATE_ENTRY',
        message: 'Resource already exists',
      });
      return;
    }

    // Foreign key constraint violation
    if (pgError.code === '23503') {
      res.status(400).json({
        error: 'INVALID_REFERENCE',
        message: 'Referenced resource does not exist',
      });
      return;
    }

    // Check constraint violation
    if (pgError.code === '23514') {
      res.status(400).json({
        error: 'CONSTRAINT_VIOLATION',
        message: 'Data violates business rules',
      });
      return;
    }
  }

  // PRIORITY 4: Default 500 error (unknown/unhandled)
  res.status(500).json({
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred. Please try again later.',
  });
}