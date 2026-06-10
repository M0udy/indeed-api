/**
 * Domain types for the InDeed platform.
 *
 * These interfaces mirror the database schema (snake_case columns) and the API
 * surface. They are the single source of truth for the shapes that flow through
 * services, controllers, and tests — no `any` anywhere.
 */

// ── Enums (string-literal unions) ────────────────────────────

export type KycStatus = 'pending' | 'verified' | 'rejected';

export type SubscriptionTier = 'free' | 'premium' | 'professional' | 'enterprise';

export type VerificationStatus = 'unverified' | 'verified' | 'caution' | 'flagged';

export type FraudRecommendation = 'approve' | 'review' | 'reject';

// ── Database row shapes ──────────────────────────────────────

/** A row from the `users` table. */
export interface User {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  kyc_status: KycStatus;
  subscription_tier: SubscriptionTier;
  verification_badge: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A row from the `properties` table. */
export interface Property {
  id: string;
  seller_id: string;
  title: string;
  description: string | null;
  location: string | null;
  latitude: string | null; // pg returns DECIMAL as string to preserve precision
  longitude: string | null;
  size_acres: string | null;
  price_usd: string | null;
  deed_number: string | null;
  image_urls: string[];
  deed_document_url: string | null;
  fraud_score: number | null;
  fraud_flags: Record<string, boolean>;
  verification_status: VerificationStatus;
  created_at: Date;
  updated_at: Date;
}

/** A row from the `fraud_analyses` table. */
export interface FraudAnalysis {
  id: string;
  property_id: string;
  fraud_score: number;
  red_flags: string[];
  recommendation: FraudRecommendation;
  claude_response: string | null;
  analyzed_at: Date;
}

/** A row from the `otp_tokens` table. */
export interface OtpToken {
  id: string;
  phone: string;
  otp: string;
  consumed: boolean;
  created_at: Date;
  expires_at: Date;
}

/** A row from the `auth_tokens` table. */
export interface AuthToken {
  id: string;
  user_id: string;
  token: string;
  revoked: boolean;
  created_at: Date;
  expires_at: Date;
}

// ── JWT ──────────────────────────────────────────────────────

/** Claims embedded in the signed JWT. */
export interface JwtPayload {
  sub: string; // user id
  phone: string;
  tier: SubscriptionTier;
}

// ── API response DTOs ────────────────────────────────────────

/** The compact user object returned to clients (no internal timestamps). */
export interface UserPublic {
  id: string;
  phone: string;
  email: string | null;
  name: string | null;
  subscription_tier: SubscriptionTier;
  verification_badge: boolean;
}

/** Seller summary embedded in a property detail response. */
export interface SellerSummary {
  name: string | null;
  phone: string;
  badge: boolean;
}

/** Summary shape used in list/search results. */
export interface PropertySummary {
  id: string;
  title: string;
  location: string | null;
  price_usd: number | null;
  image_urls: string[];
  fraud_score: number | null;
  verification_status: VerificationStatus;
}

/** Full property detail returned by GET /properties/:id. */
export interface PropertyDetail {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  price_usd: number | null;
  size_acres: number | null;
  image_urls: string[];
  deed_number: string | null;
  deed_document_url: string | null;
  fraud_score: number | null;
  fraud_flags: Record<string, boolean>;
  verification_status: VerificationStatus;
  created_at: Date;
  seller: SellerSummary;
}

/** Result of a fraud analysis run, as returned to clients. */
export interface FraudAnalysisResult {
  fraud_score: number | null;
  red_flags: string[];
  recommendation: FraudRecommendation | null;
  verification_status: VerificationStatus;
  locked?: boolean;
}

// ── Service-layer input contracts ────────────────────────────

/** Validated payload to create a property. */
export interface CreatePropertyInput {
  title: string;
  description?: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  size_acres?: number;
  price_usd?: number;
  deed_number?: string;
}

/** Validated payload to update a property (all fields optional). */
export type UpdatePropertyInput = Partial<CreatePropertyInput>;

/** Validated filters for property search. */
export interface PropertyFilters {
  location?: string;
  price_min?: number;
  price_max?: number;
  size_min?: number;
  size_max?: number;
  limit: number;
  offset: number;
}

/** The structured output we ask Claude Haiku to produce. */
export interface ClaudeFraudVerdict {
  fraud_score: number;
  red_flags: string[];
  recommendation: FraudRecommendation;
  reasoning: string;
}
