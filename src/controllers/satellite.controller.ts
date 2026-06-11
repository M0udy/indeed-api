import type { Response } from 'express';
import { satelliteService, SatelliteService } from '../services/satellite.service';
import { propertyService, PropertyService } from '../services/property.service';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  UnprocessableEntityError,
  ValidationError,
} from '../utils/errors';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type { VerifySatelliteBody } from '../utils/validators';

/**
 * HTTP handler for satellite location verification. Collaborators are
 * constructor-injected for testability; a default-wired singleton is exported
 * for the route.
 */
export class SatelliteController {
  constructor(
    private readonly satellite: SatelliteService = satelliteService,
    private readonly properties: PropertyService = propertyService,
  ) {}

  /**
   * POST /properties/:id/verify-satellite — verify the listing's coordinates
   * against satellite imagery, persist to `properties.satellite_data`, and
   * return the result. Only the listing's seller may run verification.
   */
  verify = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.auth) throw new UnauthorizedError();

    const id = req.params.id;
    if (!id) throw new ValidationError('Missing property id');

    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id !== req.auth.sub) {
      throw new ForbiddenError('You can only verify your own listings');
    }

    const { latitude, longitude, description } = (res.locals as ValidatedLocals)
      .body as VerifySatelliteBody;

    // Fall back to the stored description/title when none is supplied.
    const effectiveDescription =
      description ?? property.description ?? property.title ?? '';

    const result = await this.satellite.verifySatellite(latitude, longitude, effectiveDescription);
    if (!result) {
      throw new UnprocessableEntityError('Could not verify the property against satellite imagery');
    }

    await this.properties.attachSatelliteData(id, result);

    res.status(200).json({ satellite: result, success: true });
  };
}

export const satelliteController = new SatelliteController();
