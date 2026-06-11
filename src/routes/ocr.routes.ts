import { Router } from 'express';
import multer from 'multer';
import { ocrController } from '../controllers/ocr.controller';
import { authenticate } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { ValidationError } from '../utils/errors';

/**
 * OCR router — deed parsing for a property.
 *
 * Mounted alongside the property router at `/properties`, exposing
 * `POST /properties/:id/ocr`. Images are buffered in memory (10 MB cap) and
 * restricted to JPG/PNG; nothing touches disk.
 */
export const ocrRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    const allowed = ['image/jpeg', 'image/png'];
    if (allowed.includes(file.mimetype)) {
      callback(null, true);
      return;
    }
    callback(new ValidationError(`Unsupported file type "${file.mimetype}". Allowed: JPG, PNG`));
  },
});

ocrRouter.post(
  '/:id/ocr',
  authenticate,
  upload.single('file'),
  asyncHandler(ocrController.parse),
);
