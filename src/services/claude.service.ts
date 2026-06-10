import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { UpstreamServiceError } from '../utils/errors';
import type { ClaudeFraudVerdict, FraudRecommendation, Property } from '../types';

/**
 * Claude Haiku-powered property fraud detection.
 *
 * We use Claude's tool-calling to force a strictly-typed JSON verdict — far more
 * reliable than parsing free-text. The model evaluates deed-number validity,
 * seller signals, price anomalies, and location risk, then returns a 0–100
 * fraud score with concrete red flags and an action recommendation.
 */

const FRAUD_TOOL_NAME = 'record_fraud_verdict';

/** JSON-Schema for the structured verdict Claude must return. */
const fraudTool: Anthropic.Tool = {
  name: FRAUD_TOOL_NAME,
  description:
    'Record the structured fraud-risk verdict for a property listing after analysis.',
  input_schema: {
    type: 'object',
    properties: {
      fraud_score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: '0 = no fraud risk, 100 = almost certainly fraudulent.',
      },
      red_flags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Short, specific risk findings, e.g. "price 70% below market".',
      },
      recommendation: {
        type: 'string',
        enum: ['approve', 'review', 'reject'],
        description: 'approve (<25), review (25–60), reject (>60), guided by the score.',
      },
      reasoning: {
        type: 'string',
        description: 'A concise paragraph explaining the verdict.',
      },
    },
    required: ['fraud_score', 'red_flags', 'recommendation', 'reasoning'],
  },
};

const SYSTEM_PROMPT = `You are InDeed's senior property-fraud analyst for Zambia and East Africa.
You assess real-estate listings for signs of fraud. Consider, among other things:
- Deed/title number plausibility and whether it matches regional formats.
- Price anomalies relative to size and location (suspiciously low prices are a classic scam signal).
- Missing, vague, or inconsistent location, size, or seller information.
- Listings that pressure buyers or lack verifiable documentation.
Be calibrated and specific. Do not invent facts not present in the listing; flag missing data as a risk rather than assuming guilt. Always respond by calling the ${FRAUD_TOOL_NAME} tool.`;

export class ClaudeService {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(client?: Anthropic) {
    this.model = config.anthropic.model;
    this.client = client ?? new Anthropic({ apiKey: config.anthropic.apiKey });
  }

  /**
   * Analyse a property listing and return a structured fraud verdict.
   *
   * @throws {UpstreamServiceError} if Claude is unreachable or returns no verdict.
   */
  async analyzeProperty(
    property: Property,
    seller: { name: string | null; kyc_status: string; verification_badge: boolean },
  ): Promise<ClaudeFraudVerdict> {
    const listing = this.buildListingDescription(property, seller);

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [fraudTool],
        tool_choice: { type: 'tool', name: FRAUD_TOOL_NAME },
        messages: [
          {
            role: 'user',
            content: `Analyse this property listing for fraud risk:\n\n${listing}`,
          },
        ],
      });
    } catch (err) {
      logger.error('Claude fraud analysis request failed', {
        propertyId: property.id,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new UpstreamServiceError('Fraud analysis service is temporarily unavailable');
    }

    const verdict = this.extractVerdict(response);
    if (!verdict) {
      logger.error('Claude returned no usable verdict', { propertyId: property.id });
      throw new UpstreamServiceError('Fraud analysis returned no result');
    }

    logger.info('Fraud analysis complete', {
      propertyId: property.id,
      fraudScore: verdict.fraud_score,
      recommendation: verdict.recommendation,
    });
    return verdict;
  }

  /** Render the property + seller into a compact prompt block. */
  private buildListingDescription(
    property: Property,
    seller: { name: string | null; kyc_status: string; verification_badge: boolean },
  ): string {
    const lines = [
      `Title: ${property.title}`,
      `Description: ${property.description ?? '(none provided)'}`,
      `Location: ${property.location ?? '(none provided)'}`,
      `Coordinates: ${property.latitude ?? '?'}, ${property.longitude ?? '?'}`,
      `Size (acres): ${property.size_acres ?? '(unknown)'}`,
      `Price (USD): ${property.price_usd ?? '(unknown)'}`,
      `Deed number: ${property.deed_number ?? '(none provided)'}`,
      `Number of images: ${property.image_urls.length}`,
      `Deed document attached: ${property.deed_document_url ? 'yes' : 'no'}`,
      `Seller name: ${seller.name ?? '(unknown)'}`,
      `Seller KYC status: ${seller.kyc_status}`,
      `Seller verification badge: ${seller.verification_badge ? 'yes' : 'no'}`,
    ];
    return lines.join('\n');
  }

  /** Pull the structured tool-use payload out of Claude's response. */
  private extractVerdict(response: Anthropic.Message): ClaudeFraudVerdict | null {
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name === FRAUD_TOOL_NAME) {
        const input = block.input as Partial<ClaudeFraudVerdict>;
        if (
          typeof input.fraud_score === 'number' &&
          Array.isArray(input.red_flags) &&
          typeof input.recommendation === 'string'
        ) {
          return {
            fraud_score: clampScore(input.fraud_score),
            red_flags: input.red_flags.filter((f): f is string => typeof f === 'string'),
            recommendation: normaliseRecommendation(input.recommendation),
            reasoning: typeof input.reasoning === 'string' ? input.reasoning : '',
          };
        }
      }
    }
    return null;
  }
}

/** Clamp the model's score into the valid 0–100 integer range. */
function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Coerce arbitrary model output into a known recommendation value. */
function normaliseRecommendation(value: string): FraudRecommendation {
  const v = value.toLowerCase();
  if (v === 'approve' || v === 'review' || v === 'reject') return v;
  return 'review';
}

/** Shared singleton used by controllers. */
export const claudeService = new ClaudeService();
