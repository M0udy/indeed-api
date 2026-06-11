import { IdentityController } from '../src/controllers/identity.controller';
import type { IdentityService } from '../src/services/identity.service';
import type { PropertyService } from '../src/services/property.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { IdentityVerification, Property } from '../src/types';
import { ForbiddenError, UnprocessableEntityError } from '../src/utils/errors';
import { mockRequest, mockResponse } from './helpers';

function fakeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'prop-1',
    seller_id: 'seller-1',
    title: 'Plot',
    description: null,
    location: null,
    latitude: null,
    longitude: null,
    size_acres: null,
    price_usd: null,
    deed_number: null,
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

const identityResult: IdentityVerification = {
  verified: true,
  confidence_score: 0.95,
  nrc: 'ZM0123456789',
  name: 'John Banda',
  date_of_birth: '1988-04-12',
  photo_match: null,
  verified_at: '2026-06-11T00:00:00.000Z',
};

function authedRequest(sub = 'seller-1'): AuthenticatedRequest {
  const req = mockRequest({ params: { id: 'prop-1' } }) as AuthenticatedRequest;
  req.auth = { sub, phone: '+260123456789', tier: 'premium' };
  return req;
}

describe('IdentityController.verify', () => {
  it('verifies, persists, and returns the result', async () => {
    const identity = {
      verifyIdentity: jest.fn().mockResolvedValue(identityResult),
    } as unknown as IdentityService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachIdentityData: jest.fn().mockResolvedValue(fakeProperty({ identity_data: identityResult })),
    } as unknown as PropertyService;

    const controller = new IdentityController(identity, properties);
    const res = mockResponse({ body: { seller_nrc: 'ZM0123456789' } });
    await controller.verify(authedRequest(), res);

    expect(identity.verifyIdentity).toHaveBeenCalledWith('ZM0123456789', undefined);
    expect(properties.attachIdentityData).toHaveBeenCalledWith('prop-1', identityResult);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, identity: { verified: true } });
  });

  it('passes the photo URL through when provided', async () => {
    const identity = {
      verifyIdentity: jest.fn().mockResolvedValue(identityResult),
    } as unknown as IdentityService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachIdentityData: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new IdentityController(identity, properties);
    const res = mockResponse({
      body: { seller_nrc: 'ZM0123456789', seller_photo_url: 'https://x/y.jpg' },
    });
    await controller.verify(authedRequest(), res);

    expect(identity.verifyIdentity).toHaveBeenCalledWith('ZM0123456789', 'https://x/y.jpg');
  });

  it('forbids verifying identity on someone else’s listing', async () => {
    const identity = { verifyIdentity: jest.fn() } as unknown as IdentityService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty({ seller_id: 'other' })),
    } as unknown as PropertyService;

    const controller = new IdentityController(identity, properties);
    const res = mockResponse({ body: { seller_nrc: 'ZM0123456789' } });

    await expect(controller.verify(authedRequest('seller-1'), res)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(identity.verifyIdentity).not.toHaveBeenCalled();
  });

  it('returns 422 when verification fails', async () => {
    const identity = {
      verifyIdentity: jest.fn().mockResolvedValue(null),
    } as unknown as IdentityService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachIdentityData: jest.fn(),
    } as unknown as PropertyService;

    const controller = new IdentityController(identity, properties);
    const res = mockResponse({ body: { seller_nrc: 'ZM0123456789' } });

    await expect(controller.verify(authedRequest(), res)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(properties.attachIdentityData).not.toHaveBeenCalled();
  });
});
