import type {
  Property,
  PropertyDetail,
  PropertySummary,
  SellerSummary,
  User,
  UserPublic,
} from '../types';

/**
 * Pure functions that translate database rows into the public DTOs returned by
 * the API. Centralising the mapping keeps controllers thin and ensures decimal
 * columns (which pg returns as strings) are converted to numbers exactly once.
 */

/** Parse a pg DECIMAL string into a number, preserving null. */
function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Map a `users` row to the compact public user object. */
export function toUserPublic(user: User): UserPublic {
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    name: user.name,
    subscription_tier: user.subscription_tier,
    verification_badge: user.verification_badge,
  };
}

/** Map a `properties` row to the list/search summary shape. */
export function toPropertySummary(property: Property): PropertySummary {
  return {
    id: property.id,
    title: property.title,
    location: property.location,
    price_usd: toNumber(property.price_usd),
    image_urls: property.image_urls,
    fraud_score: property.fraud_score,
    verification_status: property.verification_status,
  };
}

/** Map a `properties` row + its seller to the full detail shape. */
export function toPropertyDetail(property: Property, seller: User): PropertyDetail {
  const sellerSummary: SellerSummary = {
    name: seller.name,
    phone: seller.phone,
    badge: seller.verification_badge,
  };

  return {
    id: property.id,
    title: property.title,
    description: property.description,
    location: property.location,
    latitude: toNumber(property.latitude),
    longitude: toNumber(property.longitude),
    price_usd: toNumber(property.price_usd),
    size_acres: toNumber(property.size_acres),
    image_urls: property.image_urls,
    deed_number: property.deed_number,
    deed_document_url: property.deed_document_url,
    fraud_score: property.fraud_score,
    fraud_flags: property.fraud_flags,
    verification_status: property.verification_status,
    created_at: property.created_at,
    seller: sellerSummary,
  };
}
