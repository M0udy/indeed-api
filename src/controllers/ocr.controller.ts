import type { Response } from 'express';
import { ocrService, OcrService } from '../services/ocr.service';
import { propertyService, PropertyService } from '../services/property.service';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from '../utils/errors';
import type { AuthenticatedRequest } from '../middleware/auth';

/**
 * HTTP handler for deed OCR. Collaborators are constructor-injected for
 * testability; a default-wired singleton is exported for the route.
 */
export class OcrController {
  constructor(
    private readonly ocr: OcrService = ocrService,
    private readonly properties: PropertyService = propertyService,
  ) {}

  /**
   * POST /properties/:id/ocr — parse an uploaded deed image, persist the
   * structured result to `properties.deed_data`, and return it.
   *
   * Only the listing's seller may run OCR on it.
   */
  parse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.auth) throw new UnauthorizedError();

    const id = req.params.id;
    if (!id) throw new ValidationError('Missing property id');

    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id !== req.auth.sub) {
      throw new ForbiddenError('You can only run OCR on your own listings');
    }

    const file = req.file;
    if (!file) throw new ValidationError('No file provided in the "file" form field');

    const deedData = await this.ocr.parseDeedImage(file.buffer);
    if (!deedData) {
      // Parsing failed entirely (unreadable / blurry image).
      throw new UnprocessableEntityError('Could not parse the deed image. Try a clearer photo.');
    }

    await this.properties.attachDeedData(id, deedData);

    res.status(200).json({ deed_data: deedData, success: true });
  };
}

export const ocrController = new OcrController();
