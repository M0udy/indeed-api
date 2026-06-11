import dotenv from 'dotenv';

dotenv.config();

/**
 * Strongly-typed, validated application configuration.
 *
 * All environment access funnels through this module so the rest of the
 * codebase never touches `process.env` directly and never sees `undefined`
 * where a value is required.
 */

/** Read a required env var, throwing a clear error if it is missing. */
function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Read an optional env var with a fallback default. */
function optional(key: string, fallback: string): string {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

/** Parse a boolean-ish env var ("true"/"1" => true). */
function boolean(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/** Parse an integer env var with a fallback. */
function integer(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly port: number;
  readonly corsOrigins: string[];
  readonly database: {
    readonly url: string;
    readonly ssl: boolean;
    readonly sslRejectUnauthorized: boolean;
    readonly caCert: string | undefined;
  };
  readonly jwt: {
    readonly secret: string;
    readonly expiresIn: string;
  };
  readonly aws: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly region: string;
    readonly bucket: string;
  };
  readonly anthropic: {
    readonly apiKey: string;
    readonly model: string;
  };
  readonly africasTalking: {
    readonly apiKey: string;
    readonly username: string;
    readonly senderId: string | undefined;
  };
  readonly otp: {
    readonly expiryMinutes: number;
    readonly debugReturn: boolean;
  };
  readonly idswyft: {
    readonly apiKey: string;
    readonly baseUrl: string;
    /** When true, the identity service uses a deterministic local mock. */
    readonly mock: boolean;
  };
  readonly stripe: {
    readonly secretKey: string;
    readonly webhookSecret: string;
    readonly currency: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  };
}

/**
 * Build the config object. In `test` mode we tolerate missing third-party
 * credentials (tests mock the services), so those reads are optional there.
 */
function buildConfig(): AppConfig {
  const nodeEnv = optional('NODE_ENV', 'development') as AppConfig['nodeEnv'];
  const isTest = nodeEnv === 'test';

  // In tests we don't want to crash on absent credentials.
  const req = isTest ? (key: string) => optional(key, `test-${key}`) : required;

  return {
    nodeEnv,
    port: integer('PORT', 4000),
    corsOrigins: optional('CORS_ORIGINS', 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    database: {
      url: req('DATABASE_URL'),
      ssl: boolean('DATABASE_SSL', nodeEnv === 'production'),
      // Verification stays ON unless explicitly disabled. Never disable in prod.
      sslRejectUnauthorized: boolean('DATABASE_SSL_REJECT_UNAUTHORIZED', true),
      caCert: process.env.DATABASE_CA_CERT || undefined,
    },
    jwt: {
      secret: req('JWT_SECRET'),
      expiresIn: optional('JWT_EXPIRES_IN', '7d'),
    },
    aws: {
      accessKeyId: req('AWS_ACCESS_KEY_ID'),
      secretAccessKey: req('AWS_SECRET_ACCESS_KEY'),
      region: optional('AWS_REGION', 'us-east-1'),
      bucket: optional('AWS_S3_BUCKET', 'indeed-properties'),
    },
    anthropic: {
      apiKey: req('ANTHROPIC_API_KEY'),
      model: optional('CLAUDE_MODEL', 'claude-haiku-4-5-20251001'),
    },
    africasTalking: {
      apiKey: req('AFRICA_TALKING_API_KEY'),
      username: optional('AFRICA_TALKING_USERNAME', 'sandbox'),
      senderId: process.env.AFRICA_TALKING_SENDER_ID || undefined,
    },
    otp: {
      expiryMinutes: integer('OTP_EXPIRY_MINUTES', 10),
      debugReturn: boolean('OTP_DEBUG_RETURN', false),
    },
    idswyft: {
      // Optional: identity verification simply fails closed if unconfigured.
      apiKey: optional('IDSWYFT_API_KEY', ''),
      baseUrl: optional('IDSWYFT_BASE_URL', 'https://api.idswyft.com'),
      // Auto-enable the mock when no key is set (so dev/test never block on it).
      mock: boolean('IDSWYFT_MOCK', isTest || optional('IDSWYFT_API_KEY', '') === ''),
    },
    stripe: {
      // Optional: payment endpoints return a clear error until configured.
      secretKey: optional('STRIPE_SECRET_KEY', ''),
      webhookSecret: optional('STRIPE_WEBHOOK_SECRET', ''),
      currency: optional('STRIPE_CURRENCY', 'zmw'),
      successUrl: optional('STRIPE_SUCCESS_URL', 'http://localhost:3000/billing/success'),
      cancelUrl: optional('STRIPE_CANCEL_URL', 'http://localhost:3000/billing/cancel'),
    },
  };
}

export const config: AppConfig = buildConfig();
