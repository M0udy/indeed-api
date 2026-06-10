import type { Request, Response } from 'express';
import { config } from '../config/env';
import { authService } from '../services/auth.service';
import { smsService, type SmsService } from '../services/sms.service';
import { userService, type UserService } from '../services/user.service';
import { AuthService } from '../services/auth.service';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import { toUserPublic } from '../utils/mappers';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type { RequestOtpBody, VerifyOtpBody } from '../utils/validators';

/**
 * HTTP handlers for the authentication flow. The class takes its collaborators
 * by constructor injection so tests can pass fakes; a default-wired singleton is
 * exported for the routes to use.
 */
export class AuthController {
  constructor(
    private readonly auth: AuthService = authService,
    private readonly sms: SmsService = smsService,
    private readonly users: UserService = userService,
  ) {}

  /** POST /auth/request-otp — generate, store, and SMS a one-time code. */
  requestOtp = async (_req: Request, res: Response): Promise<void> => {
    const { phone } = (res.locals as ValidatedLocals).body as RequestOtpBody;

    const otp = this.auth.generateOtp();
    await this.auth.storeOtp(phone, otp);
    await this.sms.sendOtp(phone, otp);

    res.status(200).json({
      success: true,
      phone,
      otp_sent: true,
      // Only echoed in non-production when OTP_DEBUG_RETURN=true — eases local testing.
      ...(config.otp.debugReturn && config.nodeEnv !== 'production' ? { debug_otp: otp } : {}),
    });
  };

  /** POST /auth/verify-otp — validate the code, upsert the user, issue a JWT. */
  verifyOtp = async (_req: Request, res: Response): Promise<void> => {
    const { phone, otp } = (res.locals as ValidatedLocals).body as VerifyOtpBody;

    const valid = await this.auth.verifyOtp(phone, otp);
    if (!valid) {
      throw new ValidationError('Invalid or expired verification code');
    }

    const user = await this.auth.findOrCreateUser(phone);
    const token = await this.auth.issueToken(user);

    res.status(200).json({
      token,
      user: {
        id: user.id,
        phone: user.phone,
        name: user.name,
        subscription_tier: user.subscription_tier,
      },
    });
  };

  /** GET /auth/me — return the authenticated user's profile. */
  me = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    if (!auth) throw new UnauthorizedError();

    const user = await this.users.findById(auth.sub);
    if (!user) throw new NotFoundError('User not found');

    res.status(200).json(toUserPublic(user));
  };

  /** POST /auth/refresh — rotate the current token for a fresh one. */
  refresh = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = req.auth;
    const oldToken = req.token;
    if (!auth || !oldToken) throw new UnauthorizedError();

    const user = await this.users.findById(auth.sub);
    if (!user) throw new NotFoundError('User not found');

    const token = await this.auth.issueToken(user);
    // Invalidate the previous token so it cannot be reused after rotation.
    await this.auth.revokeToken(oldToken);

    res.status(200).json({ token });
  };
}

export const authController = new AuthController();
