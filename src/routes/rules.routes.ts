import { Router } from 'express';
import { rulesController } from '../controllers/rules.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { checkRulesSchema } from '../utils/validators';

/**
 * Rules router — fraud rules-engine evaluation for a property.
 *
 * Mounted alongside the property router at `/properties`, exposing
 * `POST /properties/:id/check-rules`.
 */
export const rulesRouter = Router();

rulesRouter.post(
  '/:id/check-rules',
  authenticate,
  validateBody(checkRulesSchema),
  asyncHandler(rulesController.check),
);
