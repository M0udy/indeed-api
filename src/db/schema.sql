-- ─────────────────────────────────────────────────────────────
-- InDeed — PostgreSQL schema
-- Compatible with Supabase / standard PostgreSQL 13+.
-- Run with: psql "$DATABASE_URL" -f src/db/schema.sql
--           or: npm run db:migrate
-- ─────────────────────────────────────────────────────────────

-- gen_random_uuid() lives in pgcrypto on older PG; Supabase ships it by default.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             VARCHAR(20) UNIQUE NOT NULL,
  email             VARCHAR(255),
  name              VARCHAR(255),
  kyc_status        VARCHAR(50) NOT NULL DEFAULT 'pending',       -- pending | verified | rejected
  subscription_tier VARCHAR(50) NOT NULL DEFAULT 'free',          -- free | premium | professional | enterprise
  verification_badge BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── properties ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title               VARCHAR(500) NOT NULL,
  description         TEXT,
  location            VARCHAR(255),
  latitude            DECIMAL(10, 8),
  longitude           DECIMAL(11, 8),
  size_acres          DECIMAL(10, 2),
  price_usd           DECIMAL(12, 2),
  deed_number         VARCHAR(255),
  image_urls          TEXT[] NOT NULL DEFAULT '{}',               -- array of S3 URLs
  deed_document_url   VARCHAR(500),
  fraud_score         INTEGER,                                    -- 0-100, NULL if not analyzed
  fraud_flags         JSONB NOT NULL DEFAULT '{}'::jsonb,         -- { "flag1": true, ... }
  verification_status VARCHAR(50) NOT NULL DEFAULT 'unverified',  -- unverified | verified | caution | flagged
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_properties_seller_id  ON properties (seller_id);
CREATE INDEX IF NOT EXISTS idx_properties_location   ON properties (location);
CREATE INDEX IF NOT EXISTS idx_properties_price      ON properties (price_usd);
CREATE INDEX IF NOT EXISTS idx_properties_created_at ON properties (created_at DESC);

-- ── fraud_analyses ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  fraud_score     INTEGER NOT NULL,
  red_flags       JSONB NOT NULL DEFAULT '[]'::jsonb,             -- array of detected flag strings
  recommendation  VARCHAR(500),                                  -- approve | review | reject
  claude_response TEXT,                                          -- full Claude analysis
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fraud_analyses_property_id ON fraud_analyses (property_id);

-- ── otp_tokens ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone      VARCHAR(20) NOT NULL,
  otp        VARCHAR(6) NOT NULL,
  consumed   BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS idx_otp_tokens_phone ON otp_tokens (phone);

-- ── auth_tokens ──────────────────────────────────────────────
-- Stores issued JWTs so they can be revoked / rotated server-side.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      TEXT NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user_id ON auth_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_token   ON auth_tokens (token);
