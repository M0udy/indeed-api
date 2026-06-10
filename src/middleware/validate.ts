import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from 'zod';
import { ValidationError } from '../utils/errors';

/**
 * Request-validation middleware factory built on Zod.
 *
 * Each factory parses one part of the request (`body`, `query`, or `params`),
 * replaces it with the parsed-and-typed value, and forwards a structured
 * {@link ValidationError} (400) on failure. Parsed values are stashed on
 * `res.locals` so handlers read fully-typed data without re-validating.
 */

/** Where validated values are stored for downstream handlers to read. */
export interface ValidatedLocals {
  body?: unknown;
  queryParams?: unknown;
  params?: unknown;
}

function formatZodError(err: ZodError): Array<{ path: string; message: string }> {
  return err.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Validate `req.body` against `schema`. */
export function validateBody<S extends ZodTypeAny>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req.body) as ZodInfer<S>;
      (res.locals as ValidatedLocals).body = parsed;
      next();
    } catch (err) {
      next(toValidationError(err));
    }
  };
}

/** Validate `req.query` against `schema`. */
export function validateQuery<S extends ZodTypeAny>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req.query) as ZodInfer<S>;
      (res.locals as ValidatedLocals).queryParams = parsed;
      next();
    } catch (err) {
      next(toValidationError(err));
    }
  };
}

/** Validate `req.params` against `schema`. */
export function validateParams<S extends ZodTypeAny>(schema: S) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const parsed = schema.parse(req.params) as ZodInfer<S>;
      (res.locals as ValidatedLocals).params = parsed;
      next();
    } catch (err) {
      next(toValidationError(err));
    }
  };
}

function toValidationError(err: unknown): unknown {
  if (err instanceof ZodError) {
    return new ValidationError('Request validation failed', formatZodError(err));
  }
  return err;
}
