import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { authService, AuthService } from '../services/auth.service';
import { userService, UserService } from '../services/user.service';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { JwtPayload, User } from '../types';

/**
 * Authenticated request shape. After {@link authenticate} runs, `req.auth`,
 * `req.token`, and `req.user` are guaranteed to be present.
 */
export interface AuthenticatedRequest extends Request {
  auth?: JwtPayload;
  token?: string;
  user?: User;
}

/** Extract a Bearer token from the Authorization header. */
function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme !== 'Bearer' || !value) return null;
  return value.trim();
}

/** Collaborators for {@link createAuthenticate}, injectable for testing. */
export interface AuthenticateDeps {
  auth?: AuthService;
  users?: UserService;
}

/**
 * Build the authentication middleware.
 *
 * Validates a non-revoked JWT, loads the user, and — crucially — rejects
 * **suspended** accounts with a 403 even when their token is otherwise valid.
 * The user is read from the database on every request, so a suspension takes
 * effect immediately without waiting for token expiry.
 *
 * Populates `req.auth` (claims), `req.token` (raw token), and `req.user` (row).
 *
 * @throws 401 when the token is missing, malformed, expired, revoked, or its
 *         user no longer exists; 403 when the account is suspended.
 */
export function createAuthenticate(deps: AuthenticateDeps = {}): RequestHandler {
  const authSvc = deps.auth ?? authService;
  const users = deps.users ?? userService;

  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        throw new UnauthorizedError('Missing Bearer token');
      }

      const payload = await authSvc.verifyToken(token);

      const user = await users.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedError('User not found');
      }
      if (user.suspended_at !== null) {
        throw new ForbiddenError('Account suspended');
      }

      req.auth = payload;
      req.token = token;
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Default-wired authentication middleware used by the routers. */
export const authenticate = createAuthenticate();
