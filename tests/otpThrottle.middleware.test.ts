import express, { type Express } from 'express';
import request from 'supertest';
import { OtpAttemptStore, otpThrottle } from '../src/middleware/otpThrottle';
import { errorHandler } from '../src/middleware/errorHandler';

const PHONE = '+260123456789';

/**
 * Build a tiny app that mimics verify-otp: a body `{ otp }` of "correct" → 200,
 * anything else → 400 (a failed verify, the case the throttle counts).
 */
function buildApp(store: OtpAttemptStore): Express {
  const app = express();
  app.use(express.json());
  app.post('/verify', otpThrottle(store), (req, res) => {
    if ((req.body as { otp?: string }).otp === 'correct') {
      res.status(200).json({ token: 'jwt' });
    } else {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid OTP' } });
    }
  });
  app.use(errorHandler);
  return app;
}

function attempt(app: Express, otp = 'wrong') {
  return request(app).post('/verify').send({ phone: PHONE, otp });
}

// ── Store logic (deterministic via an injected clock — no timers) ──
describe('OtpAttemptStore', () => {
  it('locks a phone after the 3rd failed attempt', () => {
    let t = 0;
    const store = new OtpAttemptStore({ limit: 3, windowMs: 1000, lockMs: 1000, now: () => t });

    store.recordFailure(PHONE);
    expect(store.lockedFor(PHONE)).toBe(0); // 1 failure
    store.recordFailure(PHONE);
    expect(store.lockedFor(PHONE)).toBe(0); // 2 failures
    store.recordFailure(PHONE);
    expect(store.lockedFor(PHONE)).toBeGreaterThan(0); // 3rd → locked
  });

  it('reset() clears the counter (success path)', () => {
    let t = 0;
    const store = new OtpAttemptStore({ limit: 3, windowMs: 1000, lockMs: 1000, now: () => t });
    store.recordFailure(PHONE);
    store.recordFailure(PHONE);
    store.reset(PHONE); // a successful verify
    store.recordFailure(PHONE); // counts as the 1st again, not the 3rd
    expect(store.lockedFor(PHONE)).toBe(0);
  });

  it('unlocks after the lock window expires', () => {
    let t = 0;
    const store = new OtpAttemptStore({ limit: 3, windowMs: 1000, lockMs: 1000, now: () => t });
    store.recordFailure(PHONE);
    store.recordFailure(PHONE);
    store.recordFailure(PHONE);
    expect(store.lockedFor(PHONE)).toBeGreaterThan(0); // locked until t=1000

    t = 1001; // lock window elapsed
    expect(store.lockedFor(PHONE)).toBe(0);
  });

  it('resets the failure window if attempts are spread beyond it', () => {
    let t = 0;
    const store = new OtpAttemptStore({ limit: 3, windowMs: 1000, lockMs: 1000, now: () => t });
    store.recordFailure(PHONE); // t=0, failures=1
    t = 1500; // beyond the 1000ms window
    store.recordFailure(PHONE); // window reset → failures=1, not 2
    store.recordFailure(PHONE); // failures=2
    expect(store.lockedFor(PHONE)).toBe(0); // still under the limit
  });

  it('keys each phone independently', () => {
    let t = 0;
    const store = new OtpAttemptStore({ limit: 3, windowMs: 1000, lockMs: 1000, now: () => t });
    store.recordFailure(PHONE);
    store.recordFailure(PHONE);
    store.recordFailure(PHONE); // PHONE locked
    expect(store.lockedFor('+260999999999')).toBe(0); // a different phone is unaffected
  });
});

// ── Middleware integration (count-based, deterministic) ──
describe('otpThrottle middleware', () => {
  it('allows 3 failed attempts, then blocks the 4th with 429', async () => {
    const app = buildApp(new OtpAttemptStore());

    expect((await attempt(app)).status).toBe(400);
    expect((await attempt(app)).status).toBe(400);
    expect((await attempt(app)).status).toBe(400);

    const blocked = await attempt(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blocked.body.error.message).toMatch(/Too many OTP attempts\. Try again in \d+ minutes\./);
    expect(blocked.body.error.retryAfter).toBeGreaterThan(0);
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('does not run the verify handler once locked', async () => {
    const handler = jest.fn((_req, res: express.Response) => res.status(400).json({}));
    const app = express();
    app.use(express.json());
    app.post('/verify', otpThrottle(new OtpAttemptStore()), handler);
    app.use(errorHandler);

    for (let i = 0; i < 3; i += 1) await request(app).post('/verify').send({ phone: PHONE, otp: 'x' });
    handler.mockClear();
    const blocked = await request(app).post('/verify').send({ phone: PHONE, otp: 'x' });

    expect(blocked.status).toBe(429);
    expect(handler).not.toHaveBeenCalled(); // throttle short-circuited before the handler
  });

  it('resets the counter on a successful verification', async () => {
    const app = buildApp(new OtpAttemptStore());

    await attempt(app); // 1 fail
    await attempt(app); // 2 fails
    expect((await attempt(app, 'correct')).status).toBe(200); // success → reset

    // After reset, three fresh failures are allowed again before any block.
    expect((await attempt(app)).status).toBe(400);
    expect((await attempt(app)).status).toBe(400);
    expect((await attempt(app)).status).toBe(400);
  });

  it('does not throttle requests without a phone', async () => {
    const app = express();
    app.use(express.json());
    app.post('/verify', otpThrottle(new OtpAttemptStore()), (_req, res) => res.status(400).json({}));
    app.use(errorHandler);

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/verify').send({ otp: 'x' }); // no phone
      expect(res.status).toBe(400); // never 429
    }
  });
});
