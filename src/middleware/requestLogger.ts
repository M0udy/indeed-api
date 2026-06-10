import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/** Request augmented with a correlation id for tracing. */
export interface TracedRequest extends Request {
  id?: string;
}

/**
 * Log every request once it completes, with method, path, status, duration, and
 * a per-request correlation id (also echoed back in the `X-Request-Id` header).
 */
export function requestLogger(req: TracedRequest, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);

  const start = Date.now();
  logger.info('→ request', { requestId, method: req.method, path: req.originalUrl });

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('← response', {
      requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}
