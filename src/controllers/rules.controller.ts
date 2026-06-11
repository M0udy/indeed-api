import type { Response } from 'express';
import { rulesService, RulesService } from '../services/rules.service';
import { propertyService, PropertyService } from '../services/property.service';
import { NotFoundError, UnauthorizedError, ValidationError, ForbiddenError } from '../utils/errors';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type { CheckRulesBody } from '../utils/validators';
import type {
  DeedData,
  IdentityVerification,
  Property,
  RulesIdentityInput,
  RulesOcrInput,
  RulesPropertyInput,
  SatelliteData,
} from '../types';

/**
 * HTTP handler for the fraud rules engine. Collaborators are constructor-
 * injected for testability; a default-wired singleton is exported for the route.
 */
export class RulesController {
  constructor(
    private readonly rules: RulesService = rulesService,
    private readonly properties: PropertyService = propertyService,
  ) {}

  /**
   * POST /properties/:id/check-rules — evaluate the 12 fraud rules.
   *
   * Inputs are taken from the request body when supplied, otherwise from data
   * already stored on the property (OCR + identity results). Only the listing's
   * seller may run the check. The result is persisted to `properties.rules_check`.
   */
  check = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (!req.auth) throw new UnauthorizedError();

    const id = req.params.id;
    if (!id) throw new ValidationError('Missing property id');

    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id !== req.auth.sub) {
      throw new ForbiddenError('You can only run rule checks on your own listings');
    }

    const body = (res.locals as ValidatedLocals).body as CheckRulesBody;

    const propertyInput = this.buildPropertyInput(property, body);
    const ocrData = this.buildOcrInput(property, body);
    const identity = this.buildIdentityInput(property, body);
    const satellite = this.buildSatelliteInput(body);

    const evaluation = await this.rules.evaluateRules(propertyInput, ocrData, identity, satellite);
    await this.properties.attachRulesCheck(id, evaluation);

    res.status(200).json({
      red_flags: evaluation.red_flags,
      rule_score: evaluation.rule_score,
      details: evaluation.details,
      success: true,
    });
  };

  // ── input assembly ────────────────────────────────────────

  /** Merge stored property fields with caller-supplied contextual signals. */
  private buildPropertyInput(property: Property, body: CheckRulesBody): RulesPropertyInput {
    const ctx = body.property ?? {};
    return {
      id: property.id,
      price_usd: property.price_usd === null ? null : Number(property.price_usd),
      deed_number: property.deed_number,
      location: property.location,
      ...(ctx.market_value_usd !== undefined ? { market_value_usd: ctx.market_value_usd } : {}),
      ...(ctx.deed_registry_match !== undefined
        ? { deed_registry_match: ctx.deed_registry_match }
        : {}),
      ...(ctx.duplicate_listing_count !== undefined
        ? { duplicate_listing_count: ctx.duplicate_listing_count }
        : {}),
      ...(ctx.seller_dispute_count !== undefined
        ? { seller_dispute_count: ctx.seller_dispute_count }
        : {}),
      ...(ctx.seller_nrc !== undefined ? { seller_nrc: ctx.seller_nrc } : {}),
    };
  }

  /** Prefer body OCR data, else fall back to stored deed_data. */
  private buildOcrInput(property: Property, body: CheckRulesBody): RulesOcrInput | null {
    if (body.ocr_data) return body.ocr_data;
    const stored = this.asStored<DeedData>(property.deed_data);
    if (!stored) return null;
    return {
      deed_number: stored.deed_number,
      transaction_date: stored.transaction_date,
      amount_in_numbers: stored.amount_in_numbers,
      buyer_name: stored.buyer_name,
    };
  }

  /** Prefer body identity, else fall back to stored identity_data. */
  private buildIdentityInput(property: Property, body: CheckRulesBody): RulesIdentityInput | null {
    if (body.identity) {
      return { verified: body.identity.verified ?? false, nrc: body.identity.nrc ?? null };
    }
    const stored = this.asStored<IdentityVerification>(property.identity_data);
    if (!stored) return null;
    return { verified: stored.verified, nrc: stored.nrc };
  }

  /** Build satellite input from the body, if present. */
  private buildSatelliteInput(body: CheckRulesBody): SatelliteData | null {
    if (!body.satellite) return null;
    return {
      matches_description: body.satellite.matches_description ?? null,
      confidence: body.satellite.confidence ?? null,
      notes: body.satellite.notes ?? null,
    };
  }

  /** Treat an empty JSONB object (`{}`) as "no stored value". */
  private asStored<T extends object>(value: T | Record<string, never>): T | null {
    return Object.keys(value).length > 0 ? (value as T) : null;
  }
}

export const rulesController = new RulesController();
