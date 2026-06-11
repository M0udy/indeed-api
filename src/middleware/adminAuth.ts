import type { NextFunction, Response } from 'express';
import { userService, UserService } from '../services/user.service';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';
import type { AuthenticatedRequest } from './auth';
import type { User } from '../types';

/**
 * Request that has passed admin authorization. After {@link adminOnly} runs,
 * `req.adminUser` is the full, verified admin user record.
 */
export interface AdminRequest extends AuthenticatedRequest {
  adminUser?: User;
}

/**
 * Require that the authenticated user is an admin.
 *
 * Runs AFTER {@link authenticate}. The admin role is read from the database on
 * every request (not from the JWT), so revoking or suspending an admin takes
 * effect immediately without waiting for token expiry. Suspended accounts are
 * rejected even if they hold the admin role.
 *
 * The user lookup is injected so the guard can be unit-tested without a DB.
 */
export function adminOnly(users: UserService = userService) {
  return async (req: AdminRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.auth) {
        throw new UnauthorizedError();
      }
      const user = await users.findById(req.auth.sub);
      if (!user) {
        throw new UnauthorizedError('User not found');
      }
      if (user.suspended_at !== null) {
        throw new ForbiddenError('Account is suspended');
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
