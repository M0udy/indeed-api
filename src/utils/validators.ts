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

/** A UUID path parameter. */
export const uuidSchema = z.string().uuid('Invalid id format');

export type RequestOtpBody = z.infer<typeof requestOtpSchema>;
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>;
export type CreatePropertyBody = z.infer<typeof createPropertySchema>;
export type UpdatePropertyBody = z.infer<typeof updatePropertySchema>;
export type PropertyFiltersQuery = z.infer<typeof propertyFiltersSchema>;
