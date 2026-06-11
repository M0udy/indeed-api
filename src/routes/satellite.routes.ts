import { Router } from 'express';
import { satelliteController } from '../controllers/satellite.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { verifySatelliteSchema } from '../utils/validators';

/**
 * Satellite router — location verification for a property.
 *
 * Mounted alongside the property router at `/properties`, exposing
 * `POST /properties/:id/verify-satellite`.
 */
export const satelliteRouter = Router();

satelliteRouter.post(
  '/:id/verify-satellite',
  authenticate,
  validateBody(verifySatelliteSchema),
  asyncHandler(satelliteController.verify),
);
