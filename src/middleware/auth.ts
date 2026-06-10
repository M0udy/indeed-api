import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/auth.service';
import { UnauthorizedError } from '../utils/errors';
import type { JwtPayload } from '../types';

/**
 * Authenticated request shape. After {@link authenticate} runs, `req.auth` and
 * `req.token` are guaranteed to be present.
 */
export interface AuthenticatedRequest extends Request {
  auth?: JwtPayload;
  token?: string;
}

/** Extract a Bearer token from the Authorization header. */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value.trim();
}

/**
 * Require a valid, non-revoked JWT. Populates `req.auth` with the decoded
 * payload and `req.token` with the raw token, then calls `next()`.
 *
 * Rejects with 401 (via the error middleware) when the token is missing,
 * malformed, expired, or revoked.
 */
export async function authenticate(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      throw new UnauthorizedError('Missing Bearer token');
    }
    const payload = await authService.verifyToken(token);
    req.auth = payload;
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}
