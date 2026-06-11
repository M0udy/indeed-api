import { Router } from 'express';
import { adminController } from '../controllers/admin.controller';
import { authenticate } from '../middleware/auth';
import { adminOnly } from '../middleware/adminAuth';
import { validateBody, validateQuery } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  adminFraudCaseFiltersSchema,
  adminUserFiltersSchema,
  adminUserUpdateSchema,
  reportQuerySchema,
  resolveFraudCaseSchema,
} from '../utils/validators';

/**
 * Admin router. Every route requires a valid JWT (`authenticate`) AND an admin
 * role verified against the database (`adminOnly`).
 */
export const adminRouter = Router();

// Apply auth + admin gate to every route on this router.
adminRouter.use(authenticate, adminOnly());

adminRouter.get('/analytics', asyncHandler(adminController.analytics));

adminRouter.get(
  '/users',
  validateQuery(adminUserFiltersSchema),
  asyncHandler(adminController.listUsers),
);
adminRouter.patch(
  '/users/:id',
  validateBody(adminUserUpdateSchema),
  asyncHandler(adminController.updateUser),
);

adminRouter.get(
  '/fraud-cases',
  validateQuery(adminFraudCaseFiltersSchema),
  asyncHandler(adminController.listFraudCases),
);
adminRouter.patch(
  '/fraud-cases/:id',
  validateBody(resolveFraudCaseSchema),
  asyncHandler(adminController.resolveFraudCase),
);

adminRouter.get(
  '/reports',
  validateQuery(reportQuerySchema),
  asyncHandler(adminController.reports),
);
