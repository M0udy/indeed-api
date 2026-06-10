import { AuthService } from '../src/services/auth.service';

describe('AuthService', () => {
  const service = new AuthService();

  describe('generateOtp', () => {
    it('produces a 6-digit numeric string', () => {
      for (let i = 0; i < 100; i += 1) {
        const otp = service.generateOtp();
        expect(otp).toMatch(/^\d{6}$/);
      }
    });

    it('zero-pads small numbers to 6 digits', () => {
      // Probabilistic: across many samples we should see varied values,
      // all still exactly 6 characters long.
      const lengths = new Set<number>();
      for (let i = 0; i < 50; i += 1) lengths.add(service.generateOtp().length);
      expect([...lengths]).toEqual([6]);
    });
  });
});
