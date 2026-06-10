import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { AppError, isAppError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { TracedRequest } from './requestLogger';

/** Standard JSON error envelope returned for every failure. */
interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/**
 * 404 handler for unmatched routes. Registered after all routes.
 */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ErrorResponseBody = {
    error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.originalUrl}` },
  };
  res.status(404).json(body);
}

/**
 * Central error handler. Maps known error types to clean HTTP responses and
 * hides internal details for unexpected (500) errors. Must be the LAST `app.use`.
 */
export function errorHandler(
  err: unknown,
  req: TracedRequest,
  res: Response,
  // Express identifies an error handler by its 4-arg signature; `next` is required.
  _next: NextFunction,
): void {
  const requestId = req.id;

  // Our own typed errors → their declared status code.
  if (isAppError(err)) {
    respond(res, err.statusCode, err.code, err.message, err.details, requestId);
    return;
  }

  // Multer (file upload) errors → 400 with a friendly message.
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'Uploaded file is too large' : `Upload error: ${err.message}`;
    respond(res, 400, 'UPLOAD_ERROR', message, undefined, requestId);
    return;
  }

  // Anything else is unexpected: log the full error, return a generic 500.
  logger.error('Unhandled error', {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  respond(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred', undefined, requestId);
}

function respond(
  res: Response,
  status: number,
  code: string,
  message: string,
  details: unknown,
  requestId: string | undefined,
): void {
  const body: ErrorResponseBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  if (requestId !== undefined) body.error.requestId = requestId;
  res.status(status).json(body);
}

/** Re-export so callers can reference the base type if needed. */
export { AppError };
