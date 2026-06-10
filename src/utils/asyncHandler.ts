import type { NextFunction, Request, Response, RequestHandler } from 'express';

/**
 * Wrap an async Express handler so that any rejected promise is forwarded to
 * `next()` and caught by the central error middleware. Without this, async
 * throws become unhandled rejections instead of clean HTTP error responses.
 *
 * @example
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
