import { query } from '../config/database';
import type {
  CreatePropertyInput,
  DeedData,
  FraudRecommendation,
  IdentityVerification,
  Property,
  PropertyFilters,
  RuleEvaluation,
  SatelliteVerification,
  UpdatePropertyInput,
  VerificationStatus,
} from '../types';

/**
 * Data access for the `properties` table.
 *
 * Every method uses parameterised SQL — column lists are built from a fixed
 * allow-list, never from raw user input — so the query builder is injection-safe
 * even for the dynamic UPDATE and search filters.
 */
export class PropertyService {
  /** Insert a new listing owned by `sellerId`. */
  async create(sellerId: string, input: CreatePropertyInput): Promise<Property> {
    const { rows } = await query<Property>(
      `INSERT INTO properties
         (seller_id, title, description, location, latitude, longitude,
          size_acres, price_usd, deed_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        sellerId,
        input.title,
        input.description ?? null,
        input.location ?? null,
        input.latitude ?? null,
        input.longitude ?? null,
        input.size_acres ?? null,
        input.price_usd ?? null,
        input.deed_number ?? null,
      ],
    );
    // INSERT ... RETURNING always yields exactly one row.
    return rows[0] as Property;
  }

  /** Fetch a listing by id, or null if not found. */
  async findById(id: string): Promise<Property | null> {
    const { rows } = await query<Property>(`SELECT * FROM properties WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** List all properties for a given seller, newest first. */
  async findBySeller(sellerId: string): Promise<Property[]> {
    const { rows } = await query<Property>(
      `SELECT * FROM properties WHERE seller_id = $1 ORDER BY created_at DESC`,
      [sellerId],
    );
    return rows;
  }

  /** Search/filter listings. Builds a parameterised WHERE clause dynamically. */
  async search(filters: PropertyFilters): Promise<Property[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.location !== undefined) {
      params.push(`%${filters.location}%`);
      conditions.push(`location ILIKE $${params.length}`);
    }
    if (filters.price_min !== undefined) {
      params.push(filters.price_min);
      conditions.push(`price_usd >= $${params.length}`);
    }
    if (filters.price_max !== undefined) {
      params.push(filters.price_max);
      conditions.push(`price_usd <= $${params.length}`);
    }
    if (filters.size_min !== undefined) {
      params.push(filters.size_min);
      conditions.push(`size_acres >= $${params.length}`);
    }
    if (filters.size_max !== undefined) {
      params.push(filters.size_max);
      conditions.push(`size_acres <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(filters.limit);
    const limitParam = `$${params.length}`;
    params.push(filters.offset);
    const offsetParam = `$${params.length}`;

    const { rows } = await query<Property>(
      `SELECT * FROM properties
       ${where}
       ORDER BY created_at DESC
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );
    return rows;
  }

  /**
   * Update mutable fields of a listing. Only columns present in `input` are
   * touched; the SET clause is assembled from a fixed allow-list of columns.
   */
  async update(id: string, input: UpdatePropertyInput): Promise<Property | null> {
    const allowed: ReadonlyArray<keyof UpdatePropertyInput> = [
      'title',
      'description',
      'location',
      'latitude',
      'longitude',
      'size_acres',
      'price_usd',
      'deed_number',
    ];

    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const column of allowed) {
      if (input[column] !== undefined) {
        params.push(input[column]);
        assignments.push(`${column} = $${params.length}`);
      }
    }

    if (assignments.length === 0) {
      // Nothing to update; return the current row unchanged.
      return this.findById(id);
    }

    assignments.push(`updated_at = now()`);
    params.push(id);

    const { rows } = await query<Property>(
      `UPDATE properties SET ${assignments.join(', ')}
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  }

  /** Persist fraud-analysis results onto the listing. */
  async applyFraudResult(
    id: string,
    fraudScore: number,
    fraudFlags: Record<string, boolean>,
    verificationStatus: VerificationStatus,
  ): Promise<Property | null> {
    const { rows } = await query<Property>(
      `UPDATE properties
          SET fraud_score = $2,
              fraud_flags = $3::jsonb,
              verification_status = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, fraudScore, JSON.stringify(fraudFlags), verificationStatus],
    );
    return rows[0] ?? null;
  }

  /** Record a fraud-analysis audit row. */
  async recordAnalysis(
    propertyId: string,
    fraudScore: number,
    redFlags: string[],
    recommendation: FraudRecommendation,
    claudeResponse: string,
  ): Promise<void> {
    await query(
      `INSERT INTO fraud_analyses
         (property_id, fraud_score, red_flags, recommendation, claude_response)
       VALUES ($1, $2, $3::jsonb, $4, $5)`,
      [propertyId, fraudScore, JSON.stringify(redFlags), recommendation, claudeResponse],
    );
  }

  /** Append uploaded asset URLs (image array and/or deed document). */
  async attachUpload(
    id: string,
    kind: 'image' | 'document',
    url: string,
  ): Promise<Property | null> {
    if (kind === 'image') {
      const { rows } = await query<Property>(
        `UPDATE properties
            SET image_urls = array_append(image_urls, $2), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, url],
      );
      return rows[0] ?? null;
    }

    const { rows } = await query<Property>(
      `UPDATE properties
          SET deed_document_url = $2, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, url],
    );
    return rows[0] ?? null;
  }

  /** Persist OCR-extracted deed data onto the listing. */
  async attachDeedData(id: string, deedData: DeedData): Promise<Property | null> {
    const { rows } = await query<Property>(
      `UPDATE properties
          SET deed_data = $2::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(deedData)],
    );
    return rows[0] ?? null;
  }

  /** Persist a seller identity-verification result onto the listing. */
  async attachIdentityData(
    id: string,
    identity: IdentityVerification,
  ): Promise<Property | null> {
    const { rows } = await query<Property>(
      `UPDATE properties
          SET identity_data = $2::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(identity)],
    );
    return rows[0] ?? null;
  }

  /** Persist a fraud rules-engine evaluation onto the listing. */
  async attachRulesCheck(id: string, evaluation: RuleEvaluation): Promise<Property | null> {
    const { rows } = await query<Property>(
      `UPDATE properties
          SET rules_check = $2::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(evaluation)],
    );
    return rows[0] ?? null;
  }

  /** Persist a satellite location-verification result onto the listing. */
  async attachSatelliteData(
    id: string,
    data: SatelliteVerification,
  ): Promise<Property | null> {
    const { rows } = await query<Property>(
      `UPDATE properties
          SET satellite_data = $2::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, JSON.stringify(data)],
    );
    return rows[0] ?? null;
  }

  /** Delete a listing. Returns true if a row was removed. */
  async delete(id: string): Promise<boolean> {
    const { rowCount } = await query(`DELETE FROM properties WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }
}

export const propertyService = new PropertyService();
