// Mock the database layer so persistence runs against controlled results.
jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [{}], rowCount: 1 }),
  withTransaction: jest.fn(),
  isDatabaseConnected: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { PropertyService } from '../src/services/property.service';
import { query } from '../src/config/database';
import type { ClaudeService } from '../src/services/claude.service';
import type { RulesService } from '../src/services/rules.service';
import type { ClaudeFraudVerdict, Property, RuleEvaluation, User } from '../src/types';

const mockQuery = query as jest.Mock;

function fakeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'prop-1',
    seller_id: 'seller-1',
    title: 'Plot in Thornpark',
    description: 'Nice plot',
    location: 'Thornpark',
    latitude: null,
    longitude: null,
    size_acres: '1.50',
    price_usd: '15000.00',
    deed_number: 'ZM-2024-001234',
    image_urls: [],
    deed_document_url: null,
    fraud_score: null,
    fraud_flags: {},
    verification_status: 'unverified',
    deed_data: {},
    identity_data: {},
    rules_check: {},
    satellite_data: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function fakeSeller(): User {
  return {
    id: 'seller-1',
    phone: '+260123456789',
    email: null,
    name: 'Seller',
    kyc_status: 'pending',
    subscription_tier: 'free',
    verification_badge: false,
    admin_role: 'user',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  };
}

function fakeRules(ruleScore: number, redFlags: string[] = []): RulesService {
  const evaluation: RuleEvaluation = {
    red_flags: redFlags,
    rule_score: ruleScore,
    details: {},
    evaluated_at: '2026-06-11T00:00:00.000Z',
  };
  return { evaluateRules: jest.fn().mockResolvedValue(evaluation) } as unknown as RulesService;
}

function fakeClaude(verdict: ClaudeFraudVerdict): ClaudeService {
  return { analyzeProperty: jest.fn().mockResolvedValue(verdict) } as unknown as ClaudeService;
}

describe('PropertyService.analyzeProperty', () => {
  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rows: [{}], rowCount: 1 });
  });

  it('averages the rules and Claude scores into the combined fraud_score', async () => {
    const claude = fakeClaude({
      fraud_score: 60,
      red_flags: ['price unusually low'],
      recommendation: 'review',
      reasoning: 'Below market price.',
    });
    const rules = fakeRules(40, ['rule_2_triggered']);
    const service = new PropertyService(claude, rules);

    const result = await service.analyzeProperty(fakeProperty(), fakeSeller());

    expect(result.rule_score).toBe(40);
    expect(result.claude_score).toBe(60);
    expect(result.fraud_score).toBe(50); // (40 + 60) / 2
    expect(result.verification_status).toBe('caution'); // 50 → caution
    expect(result.recommendation).toBe('review');
    // Red flags from both engines, de-duplicated.
    expect(result.red_flags).toEqual(['price unusually low', 'rule_2_triggered']);
  });

  it('rounds the average to an integer', async () => {
    const service = new PropertyService(
      fakeClaude({ fraud_score: 70, red_flags: [], recommendation: 'review', reasoning: '' }),
      fakeRules(15),
    );
    const result = await service.analyzeProperty(fakeProperty(), fakeSeller());
    expect(result.fraud_score).toBe(43); // round((70 + 15) / 2) = round(42.5)
  });

  it('maps a low combined score to "verified" and a high one to "flagged"', async () => {
    const low = await new PropertyService(
      fakeClaude({ fraud_score: 10, red_flags: [], recommendation: 'approve', reasoning: '' }),
      fakeRules(8),
    ).analyzeProperty(fakeProperty(), fakeSeller());
    expect(low.verification_status).toBe('verified'); // 9 < 25

    const high = await new PropertyService(
      fakeClaude({ fraud_score: 90, red_flags: [], recommendation: 'reject', reasoning: '' }),
      fakeRules(80),
    ).analyzeProperty(fakeProperty(), fakeSeller());
    expect(high.verification_status).toBe('flagged'); // 85 > 60
  });

  it('persists the combined score and writes an audit row', async () => {
    const service = new PropertyService(
      fakeClaude({ fraud_score: 60, red_flags: ['x'], recommendation: 'review', reasoning: 'r' }),
      fakeRules(40, ['rule_2_triggered']),
    );

    await service.analyzeProperty(fakeProperty(), fakeSeller());

    const statements = mockQuery.mock.calls.map((c) => String(c[0]));
    const update = statements.find((s) => s.includes('UPDATE properties') && s.includes('fraud_score'));
    const insert = statements.find((s) => s.includes('INSERT INTO fraud_analyses'));
    expect(update).toBeDefined();
    expect(insert).toBeDefined();

    // The persisted score is the combined 50, not either sub-score.
    const updateCall = mockQuery.mock.calls.find(
      (c) => String(c[0]).includes('UPDATE properties') && String(c[0]).includes('fraud_score'),
    );
    expect(updateCall?.[1]?.[1]).toBe(50);
  });

  it('runs both engines exactly once', async () => {
    const claude = fakeClaude({ fraud_score: 50, red_flags: [], recommendation: 'review', reasoning: '' });
    const rules = fakeRules(50);
    const service = new PropertyService(claude, rules);

    await service.analyzeProperty(fakeProperty(), fakeSeller());

    expect((claude.analyzeProperty as jest.Mock)).toHaveBeenCalledTimes(1);
    expect((rules.evaluateRules as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
