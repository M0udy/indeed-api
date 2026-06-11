import { OcrController } from '../src/controllers/ocr.controller';
import type { OcrService } from '../src/services/ocr.service';
import type { PropertyService } from '../src/services/property.service';
import type { AuthenticatedRequest } from '../src/middleware/auth';
import type { DeedData, Property } from '../src/types';
import { ForbiddenError, UnprocessableEntityError, ValidationError } from '../src/utils/errors';
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
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const deedData: DeedData = {
  deed_number: 'ZM-2024-001234',
  property_address: '123 Main St, Lusaka',
  seller_name: 'John Doe',
  buyer_name: null,
  transaction_date: '2024-03-15',
  amount_in_words: null,
  amount_in_numbers: 1_000_000,
  location_coordinates: null,
  confidence_score: 0.92,
  raw_text: 'Deed Number: ZM-2024-001234',
};

function authedRequest(sub = 'seller-1'): AuthenticatedRequest {
  const req = mockRequest({ params: { id: 'prop-1' } }) as AuthenticatedRequest;
  req.auth = { sub, phone: '+260123456789', tier: 'premium' };
  req.file = { buffer: Buffer.from('img') } as Express.Multer.File;
  return req;
}

describe('OcrController.parse', () => {
  it('parses the deed, persists it, and returns the data', async () => {
    const ocr = { parseDeedImage: jest.fn().mockResolvedValue(deedData) } as unknown as OcrService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachDeedData: jest.fn().mockResolvedValue(fakeProperty({ deed_data: deedData })),
    } as unknown as PropertyService;

    const controller = new OcrController(ocr, properties);
    const res = mockResponse();
    await controller.parse(authedRequest(), res);

    expect(properties.attachDeedData).toHaveBeenCalledWith('prop-1', deedData);
    expect(res._status).toBe(200);
    expect(res._json).toMatchObject({ success: true, deed_data: { deed_number: 'ZM-2024-001234' } });
  });

  it('forbids OCR on a listing owned by someone else', async () => {
    const ocr = { parseDeedImage: jest.fn() } as unknown as OcrService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty({ seller_id: 'other' })),
    } as unknown as PropertyService;

    const controller = new OcrController(ocr, properties);
    await expect(controller.parse(authedRequest('seller-1'), mockResponse())).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(ocr.parseDeedImage).not.toHaveBeenCalled();
  });

  it('returns 422 when the image cannot be parsed', async () => {
    const ocr = { parseDeedImage: jest.fn().mockResolvedValue(null) } as unknown as OcrService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
      attachDeedData: jest.fn(),
    } as unknown as PropertyService;

    const controller = new OcrController(ocr, properties);
    await expect(controller.parse(authedRequest(), mockResponse())).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(properties.attachDeedData).not.toHaveBeenCalled();
  });

  it('rejects when no file is provided', async () => {
    const ocr = { parseDeedImage: jest.fn() } as unknown as OcrService;
    const properties = {
      findById: jest.fn().mockResolvedValue(fakeProperty()),
    } as unknown as PropertyService;

    const controller = new OcrController(ocr, properties);
    const req = authedRequest();
    delete req.file;
    await expect(controller.parse(req, mockResponse())).rejects.toBeInstanceOf(ValidationError);
  });
});
