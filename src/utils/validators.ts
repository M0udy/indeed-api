import { z } from 'zod';

/**
 * Zod schemas for every request payload. Validation happens at the edge (in the
 * `validate` middleware) so controllers always receive well-formed, typed data.
 * Using a schema library also closes the door on injection via malformed input.
 */

/** E.164-ish phone number: leading +, 8–15 digits. */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Phone must be in international format, e.g. +260123456789');

export const requestOtpSchema = z.object({
  phone: phoneSchema,
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'OTP must be a 6-digit code'),
});

/** Coerce a query-string numeric value (always arrives as a string). */
const numericQuery = z.coerce.number().finite();

export const createPropertySchema = z.object({
  title: z.string().trim().min(3).max(500),
  description: z.string().trim().max(20_000).optional(),
  location: z.string().trim().max(255).optional(),
  // Accept both `latitude`/`longitude` and the spec's `lat`/`lng` aliases.
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  size_acres: z.coerce.number().nonnegative().max(1_000_000).optional(),
  price_usd: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
  deed_number: z.string().trim().max(255).optional(),
});

export const updatePropertySchema = createPropertySchema.partial().refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' },
);

export const propertyFiltersSchema = z.object({
  location: z.string().trim().max(255).optional(),
  price_min: numericQuery.nonnegative().optional(),
  price_max: numericQuery.nonnegative().optional(),
  size_min: numericQuery.nonnegative().optional(),
  size_max: numericQuery.nonnegative().optional(),
  limit: numericQuery.int().min(1).max(100).optional().default(50),
  offset: numericQuery.int().min(0).optional().default(0),
});

/** Zambian NRC: `ZM` followed by 10 digits (case/space tolerant on input). */
export const nrcSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase().replace(/[\s-]/g, ''))
  .refine((value) => /^ZM\d{10}$/.test(value), {
    message: 'NRC must be in the format ZM0123456789',
  });

export const verifyIdentitySchema = z.object({
  seller_nrc: nrcSchema,
  seller_photo_url: z.string().trim().url('seller_photo_url must be a valid URL').optional(),
});

/**
 * Body for POST /properties/:id/check-rules. Every section is optional — any
 * field not supplied falls back to data already stored on the property. Unknown
 * extra keys are stripped.
 */
export const checkRulesSchema = z.object({
  property: z
    .object({
      market_value_usd: z.coerce.number().nonnegative(),
      deed_registry_match: z.boolean(),
      duplicate_listing_count: z.coerce.number().int().nonnegative(),
      seller_dispute_count: z.coerce.number().int().nonnegative(),
      seller_nrc: z.string().trim(),
    })
    .partial()
    .optional(),
  ocr_data: z
    .object({
      deed_number: z.string().trim().nullable(),
      transaction_date: z.string().trim().nullable(),
      amount_in_numbers: z.coerce.number().nullable(),
      buyer_name: z.string().trim().nullable(),
    })
    .partial()
    .optional(),
  identity: z
    .object({
      verified: z.boolean(),
      nrc: z.string().trim().nullable(),
    })
    .partial()
    .optional(),
  satellite: z
    .object({
      matches_description: z.boolean().nullable(),
      confidence: z.coerce.number().nullable(),
      notes: z.string().nullable(),
    })
    .partial()
    .optional(),
});

/** Message body shared by both send paths: non-empty, length-bounded text. */
const messageContentSchema = z.string().trim().min(1, 'Message cannot be empty').max(5000);

export const sendMessageSchema = z.object({
  conversation_id: z.string().uuid('Invalid conversation id'),
  content: messageContentSchema,
});

export const messageSellerSchema = z.object({
  content: messageContentSchema,
});

/**
 * Stripe checkout body. Only the plan is accepted — the price is derived
 * server-side from the plan catalogue, never trusted from the client.
 */
export const stripeCheckoutSchema = z.object({
  tier: z.enum(['buyer', 'seller', 'bank']),
});

export const mobileMoneySchema = z.object({
  provider: z.enum(['mtn', 'airtel', 'zamtel']),
  amount: z.coerce.number().positive('Amount must be greater than zero').max(10_000_000),
});

/** Parse a query-string boolean ("true"/"false") without the coerce foot-gun. */
const queryBoolean = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .optional();

export const adminUserFiltersSchema = z.object({
  tier: z.enum(['free', 'premium', 'professional', 'enterprise']).optional(),
  admin_role: z.enum(['user', 'admin']).optional(),
  suspended: queryBoolean,
  kyc_status: z.enum(['pending', 'verified', 'rejected']).optional(),
  search: z.string().trim().max(255).optional(),
  limit: numericQuery.int().min(1).max(200).optional().default(50),
  offset: numericQuery.int().min(0).optional().default(0),
});

export const adminUserUpdateSchema = z
  .object({
    subscription_tier: z.enum(['free', 'premium', 'professional', 'enterprise']).optional(),
    admin_role: z.enum(['user', 'admin']).optional(),
    suspended: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

export const adminFraudCaseFiltersSchema = z.object({
  status: z.enum(['open', 'resolved', 'dismissed']).optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  min_score: numericQuery.int().min(0).max(100).optional(),
  limit: numericQuery.int().min(1).max(200).optional().default(50),
  offset: numericQuery.int().min(0).optional().default(0),
});

export const resolveFraudCaseSchema = z.object({
  notes: z.string().trim().min(1, 'Resolution notes are required').max(5000),
  // Optional: allow dismissing instead of resolving.
  status: z.enum(['resolved', 'dismissed']).optional().default('resolved'),
});

export const reportQuerySchema = z.object({
  type: z.enum(['users', 'fraud_cases', 'payments', 'revenue']),
  format: z.enum(['csv', 'json']).optional().default('csv'),
});

export const verifySatelliteSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  description: z.string().trim().max(20_000).optional(),
});

/** A UUID path parameter. */
export const uuidSchema = z.string().uuid('Invalid id format');

export type RequestOtpBody = z.infer<typeof requestOtpSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type CreatePropertyBody = z.infer<typeof createPropertySchema>;
export type UpdatePropertyBody = z.infer<typeof updatePropertySchema>;
export type PropertyFiltersQuery = z.infer<typeof propertyFiltersSchema>;
export type VerifyIdentityBody = z.infer<typeof verifyIdentitySchema>;
export type CheckRulesBody = z.infer<typeof checkRulesSchema>;
export type SendMessageBody = z.infer<typeof sendMessageSchema>;
export type MessageSellerBody = z.infer<typeof messageSellerSchema>;
export type StripeCheckoutBody = z.infer<typeof stripeCheckoutSchema>;
export type MobileMoneyBody = z.infer<typeof mobileMoneySchema>;
export type AdminUserFiltersQuery = z.infer<typeof adminUserFiltersSchema>;
export type AdminUserUpdateBody = z.infer<typeof adminUserUpdateSchema>;
export type AdminFraudCaseFiltersQuery = z.infer<typeof adminFraudCaseFiltersSchema>;
export type ResolveFraudCaseBody = z.infer<typeof resolveFraudCaseSchema>;
export type ReportQuery = z.infer<typeof reportQuerySchema>;
export type VerifySatelliteBody = z.infer<typeof verifySatelliteSchema>;
