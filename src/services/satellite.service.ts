import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { UpstreamServiceError } from '../utils/errors';
import type { SatelliteVerification } from '../types';

/**
 * Satellite location verification.
 *
 * Fetches a satellite image for a coordinate pair and asks Claude vision whether
 * the imagery is consistent with the property description. Both external steps
 * are abstracted behind injected collaborators — a {@link SatelliteImageProvider}
 * and a {@link SatelliteVisionAnalyzer} — so the orchestration is fully testable
 * offline and the imagery backend (Google Earth Engine, Static Maps, …) can be
 * swapped in one place.
 *
 * The public method never throws: invalid coordinates or any upstream failure
 * resolve to `null`, which callers treat as "could not verify".
 */

/** A fetched satellite image: a (key-free) URL plus the bytes for vision. */
export interface SatelliteImage {
  imageUrl: string;
  imageBase64: string;
  mediaType: 'image/png' | 'image/jpeg';
}

/** Low-level imagery source: coordinates → image, or null if unavailable. */
export interface SatelliteImageProvider {
  fetchImage(lat: number, lng: number): Promise<SatelliteImage | null>;
}

/** Structured verdict from the vision model. */
export interface SatelliteVerdict {
  matches: boolean;
  confidence: number; // 0–1
  reasoning: string;
}

/** Vision step: compare an image to a description. */
export interface SatelliteVisionAnalyzer {
  analyze(image: SatelliteImage, description: string): Promise<SatelliteVerdict>;
}

/** A 1×1 transparent PNG used by the mock provider. */
const MOCK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Real imagery provider. Substitutes the coordinate/key placeholders in the
 * configured URL template, fetches the PNG/JPEG, and returns the bytes plus a
 * key-stripped URL (so the API key never leaks into the DB or API responses).
 */
export class HttpSatelliteImageProvider implements SatelliteImageProvider {
  async fetchImage(lat: number, lng: number): Promise<SatelliteImage | null> {
    const url = config.satellite.urlTemplate
      .replace('{lat}', String(lat))
      .replace('{lng}', String(lng))
      .replace('{apiKey}', config.satellite.apiKey);

    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      logger.error('Satellite image fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!response.ok) {
      logger.error('Satellite image source returned an error', { status: response.status });
      return null;
    }

    const contentType = response.headers.get('content-type') ?? 'image/png';
    const mediaType: SatelliteImage['mediaType'] = contentType.includes('jpeg')
      ? 'image/jpeg'
      : 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());

    return { imageUrl: stripApiKey(url), imageBase64: buffer.toString('base64'), mediaType };
  }
}

/** Deterministic offline provider for dev/test. */
export class MockSatelliteImageProvider implements SatelliteImageProvider {
  fetchImage(lat: number, lng: number): Promise<SatelliteImage | null> {
    return Promise.resolve({
      imageUrl: `https://satellite.mock/${lat},${lng}.png`,
      imageBase64: MOCK_PNG_BASE64,
      mediaType: 'image/png',
    });
  }
}

const VISION_TOOL_NAME = 'record_satellite_match';

/** Claude-vision implementation of the analyzer. */
export class ClaudeVisionAnalyzer implements SatelliteVisionAnalyzer {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client?: Anthropic) {
    this.model = config.anthropic.model;
    this.client = client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  async analyze(image: SatelliteImage, description: string): Promise<SatelliteVerdict> {
    const tool: Anthropic.Tool = {
      name: VISION_TOOL_NAME,
      description: 'Record whether the satellite image matches the property description.',
      input_schema: {
        type: 'object',
        properties: {
          matches: { type: 'boolean', description: 'True if the imagery is consistent with the description.' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          reasoning: { type: 'string' },
        },
        required: ['matches', 'confidence', 'reasoning'],
      },
    };

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      tools: [tool],
      tool_choice: { type: 'tool', name: VISION_TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: image.mediaType, data: image.imageBase64 },
            },
            {
              type: 'text',
              text: `This is a satellite image of a property location. Property description:\n"${description}"\n\nDoes the satellite imagery plausibly match this description (terrain, development, surroundings)? Be conservative: if the image is unreadable or clearly inconsistent, set matches=false.`,
            },
          ],
        },
      ],
    });

    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === VISION_TOOL_NAME) {
        const input = block.input as Partial<SatelliteVerdict>;
        return {
          matches: input.matches === true,
          confidence: typeof input.confidence === 'number' ? input.confidence : 0,
          reasoning: typeof input.reasoning === 'string' ? input.reasoning : '',
        };
      }
    }
    throw new UpstreamServiceError('Vision model returned no verdict');
  }
}

export class SatelliteService {
  private readonly imageProvider: SatelliteImageProvider;
  private readonly vision: SatelliteVisionAnalyzer;

  constructor(imageProvider?: SatelliteImageProvider, vision?: SatelliteVisionAnalyzer) {
    this.imageProvider =
      imageProvider ??
      (config.satellite.mock ? new MockSatelliteImageProvider() : new HttpSatelliteImageProvider());
    this.vision = vision ?? new ClaudeVisionAnalyzer();
  }

  /**
   * Verify a property location against satellite imagery.
   *
   * @param lat                 Latitude (-90..90).
   * @param lng                 Longitude (-180..180).
   * @param propertyDescription Listing description to compare against.
   * @returns The verification result, or `null` if coordinates are invalid or an
   *          upstream step failed.
   */
  async verifySatellite(
    lat: number,
    lng: number,
    propertyDescription: string,
  ): Promise<SatelliteVerification | null> {
    if (!isValidLat(lat) || !isValidLng(lng)) {
      logger.warn('Satellite verification called with invalid coordinates', { lat, lng });
      return null;
    }

    let image: SatelliteImage | null;
    try {
      image = await this.imageProvider.fetchImage(lat, lng);
    } catch (err) {
      logger.error('Satellite image provider threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (!image) {
      logger.warn('No satellite image available for coordinates', { lat, lng });
      return null;
    }

    let verdict: SatelliteVerdict;
    try {
      verdict = await this.vision.analyze(image, propertyDescription);
    } catch (err) {
      logger.error('Satellite vision analysis failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const result: SatelliteVerification = {
      verified: verdict.matches,
      confidence_score: clampUnit(verdict.confidence),
      image_url: image.imageUrl,
      matches_description: verdict.matches,
      analysis: verdict.reasoning || null,
      latitude: lat,
      longitude: lng,
      verified_at: new Date().toISOString(),
    };

    logger.info('Satellite verification complete', {
      verified: result.verified,
      confidence: result.confidence_score,
    });
    return result;
  }
}

/** Remove a `key=...` query param from a URL so the API key isn't persisted. */
function stripApiKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete('key');
    return parsed.toString();
  } catch {
    return url;
  }
}

function isValidLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

/** Clamp a confidence value into [0, 1], rounded to 2 dp. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/** Shared singleton used by controllers. */
export const satelliteService = new SatelliteService();
