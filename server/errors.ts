/**
 * ============================================================================
 * CUSTOM ERROR CLASSES
 * ============================================================================
 *
 * Production-grade error handling with structured responses.
 * 
 * Unified AppError: Standard error class with domain codes and HTTP status
 * Legacy classes: Maintained for backward compatibility
 */

/**
 * Standardized Error Codes
 */
export const ERROR_CODES = {
  DUPLICATE_APPLICATION: 'APP_ERR_DUPLICATE',
  CAPACITY_LIMIT_REACHED: 'APP_ERR_CAPACITY_FULL',
  INVALID_TRANSITION: 'APP_ERR_INVALID_STATE_CHANGE',
  ACK_DEADLINE_EXPIRED: 'APP_ERR_ACK_TIMEOUT',
  JOB_NOT_FOUND: 'APP_ERR_JOB_NOT_FOUND',
  APP_NOT_FOUND: 'APP_ERR_NOT_FOUND',
  INVALID_EXIT: 'APP_ERR_INVALID_EXIT',
};

/**
 * Unified application error class
 * Provides: code (domain error), statusCode (HTTP), message, and optional details
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Legacy error classes (maintained for backward compatibility)
 */
export class ValidationError extends Error {
  constructor(message: string, public details?: any) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string, id?: string) {
    super(`${resource}${id ? ` with id ${id}` : ''} not found`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class DatabaseError extends Error {
  constructor(message: string, public originalError?: Error) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class StateTransitionError extends Error {
  constructor(fromStatus: string, toStatus: string, reason?: string) {
    super(`Invalid state transition from ${fromStatus} to ${toStatus}${reason ? `: ${reason}` : ''}`);
    this.name = 'StateTransitionError';
  }
}