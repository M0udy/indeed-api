import { Router } from 'express';
import { paymentController } from '../controllers/payment.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { mobileMoneySchema, stripeCheckoutSchema } from '../utils/validators';

/**
 * Payments router — Stripe checkout, the Stripe webhook, mobile money, and
 * invoice retrieval.
 *
 * NOTE: the webhook route is intentionally unauthenticated (Stripe calls it and
 * authenticates via signature) and relies on the raw-body parser registered for
 * its path in `app.ts` BEFORE the JSON body parser.
 */
export const paymentRouter = Router();

paymentRouter.post(
  '/stripe/checkout',
  authenticate,
  validateBody(stripeCheckoutSchema),
  asyncHandler(paymentController.stripeCheckout),
);

paymentRouter.post('/webhook/stripe', asyncHandler(paymentController.stripeWebhook));

paymentRouter.post(
  '/mobile-money',
  authenticate,
  validateBody(mobileMoneySchema),
  asyncHandler(paymentController.mobileMoney),
);

paymentRouter.get('/invoice/:id', authenticate, asyncHandler(paymentController.invoice));
