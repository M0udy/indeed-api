import express, { type Express } from 'express';
import request from 'supertest';
import {
  InMemoryRateStore,
  rateLimit,
  phoneIdentify,
  userIdentify,
  type RateLimitOptions,
} from '../src/middleware/rateLimit';
import { errorHandler } from '../src/middleware/errorHandler';

/**
 * Each test gets a fresh in-memory store (injected), so counters never leak
 * between cases. A tiny app exercises the full middleware → error-handler path,
 * including the documented 429 body shape and Retry-After header.
 */

function buildApp(
  limit: number,
  windowMs: number,
  opts: Omit<RateLimitOptions, 'store'> = {},
  method: 'get' | 'post' = 'get',
): Express {
  const app = express();
  app.use(express.json());
  const store = new InMemoryRateStore();
  const limiter = rateLimit('test', limit, windowMs, { ...opts, store });
  app[method]('/x', limiter, (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

/** Fire N sequential GETs and return their status codes. */
async function hit(app: Express, n: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await request(app).get('/x');
    statuses.push(res.status);
  }
  return statuses;
}

describe('rateLimit middleware', () => {
  it('allows requests up to the limit, then returns 429', async () => {
    const app = buildApp(3, 60_000);
    const statuses = await hit(app, 4);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('returns the documented 429 body shape and Retry-After header', async () => {
    const app = buildApp(1, 60_000);
    await request(app).get('/x'); // consume the single allowed request
    const res = await request(app).get('/x');

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res.body.error.message).toMatch(/Too many requests\. Try again in \d+ seconds\./);
    expect(typeof res.body.error.retryAfter).toBe('number');
    expect(res.body.error.retryAfter).toBeGreaterThan(0);
    // Header mirrors the body value.
    expect(res.headers['retry-after']).toBe(String(res.body.error.retryAfter));
  });

  it('exposes X-RateLimit-* headers', async () => {
    const app = buildApp(5, 60_000);
    const res = await request(app).get('/x');
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('tracks identities independently', async () => {
    // Key by a query param so each "client" has its own bucket.
    const app = buildApp(1, 60_000, { identify: (req) => String(req.query.id ?? '') });
    expect((await request(app).get('/x?id=a')).status).toBe(200);
    expect((await request(app).get('/x?id=b')).status).toBe(200); // different client, fresh count
    expect((await request(app).get('/x?id=a')).status).toBe(429); // client a exhausted
  });

  it('does not limit requests it cannot attribute to a client', async () => {
    const app = buildApp(1, 60_000, { identify: () => undefined });
    expect(await hit(app, 3)).toEqual([200, 200, 200]);
  });

  it('skips requests matched by the skip predicate', async () => {
    const app = buildApp(1, 60_000, { skip: (req) => req.query.skip === '1' });
    expect((await request(app).get('/x?skip=1')).status).toBe(200);
    expect((await request(app).get('/x?skip=1')).status).toBe(200); // never counted
  });

  describe('configured tiers', () => {
    it('OTP tier: 5 requests per phone per hour', async () => {
      const store = new InMemoryRateStore();
      const app = express();
      app.use(express.json());
      app.post('/otp', rateLimit('otp', 5, 3_600_000, { identify: phoneIdentify, store }), (_r, res) =>
        res.json({ ok: true }),
      );
      app.use(errorHandler);

      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await request(app).post('/otp').send({ phone: '+260123456789' });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      // retryAfter is bounded by the 1-hour window.
      const blocked = await request(app).post('/otp').send({ phone: '+260123456789' });
      expect(blocked.body.error.retryAfter).toBeLessThanOrEqual(3600);
    });

    it('OTP tier: a different phone has its own count', async () => {
      const store = new InMemoryRateStore();
      const app = express();
      app.use(express.json());
      app.post('/otp', rateLimit('otp', 5, 3_600_000, { identify: phoneIdentify, store }), (_r, res) =>
        res.json({ ok: true }),
      );
      app.use(errorHandler);

      for (let i = 0; i < 5; i += 1) await request(app).post('/otp').send({ phone: '+260000000001' });
      const other = await request(app).post('/otp').send({ phone: '+260000000002' });
      expect(other.status).toBe(200);
    });

    it('analyze tier: 10 requests per user per day', async () => {
      const store = new InMemoryRateStore();
      const app = express();
      // Simulate an authenticated user upstream of the limiter.
      app.use((req, _res, next) => {
        (req as express.Request & { auth?: { sub: string } }).auth = { sub: 'user-1' };
        next();
      });
      app.post('/analyze', rateLimit('analyze', 10, 86_400_000, { identify: userIdentify, store }), (_r, res) =>
        res.json({ ok: true }),
      );
      app.use(errorHandler);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) statuses.push((await request(app).post('/analyze')).status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(10);
      expect(statuses[10]).toBe(429);
    });

    it('general tier: 100 requests per IP per minute', async () => {
      const app = buildApp(100, 60_000, { identify: () => 'fixed-ip' });
      const statuses = await hit(app, 101);
      expect(statuses.filter((s) => s === 200)).toHaveLength(100);
      expect(statuses[100]).toBe(429);
    });
  });
});

describe('InMemoryRateStore', () => {
  it('starts a fresh window after the previous one resets', async () => {
    const store = new InMemoryRateStore();
    const first = await store.increment('k', 50); // 50ms window
    expect(first.count).toBe(1);
    const second = await store.increment('k', 50);
    expect(second.count).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 60));
    const afterReset = await store.increment('k', 50);
    expect(afterReset.count).toBe(1); // window expired → counter reset
  });
});
