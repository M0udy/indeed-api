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
  admin_role        VARCHAR(50) NOT NULL DEFAULT 'user',          -- user | admin
  suspended_at      TIMESTAMPTZ,                                  -- non-null when the account is suspended
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill admin columns on pre-existing databases.
ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_role   VARCHAR(50) NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

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
  deed_data           JSONB NOT NULL DEFAULT '{}'::jsonb,         -- OCR-extracted deed fields
  identity_data       JSONB NOT NULL DEFAULT '{}'::jsonb,         -- seller NRC verification result
  rules_check         JSONB NOT NULL DEFAULT '{}'::jsonb,         -- fraud rules-engine evaluation
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill columns on databases created before these features were added.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS deed_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS identity_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS rules_check JSONB NOT NULL DEFAULT '{}'::jsonb;

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
  status          VARCHAR(20) NOT NULL DEFAULT 'open',           -- open | resolved | dismissed
  resolution_notes TEXT,                                         -- admin notes on resolution
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Backfill case-management columns on pre-existing databases.
ALTER TABLE fraud_analyses ADD COLUMN IF NOT EXISTS status           VARCHAR(20) NOT NULL DEFAULT 'open';
ALTER TABLE fraud_analyses ADD COLUMN IF NOT EXISTS resolution_notes TEXT;
ALTER TABLE fraud_analyses ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE fraud_analyses ADD COLUMN IF NOT EXISTS resolved_by      UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_fraud_analyses_property_id ON fraud_analyses (property_id);
CREATE INDEX IF NOT EXISTS idx_fraud_analyses_status      ON fraud_analyses (status);

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

-- ── conversations ────────────────────────────────────────────
-- One thread per (property, buyer, seller) triple.
CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  buyer_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seller_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_conversation UNIQUE (property_id, buyer_id, seller_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_buyer_id  ON conversations (buyer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_seller_id ON conversations (seller_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg  ON conversations (last_message_at DESC);

-- ── messages ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages (conversation_id) WHERE read_at IS NULL;

-- ── payments ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount            DECIMAL(12, 2) NOT NULL,                       -- major units (Kwacha)
  currency          VARCHAR(10) NOT NULL DEFAULT 'ZMW',
  status            VARCHAR(20) NOT NULL DEFAULT 'pending',        -- pending | completed | failed | refunded
  provider          VARCHAR(20) NOT NULL,                          -- stripe | mobile_money
  subscription_tier VARCHAR(50),                                   -- granted tier on success (null for ad-hoc)
  valid_until       TIMESTAMPTZ,                                   -- subscription expiry
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments (status);

-- ── invoices ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pdf_url      VARCHAR(500),
  html_content TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_payment UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices (user_id);
