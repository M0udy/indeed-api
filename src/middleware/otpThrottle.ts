import type { NextFunction, Request, Response } from 'express';
import { RateLimitError } from '../utils/errors';
import { logger } from '../utils/logger';
import type { ValidatedLocals } from './validate';

/**
 * OTP brute-force protection for `POST /auth/verify-otp`.
 *
 * The global IP limiter (100/min) does not stop a distributed attacker guessing
 * a 6-digit code. This middleware adds a **per-phone** guard: after N failed
 * verify attempts within a window, the phone is locked for a cooldown period and
 * further attempts are rejected with `429` — independent of source IP.
 *
 * Counting is keyed on the phone number (from the validated body), incremented
 * on a failed verify and reset on success. State lives in an injectable
 * {@link OtpAttemptStore} (in-memory by default; the store takes an injectable
 * clock so the logic is unit-tested with zero timers).
 */

/** Per-phone attempt record. */
interface AttemptRecord {
  failures: number;
  windowStart: number;
  lockedUntil: number | null;
}

export interface OtpAttemptStoreOptions {
  /** Failed attempts allowed before locking. Default 3. */
  limit?: number;
  /** Sliding window for counting failures (ms). Default 15 min. */
  windowMs?: number;
  /** Lock duration once the limit is hit (ms). Default 15 min. */
  lockMs?: number;
  /** Clock, injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
}

/** In-memory per-phone OTP attempt tracker. */
export class OtpAttemptStore {
  private readonly attempts = new Map<string, AttemptRecord>();
  readonly limit: number;
  readonly windowMs: number;
  readonly lockMs: number;
  private readonly now: () => number;

  constructor(opts: OtpAttemptStoreOptions = {}) {
    this.limit = opts.limit ?? 3;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? ((): number => Date.now());

    // Periodically drop stale entries; unref'd so it never holds the process.
    const timer = setInterval(() => this.sweep(), 60_000);
    timer.unref?.();
  }

  /** Remaining lock time in ms for a phone, or 0 if it is not locked. */
  lockedFor(phone: string): number {
    const rec = this.attempts.get(phone);
    if (!rec || rec.lockedUntil === null) return 0;
    const remaining = rec.lockedUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Record a failed verify; locks the phone once the limit is reached. */
  recordFailure(phone: string): void {
    const now = this.now();
    const existing = this.attempts.get(phone);

    let rec: AttemptRecord;
    if (!existing || now - existing.windowStart > this.windowMs) {
      // First failure, or the previous window has expired → start fresh.
      rec = { failures: 1, windowStart: now, lockedUntil: null };
      this.attempts.set(phone, rec);
    } else {
      existing.failures += 1;
      rec = existing;
    }

    if (rec.failures >= this.limit) {
      rec.lockedUntil = now + this.lockMs;
    }
  }

  /** Clear all state for a phone (called on a successful verification). */
  reset(phone: string): void {
    this.attempts.delete(phone);
  }

  private sweep(): void {
    const now = this.now();
    for (const [phone, rec] of this.attempts) {
      const lockExpired = rec.lockedUntil !== null && rec.lockedUntil <= now;
      const windowExpired = rec.lockedUntil === null && now - rec.windowStart > this.windowMs;
      if (lockExpired || windowExpired) this.attempts.delete(phone);
    }
  }
}

/** Shared default store used by the middleware. */
export const otpAttemptStore = new OtpAttemptStore();

/** Mask all but the last 3 digits of a phone for safe logging. */
function maskPhone(phone: string): string {
  return phone.length <= 3 ? '***' : `${'*'.repeat(phone.length - 3)}${phone.slice(-3)}`;
}

/**
 * Build the OTP throttle middleware. Place it AFTER body validation and BEFORE
 * the verify controller. It rejects locked phones with `429` up front, and hooks
 * the response to record the attempt outcome (reset on `200`, increment on `400`).
 */
export function otpThrottle(store: OtpAttemptStore = otpAttemptStore) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Prefer the validated/trimmed phone so whitespace can't fork the counter.
    const validated = (res.locals as ValidatedLocals).body as { phone?: unknown } | undefined;
    const raw = req.body as { phone?: unknown } | undefined;
    const candidate = validated?.phone ?? raw?.phone;
    const phone = typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;

    // Can't attribute the request to a phone → let validation handle it.
    if (!phone) {
      next();
      return;
    }

    const lockedForMs = store.lockedFor(phone);
    if (lockedForMs > 0) {
      const retryAfterSec = Math.ceil(lockedForMs / 1000);
      const minutes = Math.max(1, Math.ceil(lockedForMs / 60_000));
      logger.warn('OTP verify blocked — phone temporarily locked', { phone: maskPhone(phone) });
      next(
        new RateLimitError(retryAfterSec, `Too many OTP attempts. Try again in ${minutes} minutes.`),
      );
      return;
    }

    // Record the outcome once the response is sent: success resets, a failed
    // verify (400 after validation passed) increments toward the lock.
    res.on('finish', () => {
      if (res.statusCode === 200) {
        store.reset(phone);
      } else if (res.statusCode === 400 || res.statusCode === 401) {
        store.recordFailure(phone);
      }
    });

    next();
  };
}
