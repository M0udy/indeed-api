import { Engine, type TopLevelCondition } from 'json-rules-engine';
import { normaliseNrc } from './identity.service';
import { logger } from '../utils/logger';
import type {
  RuleEvaluation,
  RuleResult,
  RuleSeverity,
  RulesIdentityInput,
  RulesOcrInput,
  RulesPropertyInput,
  SatelliteData,
} from '../types';

/**
 * Deterministic fraud rules engine.
 *
 * Twelve rules are evaluated with {@link https://github.com/CacheControl/json-rules-engine
 * json-rules-engine}. Following the engine's recommended pattern, all derived
 * values (price ratios, deed age, NRC validity, …) are computed in code into a
 * flat {@link Facts} object, and each rule is a small declarative condition over
 * those facts. Every triggered rule contributes its weight (8 points, except the
 * "warning only" rule 11 which contributes 0) to a 0–100 `rule_score`.
 *
 * The engine is built once and reused; facts are supplied per evaluation, so the
 * service holds no mutable per-request state.
 */

/** Points awarded per triggered (non-warning) rule. */
const RULE_WEIGHT = 8;
const MAX_SCORE = 100;

/** Relative tolerance when comparing deed amount to listed price (rule 10). */
const AMOUNT_TOLERANCE = 0.05;

/** Lusaka metropolitan area keywords used by rule 11. */
const LUSAKA_METRO_KEYWORDS = [
  'lusaka',
  'thornpark',
  'thorn park',
  'kabulonga',
  'woodlands',
  'roma',
  'chelston',
  'avondale',
  'chilenje',
  'matero',
  'kabwata',
  'libala',
  'olympia',
  'rhodes park',
  'longacres',
  'kalingalinga',
  'chalala',
  'ibex',
  'meanwood',
  'garden',
  'northmead',
  'emmasdale',
  'kamwala',
];

/** Milliseconds in an average year (accounts for leap years). */
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

/** Flat fact set derived from the raw inputs and consumed by the engine. */
interface Facts {
  deed_number_present: boolean;
  deed_registry_match: boolean;
  price_ratio: number;
  identity_verified: boolean;
  nrc_invalid: boolean;
  duplicate_count: number;
  deed_age_years: number;
  satellite_mismatch: boolean;
  buyer_name_missing: boolean;
  amount_mismatch: boolean;
  outside_lusaka: boolean;
  dispute_count: number;
}

/** Static definition of a single rule. */
interface RuleDef {
  id: string;
  description: string;
  weight: number;
  severity: RuleSeverity;
  conditions: TopLevelCondition;
  /** Produces the human-readable reason shown when the rule triggers. */
  reason: (facts: Facts) => string;
}

/** The twelve fraud rules, in order. */
const RULE_DEFS: readonly RuleDef[] = [
  {
    id: 'rule_1',
    description: 'Deed number not found in registry',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: {
      any: [
        { fact: 'deed_number_present', operator: 'equal', value: false },
        { fact: 'deed_registry_match', operator: 'equal', value: false },
      ],
    },
    reason: (f) =>
      f.deed_number_present
        ? 'Deed number could not be located in the lands registry.'
        : 'No deed number was provided for this property.',
  },
  {
    id: 'rule_2',
    description: 'Price unusually low (< 30% of market value)',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'price_ratio', operator: 'lessThan', value: 0.3 }] },
    reason: (f) => `Listed price is ${Math.round(f.price_ratio * 100)}% of estimated market value.`,
  },
  {
    id: 'rule_3',
    description: 'Price unusually high (> 300% of market value)',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'price_ratio', operator: 'greaterThan', value: 3 }] },
    reason: (f) => `Listed price is ${Math.round(f.price_ratio * 100)}% of estimated market value.`,
  },
  {
    id: 'rule_4',
    description: 'Seller identity not verified',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'identity_verified', operator: 'equal', value: false }] },
    reason: () => 'Seller identity has not been verified.',
  },
  {
    id: 'rule_5',
    description: 'Seller NRC has an invalid format',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'nrc_invalid', operator: 'equal', value: true }] },
    reason: () => 'Seller NRC does not match the expected ZM0123456789 format.',
  },
  {
    id: 'rule_6',
    description: 'Property listed multiple times simultaneously',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'duplicate_count', operator: 'greaterThan', value: 0 }] },
    reason: (f) => `${f.duplicate_count} other active listing(s) share this deed number.`,
  },
  {
    id: 'rule_7',
    description: 'Deed date very old (> 10 years, no recent updates)',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'deed_age_years', operator: 'greaterThan', value: 10 }] },
    reason: (f) => `Deed transaction date is ${Math.floor(f.deed_age_years)} years old.`,
  },
  {
    id: 'rule_8',
    description: 'Satellite image does not match property description',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'satellite_mismatch', operator: 'equal', value: true }] },
    reason: () => 'Satellite imagery does not match the stated property description.',
  },
  {
    id: 'rule_9',
    description: 'Buyer name missing',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'buyer_name_missing', operator: 'equal', value: true }] },
    reason: () => 'No buyer name was found on the deed.',
  },
  {
    id: 'rule_10',
    description: 'Transaction amount does not match stated price',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'amount_mismatch', operator: 'equal', value: true }] },
    reason: () => 'Deed transaction amount differs from the listed price.',
  },
  {
    id: 'rule_11',
    description: 'Location outside Lusaka metro (warning only)',
    weight: 0,
    severity: 'warning',
    conditions: { all: [{ fact: 'outside_lusaka', operator: 'equal', value: true }] },
    reason: () => 'Property is located outside the Lusaka metropolitan area.',
  },
  {
    id: 'rule_12',
    description: 'Seller has a history of disputes',
    weight: RULE_WEIGHT,
    severity: 'flag',
    conditions: { all: [{ fact: 'dispute_count', operator: 'greaterThan', value: 0 }] },
    reason: (f) => `Seller has ${f.dispute_count} prior dispute(s) on record.`,
  },
] as const;

export class RulesService {
  private readonly engine: Engine;

  constructor() {
    this.engine = new Engine([], { allowUndefinedFacts: true });
    for (const def of RULE_DEFS) {
      this.engine.addRule({ name: def.id, conditions: def.conditions, event: { type: def.id } });
    }
  }

  /**
   * Evaluate all fraud rules for a property.
   *
   * @param property      Property fields + contextual signals.
   * @param ocrData       Deed OCR fields, or null if OCR has not run.
   * @param identity      Seller identity result, or null if not verified.
   * @param satelliteData Satellite analysis, or null if unavailable.
   * @returns A {@link RuleEvaluation} with triggered flags, score, and details.
   */
  async evaluateRules(
    property: RulesPropertyInput,
    ocrData: RulesOcrInput | null,
    identity: RulesIdentityInput | null,
    satelliteData: SatelliteData | null,
  ): Promise<RuleEvaluation> {
    const facts = this.computeFacts(property, ocrData, identity, satelliteData);

    const { events } = await this.engine.run(facts);
    const triggered = new Set(events.map((event) => event.type));

    const details: Record<string, RuleResult> = {};
    const redFlags: string[] = [];
    let score = 0;

    for (const def of RULE_DEFS) {
      const isTriggered = triggered.has(def.id);
      const key = `${def.id}_triggered`;
      details[def.id] = {
        id: def.id,
        key,
        description: def.description,
        triggered: isTriggered,
        weight: def.weight,
        severity: def.severity,
        reason: isTriggered ? def.reason(facts) : null,
      };
      if (isTriggered) {
        redFlags.push(key);
        score += def.weight;
      }
    }

    const evaluation: RuleEvaluation = {
      red_flags: redFlags,
      rule_score: Math.min(MAX_SCORE, score),
      details,
      evaluated_at: new Date().toISOString(),
    };

    logger.info('Rules evaluation complete', {
      propertyId: property.id,
      ruleScore: evaluation.rule_score,
      triggered: redFlags.length,
    });
    return evaluation;
  }

  /** Derive the flat fact set the engine evaluates against. */
  private computeFacts(
    property: RulesPropertyInput,
    ocrData: RulesOcrInput | null,
    identity: RulesIdentityInput | null,
    satelliteData: SatelliteData | null,
  ): Facts {
    const deedNumberPresent = isNonEmpty(property.deed_number);

    // Unknown registry status (null/undefined) is treated as a match so the
    // rule only fires on an explicit "not found".
    const deedRegistryMatch = property.deed_registry_match !== false;

    const priceRatio = this.computePriceRatio(property.price_usd, property.market_value_usd);

    const nrc = identity?.nrc ?? property.seller_nrc ?? null;
    const nrcInvalid = isNonEmpty(nrc) ? normaliseNrc(nrc) === null : false;

    return {
      deed_number_present: deedNumberPresent,
      deed_registry_match: deedRegistryMatch,
      price_ratio: priceRatio,
      identity_verified: identity?.verified === true,
      nrc_invalid: nrcInvalid,
      duplicate_count: property.duplicate_listing_count ?? 0,
      deed_age_years: this.computeDeedAgeYears(ocrData?.transaction_date ?? null),
      satellite_mismatch: satelliteData?.matches_description === false,
      // Only assessable when OCR data is present.
      buyer_name_missing: ocrData ? !isNonEmpty(ocrData.buyer_name) : false,
      amount_mismatch: this.computeAmountMismatch(property.price_usd, ocrData?.amount_in_numbers),
      outside_lusaka: isNonEmpty(property.location) ? !isLusakaMetro(property.location) : false,
      dispute_count: property.seller_dispute_count ?? 0,
    };
  }

  /** Price ÷ market value; returns a neutral 1 when either is unknown. */
  private computePriceRatio(price: number | null, market: number | null | undefined): number {
    if (price === null || market === null || market === undefined || market <= 0) return 1;
    return price / market;
  }

  /** Age in years of a deed date string; 0 when missing or unparseable. */
  private computeDeedAgeYears(dateStr: string | null): number {
    if (!isNonEmpty(dateStr)) return 0;
    const parsed = Date.parse(dateStr);
    if (Number.isNaN(parsed)) return 0;
    const ageMs = Date.now() - parsed;
    return ageMs > 0 ? ageMs / YEAR_MS : 0;
  }

  /** Whether the deed amount differs from the listed price beyond tolerance. */
  private computeAmountMismatch(
    price: number | null,
    amount: number | null | undefined,
  ): boolean {
    if (price === null || price <= 0 || amount === null || amount === undefined) return false;
    return Math.abs(amount - price) / price > AMOUNT_TOLERANCE;
  }
}

/** True when a string value is present and non-blank. */
function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether a location string falls within the Lusaka metro keyword set. */
function isLusakaMetro(location: string): boolean {
  const haystack = location.toLowerCase();
  return LUSAKA_METRO_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/** Shared singleton used by controllers. */
export const rulesService = new RulesService();
