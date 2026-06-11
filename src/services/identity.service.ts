import { config } from '../config/env';
import { logger } from '../utils/logger';
import type { IdentityVerification } from '../types';

/**
 * Seller identity verification against the Zambian National Registration Card
 * (NRC) via the Idswyft identity provider.
 *
 * The provider call is abstracted behind {@link IdswyftClient} and injected, so
 * tests (and a local mock) can run without network access. The public method
 * never throws: an invalid NRC or a provider failure resolves to `null`, which
 * callers treat as "could not verify".
 */

/** Raw response shape we consume from the Idswyft verify endpoint. */
export interface IdswyftVerifyResponse {
  verified: boolean;
  confidence?: number; // 0–1
  full_name?: string | null;
  date_of_birth?: string | null;
  photo_match?: boolean | null;
}

/** Low-level provider contract: NRC (+ optional photo) → verification result. */
export interface IdswyftClient {
  verify(input: { nrc: string; photoUrl?: string }): Promise<IdswyftVerifyResponse>;
}

/**
 * Zambian NRC in the format expected by this platform: the two-letter country
 * prefix `ZM` followed by 10 digits, e.g. `ZM0123456789`.
 */
const NRC_PATTERN = /^ZM\d{10}$/;

/** Validate and canonicalise an NRC string; returns null if it is malformed. */
export function normaliseNrc(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/[\s-]/g, '');
  return NRC_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * Real Idswyft client backed by their REST API.
 *
 * Uses the global `fetch` (Node ≥ 18). Network/HTTP errors propagate to the
 * service, which converts them to a `null` result.
 */
export class HttpIdswyftClient implements IdswyftClient {
  async verify(input: { nrc: string; photoUrl?: string }): Promise<IdswyftVerifyResponse> {
    const response = await fetch(`${config.idswyft.baseUrl}/v1/verify/nrc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.idswyft.apiKey}`,
      },
      body: JSON.stringify({
        nrc_number: input.nrc,
        ...(input.photoUrl ? { photo_url: input.photoUrl } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Idswyft responded with HTTP ${response.status}`);
    }
    return (await response.json()) as IdswyftVerifyResponse;
  }
}

/**
 * Deterministic mock client for local development and tests. It "verifies" any
 * well-formed NRC, deriving a stable confidence/name from the NRC digits so the
 * same input always yields the same output.
 */
export class MockIdswyftClient implements IdswyftClient {
  verify(input: { nrc: string; photoUrl?: string }): Promise<IdswyftVerifyResponse> {
    const digits = input.nrc.slice(2);
    // Treat NRCs ending in an even digit as a successful match.
    const lastDigit = Number(digits.at(-1) ?? '0');
    const verified = lastDigit % 2 === 0;

    return Promise.resolve({
      verified,
      confidence: verified ? 0.95 : 0.2,
      full_name: verified ? `Test Holder ${digits.slice(0, 4)}` : null,
      date_of_birth: verified ? '1990-01-01' : null,
      photo_match: input.photoUrl ? verified : null,
    });
  }
}

export class IdentityService {
  private readonly client: IdswyftClient;

  constructor(client?: IdswyftClient) {
    this.client =
      client ?? (config.idswyft.mock ? new MockIdswyftClient() : new HttpIdswyftClient());
  }

  /**
   * Verify a seller's NRC, optionally with a portrait photo for biometric match.
   *
   * @param nrcNumber Zambian NRC, e.g. `ZM0123456789`.
   * @param photoUrl  Optional URL of a seller photo for face matching.
   * @returns A typed {@link IdentityVerification}, or `null` if the NRC is
   *          invalid or the provider call failed.
   */
  async verifyIdentity(nrcNumber: string, photoUrl?: string): Promise<IdentityVerification | null> {
    const nrc = normaliseNrc(nrcNumber);
    if (!nrc) {
      logger.warn('Identity verification called with an invalid NRC format');
      return null;
    }

    let raw: IdswyftVerifyResponse;
    try {
      raw = await this.client.verify(photoUrl ? { nrc, photoUrl } : { nrc });
    } catch (err) {
      logger.error('Idswyft verification request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const result: IdentityVerification = {
      verified: raw.verified === true,
      confidence_score: clampScore(raw.confidence),
      nrc,
      name: raw.full_name ?? null,
      date_of_birth: raw.date_of_birth ?? null,
      photo_match: photoUrl ? (raw.photo_match ?? null) : null,
      verified_at: new Date().toISOString(),
    };

    logger.info('Identity verification complete', {
      verified: result.verified,
      confidence: result.confidence_score,
      withPhoto: Boolean(photoUrl),
    });
    return result;
  }
}

/** Clamp a possibly-undefined provider confidence into [0, 1]. */
function clampScore(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/** Shared singleton used by controllers. */
export const identityService = new IdentityService();
