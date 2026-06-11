import { AuthController } from '../src/controllers/auth.controller';
import type { AuthService } from '../src/services/auth.service';
import type { SmsService } from '../src/services/sms.service';
import type { UserService } from '../src/services/user.service';
import type { User } from '../src/types';
import { ValidationError } from '../src/utils/errors';
import { mockRequest, mockResponse } from './helpers';
import type { AuthenticatedRequest } from '../src/middleware/auth';

/** Build a fully-populated fake user row. */
function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '+260123456789',
    email: null,
    name: 'Test Seller',
    kyc_status: 'pending',
    subscription_tier: 'free',
    verification_badge: false,
    admin_role: 'user',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AuthController', () => {
  describe('requestOtp', () => {
    it('generates, stores, and sends an OTP', async () => {
      const auth = {
        generateOtp: jest.fn().mockReturnValue('123456'),
        storeOtp: jest.fn().mockResolvedValue(undefined),
      } as unknown as AuthService;
      const sms = { sendOtp: jest.fn().mockResolvedValue(undefined) } as unknown as SmsService;
      const users = {} as UserService;

      const controller = new AuthController(auth, sms, users);
      const res = mockResponse({ body: { phone: '+260123456789' } });

      await controller.requestOtp(mockRequest(), res);

      expect(auth.generateOtp).toHaveBeenCalledTimes(1);
      expect(auth.storeOtp).toHaveBeenCalledWith('+260123456789', '123456');
      expect(sms.sendOtp).toHaveBeenCalledWith('+260123456789', '123456');
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ success: true, otp_sent: true });
    });
  });

  describe('verifyOtp', () => {
    it('issues a token for a valid OTP', async () => {
      const user = fakeUser();
      const auth = {
        verifyOtp: jest.fn().mockResolvedValue(true),
        findOrCreateUser: jest.fn().mockResolvedValue(user),
        issueToken: jest.fn().mockResolvedValue('jwt-token'),
      } as unknown as AuthService;
      const controller = new AuthController(auth, {} as SmsService, {} as UserService);
      const res = mockResponse({ body: { phone: user.phone, otp: '123456' } });

      await controller.verifyOtp(mockRequest(), res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({
        token: 'jwt-token',
        user: { id: 'user-1', subscription_tier: 'free' },
      });
    });

    it('rejects an invalid OTP with a 400', async () => {
      const auth = {
        verifyOtp: jest.fn().mockResolvedValue(false),
      } as unknown as AuthService;
      const controller = new AuthController(auth, {} as SmsService, {} as UserService);
      const res = mockResponse({ body: { phone: '+260123456789', otp: '000000' } });

      await expect(controller.verifyOtp(mockRequest(), res)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('me', () => {
    it('returns the authenticated user profile', async () => {
      const user = fakeUser({ subscription_tier: 'premium', verification_badge: true });
      const users = { findById: jest.fn().mockResolvedValue(user) } as unknown as UserService;
      const controller = new AuthController({} as AuthService, {} as SmsService, users);

      const req = mockRequest() as AuthenticatedRequest;
      req.auth = { sub: 'user-1', phone: user.phone, tier: 'premium' };
      const res = mockResponse();

      await controller.me(req, res);

      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ id: 'user-1', subscription_tier: 'premium', verification_badge: true });
    });
  });
});
