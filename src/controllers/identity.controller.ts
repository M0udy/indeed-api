import type { Response } from 'express';
import { identityService, IdentityService } from '../services/identity.service';
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
import type { VerifyIdentityBody } from '../utils/validators';

/**
 * HTTP handler for seller identity verification. Collaborators are
 * constructor-injected for testability; a default-wired singleton is exported
 * for the route.
 */
export class IdentityController {
  constructor(
    private readonly identity: IdentityService = identityService,
    private readonly properties: PropertyService = propertyService,
  ) {}

  /**
   * POST /properties/:id/verify-identity — verify the seller's NRC (optionally
   * with a portrait photo), persist the result to `properties.identity_data`,
   * and return it. Only the listing's seller may run verification on it.
   */
  verify = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.auth) throw new UnauthorizedError();

    const id = req.params.id;
    if (!id) throw new ValidationError('Missing property id');

    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id !== req.auth.sub) {
      throw new ForbiddenError('You can only verify identity on your own listings');
    }

    const { seller_nrc, seller_photo_url } = (res.locals as ValidatedLocals)
      .body as VerifyIdentityBody;

    const result = await this.identity.verifyIdentity(seller_nrc, seller_photo_url);
    if (!result) {
      // Invalid NRC or provider failure.
      throw new UnprocessableEntityError('Could not verify the seller identity');
    }

    await this.properties.attachIdentityData(id, result);

    res.status(200).json({ identity: result, success: true });
  };
}

export const identityController = new IdentityController();
