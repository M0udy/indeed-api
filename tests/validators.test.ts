import {
  createPropertySchema,
  phoneSchema,
  propertyFiltersSchema,
  verifyOtpSchema,
} from '../src/utils/validators';

describe('validators', () => {
  describe('phoneSchema', () => {
    it('accepts a valid international number', () => {
      expect(phoneSchema.parse('+260123456789')).toBe('+260123456789');
    });

    it('rejects a number without a country code', () => {
      expect(() => phoneSchema.parse('0977123456')).toThrow();
    });

    it('rejects a number with letters', () => {
      expect(() => phoneSchema.parse('+26012ABC')).toThrow();
    });
  });

  describe('verifyOtpSchema', () => {
    it('accepts a 6-digit OTP', () => {
      const result = verifyOtpSchema.parse({ phone: '+260123456789', otp: '123456' });
      expect(result.otp).toBe('123456');
    });

    it('rejects an OTP that is too short', () => {
      expect(() => verifyOtpSchema.parse({ phone: '+260123456789', otp: '123' })).toThrow();
    });
  });

  describe('createPropertySchema', () => {
    it('accepts a minimal valid listing', () => {
      const result = createPropertySchema.parse({ title: 'Nice plot in Thornpark' });
      expect(result.title).toBe('Nice plot in Thornpark');
    });

    it('coerces numeric strings for price and size', () => {
      const result = createPropertySchema.parse({
        title: 'Plot',
        price_usd: '15000',
        size_acres: '2.5',
      });
      expect(result.price_usd).toBe(15000);
      expect(result.size_acres).toBe(2.5);
    });

    it('rejects an out-of-range latitude', () => {
      expect(() => createPropertySchema.parse({ title: 'Plot', latitude: 200 })).toThrow();
    });

    it('rejects a title that is too short', () => {
      expect(() => createPropertySchema.parse({ title: 'ab' })).toThrow();
    });
  });

  describe('propertyFiltersSchema', () => {
    it('applies default limit and offset', () => {
      const result = propertyFiltersSchema.parse({});
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it('coerces query-string numbers', () => {
      const result = propertyFiltersSchema.parse({ price_min: '100', price_max: '500' });
      expect(result.price_min).toBe(100);
      expect(result.price_max).toBe(500);
    });

    it('caps the limit at 100', () => {
      expect(() => propertyFiltersSchema.parse({ limit: '500' })).toThrow();
    });
  });
});
