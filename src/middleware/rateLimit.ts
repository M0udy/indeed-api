import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { RateLimitError } from '../utils/errors';
import type { AuthenticatedRequest } from './auth';

/**
 * Fixed-window rate limiting.
 *
 * Counters live behind a {@link RateStore} — an in-memory map by default, or
 * Redis when `REDIS_URL` is configured (so limits are shared across instances).
 * Exceeding a limit throws a {@link RateLimitError}, which the central error
 * handler renders as a `429` with a `Retry-After` header and `retryAfter` body.
 */

/** A counter snapshot for one window. */
export interface RateHit {
  count: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

/** Pluggable backing store for rate counters. */
export interface RateStore {
  increment(key: string, windowMs: number): Promise<RateHit>;
}

/** In-process store. Fine for a single instance; not shared across replicas. */
export class InMemoryRateStore implements RateStore {
  private readonly hits = new Map<string, RateHit>();

  constructor() {
    // Periodically drop expired entries so the map can't grow unbounded.
    // `unref` keeps this timer from holding the process (and Jest) open.
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  increment(key: string, windowMs: number): Promise<RateHit> {
    const now = Date.now();
    const existing = this.hits.get(key);
    if (!existing || existing.resetAt <= now) {
      const fresh: RateHit = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, fresh);
      return Promise.resolve({ ...fresh });
    }
    existing.count += 1;
    return Promise.resolve({ count: existing.count, resetAt: existing.resetAt });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, hit] of this.hits) {
      if (hit.resetAt <= now) this.hits.delete(key);
    }
  }
}

/** The slice of a Redis client this store needs. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
}

/** Redis-backed store using atomic INCR + PEXPIRE (fixed window). */
export class RedisRateStore implements RateStore {
  constructor(private readonly redis: RedisLike) {}

  async increment(key: string, windowMs: number): Promise<RateHit> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.pexpire(key, windowMs);
    }
    let ttl = await this.redis.pttl(key);
    if (ttl < 0) {
      // Key had no expiry (e.g. created by an older path) — set one now.
      await this.redis.pexpire(key, windowMs);
      ttl = windowMs;
    }
    return { count, resetAt: Date.now() + ttl };
  }
}

/** Lazily construct an ioredis client without making it a hard dependency. */
function createRedisClient(url: string): RedisLike | null {
  try {
    // ioredis is an optional dependency; only required when REDIS_URL is set.
    const mod = require('ioredis') as
      | (new (connection: string) => RedisLike)
      | { default: new (connection: string) => RedisLike };
    const Ctor = (typeof mod === 'function' ? mod : mod.default) as new (
      connection: string,
    ) => RedisLike;
    return new Ctor(url);
  } catch (err) {
    logger.warn('REDIS_URL is set but ioredis is unavailable; using in-memory rate limiting', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Build the process-wide default store from configuration. */
function buildDefaultStore(): RateStore {
  if (config.rateLimit.redisUrl) {
    const client = createRedisClient(config.rateLimit.redisUrl);
    if (client) {
      logger.info('Rate limiting backed by Redis');
      return new RedisRateStore(client);
    }
  }
  return new InMemoryRateStore();
}

/** Shared default store used by all limiters unless one is injected. */
export const defaultRateStore: RateStore = buildDefaultStore();

/** Derives the client identity a limit is counted against. */
export type IdentifyFn = (req: Request) => string | undefined;

/** Key by client IP (honours `trust proxy`). */
export const ipIdentify: IdentifyFn = (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

/** Key by the `phone` field in the request body. */
export const phoneIdentify: IdentifyFn = (req) => {
  const body = req.body as { phone?: unknown } | undefined;
  return typeof body?.phone === 'string' && body.phone.length > 0 ? body.phone : undefined;
};

/** Key by the authenticated user id (requires `authenticate` to run first). */
export const userIdentify: IdentifyFn = (req) => (req as AuthenticatedRequest).auth?.sub;

export interface RateLimitOptions {
  /** How to identify the client; defaults to IP. */
  identify?: IdentifyFn;
  /** Return true to bypass the limit for a request (e.g. health checks). */
  skip?: (req: Request) => boolean;
  /** Backing store; defaults to the shared {@link defaultRateStore}. */
  store?: RateStore;
}

/**
 * Build a rate-limit middleware.
 *
 * @param key      Bucket name (namespaces the counter, e.g. `"otp"`).
 * @param limit    Max requests allowed per window.
 * @param windowMs Window length in milliseconds.
 * @param options  Identity/skip/store overrides.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  options: RateLimitOptions = {},
): RequestHandler {
  const identify = options.identify ?? ipIdentify;
  const store = options.store ?? defaultRateStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (options.skip?.(req)) {
        next();
        return;
      }

      const identity = identify(req);
      if (identity === undefined) {
        // Can't attribute the request to a client — don't limit it.
        next();
        return;
      }

      const bucket = `ratelimit:${key}:${identity}`;
      const { count, resetAt } = await store.increment(bucket, windowMs);

      const remaining = Math.max(0, limit - count);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

      if (count > limit) {
        const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
        throw new RateLimitError(retryAfter);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

// ── Pre-configured limiters for the documented tiers ─────────

/** OTP requests: 5 per phone number per hour. */
export const otpRateLimit = rateLimit('otp', 5, 60 * 60 * 1000, { identify: phoneIdentify });

/** Fraud analysis: 10 per user per day. */
export const analyzeRateLimit = rateLimit('analyze', 10, 24 * 60 * 60 * 1000, {
  identify: userIdentify,
});

/** General API: 100 per IP per minute. Skips health checks and CORS preflight. */
export const generalRateLimit = rateLimit('general', 100, 60 * 1000, {
  identify: ipIdentify,
  skip: (req) => req.method === 'OPTIONS' || req.path === '/health' || req.path === '/',
});
