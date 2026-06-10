import { Router } from 'express';
import multer from 'multer';
import { propertyController } from '../controllers/property.controller';
import { authenticate } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  createPropertySchema,
  propertyFiltersSchema,
  updatePropertySchema,
} from '../utils/validators';

/**
 * /properties router — marketplace CRUD, S3 uploads, and AI fraud analysis.
 *
 * Uploads are buffered in memory (15 MB cap) and streamed straight to S3, so no
 * temp files touch disk.
 */
export const propertyRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// Public reads
propertyRouter.get(
  '/',
  validateQuery(propertyFiltersSchema),
  asyncHandler(propertyController.list),
);
propertyRouter.get('/user/:userId', asyncHandler(propertyController.listByUser));
propertyRouter.get('/:id', asyncHandler(propertyController.getById));

// Authenticated writes
propertyRouter.post(
  '/',
  authenticate,
  validateBody(createPropertySchema),
  asyncHandler(propertyController.create),
);
propertyRouter.put(
  '/:id',
  authenticate,
  validateBody(updatePropertySchema),
  asyncHandler(propertyController.update),
);
propertyRouter.delete('/:id', authenticate, asyncHandler(propertyController.remove));

// File upload + fraud analysis
propertyRouter.post(
  '/:id/upload',
  authenticate,
  upload.single('file'),
  asyncHandler(propertyController.upload),
);
propertyRouter.post('/:id/analyze', authenticate, asyncHandler(propertyController.analyze));
