import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { requestOtpSchema, verifyOtpSchema } from '../utils/validators';

/** /auth router — OTP login, profile, and token refresh. */
export const authRouter = Router();

authRouter.post(
  '/request-otp',
  validateBody(requestOtpSchema),
  asyncHandler(authController.requestOtp),
);

authRouter.post(
  '/verify-otp',
  validateBody(verifyOtpSchema),
  asyncHandler(authController.verifyOtp),
);

authRouter.get('/me', authenticate, asyncHandler(authController.me));

authRouter.post('/refresh', authenticate, asyncHandler(authController.refresh));
