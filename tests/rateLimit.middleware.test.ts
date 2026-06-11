import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import request from 'supertest';
import {
  InMemoryRateStore,
  rateLimit,
  ipIdentify,
  phoneIdentify,
  userIdentify,
  type RateLimitOptions,
} from '../src/middleware/rateLimit';
import { errorHandler } from '../src/middleware/errorHandler';
import { RateLimitError } from '../src/utils/errors';

/**
 * Counting/identity behaviour is tested by driving the middleware DIRECTLY with
 * mock req/res/next — no HTTP. This is deterministic and avoids the ephemeral
 * per-request servers `supertest` creates (firing 100+ of those churns sockets
 * and intermittently produces `socket hang up` / scrambled responses).
 *
 * A small set of supertest tests (≤2 requests each) remains, purely to verify
 * the real 429 response body + headers through the error handler.
 */

/** Minimal Response stub — the limiter only calls `setHeader`. */
function mockRes(): Response {
  return { setHeader: (): void => undefined } as unknown as Response;
}

/**
 * Invoke the middleware `n` times with a fresh `next` each call. Returns the
 * argument passed to `next()` per call: `undefined` = allowed through, a
 * `RateLimitError` = blocked.
 */
async function drive(mw: RequestHandler, req: Request, n: number): Promise<unknown[]> {
  const outcomes: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    let received: unknown;
    const next: NextFunction = (err?: unknown): void => {
      received = err;
    };
    await mw(req, mockRes(), next);
    outcomes.push(received);
  }
  return outcomes;
}

describe('rateLimit counting (direct middleware — no sockets)', () => {
  it('allows requests up to the limit, then blocks', async () => {
    const mw = rateLimit('test', 3, 60_000, { identify: () => 'c', store: new InMemoryRateStore() });
    const outcomes = await drive(mw, {} as Request, 4);
    expect(outcomes.slice(0, 3).every((o) => o === undefined)).toBe(true);
    expect(outcomes[3]).toBeInstanceOf(RateLimitError);
    expect((outcomes[3] as RateLimitError).statusCode).toBe(429);
  });

  it('tracks identities independently', async () => {
    const mw = rateLimit('test', 1, 60_000, {
      identify: (req) => (req as Request & { clientId?: string }).clientId,
      store: new InMemoryRateStore(),
    });
    const reqA = { clientId: 'a' } as unknown as Request;
    const reqB = { clientId: 'b' } as unknown as Request;

    expect((await drive(mw, reqA, 1))[0]).toBeUndefined(); // a: 1 allowed
    expect((await drive(mw, reqB, 1))[0]).toBeUndefined(); // b: fresh count, allowed
    expect((await drive(mw, reqA, 1))[0]).toBeInstanceOf(RateLimitError); // a: exhausted
  });

  it('does not limit requests it cannot attribute to a client', async () => {
    const mw = rateLimit('test', 1, 60_000, { identify: () => undefined, store: new InMemoryRateStore() });
    const outcomes = await drive(mw, {} as Request, 3);
    expect(outcomes).toEqual([undefined, undefined, undefined]);
  });

  describe('configured tiers', () => {
    it('OTP tier: 5 requests per phone per hour, 6th blocked', async () => {
      const mw = rateLimit('otp', 5, 3_600_000, { identify: phoneIdentify, store: new InMemoryRateStore() });
      const req = { body: { phone: '+260123456789' } } as unknown as Request;

      const outcomes = await drive(mw, req, 6);
      expect(outcomes.filter((o) => o === undefined)).toHaveLength(5);
      const blocked = outcomes[5];
      expect(blocked).toBeInstanceOf(RateLimitError);
      // retryAfter is bounded by the 1-hour window.
      expect((blocked as RateLimitError).retryAfter).toBeGreaterThan(0);
      expect((blocked as RateLimitError).retryAfter).toBeLessThanOrEqual(3600);
    });

    it('OTP tier: a different phone has its own count', async () => {
      const mw = rateLimit('otp', 5, 3_600_000, { identify: phoneIdentify, store: new InMemoryRateStore() });
      const reqA = { body: { phone: '+260000000001' } } as unknown as Request;
      const reqB = { body: { phone: '+260000000002' } } as unknown as Request;

      await drive(mw, reqA, 5); // exhaust phone A
      expect((await drive(mw, reqB, 1))[0]).toBeUndefined(); // phone B still allowed
    });

    it('analyze tier: 10 requests per user per day, 11th blocked', async () => {
      const mw = rateLimit('analyze', 10, 86_400_000, { identify: userIdentify, store: new InMemoryRateStore() });
      const req = { auth: { sub: 'user-1' } } as unknown as Request;

      const outcomes = await drive(mw, req, 11);
      expect(outcomes.filter((o) => o === undefined)).toHaveLength(10);
      expect(outcomes[10]).toBeInstanceOf(RateLimitError);
    });

    it('general tier: 100 requests per IP per minute, 101st blocked', async () => {
      const mw = rateLimit('general', 100, 60_000, { identify: ipIdentify, store: new InMemoryRateStore() });
      const req = { ip: '10.0.0.1' } as unknown as Request;

      const outcomes = await drive(mw, req, 101);
      expect(outcomes.filter((o) => o === undefined)).toHaveLength(100);
      expect(outcomes[100]).toBeInstanceOf(RateLimitError);
    });
  });
});

// ── 429 response shape (supertest, ≤2 requests each) ──
function buildApp(limit: number, opts: Omit<RateLimitOptions, 'store'> = {}): Express {
  const app = express();
  app.use(express.json());
  const limiter = rateLimit('test', limit, 60_000, { ...opts, store: new InMemoryRateStore() });
  app.get('/x', limiter, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('rateLimit HTTP response', () => {
  it('returns the documented 429 body shape and Retry-After header', async () => {
    const app = buildApp(1);
    await request(app).get('/x'); // consume the single allowed request
    const res = await request(app).get('/x');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.body.error.message).toMatch(/Too many requests\. Try again in \d+ seconds\./);
    expect(typeof res.body.error.retryAfter).toBe('number');
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.body.error.retryAfter));
  });

  it('exposes X-RateLimit-* headers', async () => {
    const res = await request(buildApp(5)).get('/x');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('skips requests matched by the skip predicate', async () => {
    const app = buildApp(1, { skip: (req) => req.query.skip === '1' });
    expect((await request(app).get('/x?skip=1')).status).toBe(200);
    expect((await request(app).get('/x?skip=1')).status).toBe(200); // never counted
  });
});

describe('InMemoryRateStore', () => {
  it('starts a fresh window after the previous one resets', async () => {
    const store = new InMemoryRateStore();
    expect((await store.increment('k', 50)).count).toBe(1);
    expect((await store.increment('k', 50)).count).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await store.increment('k', 50)).count).toBe(1); // window expired → reset
  });
});
