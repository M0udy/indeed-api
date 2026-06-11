import { RulesController } from '../src/controllers/rules.controller';
import type { RulesService } from '../src/services/rules.service';
import type { PropertyService } from '../src/services/property.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { Property, RuleEvaluation } from '../src/types';
import { ForbiddenError } from '../src/utils/errors';
import { mockRequest, mockResponse } from './helpers';

function fakeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'prop-1',
    seller_id: 'seller-1',
    title: 'Plot',
    description: null,
    location: 'Lusaka',
    latitude: null,
    longitude: null,
    size_acres: null,
    price_usd: '100000.00',
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

const evaluation: RuleEvaluation = {
  red_flags: ['rule_4_triggered'],
  rule_score: 8,
  details: {},
  evaluated_at: '2026-06-11T00:00:00.000Z',
};

function authedRequest(sub = 'seller-1'): AuthenticatedRequest {
  const req = mockRequest({ params: { id: 'prop-1' } }) as AuthenticatedRequest;
  req.auth = { sub, phone: '+260123456789', tier: 'premium' };
  return req;
}

describe('RulesController.check', () => {
  it('evaluates rules, persists, and returns the result', async () => {
    const rules = {
      evaluateRules: jest.fn().mockResolvedValue(evaluation),
    } as unknown as RulesService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachRulesCheck: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new RulesController(rules, properties);
    const res = mockResponse({ body: {} });
    await controller.check(authedRequest(), res);

    expect(rules.evaluateRules).toHaveBeenCalledTimes(1);
    expect(properties.attachRulesCheck).toHaveBeenCalledWith('prop-1', evaluation);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, rule_score: 8, red_flags: ['rule_4_triggered'] });
  });

  it('passes the listed price and body context through to the engine', async () => {
    const rules = {
      evaluateRules: jest.fn().mockResolvedValue(evaluation),
    } as unknown as RulesService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachRulesCheck: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new RulesController(rules, properties);
    const res = mockResponse({ body: { property: { market_value_usd: 250000 } } });
    await controller.check(authedRequest(), res);

    const [propertyInput] = (rules.evaluateRules as jest.Mock).mock.calls[0];
    expect(propertyInput).toMatchObject({ id: 'prop-1', price_usd: 100000, market_value_usd: 250000 });
  });

  it('forbids running rules on someone else’s listing', async () => {
    const rules = { evaluateRules: jest.fn() } as unknown as RulesService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty({ seller_id: 'other' })),
    } as unknown as PropertyService;

    const controller = new RulesController(rules, properties);
    await expect(controller.check(authedRequest('seller-1'), mockResponse({ body: {} }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(rules.evaluateRules).not.toHaveBeenCalled();
  });
});
