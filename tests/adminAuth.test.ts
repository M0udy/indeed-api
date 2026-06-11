import { adminOnly, type AdminRequest } from '../src/middleware/adminAuth';
import { createAuthenticate } from '../src/middleware/auth';
import type { AuthService } from '../src/services/auth.service';
import type { UserService } from '../src/services/user.service';
import { ForbiddenError, UnauthorizedError } from '../src/utils/errors';
import type { JwtPayload, User } from '../src/types';
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

/** A request as it looks AFTER authenticate has attached the user. */
function reqWithUser(user: User | undefined): AdminRequest {
  const req = mockRequest() as AdminRequest;
  req.auth = { sub: 'user-1', phone: '+260123456789', tier: 'enterprise' };
  if (user) req.user = user;
  return req;
}

describe('adminOnly', () => {
  it('allows an admin through (reusing req.user) and attaches adminUser', () => {
    const req = reqWithUser(fakeUser({ admin_role: 'admin' }));
    const next = jest.fn();

    adminOnly()(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.adminUser?.id).toBe('user-1');
  });

  it('rejects a non-admin with ForbiddenError', () => {
    const req = reqWithUser(fakeUser({ admin_role: 'user' }));
    const next = jest.fn();

    adminOnly()(req, {} as never, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(ForbiddenError);
  });

  it('treats a missing req.user as 401 (mis-wired route)', () => {
    const req = reqWithUser(undefined);
    const next = jest.fn();

    adminOnly()(req, {} as never, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
  });

  it('loads the user exactly once across authenticate + adminOnly', async () => {
    const payload: JwtPayload = { sub: 'user-1', phone: '+260123456789', tier: 'enterprise' };
    const auth = { verifyToken: jest.fn().mockResolvedValue(payload) } as unknown as AuthService;
    const users = {
      findById: jest.fn().mockResolvedValue(fakeUser({ admin_role: 'admin' })),
    } as unknown as UserService;

    const authenticate = createAuthenticate({ auth, users });
    const req = mockRequest({ headers: { authorization: 'Bearer t' } }) as AdminRequest;

    // 1) authenticate loads + attaches the user.
    const next1 = jest.fn();
    await authenticate(req, {} as never, next1);
    expect(next1).toHaveBeenCalledWith();
    expect(req.user?.id).toBe('user-1');

    // 2) adminOnly reuses it — no second lookup.
    const next2 = jest.fn();
    adminOnly()(req, {} as never, next2);
    expect(next2).toHaveBeenCalledWith();
    expect(req.adminUser?.id).toBe('user-1');

    // The DB was hit exactly once for the whole request.
    expect(users.findById).toHaveBeenCalledTimes(1);
  });
});
