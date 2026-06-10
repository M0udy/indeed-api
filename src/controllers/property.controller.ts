import type { Request, Response } from 'express';
import { propertyService, PropertyService } from '../services/property.service';
import { userService, UserService } from '../services/user.service';
import { s3Service, S3Service } from '../services/s3.service';
import { claudeService, ClaudeService } from '../services/claude.service';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';
import { toPropertyDetail, toPropertySummary } from '../utils/mappers';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ValidatedLocals } from '../middleware/validate';
import type {
  CreatePropertyInput,
  FraudAnalysisResult,
  PropertyFilters,
  UpdatePropertyInput,
  VerificationStatus,
} from '../types';
import type {
  CreatePropertyBody,
  PropertyFiltersQuery,
  UpdatePropertyBody,
} from '../utils/validators';

/** Subscription tiers that unlock the full fraud analysis. */
const PAID_TIERS = new Set(['premium', 'professional', 'enterprise']);

/**
 * HTTP handlers for the property marketplace, file uploads, and AI fraud
 * detection. Collaborators are injected for testability.
 */
export class PropertyController {
  constructor(
    private readonly properties: PropertyService = propertyService,
    private readonly users: UserService = userService,
    private readonly s3: S3Service = s3Service,
    private readonly claude: ClaudeService = claudeService,
  ) {}

  /** POST /properties — create a listing owned by the authenticated user. */
  create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const body = (res.locals as ValidatedLocals).body as CreatePropertyBody;
    const input = this.normaliseCreateInput(body);

    const property = await this.properties.create(auth.sub, input);

    res.status(201).json({
      id: property.id,
      title: property.title,
      location: property.location,
      price_usd: property.price_usd === null ? null : Number(property.price_usd),
      created_at: property.created_at,
      fraud_score: property.fraud_score,
    });
  };

  /** GET /properties — search/filter listings. */
  list = async (_req: Request, res: Response): Promise<void> => {
    const query = (res.locals as ValidatedLocals).queryParams as PropertyFiltersQuery;
    const filters: PropertyFilters = {
      ...(query.location !== undefined ? { location: query.location } : {}),
      ...(query.price_min !== undefined ? { price_min: query.price_min } : {}),
      ...(query.price_max !== undefined ? { price_max: query.price_max } : {}),
      ...(query.size_min !== undefined ? { size_min: query.size_min } : {}),
      ...(query.size_max !== undefined ? { size_max: query.size_max } : {}),
      limit: query.limit,
      offset: query.offset,
    };

    const properties = await this.properties.search(filters);
    res.status(200).json(properties.map(toPropertySummary));
  };

  /** GET /properties/:id — full detail including seller summary. */
  getById = async (req: Request, res: Response): Promise<void> => {
    const id = this.requireIdParam(req);
    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');

    const seller = await this.users.findById(property.seller_id);
    if (!seller) throw new NotFoundError('Seller not found');

    res.status(200).json(toPropertyDetail(property, seller));
  };

  /** GET /properties/user/:userId — all listings for a seller. */
  listByUser = async (req: Request, res: Response): Promise<void> => {
    const userId = req.params.userId;
    if (!userId) throw new ValidationError('Missing userId');

    const properties = await this.properties.findBySeller(userId);
    res.status(200).json(properties.map(toPropertySummary));
  };

  /** PUT /properties/:id — update a listing (seller only). */
  update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const id = this.requireIdParam(req);

    await this.assertOwnership(id, auth.sub);

    const body = (res.locals as ValidatedLocals).body as UpdatePropertyBody;
    const input = this.normaliseUpdateInput(body);

    const updated = await this.properties.update(id, input);
    if (!updated) throw new NotFoundError('Property not found');

    const seller = await this.users.findById(updated.seller_id);
    if (!seller) throw new NotFoundError('Seller not found');

    res.status(200).json(toPropertyDetail(updated, seller));
  };

  /** DELETE /properties/:id — delete a listing (seller only). */
  remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const id = this.requireIdParam(req);

    await this.assertOwnership(id, auth.sub);
    const deleted = await this.properties.delete(id);
    if (!deleted) throw new NotFoundError('Property not found');

    res.status(200).json({ success: true });
  };

  /** POST /properties/:id/upload — upload an image or deed doc to S3 (seller only). */
  upload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const id = this.requireIdParam(req);
    await this.assertOwnership(id, auth.sub);

    const file = req.file;
    if (!file) throw new ValidationError('No file provided in the "file" form field');

    const result = await this.s3.uploadPropertyFile(id, file);
    await this.properties.attachUpload(id, result.kind, result.url);

    res.status(201).json({ url: result.url, property_id: id, kind: result.kind });
  };

  /**
   * POST /properties/:id/analyze — run AI fraud detection.
   *
   * Free-tier callers get a locked response. Paid tiers trigger a Claude Haiku
   * analysis whose results are persisted to the listing and audit table.
   */
  analyze = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const auth = this.requireAuth(req);
    const id = this.requireIdParam(req);

    const property = await this.properties.findById(id);
    if (!property) throw new NotFoundError('Property not found');

    const requester = await this.users.findById(auth.sub);
    if (!requester) throw new NotFoundError('User not found');

    // Gate behind a paid subscription tier.
    if (!PAID_TIERS.has(requester.subscription_tier)) {
      const locked: FraudAnalysisResult = {
        fraud_score: null,
        red_flags: [],
        recommendation: null,
        verification_status: property.verification_status,
        locked: true,
      };
      res.status(200).json(locked);
      return;
    }

    const seller = await this.users.findById(property.seller_id);
    if (!seller) throw new NotFoundError('Seller not found');

    const verdict = await this.claude.analyzeProperty(property, {
      name: seller.name,
      kyc_status: seller.kyc_status,
      verification_badge: seller.verification_badge,
    });

    const verificationStatus = this.scoreToStatus(verdict.fraud_score);
    const fraudFlags = this.flagsToObject(verdict.red_flags);

    await this.properties.applyFraudResult(id, verdict.fraud_score, fraudFlags, verificationStatus);
    await this.properties.recordAnalysis(
      id,
      verdict.fraud_score,
      verdict.red_flags,
      verdict.recommendation,
      verdict.reasoning,
    );

    const result: FraudAnalysisResult = {
      fraud_score: verdict.fraud_score,
      red_flags: verdict.red_flags,
      recommendation: verdict.recommendation,
      verification_status: verificationStatus,
    };
    res.status(200).json(result);
  };

  // ── helpers ───────────────────────────────────────────────

  private requireAuth(req: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
    if (!req.auth) throw new UnauthorizedError();
    return req.auth;
  }

  private requireIdParam(req: Request): string {
    const id = req.params.id;
    if (!id) throw new ValidationError('Missing property id');
    return id;
  }

  /** Confirm the property exists and is owned by `userId`, else throw. */
  private async assertOwnership(propertyId: string, userId: string): Promise<void> {
    const property = await this.properties.findById(propertyId);
    if (!property) throw new NotFoundError('Property not found');
    if (property.seller_id !== userId) {
      throw new ForbiddenError('You can only modify your own listings');
    }
  }

  /** Merge the spec's lat/lng aliases into latitude/longitude. */
  private normaliseCreateInput(body: CreatePropertyBody): CreatePropertyInput {
    const latitude = body.latitude ?? body.lat;
    const longitude = body.longitude ?? body.lng;
    return {
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      ...(body.size_acres !== undefined ? { size_acres: body.size_acres } : {}),
      ...(body.price_usd !== undefined ? { price_usd: body.price_usd } : {}),
      ...(body.deed_number !== undefined ? { deed_number: body.deed_number } : {}),
    };
  }

  private normaliseUpdateInput(body: UpdatePropertyBody): UpdatePropertyInput {
    const latitude = body.latitude ?? body.lat;
    const longitude = body.longitude ?? body.lng;
    return {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(longitude !== undefined ? { longitude } : {}),
      ...(body.size_acres !== undefined ? { size_acres: body.size_acres } : {}),
      ...(body.price_usd !== undefined ? { price_usd: body.price_usd } : {}),
      ...(body.deed_number !== undefined ? { deed_number: body.deed_number } : {}),
    };
  }

  /** Map a 0–100 fraud score to a verification status bucket. */
  private scoreToStatus(score: number): VerificationStatus {
    if (score < 25) return 'verified';
    if (score <= 60) return 'caution';
    return 'flagged';
  }

  /** Turn the red-flag array into the `{ flag: true }` JSONB object. */
  private flagsToObject(redFlags: string[]): Record<string, boolean> {
    const flags: Record<string, boolean> = {};
    for (const flag of redFlags) flags[flag] = true;
    return flags;
  }
}

export const propertyController = new PropertyController();
