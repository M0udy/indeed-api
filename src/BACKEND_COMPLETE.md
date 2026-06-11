# InDeed Backend — Handoff Guide

AI-powered property fraud detection platform for Zambia and East Africa.

> **Repo:** `github.com/M0udy/indeed-api` · **Stack:** Node.js + Express + TypeScript + PostgreSQL
> **Last verified:** all checks green (`npm run typecheck`, `npm test`, `npm run build`).

---

## 1. Executive Summary

**What was built** — a production-ready REST backend powering a property
marketplace with a 4-layer AI fraud-detection pipeline, OTP/JWT auth, buyer↔seller
messaging, a subscription + payments system (Stripe + mobile money), an admin
dashboard, and interactive API docs.

**Status:** ✅ Ready for deployment. Fully typed (no `any`), every endpoint behind
input validation and centralised error handling, parameterised SQL throughout.

**Test coverage:** **187 tests across 22 suites — all passing.** Tests run fully
offline (database mocked, external services injected as fakes), so CI needs no
credentials.

| Metric | Value |
|--------|-------|
| API operations | 33 (30 documented paths) |
| Service modules | 13 (across 8 functional domains) |
| Database tables | 9 |
| Tests | 187 / 22 suites |
| External integrations | Claude, AWS S3, Africa's Talking, Idswyft, Stripe, Google imagery |

---

## 2. Architecture Overview

```
src/
├── config/          env (typed/validated) + pg Pool
├── types/           all domain interfaces (single source of truth)
├── middleware/      auth, adminAuth, validate (zod), rateLimit, errorHandler, requestLogger
├── services/        13 modules — see below
├── controllers/     thin HTTP handlers (constructor-injected services)
├── routes/          per-feature routers; routes/properties/ aggregates /properties/*
├── jobs/            subscriptionExpiry (downgrade lapsed users)
├── utils/           errors, logger, mappers, validators, scheduler, asyncHandler, swagger
├── db/              schema.sql + migrate.ts
├── app.ts           Express app factory (no listen — testable)
└── server.ts        entry point + graceful shutdown + scheduler boot
```

**13 service modules across 8 domains**

| Domain | Services |
|--------|----------|
| Auth | `auth.service` (OTP + JWT), `user.service` |
| Marketplace | `property.service` (CRUD + combined fraud analysis) |
| Verification | `ocr.service`, `identity.service`, `satellite.service`, `claude.service` |
| Rules | `rules.service` (12-rule engine, json-rules-engine) |
| Messaging | `messaging.service` |
| Payments | `payment.service` (Stripe + mobile money + PDF invoices) |
| Admin | `admin.service` (analytics, user admin, fraud cases, reports) |
| Infrastructure | `sms.service` (Africa's Talking), `s3.service` (AWS) |

**4-layer fraud detection** — OCR (deed parsing) + Identity (NRC verification) +
Rules (12 deterministic checks) + Satellite (imagery vs. description via Claude
vision), combined with a Claude listing analysis into one `fraud_score`
(see §5).

**Cross-cutting:** JWT auth (suspension-aware), Zod validation, Helmet, CORS
allow-list, rate limiting (3 tiers), structured logging with per-request
correlation ids, OpenAPI 3.0 docs at `/api-docs`.

---

## 3. Deployment (Railway)

Railway runs the compiled Node app and provisions PostgreSQL.

### Steps

1. **Create project** → "Deploy from GitHub repo" → select `M0udy/indeed-api`.
2. **Add PostgreSQL** → New → Database → PostgreSQL. Railway sets `DATABASE_URL`.
   - Reference it in the service: `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. **Configure the service:**
   - **Build command:** `npm ci && npm run build`
   - **Start command:** `npm start`
   - **Health check path:** `/health` (expects `200`)
4. **Set environment variables** (see §8 for the full list). At minimum:
   `DATABASE_URL`, `DATABASE_SSL=true`, `JWT_SECRET`, `ANTHROPIC_API_KEY`,
   `AWS_*`, `AFRICA_TALKING_*`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS=1`.
5. **Run the migration once** (Railway shell or a one-off command):
   ```bash
   npm run db:migrate
   ```
6. **(Optional) Add Redis** for distributed rate limiting → set `REDIS_URL`.
7. **Deploy.** Verify: `curl https://<your-app>.up.railway.app/health` → `{"status":"ok"}`.

### First-time setup checklist

- [ ] PostgreSQL provisioned, `DATABASE_URL` + `DATABASE_SSL=true` set
- [ ] `JWT_SECRET` set to a long random value (**not** the default)
- [ ] `ANTHROPIC_API_KEY` set (required at boot — app won't start without it)
- [ ] AWS S3 bucket created; `AWS_ACCESS_KEY_ID/SECRET/REGION/S3_BUCKET` set
- [ ] Africa's Talking `API_KEY/USERNAME` set (sandbox is fine to start)
- [ ] `CORS_ORIGINS` includes your frontend domain(s)
- [ ] `npm run db:migrate` run successfully
- [ ] First admin promoted: `UPDATE users SET admin_role='admin' WHERE phone='+260…';`
- [ ] Stripe keys + webhook configured (if billing live) — see §8
- [ ] `/health` returns `200`, `/api-docs` loads

---

## 4. API Documentation

Base path: all routes are relative to the deployed origin. Interactive docs +
"try it out" live at **`/api-docs`**; the raw OpenAPI 3.0 spec is at
**`/api-docs.json`**.

### Auth flow (OTP → JWT)

```
POST /auth/request-otp   { phone }                 → SMS a 6-digit code (5/hour/phone)
POST /auth/verify-otp    { phone, otp }            → { token, user }  (creates user on first login)
GET  /auth/me            Bearer <token>            → profile
POST /auth/refresh       Bearer <token>            → { token }  (rotates, revokes old)
```
JWTs are stored server-side and **revocable**; the auth middleware also loads the
user and blocks suspended accounts (403).

### Properties

```
POST   /properties                 Bearer   create listing
GET    /properties?location=&price_min=&price_max=&size_min=&size_max=&limit=&offset=
GET    /properties/:id             detail (+ seller summary)
GET    /properties/user/:userId    a seller's listings
PUT    /properties/:id             Bearer   update (seller only)
DELETE /properties/:id             Bearer   delete (seller only)
POST   /properties/:id/upload      Bearer   multipart file → S3 (image/pdf, ≤15MB)
```

### Verification

```
POST /properties/:id/ocr               Bearer  parse deed image (Tesseract)        → 422 on unreadable
POST /properties/:id/verify-identity   Bearer  NRC via Idswyft                      → 422 on failure
POST /properties/:id/verify-satellite  Bearer  imagery vs description (Claude vision)
POST /properties/:id/analyze           Bearer  COMBINED fraud score (rules+Claude)  10/day/user
POST /properties/:id/check-rules       Bearer  rules engine only
```

### Messaging

```
POST /messages                      Bearer  { conversation_id, content }
GET  /conversations                 Bearer  inbox (unread_count + last_message)
GET  /conversations/:id/messages    Bearer  thread (marks read)
POST /properties/:id/message-seller Bearer  start/reuse thread + first message
```

### Payments

```
POST /payments/stripe/checkout   Bearer   { tier: buyer|seller|bank } → { sessionId, url }
POST /payments/webhook/stripe    (no auth — Stripe-Signature verified, raw body)
POST /payments/mobile-money      Bearer   { provider: mtn|airtel|zamtel, amount } → pending
GET  /payments/invoice/:id       Bearer   invoice JSON (or ?format=pdf)  (owner only)
```

### Admin (admin role required)

```
GET   /admin/analytics                         platform metrics
GET   /admin/users?tier=&suspended=&search=    filtered list
PATCH /admin/users/:id        { subscription_tier?, admin_role?, suspended? }
GET   /admin/fraud-cases?status=&severity=&min_score=
PATCH /admin/fraud-cases/:id  { notes, status: resolved|dismissed }
GET   /admin/reports?type=users|fraud_cases|payments|revenue&format=csv|json
```

### Health & ops

```
GET /health            liveness + DB probe  (NOT rate limited)
GET /                  API banner
GET /api-docs          Swagger UI
GET /api-docs.json     raw OpenAPI spec
```

### Rate limits

| Scope | Limit | Keyed by |
|-------|-------|----------|
| `POST /auth/request-otp` | 5 / hour | phone |
| `POST /properties/:id/analyze` | 10 / day | user id |
| All other endpoints (global) | 100 / minute | client IP |

`/health` and CORS preflight are exempt. Every response carries
`X-RateLimit-Limit/Remaining/Reset`; a `429` adds `Retry-After`.

### Error codes

All errors share one envelope: `{ "error": { "code", "message", "retryAfter?", "requestId?" } }`.

| HTTP | code | When |
|------|------|------|
| 400 | `VALIDATION_ERROR` | Body/query/params failed Zod validation |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired/revoked token, or unknown user |
| 402 | `PAYMENT_REQUIRED` | Feature gated behind a paid tier |
| 403 | `FORBIDDEN` | Authenticated but not permitted (e.g. not the seller; suspended; not admin) |
| 404 | `NOT_FOUND` | Resource missing |
| 422 | `UNPROCESSABLE_ENTITY` | Well-formed but unprocessable (OCR/identity/satellite failure) |
| 429 | `RATE_LIMIT_EXCEEDED` | Over a rate-limit tier (includes `retryAfter`) |
| 500 | `INTERNAL_ERROR` | Unexpected server error (details logged, not leaked) |
| 502 | `UPSTREAM_ERROR` | A third-party service (Claude, S3, SMS) failed |

---

## 5. Fraud Detection Engine

Four independent signals are computed and stored on the property, then fused by
`POST /properties/:id/analyze`.

### The four layers

1. **OCR** (`/ocr`) → `properties.deed_data` — deed number, address, names, date,
   amounts, coordinates + a `confidence_score`. (Tesseract.js, offline.)
2. **Identity** (`/verify-identity`) → `properties.identity_data` — seller NRC
   verified against Idswyft (`verified`, `confidence_score`, name, DOB).
3. **Rules** (`/check-rules`) → `properties.rules_check` — the 12-rule engine
   reads the stored OCR/identity/satellite data and emits a `rule_score`.
4. **Satellite** (`/verify-satellite`) → `properties.satellite_data` — imagery
   compared to the listing description by Claude vision (`matches_description`).

### Combined score

`POST /properties/:id/analyze` (paid tiers only — free tier gets `{ locked: true }`)
runs the **rules engine** (using stored OCR/identity/satellite data) **and** a
**Claude** analysis of the listing, then:

```
fraud_score = round((rule_score + claude_score) / 2)      // 0–100, stored on the property
```

Both engines' red flags are merged & de-duplicated; the recommendation comes from
Claude.

### verification_status mapping

| fraud_score | verification_status |
|-------------|---------------------|
| `< 25` | `verified` |
| `25–60` | `caution` |
| `> 60` | `flagged` |

(The admin dashboard separately buckets a fraud case's **severity**: `<25` low,
`<50` medium, `<75` high, else critical.)

### The 12 rules (each +8 points, capped at 100; rule 11 is a 0-point warning)

| # | Rule |
|---|------|
| 1 | Deed number not found in registry |
| 2 | Price unusually low (< 30% market) |
| 3 | Price unusually high (> 300% market) |
| 4 | Seller identity not verified |
| 5 | Seller NRC invalid format |
| 6 | Property listed multiple times simultaneously |
| 7 | Deed date very old (> 10 years) |
| 8 | Satellite image doesn't match description |
| 9 | Buyer name missing |
| 10 | Transaction amount ≠ stated price |
| 11 | Location outside Lusaka metro (**warning only**) |
| 12 | Seller has history of disputes |

Rules whose inputs are unknown (no market value, no OCR, etc.) do not fire — the
engine fails open rather than penalising missing data.

---

## 6. Database Schema

9 tables (PostgreSQL 13+ / Supabase-compatible). Full DDL in
[`src/db/schema.sql`](db/schema.sql); apply with `npm run db:migrate` (idempotent —
`CREATE … IF NOT EXISTS` + `ALTER … ADD COLUMN IF NOT EXISTS`).

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | id, phone (unique), email, name, kyc_status, **subscription_tier**, verification_badge, **admin_role**, **suspended_at** | one row per account |
| `properties` | id, **seller_id→users**, title, location, lat/lng, size_acres, price_usd, deed_number, image_urls[], fraud_score, fraud_flags(jsonb), verification_status, **deed_data**, **identity_data**, **rules_check**, **satellite_data** (jsonb) | the four verification JSONB columns hold each layer's result |
| `fraud_analyses` | id, **property_id→properties**, fraud_score, red_flags(jsonb), recommendation, claude_response, **status**, resolution_notes, resolved_at, **resolved_by→users** | audit + admin case management |
| `otp_tokens` | id, phone, otp, consumed, expires_at | single-use, time-boxed |
| `auth_tokens` | id, **user_id→users**, token, revoked, expires_at | server-side revocable JWTs |
| `conversations` | id, **property_id→properties**, **buyer_id→users**, **seller_id→users**, last_message_at | `UNIQUE(property_id, buyer_id, seller_id)` |
| `messages` | id, **conversation_id→conversations**, **sender_id→users**, content, read_at | |
| `payments` | id, **user_id→users**, amount, currency, status, provider, subscription_tier, valid_until | |
| `invoices` | id, **payment_id→payments**, **user_id→users**, pdf_url, html_content | `UNIQUE(payment_id)` |

**Relationships:** users 1—N properties / payments / conversations / messages;
properties 1—N fraud_analyses / conversations; payments 1—1 invoices. All FKs
`ON DELETE CASCADE` (except `fraud_analyses.resolved_by` → `SET NULL`).

**Indexes:** seller/location/price/created_at on properties; user_id + status on
payments; buyer/seller/last_message on conversations; conversation_id + a partial
unread index on messages; phone on otp_tokens; token + user_id on auth_tokens;
status on fraud_analyses.

---

## 7. Testing

```bash
npm test            # run all 187 tests (jest --runInBand)
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit (strict, no any)
```

**Coverage:** 22 suites covering validators, auth (service + middleware + suspension),
all controllers, the fraud rules engine (every rule + combinations + scoring), the
combined fraud analysis math, OCR/identity/satellite services, messaging
(authorization + mark-read), payments (Stripe checkout/webhook/idempotency/invoices),
admin (analytics/users/cases/reports + CSV-injection safety), rate limiting (each
tier + 429 shape), the subscription-expiry job, the scheduler, and the OpenAPI spec.

**Test design:** the database layer is mocked (`jest.mock('../src/config/database')`)
and external services are injected as fakes via constructors — so tests are fast,
deterministic, and need no network or credentials.

**Adding a test:** create `tests/<name>.test.ts`. For a service that hits the DB,
mock `../src/config/database` and queue results with `mockResolvedValueOnce`. For a
service with external deps, construct it with fakes (`new XService(fakeClient)`). For
HTTP, build an app with supertest or call the controller method directly with
`mockRequest`/`mockResponse` from `tests/helpers.ts`.

---

## 8. Configuration

All env access is centralised + validated in [`src/config/env.ts`](config/env.ts);
the app fails fast at boot on a missing **required** var. See `.env.example` for the
annotated list.

### Required (app won't boot without these in production)

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | PostgreSQL / Supabase connection string |
| `JWT_SECRET` | Signs all tokens — **change from default** |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | S3 uploads |
| `ANTHROPIC_API_KEY` | Claude (fraud detection + vision) |
| `AFRICA_TALKING_API_KEY` / `AFRICA_TALKING_USERNAME` | OTP SMS |

### Important defaults

| Var | Default | Purpose |
|-----|---------|---------|
| `NODE_ENV` | development | `production` enables prod logging + SSL default |
| `PORT` | 4000 | |
| `CORS_ORIGINS` | localhost:3000 | comma-separated frontend allow-list |
| `TRUST_PROXY_HOPS` | 1 | proxy depth for correct client IP |
| `DATABASE_SSL` | prod=on | set `true` for Supabase/Railway PG |
| `AWS_REGION` / `AWS_S3_BUCKET` | us-east-1 / indeed-properties | |
| `CLAUDE_MODEL` | claude-haiku-4-5-20251001 | |
| `JWT_EXPIRES_IN` | 7d | |
| `OTP_EXPIRY_MINUTES` | 10 | |

### Optional services — graceful degradation

The app boots and runs without these; the relevant feature degrades cleanly:

| Service | Var(s) | Behaviour when unset |
|---------|--------|----------------------|
| **Redis** | `REDIS_URL` | rate limiting uses an in-process store (per-instance) |
| **Idswyft** | `IDSWYFT_API_KEY` | identity verification uses a deterministic local mock (`IDSWYFT_MOCK` auto-on) |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | card endpoints return a clear "not configured" error; rest of API works |
| **Satellite imagery** | `SATELLITE_API_KEY`, `SATELLITE_IMAGE_URL_TEMPLATE` | a local mock image is used (`SATELLITE_MOCK` auto-on) |
| **OTP debug** | `OTP_DEBUG_RETURN` | dev-only: echoes the OTP in the response (never enable in prod) |

### Subscription tiers (pricing)

| Plan | Price (ZMW/mo) | Grants tier |
|------|----------------|-------------|
| Buyer | K600 | `premium` |
| Seller | K1,200 | `professional` |
| Bank | K8,000 (+K400/check) | `enterprise` |

---

## 9. Known Limitations

1. **`africastalking` transitive vulnerabilities** — the official SMS SDK pins
   older `axios`/`lodash`/`joi` (`npm audit`: 1 moderate, 3 high). These are in the
   SMS code path only and not exploitable through our API surface. The
   `SmsClient` interface makes swapping to a direct REST call a one-file change if a
   clean audit is required. *(The critical JSONPath-Plus RCE from json-rules-engine
   is already fixed via an npm `override`.)*
2. **In-process rate limiter** — counters are per-instance. With multiple replicas
   the effective limit is `limit × instances`. Set `REDIS_URL` for distributed
   enforcement (the `RedisRateStore` is implemented and wired).
3. **Scheduler runs per-instance** — the hourly subscription-expiry job fires on
   every replica. It's idempotent (the second run finds nothing), so harmless, but
   for exactly-once semantics move it to an external cron (Railway cron / a dedicated
   endpoint) instead of the in-process timer.
4. **Tesseract OCR accuracy** — Tesseract on raw phone photos of deeds is
   accuracy-limited. A strong upgrade is routing the OCR'd text (or the image) through
   Claude vision for extraction — the Anthropic client and vision pattern are already
   present (`satellite.service`), so it's a contained addition.
5. **Docs maintained alongside code** — the OpenAPI spec is hand-authored; a test
   guards the major paths, but adding stricter drift detection (every mounted route
   has a documented path) is a possible hardening.

---

## 10. Frontend Integration

- **Base URL:** the deployed origin (e.g. `https://<app>.up.railway.app`). Add your
  frontend domain to `CORS_ORIGINS`.
- **Auth header:** `Authorization: Bearer <token>` on every protected request. Get
  the token from `POST /auth/verify-otp`; refresh via `POST /auth/refresh`.
- **Error format:** always `{ "error": { "code", "message", "retryAfter?", "requestId?" } }`.
  Branch on `error.code` (stable) rather than the message. Surface `requestId` in bug
  reports.
- **Pagination:** list endpoints (`GET /properties`, `/admin/users`, `/admin/fraud-cases`)
  accept `?limit=&offset=` (limit default 50, max 100–200). Responses are arrays.
- **Subscription gating:** `POST /properties/:id/analyze` returns
  `{ fraud_score: null, locked: true }` for free-tier users — show an upgrade
  prompt rather than treating it as an error (HTTP is still `200`).
- **Rate limits:** read `X-RateLimit-Remaining`; on `429`, back off for
  `error.retryAfter` (or the `Retry-After` header) seconds.
- **Uploads:** `POST /properties/:id/upload` and `/ocr` take `multipart/form-data`
  with a `file` field (images/PDF). Don't set `Content-Type` manually — let the
  browser set the multipart boundary.
- **Try-it-out:** point developers at `/api-docs` (auth persists across calls).

---

## 11. Monitoring & Alerts

- **Health:** `GET /health` → `200 {status:'ok', database:'connected'}` or `503`
  when the DB is unreachable. Use it as the platform health check.
- **Structured logs:** single-line JSON in production (timestamp, level, message +
  context) via `src/utils/logger.ts`. Every request logs method/path/status/duration
  with a correlation id, echoed back as `X-Request-Id`.
- **Sentry-ready (not yet wired):** there is exactly one place to add it — the
  central `errorHandler` (`src/middleware/errorHandler.ts`) already receives every
  unhandled error with its request id. Add `Sentry.captureException(err)` there plus
  `Sentry.init()` in `server.ts`. The logger is similarly swappable for pino/winston
  at its single call site.
- **Rate-limit headers:** `X-RateLimit-Limit/Remaining/Reset` on every response —
  alert if `Remaining` trends to zero for normal users.
- **Admin analytics:** `GET /admin/analytics` surfaces user/revenue/fraud-case
  counts for an internal ops dashboard; `GET /admin/reports?type=…` exports CSV/JSON.

---

## 12. Next Steps (Post-Launch)

**Phase 2 features**
- Claude-vision OCR fallback for low-confidence deed scans (limitation #4).
- Notify-on-message (SMS/push) so sellers are alerted to buyer enquiries — the SMS
  service is already wired.
- Auto-feed satellite `matches_description` is already wired into rule 8; consider
  auto-running `/analyze` when all four verification layers complete.
- Saved searches / alerts for buyers; seller verification badges surfaced in search.

**Performance**
- Add a composite/GIN index for property search if `location ILIKE` + range filters
  get hot; consider full-text search for titles/descriptions.
- Cache `GET /properties` results (short TTL) and `/admin/analytics` (the aggregate
  queries are the heaviest).
- Reuse a stored `rules_check` in `/analyze` instead of recomputing the rules engine
  each call.

**Scalability**
- Move rate limiting to Redis (`REDIS_URL`) and the scheduler to external cron
  before horizontal scaling (limitations #2, #3).
- Externalise file uploads fully to S3 with presigned PUTs to keep large bodies off
  the app server.
- Add DB read replicas for the marketplace read path; connection pooling via the
  Supabase/Railway pooler.
- CI gate on `typecheck` + `test` + `npm audit --audit-level=high`.

---

*Generated as a point-in-time handoff. Keep this file and `/api-docs` updated as the
API evolves.*
