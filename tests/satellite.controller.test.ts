import { SatelliteController } from '../src/controllers/satellite.controller';
import type { SatelliteService } from '../src/services/satellite.service';
import type { PropertyService } from '../src/services/property.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { Property, SatelliteVerification } from '../src/types';
import { ForbiddenError, UnprocessableEntityError } from '../src/utils/errors';
import { mockRequest, mockResponse } from './helpers';

function fakeProperty(overrides: Partial<Property> = {}): Property {
  return {
    id: 'prop-1',
    seller_id: 'seller-1',
    title: 'Plot in Thornpark',
    description: 'Vacant residential plot',
    location: 'Thornpark',
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

const verification: SatelliteVerification = {
  verified: true,
  confidence_score: 0.9,
  image_url: 'https://satellite.test/img.png',
  matches_description: true,
  analysis: 'Open land consistent with a vacant plot',
  latitude: -15.4,
  longitude: 28.3,
  verified_at: '2026-06-11T00:00:00.000Z',
};

function authedRequest(sub = 'seller-1'): AuthenticatedRequest {
  const req = mockRequest({ params: { id: 'prop-1' } }) as AuthenticatedRequest;
  req.auth = { sub, phone: '+260123456789', tier: 'premium' };
  return req;
}

describe('SatelliteController.verify', () => {
  it('verifies, persists, and returns the result', async () => {
    const satellite = {
      verifySatellite: jest.fn().mockResolvedValue(verification),
    } as unknown as SatelliteService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachSatelliteData: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new SatelliteController(satellite, properties);
    const res = mockResponse({ body: { latitude: -15.4, longitude: 28.3, description: 'Vacant plot' } });
    await controller.verify(authedRequest(), res);

    expect(satellite.verifySatellite).toHaveBeenCalledWith(-15.4, 28.3, 'Vacant plot');
    expect(properties.attachSatelliteData).toHaveBeenCalledWith('prop-1', verification);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, satellite: { verified: true } });
  });

  it('falls back to the stored description when none is supplied', async () => {
    const satellite = {
      verifySatellite: jest.fn().mockResolvedValue(verification),
    } as unknown as SatelliteService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty({ description: 'Stored description' })),
      attachSatelliteData: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new SatelliteController(satellite, properties);
    const res = mockResponse({ body: { latitude: -15.4, longitude: 28.3 } });
    await controller.verify(authedRequest(), res);

    expect(satellite.verifySatellite).toHaveBeenCalledWith(-15.4, 28.3, 'Stored description');
  });

  it('forbids verifying someone else’s listing', async () => {
    const satellite = { verifySatellite: jest.fn() } as unknown as SatelliteService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty({ seller_id: 'other' })),
    } as unknown as PropertyService;

    const controller = new SatelliteController(satellite, properties);
    const res = mockResponse({ body: { latitude: -15.4, longitude: 28.3 } });

    await expect(controller.verify(authedRequest('seller-1'), res)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(satellite.verifySatellite).not.toHaveBeenCalled();
  });

  it('returns 422 when verification fails', async () => {
    const satellite = {
      verifySatellite: jest.fn().mockResolvedValue(null),
    } as unknown as SatelliteService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachSatelliteData: jest.fn(),
    } as unknown as PropertyService;

    const controller = new SatelliteController(satellite, properties);
    const res = mockResponse({ body: { latitude: -15.4, longitude: 28.3 } });

    await expect(controller.verify(authedRequest(), res)).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(properties.attachSatelliteData).not.toHaveBeenCalled();
  });
});
