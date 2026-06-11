/**
 * Typed application errors.
 *
 * Throw these from anywhere; the central error-handling middleware maps each to
 * the right HTTP status code and a safe JSON body. This keeps controllers free
 * of status-code bookkeeping and guarantees consistent error responses.
 */

/** Base class for all expected (operational) errors. */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: unknown;

  constructor(message: string, statusCode: number, code: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — request failed validation. */
export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

/** 401 — authentication is missing or invalid. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

/** 403 — authenticated but not permitted. */
export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

/** 404 — resource not found. */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

/** 409 — conflict with current state. */
export class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

/** 422 — request was well-formed but could not be processed. */
export class UnprocessableEntityError extends AppError {
  constructor(message = 'The request could not be processed', details?: unknown) {
    super(message, 422, 'UNPROCESSABLE_ENTITY', details);
  }
}

/** 402 — feature gated behind a paid subscription tier. */
export class PaymentRequiredError extends AppError {
  constructor(message = 'Upgrade your subscription to use this feature') {
    super(message, 402, 'PAYMENT_REQUIRED');
  }
}

/** 502 — an upstream third-party service failed. */
export class UpstreamServiceError extends AppError {
  constructor(message = 'An upstream service failed', details?: unknown) {
    super(message, 502, 'UPSTREAM_ERROR', details);
  }
}

/** Type guard for our own errors. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
