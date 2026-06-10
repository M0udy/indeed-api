import { randomInt, timingSafeEqual } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config/env';
import { query, withTransaction } from '../config/database';
import { logger } from '../utils/logger';
import { UnauthorizedError } from '../utils/errors';
import type { JwtPayload, User } from '../types';

/**
 * Authentication domain logic: OTP lifecycle and JWT issue/verify.
 *
 * OTPs are single-use, time-boxed, and compared in constant time. JWTs are
 * additionally persisted in `auth_tokens` so they can be revoked server-side
 * (e.g. on logout or a security event).
 */
export class AuthService {
  /** Generate a cryptographically-random 6-digit OTP (zero-padded). */
  generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /** Persist a freshly-generated OTP for a phone number. */
  async storeOtp(phone: string, otp: string): Promise<void> {
    await query(
      `INSERT INTO otp_tokens (phone, otp, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [phone, otp, String(config.otp.expiryMinutes)],
    );
  }

  /**
   * Validate a submitted OTP. On success the matching token is marked consumed
   * (and all other outstanding tokens for the phone are invalidated) inside one
   * transaction, so a code can never be replayed.
   *
   * @returns true if the OTP was valid and has now been consumed.
   */
  async verifyOtp(phone: string, submittedOtp: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string; otp: string }>(
        `SELECT id, otp
           FROM otp_tokens
          WHERE phone = $1
            AND consumed = false
            AND expires_at > now()
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE`,
        [phone],
      );

      const record = rows[0];
      if (!record || !constantTimeEquals(record.otp, submittedOtp)) {
        return false;
      }

      // Consume this token and any other live tokens for the phone.
      await client.query(
        `UPDATE otp_tokens SET consumed = true WHERE phone = $1 AND consumed = false`,
        [phone],
      );
      return true;
    });
  }

  /**
   * Find the user for a verified phone, creating one on first login.
   * Returns the full user row.
   */
  async findOrCreateUser(phone: string): Promise<User> {
    const existing = await query<User>(`SELECT * FROM users WHERE phone = $1`, [phone]);
    if (existing.rows[0]) {
      return existing.rows[0];
    }

    const created = await query<User>(
      `INSERT INTO users (phone) VALUES ($1) RETURNING *`,
      [phone],
    );
    const user = created.rows[0];
    if (!user) {
      // Should be unreachable: INSERT ... RETURNING always yields a row.
      throw new Error('Failed to create user');
    }
    logger.info('New user registered', { userId: user.id });
    return user;
  }

  /** Sign a JWT for a user and persist it so it can be revoked later. */
  async issueToken(user: User): Promise<string> {
    const payload: JwtPayload = {
      sub: user.id,
      phone: user.phone,
      tier: user.subscription_tier,
    };

    const options: SignOptions = {
      expiresIn: config.jwt.expiresIn as SignOptions['expiresIn'],
    };
    const token = jwt.sign(payload, config.jwt.secret, options);

    await query(
      `INSERT INTO auth_tokens (user_id, token, expires_at)
       VALUES ($1, $2, now() + interval '7 days')`,
      [user.id, token],
    );
    return token;
  }

  /**
   * Verify a JWT's signature/expiry AND confirm it has not been revoked in the
   * database. Returns the decoded payload.
   *
   * @throws {UnauthorizedError} for any invalid, expired, or revoked token.
   */
  async verifyToken(token: string): Promise<JwtPayload> {
    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, config.jwt.secret) as JwtPayload;
    } catch {
      throw new UnauthorizedError('Invalid or expired token');
    }

    const { rows } = await query<{ revoked: boolean }>(
      `SELECT revoked FROM auth_tokens
        WHERE token = $1 AND expires_at > now()
        LIMIT 1`,
      [token],
    );
    const record = rows[0];
    if (!record || record.revoked) {
      throw new UnauthorizedError('Token has been revoked');
    }
    return decoded;
  }

  /** Revoke a specific token (used during refresh to rotate it out). */
  async revokeToken(token: string): Promise<void> {
    await query(`UPDATE auth_tokens SET revoked = true WHERE token = $1`, [token]);
  }
}

/** Constant-time string comparison to avoid timing side channels on OTPs. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Shared singleton used by controllers. */
export const authService = new AuthService();
