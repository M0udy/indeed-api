import { createAuthenticate } from '../src/middleware/auth';
import type { AuthService } from '../src/services/auth.service';
import type { UserService } from '../src/services/user.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { JwtPayload, User } from '../src/types';
import { ForbiddenError, UnauthorizedError } from '../src/utils/errors';
import { mockRequest } from './helpers';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '+260123456789',
    email: null,
    name: 'Jane',
    kyc_status: 'verified',
    subscription_tier: 'premium',
    verification_badge: false,
    admin_role: 'user',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const payload: JwtPayload = { sub: 'user-1', phone: '+260123456789', tier: 'premium' };

function bearerReq(): AuthenticatedRequest {
  return mockRequest({ headers: { authorization: 'Bearer valid.token' } }) as AuthenticatedRequest;
}

/** Build the middleware with injected fakes. */
function build(opts: { user?: User | null; verify?: jest.Mock }) {
  const auth = {
    verifyToken: opts.verify ?? jest.fn().mockResolvedValue(payload),
  } as unknown as AuthService;
  const resolvedUser = 'user' in opts ? opts.user : fakeUser();
  const users = {
    findById: jest.fn().mockResolvedValue(resolvedUser),
  } as unknown as UserService;
  return { mw: createAuthenticate({ auth, users }), auth, users };
}

describe('authenticate middleware', () => {
  it('allows an active, non-suspended user and populates the request', async () => {
    const { mw } = build({ user: fakeUser({ suspended_at: null }) });
    const req = bearerReq();
    const next = jest.fn();

    await mw(req, {} as never, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual(payload);
    expect(req.token).toBe('valid.token');
    expect(req.user?.id).toBe('user-1');
  });

  it('blocks a suspended user with 403 Account suspended', async () => {
    const { mw } = build({ user: fakeUser({ suspended_at: new Date('2026-06-01T00:00:00Z') }) });
    const next = jest.fn();

    await mw(bearerReq(), {} as never, next);

    const err = next.mock.calls[0][0] as ForbiddenError;
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.message).toBe('Account suspended');
    expect(err.statusCode).toBe(403);
  });

  it('rejects a missing Bearer token with 401 (without hitting services)', async () => {
    const { mw, auth, users } = build({});
    const req = mockRequest({ headers: {} }) as AuthenticatedRequest;
    const next = jest.fn();

    await mw(req, {} as never, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
    expect(auth.verifyToken).not.toHaveBeenCalled();
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects when the token is invalid/expired (verifyToken throws)', async () => {
    const verify = jest.fn().mockRejectedValue(new UnauthorizedError('Invalid or expired token'));
    const { mw } = build({ verify });
    const next = jest.fn();

    await mw(bearerReq(), {} as never, next);

    expect(next.mock.calls[0][0]).toBeInstanceOf(UnauthorizedError);
  });

  it('rejects when the token is valid but the user no longer exists', async () => {
    const { mw } = build({ user: null });
    const next = jest.fn();

    await mw(bearerReq(), {} as never, next);

    const err = next.mock.calls[0][0] as UnauthorizedError;
    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err.message).toBe('User not found');
  });
});
