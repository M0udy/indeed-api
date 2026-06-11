import type { NextFunction, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { AuthenticatedRequest } from './auth';
import type { User } from '../types';

/**
 * Request that has passed admin authorization. After {@link adminOnly} runs,
 * `req.adminUser` is the verified admin user record.
 */
export interface AdminRequest extends AuthenticatedRequest {
  adminUser?: User;
}

/**
 * Require that the authenticated user is an admin.
 *
 * Runs AFTER {@link authenticate}, which has already loaded the user (rejecting
 * suspended accounts) and attached it as `req.user`. This middleware therefore
 * reuses that record instead of issuing a second database lookup — the user is
 * loaded exactly once per request.
 *
 * If `req.user` is missing the route is mis-wired (adminOnly placed before
 * authenticate); we fail closed with a 401 rather than assume anything.
 */
export function adminOnly() {
  return (req: AdminRequest, _res: Response, next: NextFunction): void => {
    try {
      const user = req.user;
      if (!user) {
        // Defensive: should be unreachable when wired as [authenticate, adminOnly()].
        throw new UnauthorizedError('Authentication required');
      }
      if (user.admin_role !== 'admin') {
        throw new ForbiddenError('Admin access required');
      }
      req.adminUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}
