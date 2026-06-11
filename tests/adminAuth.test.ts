import { adminOnly } from '../src/middleware/adminAuth';
import type { UserService } from '../src/services/user.service';
import type { AdminRequest } from '../src/middleware/adminAuth';
import { ForbiddenError, UnauthorizedError } from '../src/utils/errors';
import type { User } from '../src/types';
import { mockRequest } from './helpers';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '+260123456789',
    email: null,
    name: 'Admin',
    kyc_status: 'verified',
    subscription_tier: 'enterprise',
    verification_badge: true,
    admin_role: 'admin',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function authedReq(): AdminRequest {
  const req = mockRequest() as AdminRequest;
  req.auth = { sub: 'user-1', phone: '+260123456789', tier: 'enterprise' };
  return req;
}

describe('adminOnly', () => {
  it('allows an admin through and attaches the admin user', async () => {
    const users = { findById: jest.fn().mockResolvedValue(fakeUser()) } as unknown as UserService;
    const req = authedReq();
    const next = jest.fn();

    await adminOnly(users)(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.adminUser?.id).toBe('user-1');
  });

  it('rejects a non-admin with ForbiddenError', async () => {
    const users = {
      findById: jest.fn().mockResolvedValue(fakeUser({ admin_role: 'user' })),
    } as unknown as UserService;
    const next = jest.fn();

    await adminOnly(users)(authedReq(), {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('rejects a suspended admin', async () => {
    const users = {
      findById: jest.fn().mockResolvedValue(fakeUser({ suspended_at: new Date() })),
    } as unknown as UserService;
    const next = jest.fn();

    await adminOnly(users)(authedReq(), {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(ForbiddenError));
  });

  it('rejects an unauthenticated request', async () => {
    const users = { findById: jest.fn() } as unknown as UserService;
    const req = mockRequest() as AdminRequest; // no req.auth
    const next = jest.fn();

    await adminOnly(users)(req, {} as never, next);

    expect(next).toHaveBeenCalledWith(expect.any(UnauthorizedError));
    expect(users.findById).not.toHaveBeenCalled();
  });
});
