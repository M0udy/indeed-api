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

export type AdminRole = 'user' | 'admin';

export type FraudCaseStatus = 'open' | 'resolved' | 'dismissed';

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';

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
  admin_role: AdminRole;
  suspended_at: Date | null;
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
  /** Structured data extracted from the deed via OCR. `{}` until parsed. */
  deed_data: DeedData | Record<string, never>;
  /** Seller identity-verification result. `{}` until verified. */
  identity_data: IdentityVerification | Record<string, never>;
  /** Fraud rules-engine evaluation. `{}` until checked. */
  rules_check: RuleEvaluation | Record<string, never>;
  /** Satellite location-verification result. `{}` until verified. */
  satellite_data: SatelliteVerification | Record<string, never>;
  created_at: Date;
  updated_at: Date;
}

// ── OCR / deed parsing ───────────────────────────────────────

/** Geographic coordinates extracted from a deed, when present. */
export interface DeedCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Structured data parsed from a deed image by the OCR service.
 *
 * Every extracted field is nullable — a field is `null` when it could not be
 * confidently located in the document. `confidence_score` (0–1) reflects the
 * overall OCR quality combined with how many target fields were found.
 */
export interface DeedData {
  deed_number: string | null;
  property_address: string | null;
  seller_name: string | null;
  buyer_name: string | null;
  transaction_date: string | null;
  amount_in_words: string | null;
  amount_in_numbers: number | null;
  location_coordinates: DeedCoordinates | null;
  confidence_score: number;
  /** Raw OCR text, retained for auditing / re-parsing. */
  raw_text: string;
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

// ── Identity verification ────────────────────────────────────

/**
 * Result of verifying a seller's Zambian National Registration Card (NRC)
 * against the Idswyft identity provider.
 *
 * `name` and `date_of_birth` come back from the provider on a successful match
 * (and are `null` otherwise). `photo_match` is only populated when a selfie /
 * portrait URL was supplied for biometric comparison.
 */
export interface IdentityVerification {
  verified: boolean;
  confidence_score: number; // 0–1
  nrc: string;
  name: string | null;
  date_of_birth: string | null; // ISO date (YYYY-MM-DD)
  photo_match: boolean | null;
  /** ISO-8601 timestamp of when verification ran. */
  verified_at: string;
}

// ── Fraud rules engine ───────────────────────────────────────

/** Satellite-imagery analysis fed into the rules engine. */
export interface SatelliteData {
  /** Whether the satellite image matches the listing description. */
  matches_description: boolean | null;
  confidence?: number | null;
  notes?: string | null;
}

/**
 * The subset of property data the rules engine reads, plus contextual signals
 * the caller supplies from other services / DB lookups (market value, registry
 * match, duplicate-listing count, dispute history).
 */
export interface RulesPropertyInput {
  id: string;
  price_usd: number | null;
  deed_number: string | null;
  location: string | null;
  market_value_usd?: number | null;
  /** true = found in registry, false = not found, null/undefined = unknown. */
  deed_registry_match?: boolean | null;
  /** Number of OTHER active listings sharing this deed number. */
  duplicate_listing_count?: number | null;
  /** Count of prior disputes recorded against the seller. */
  seller_dispute_count?: number | null;
  seller_nrc?: string | null;
  /** Stored satellite verification; rule 8 reads `matches_description` from here. */
  satellite_data?: SatelliteVerification | Record<string, never> | null;
}

/** Deed fields the rules engine reads (subset of {@link DeedData}). */
export interface RulesOcrInput {
  deed_number?: string | null;
  transaction_date?: string | null;
  amount_in_numbers?: number | null;
  buyer_name?: string | null;
}

/** Identity fields the rules engine reads (subset of {@link IdentityVerification}). */
export interface RulesIdentityInput {
  verified: boolean;
  nrc?: string | null;
}

export type RuleSeverity = 'flag' | 'warning';

/** The outcome of a single fraud rule. */
export interface RuleResult {
  /** Stable rule id, e.g. `rule_2`. */
  id: string;
  /** Flag key emitted into `red_flags`, e.g. `rule_2_triggered`. */
  key: string;
  description: string;
  triggered: boolean;
  /** Points this rule contributes to `rule_score` when triggered. */
  weight: number;
  severity: RuleSeverity;
  /** Human-readable explanation when triggered, else null. */
  reason: string | null;
}

/** Aggregate result of running all fraud rules over a property. */
export interface RuleEvaluation {
  /** Keys of every triggered rule, e.g. `["rule_2_triggered", "rule_7_triggered"]`. */
  red_flags: string[];
  /** Sum of triggered rule weights, capped at 100. */
  rule_score: number;
  /** Per-rule breakdown keyed by rule id. */
  details: Record<string, RuleResult>;
  /** ISO-8601 timestamp of when evaluation ran. */
  evaluated_at: string;
}

// ── Messaging ────────────────────────────────────────────────

/** A row from the `conversations` table — one thread per property/buyer/seller. */
export interface Conversation {
  id: string;
  property_id: string;
  buyer_id: string;
  seller_id: string;
  created_at: Date;
  last_message_at: Date;
}

/** A row from the `messages` table. */
export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  read_at: Date | null;
  created_at: Date;
}

/**
 * A conversation enriched for list views: the unread count for the requesting
 * user and a preview of the most recent message.
 */
export interface ConversationSummary extends Conversation {
  unread_count: number;
  last_message: string | null;
}

// ── Payments ─────────────────────────────────────────────────

export type PaymentStatus = 'pending' | 'completed' | 'failed' | 'refunded';

export type PaymentProvider = 'stripe' | 'mobile_money';

/** Purchasable subscription plans (distinct from a user's granted tier). */
export type PaymentPlan = 'buyer' | 'seller' | 'bank';

/** Supported Zambian mobile-money providers. */
export type MobileMoneyProvider = 'mtn' | 'airtel' | 'zamtel';

/**
 * Static definition of a purchasable plan: its price (in major currency units,
 * i.e. Kwacha), the user subscription tier it grants, and an optional metered
 * per-check add-on (used by the Bank plan).
 */
export interface PlanDefinition {
  plan: PaymentPlan;
  label: string;
  amount: number; // Kwacha per month
  grants: SubscriptionTier;
  perCheckAmount?: number; // Kwacha per fraud check (Bank only)
}

/** A row from the `payments` table. */
export interface Payment {
  id: string;
  user_id: string;
  amount: string; // pg DECIMAL → string to preserve precision
  currency: string;
  status: PaymentStatus;
  provider: PaymentProvider;
  subscription_tier: SubscriptionTier | null;
  valid_until: Date | null;
  created_at: Date;
}

/** A row from the `invoices` table. */
export interface Invoice {
  id: string;
  payment_id: string;
  user_id: string;
  pdf_url: string | null;
  html_content: string;
  created_at: Date;
}

/** Result of creating a Stripe Checkout Session. */
export interface CheckoutResult {
  sessionId: string;
  url: string | null;
}

/** Result of generating an invoice: the stored record plus rendered artifacts. */
export interface InvoiceArtifacts {
  invoice: Invoice;
  pdf: Buffer;
  html: string;
}

// ── Admin dashboard ──────────────────────────────────────────

/** Aggregate platform metrics for the admin dashboard. */
export interface AdminAnalytics {
  users: {
    total: number;
    verified: number;
    suspended: number;
    new_last_30_days: number;
    by_tier: Record<string, number>;
  };
  fraud_cases: {
    total: number;
    open: number;
    resolved: number;
    high_or_critical: number;
    avg_score: number;
  };
  properties: {
    total: number;
    flagged: number;
    verified: number;
  };
  revenue: {
    total: number;
    currency: string;
    completed_payments: number;
  };
}

/** Filters for the admin user list. */
export interface AdminUserFilters {
  tier?: SubscriptionTier;
  admin_role?: AdminRole;
  suspended?: boolean;
  kyc_status?: KycStatus;
  search?: string;
  limit: number;
  offset: number;
}

/** Admin-editable user fields. */
export interface AdminUserUpdate {
  subscription_tier?: SubscriptionTier;
  admin_role?: AdminRole;
  suspended?: boolean;
}

/** Filters for the admin fraud-case list. */
export interface AdminFraudCaseFilters {
  status?: FraudCaseStatus;
  severity?: FraudSeverity;
  min_score?: number;
  limit: number;
  offset: number;
}

/** A fraud case: a fraud analysis enriched with severity, status, and property. */
export interface FraudCase {
  id: string;
  property_id: string;
  fraud_score: number;
  severity: FraudSeverity;
  status: FraudCaseStatus;
  recommendation: string | null;
  red_flags: string[];
  resolution_notes: string | null;
  resolved_at: Date | null;
  analyzed_at: Date;
  property_title: string | null;
  property_location: string | null;
}

/** Supported export report kinds and formats. */
export type ReportType = 'users' | 'fraud_cases' | 'payments' | 'revenue';
export type ReportFormat = 'csv' | 'json';

/** A generated report ready to stream to the client. */
export interface GeneratedReport {
  filename: string;
  contentType: string;
  content: string;
}

// ── Satellite verification ───────────────────────────────────

/**
 * Result of verifying a property's location against satellite imagery (the
 * image is compared to the listing description via Claude vision). Stored in
 * `properties.satellite_data` and also fed into the fraud rules engine as
 * {@link SatelliteData}.
 */
export interface SatelliteVerification {
  verified: boolean;
  confidence_score: number; // 0–1
  image_url: string | null;
  /** Whether the imagery matched the description (mirrors `verified`). */
  matches_description: boolean;
  /** Claude's reasoning for the verdict. */
  analysis: string | null;
  latitude: number;
  longitude: number;
  /** ISO-8601 timestamp of when verification ran. */
  verified_at: string;
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
