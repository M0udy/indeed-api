import { PropertyController } from '../src/controllers/property.controller';
import type { PropertyService } from '../src/services/property.service';
import type { UserService } from '../src/services/user.service';
import type { S3Service } from '../src/services/s3.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { FraudAnalysisResult, Property, User } from '../src/types';
import { ForbiddenError } from '../src/utils/errors';
import { mockRequest, mockResponse } from './helpers';

function fakeUser(overrides: Partial<User> = {}): User {
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
    ...overrides,
  };
}

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
    deed_number: 'LUSK/123',
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

function authedRequest(sub = 'seller-1', tier: User['subscription_tier'] = 'free'): AuthenticatedRequest {
  const req = mockRequest({ params: { id: 'prop-1' } }) as AuthenticatedRequest;
  req.auth = { sub, phone: '+260123456789', tier };
  return req;
}

describe('PropertyController', () => {
  describe('create', () => {
    it('creates a listing owned by the authenticated user', async () => {
      const created = fakeProperty();
      const properties = {
        create: jest.fn().mockResolvedValue(created),
      } as unknown as PropertyService;
      const controller = new PropertyController(properties, {} as UserService, {} as S3Service);

      const req = authedRequest();
      const res = mockResponse({ body: { title: 'Plot in Thornpark', price_usd: 15000 } });

      await controller.create(req, res);

      expect(properties.create).toHaveBeenCalledWith('seller-1', expect.objectContaining({ title: 'Plot in Thornpark' }));
      expect(res._status).toBe(201);
      expect(res._json).toMatchObject({ id: 'prop-1', fraud_score: null });
    });
  });

  describe('update', () => {
    it('forbids updating a listing owned by someone else', async () => {
      const properties = {
        findById: jest.fn().mockResolvedValue(fakeProperty({ seller_id: 'someone-else' })),
      } as unknown as PropertyService;
      const controller = new PropertyController(properties, {} as UserService, {} as S3Service);

      const req = authedRequest('seller-1');
      const res = mockResponse({ body: { title: 'Hijacked title' } });

      await expect(controller.update(req, res)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe('analyze', () => {
    it('returns a locked result for free-tier users', async () => {
      const properties = {
        findById: jest.fn().mockResolvedValue(fakeProperty()),
        analyzeProperty: jest.fn(),
      } as unknown as PropertyService;
      const users = {
        findById: jest.fn().mockResolvedValue(fakeUser({ subscription_tier: 'free' })),
      } as unknown as UserService;
      const controller = new PropertyController(properties, users, {} as S3Service);

      const req = authedRequest('seller-1', 'free');
      const res = mockResponse();

      await controller.analyze(req, res);

      expect(properties.analyzeProperty).not.toHaveBeenCalled();
      expect(res._status).toBe(200);
      expect(res._json).toMatchObject({ fraud_score: null, rule_score: null, claude_score: null, locked: true });
    });

    it('delegates to the combined analysis for premium users', async () => {
      const combined: FraudAnalysisResult = {
        fraud_score: 50,
        rule_score: 40,
        claude_score: 60,
        red_flags: ['price unusually low', 'rule_2_triggered'],
        recommendation: 'review',
        verification_status: 'caution',
      };
      const property = fakeProperty();
      const seller = fakeUser({ id: 'seller-1' });
      const properties = {
        findById: jest.fn().mockResolvedValue(property),
        analyzeProperty: jest.fn().mockResolvedValue(combined),
      } as unknown as PropertyService;
      const users = {
        findById: jest
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(
              id === 'premium-user'
                ? fakeUser({ id: 'premium-user', subscription_tier: 'premium' })
                : seller,
            ),
          ),
      } as unknown as UserService;

      const controller = new PropertyController(properties, users, {} as S3Service);
      const req = authedRequest('premium-user', 'premium');
      const res = mockResponse();

      await controller.analyze(req, res);

      expect(properties.analyzeProperty).toHaveBeenCalledWith(property, seller);
      expect(res._json).toMatchObject({
        fraud_score: 50,
        rule_score: 40,
        claude_score: 60,
        verification_status: 'caution',
      });
    });
  });
});
