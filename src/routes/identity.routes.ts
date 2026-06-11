import { Router } from 'express';
import { identityController } from '../controllers/identity.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyIdentitySchema } from '../utils/validators';

/**
 * Identity router — seller NRC verification for a property.
 *
 * Mounted alongside the property router at `/properties`, exposing
 * `POST /properties/:id/verify-identity`.
 */
export const identityRouter = Router();

identityRouter.post(
  '/:id/verify-identity',
  authenticate,
  validateBody(verifyIdentitySchema),
  asyncHandler(identityController.verify),
);
