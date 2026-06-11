import { RulesService } from '../src/services/rules.service';
import type {
  RulesIdentityInput,
  RulesOcrInput,
  RulesPropertyInput,
  SatelliteData,
} from '../src/types';

/**
 * The rules engine is deterministic, so each rule is exercised in isolation by
 * starting from a "clean" input set (no rules trigger) and perturbing exactly
 * one signal. Combination and scoring behaviour is then checked on top.
 */

const service = new RulesService();

/** A baseline that triggers none of the 12 rules. */
function cleanProperty(overrides: Partial<RulesPropertyInput> = {}): RulesPropertyInput {
  return {
    id: 'prop-1',
    price_usd: 100_000,
    deed_number: 'ZM-2024-001234',
    location: 'Lusaka, Thornpark',
    market_value_usd: 100_000,
    deed_registry_match: true,
    duplicate_listing_count: 0,
    seller_dispute_count: 0,
    seller_nrc: 'ZM0123456789',
    ...overrides,
  };
}

function cleanOcr(overrides: Partial<RulesOcrInput> = {}): RulesOcrInput {
  return {
    deed_number: 'ZM-2024-001234',
    transaction_date: '2024-01-01',
    amount_in_numbers: 100_000,
    buyer_name: 'Jane Buyer',
    ...overrides,
  };
}

function cleanIdentity(overrides: Partial<RulesIdentityInput> = {}): RulesIdentityInput {
  return { verified: true, nrc: 'ZM0123456789', ...overrides };
}

function cleanSatellite(overrides: Partial<SatelliteData> = {}): SatelliteData {
  return { matches_description: true, ...overrides };
}

describe('RulesService.evaluateRules', () => {
  it('triggers nothing for a clean property (score 0)', async () => {
    const result = await service.evaluateRules(
      cleanProperty(),
      cleanOcr(),
      cleanIdentity(),
      cleanSatellite(),
    );
    expect(result.red_flags).toEqual([]);
    expect(result.rule_score).toBe(0);
    expect(Object.keys(result.details)).toHaveLength(12);
    expect(typeof result.evaluated_at).toBe('string');
  });

  describe('individual rules', () => {
    it('rule 1 — deed not in registry', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ deed_registry_match: false }),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_1_triggered']);
      expect(r.rule_score).toBe(8);
      expect(r.details.rule_1?.reason).toBeTruthy();
    });

    it('rule 1 — also triggers when no deed number is present', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ deed_number: null }),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toContain('rule_1_triggered');
    });

    it('rule 2 — price unusually low', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ price_usd: 20_000 }),
        cleanOcr({ amount_in_numbers: 20_000 }), // keep amounts consistent (avoid rule 10)
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_2_triggered']);
      expect(r.rule_score).toBe(8);
    });

    it('rule 3 — price unusually high', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ price_usd: 400_000 }),
        cleanOcr({ amount_in_numbers: 400_000 }),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_3_triggered']);
    });

    it('rule 4 — seller identity not verified', async () => {
      const r = await service.evaluateRules(
        cleanProperty(),
        cleanOcr(),
        cleanIdentity({ verified: false }),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_4_triggered']);
    });

    it('rule 4 — also triggers when identity is entirely absent', async () => {
      const r = await service.evaluateRules(cleanProperty(), cleanOcr(), null, cleanSatellite());
      expect(r.red_flags).toContain('rule_4_triggered');
    });

    it('rule 5 — invalid NRC format', async () => {
      const r = await service.evaluateRules(
        cleanProperty(),
        cleanOcr(),
        cleanIdentity({ nrc: 'NOT-VALID' }),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_5_triggered']);
    });

    it('rule 6 — listed multiple times simultaneously', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ duplicate_listing_count: 2 }),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_6_triggered']);
    });

    it('rule 7 — deed date very old', async () => {
      const r = await service.evaluateRules(
        cleanProperty(),
        cleanOcr({ transaction_date: '2005-06-01' }),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_7_triggered']);
    });

    it('rule 8 — satellite mismatch', async () => {
      const r = await service.evaluateRules(
        cleanProperty(),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite({ matches_description: false }),
      );
      expect(r.red_flags).toEqual(['rule_8_triggered']);
    });

    it('rule 9 — buyer name missing', async () => {
      const r = await service.evaluateRules(
        cleanProperty(),
        cleanOcr({ buyer_name: null }),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_9_triggered']);
    });

    it('rule 10 — transaction amount does not match price', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ price_usd: 100_000 }),
        cleanOcr({ amount_in_numbers: 50_000 }),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_10_triggered']);
    });

    it('rule 11 — outside Lusaka metro is a warning (0 points)', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ location: 'Ndola, Copperbelt' }),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_11_triggered']);
      expect(r.rule_score).toBe(0); // warning contributes nothing
      expect(r.details.rule_11?.severity).toBe('warning');
    });

    it('rule 12 — seller has dispute history', async () => {
      const r = await service.evaluateRules(
        cleanProperty({ seller_dispute_count: 3 }),
        cleanOcr(),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags).toEqual(['rule_12_triggered']);
    });
  });

  describe('combinations and scoring', () => {
    it('sums weights for multiple triggered rules', async () => {
      // Rule 2 (low price) + Rule 7 (old deed).
      const r = await service.evaluateRules(
        cleanProperty({ price_usd: 20_000 }),
        cleanOcr({ amount_in_numbers: 20_000, transaction_date: '2005-01-01' }),
        cleanIdentity(),
        cleanSatellite(),
      );
      expect(r.red_flags.sort()).toEqual(['rule_2_triggered', 'rule_7_triggered']);
      expect(r.rule_score).toBe(16);
    });

    it('a warning does not add to the score alongside real flags', async () => {
      // Rule 4 (unverified) + Rule 11 (outside metro, warning).
      const r = await service.evaluateRules(
        cleanProperty({ location: 'Kitwe' }),
        cleanOcr(),
        cleanIdentity({ verified: false }),
        cleanSatellite(),
      );
      expect(r.red_flags.sort()).toEqual(['rule_11_triggered', 'rule_4_triggered']);
      expect(r.rule_score).toBe(8); // only rule 4 counts
    });

    it('scores all scoring rules together and never exceeds 100', async () => {
      // Trigger rules 1,2,4,5,6,7,8,9,10,11,12 (rule 3 excluded — opposite of 2).
      const r = await service.evaluateRules(
        cleanProperty({
          price_usd: 20_000, // rule 2
          market_value_usd: 100_000,
          deed_registry_match: false, // rule 1
          duplicate_listing_count: 4, // rule 6
          seller_dispute_count: 1, // rule 12
          location: 'Livingstone', // rule 11 (warning)
        }),
        cleanOcr({
          transaction_date: '2001-01-01', // rule 7
          buyer_name: null, // rule 9
          amount_in_numbers: 999, // rule 10 (mismatch vs 20,000)
        }),
        cleanIdentity({ verified: false, nrc: 'BAD' }), // rules 4 + 5
        cleanSatellite({ matches_description: false }), // rule 8
      );

      // 10 scoring rules × 8 = 80, plus rule 11 warning (0).
      expect(r.red_flags).toHaveLength(11);
      expect(r.red_flags).not.toContain('rule_3_triggered');
      expect(r.rule_score).toBe(80);
      expect(r.rule_score).toBeLessThanOrEqual(100);
      expect(r.details.rule_3?.triggered).toBe(false);
    });

    it('does not assess OCR-dependent rules when OCR data is absent', async () => {
      const r = await service.evaluateRules(cleanProperty(), null, cleanIdentity(), cleanSatellite());
      // Buyer-missing (9), old-deed (7), amount-mismatch (10) all need OCR data.
      expect(r.red_flags).toEqual([]);
      expect(r.rule_score).toBe(0);
    });
  });
});
