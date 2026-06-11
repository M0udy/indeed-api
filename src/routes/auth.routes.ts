import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { otpRateLimit } from '../middleware/rateLimit';
import { otpThrottle } from '../middleware/otpThrottle';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { requestOtpSchema, verifyOtpSchema } from '../utils/validators';

/** /auth router — OTP login, profile, and token refresh. */
export const authRouter = Router();

authRouter.post(
  '/request-otp',
  validateBody(requestOtpSchema),
  // 5 OTP requests per phone number per hour.
  otpRateLimit,
  asyncHandler(authController.requestOtp),
);

authRouter.post(
  '/verify-otp',
  validateBody(verifyOtpSchema),
  // Brute-force guard: lock a phone after 3 failed attempts for 15 minutes.
  otpThrottle(),
  asyncHandler(authController.verifyOtp),
);

authRouter.get('/me', authenticate, asyncHandler(authController.me));

authRouter.post('/refresh', authenticate, asyncHandler(authController.refresh));
