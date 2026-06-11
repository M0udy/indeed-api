# InDeed — Backend API

AI-powered property fraud detection platform for Zambia and East Africa.

A production-ready **Node.js + Express + TypeScript** backend that powers a
property marketplace, OTP authentication, AWS S3 document storage, and AI fraud
detection via **Claude Haiku**.

---

## Features

| Area | Endpoints |
|------|-----------|
| **Auth** (OTP + JWT) | `POST /auth/request-otp`, `POST /auth/verify-otp`, `GET /auth/me`, `POST /auth/refresh` |
| **Properties** (CRUD) | `POST /properties`, `GET /properties`, `GET /properties/:id`, `GET /properties/user/:userId`, `PUT /properties/:id`, `DELETE /properties/:id` |
| **Uploads** | `POST /properties/:id/upload` (S3) |
| **Deed OCR** | `POST /properties/:id/ocr` (Tesseract.js) |
| **Identity verification** | `POST /properties/:id/verify-identity` (Idswyft NRC) |
| **Satellite verification** | `POST /properties/:id/verify-satellite` (imagery + Claude vision) |
| **Fraud rules engine** | `POST /properties/:id/check-rules` (json-rules-engine, 12 rules) |
| **Fraud detection** | `POST /properties/:id/analyze` (Claude Haiku) |
| **Messaging** | `POST /messages`, `GET /conversations`, `GET /conversations/:id/messages`, `POST /properties/:id/message-seller` |
| **Payments** | `POST /payments/stripe/checkout`, `POST /payments/webhook/stripe`, `POST /payments/mobile-money`, `GET /payments/invoice/:id` |
| **Admin** | `GET /admin/analytics`, `GET/PATCH /admin/users`, `GET/PATCH /admin/fraud-cases`, `GET /admin/reports` |
| **Health** | `GET /health` |

Cross-cutting: JWT auth middleware, Zod input validation, centralised error
handling, request logging with correlation ids, CORS allow-list, Helmet security
headers, parameterised SQL (injection-safe), and a fully-typed codebase (no `any`).

---

## Architecture

```
src/
├── config/
│   ├── env.ts            # Validated, strongly-typed environment config
│   └── database.ts       # Shared pg Pool + query/transaction helpers
├── types/
│   ├── index.ts          # Domain interfaces (User, Property, FraudAnalysis, …)
│   └── africastalking.d.ts
├── middleware/
│   ├── auth.ts           # JWT verification (Bearer)
│   ├── validate.ts       # Zod body/query/params validators
│   ├── requestLogger.ts  # Correlation id + access logs
│   └── errorHandler.ts   # 404 + central error mapping
├── services/             # One module per integration / domain concern
│   ├── auth.service.ts   # OTP lifecycle + JWT issue/verify/revoke
│   ├── sms.service.ts    # Africa's Talking SMS (DI-friendly)
│   ├── s3.service.ts     # AWS S3 uploads
│   ├── claude.service.ts # Claude Haiku fraud analysis (tool-calling)
│   ├── property.service.ts
│   └── user.service.ts
├── controllers/          # HTTP handlers (constructor-injected services)
├── routes/               # Express routers (validation + auth wiring)
├── utils/                # errors, logger, mappers, validators, asyncHandler
├── db/
│   ├── schema.sql        # PostgreSQL schema (idempotent)
│   └── migrate.ts        # `npm run db:migrate`
├── app.ts                # Express app factory (no listen — testable)
└── server.ts             # Entry point + graceful shutdown

tests/                    # Jest unit tests (controllers, validators, health)
```

**Design choices**

- **Dependency injection** — controllers and services accept their collaborators
  via constructors (defaulting to shared singletons), so tests pass fakes with
  zero network/database access.
- **Tool-calling for fraud detection** — Claude returns a strictly-typed verdict
  via a forced tool call rather than free-text parsing.
- **Server-side token registry** — issued JWTs are stored in `auth_tokens` so
  they can be revoked (logout, rotation on refresh).

---

## Prerequisites

- Node.js ≥ 18
- A PostgreSQL database (Supabase works out of the box)
- AWS account + S3 bucket
- Anthropic API key
- Africa's Talking account (sandbox is fine for development)

---

## Getting started (local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
#    …then fill in DATABASE_URL, AWS, ANTHROPIC_API_KEY, AFRICA_TALKING_*, JWT_SECRET

# 3. Create the database schema
npm run db:migrate          # or: psql "$DATABASE_URL" -f src/db/schema.sql

# 4. Run in watch mode
npm run dev                 # http://localhost:4000

# 5. Verify
curl http://localhost:4000/health
```

### Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Hot-reloading dev server (tsx) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server (`dist/server.js`) |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the Jest test suite |
| `npm run db:migrate` | Apply `schema.sql` to `DATABASE_URL` |

---

## Environment variables

See [`.env.example`](.env.example) for the full annotated list. Key ones:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL / Supabase connection string |
| `DATABASE_SSL` | `true` for managed Postgres (Supabase) |
| `JWT_SECRET` | **Change in production** — signs all tokens |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` / `AWS_S3_BUCKET` | S3 storage |
| `ANTHROPIC_API_KEY` | Claude API key |
| `CLAUDE_MODEL` | Defaults to `claude-haiku-4-5-20251001` |
| `AFRICA_TALKING_API_KEY` / `AFRICA_TALKING_USERNAME` | OTP SMS |
| `CORS_ORIGINS` | Comma-separated allow-list (your Vercel frontend) |

> **TLS note:** database TLS verification is **on** by default. If your provider
> uses a private CA, set `DATABASE_CA_CERT` to the PEM bundle rather than
> disabling verification.

---

## API reference

### Auth

```http
POST /auth/request-otp
{ "phone": "+260123456789" }
→ { "success": true, "phone": "+260123456789", "otp_sent": true }

POST /auth/verify-otp
{ "phone": "+260123456789", "otp": "123456" }
→ { "token": "jwt…", "user": { "id", "phone", "name", "subscription_tier" } }

GET /auth/me                       Authorization: Bearer <token>
→ { "id", "phone", "email", "name", "subscription_tier", "verification_badge" }

POST /auth/refresh                 Authorization: Bearer <token>
→ { "token": "new-jwt…" }          # old token is revoked
```

> In development, set `OTP_DEBUG_RETURN=true` to echo the OTP back in the
> `request-otp` response (`debug_otp`). Never enable in production.

### Properties

```http
POST   /properties                 Authorization: Bearer <token>
GET    /properties?location=Thornpark&price_min=100&price_max=500&size_min=0.5
GET    /properties/:id
GET    /properties/user/:userId
PUT    /properties/:id             Authorization: Bearer <token>  (seller only)
DELETE /properties/:id             Authorization: Bearer <token>  (seller only)
```

### File upload

```http
POST /properties/:id/upload        Authorization: Bearer <token>
Content-Type: multipart/form-data  field: file   (jpg/png/webp/pdf, ≤15MB)
→ { "url": "https://…s3…", "property_id": "…", "kind": "image" | "document" }
```

### Deed OCR

```http
POST /properties/:id/ocr           Authorization: Bearer <token>  (seller only)
Content-Type: multipart/form-data  field: file   (jpg/png, ≤10MB)
→ {
    "deed_data": {
      "deed_number": "ZM-2024-001234",
      "property_address": "123 Main St, Lusaka",
      "seller_name": "John Doe",
      "buyer_name": "Jane Smith",
      "transaction_date": "2024-03-15",
      "amount_in_words": "One Million Kwacha Only",
      "amount_in_numbers": 1000000,
      "location_coordinates": { "latitude": -15.387526, "longitude": 28.322817 },
      "confidence_score": 0.92,
      "raw_text": "…"
    },
    "success": true
  }
```

Extracted data is stored in `properties.deed_data` (JSONB). Each field is
`null` when it could not be located; a `422` is returned if the image cannot be
parsed at all (e.g. blank/blurry). OCR runs on [Tesseract.js](https://github.com/naptha/tesseract.js)
(open-source, no external API) and is injected as an `OcrRecognizer`, so tests
run without the native engine.

### Identity verification

```http
POST /properties/:id/verify-identity   Authorization: Bearer <token>  (seller only)
{ "seller_nrc": "ZM0123456789", "seller_photo_url": "https://…/face.jpg" }   # photo optional
→ {
    "identity": {
      "verified": true,
      "confidence_score": 0.95,
      "nrc": "ZM0123456789",
      "name": "John Banda",
      "date_of_birth": "1988-04-12",
      "photo_match": true,          // null when no photo supplied
      "verified_at": "2026-06-11T…"
    },
    "success": true
  }
```

Verifies a seller's Zambian NRC (`ZM` + 10 digits) via the **Idswyft** provider
and stores the result in `properties.identity_data` (JSONB). Returns `422` when
the NRC is malformed or the provider call fails. The provider client is injected
(`IdswyftClient`), and a deterministic `MockIdswyftClient` is used automatically
when `IDSWYFT_API_KEY` is empty (or `IDSWYFT_MOCK=true`), so dev/test never block
on the external service. Configure `IDSWYFT_API_KEY` / `IDSWYFT_BASE_URL` for
production.

### Satellite verification

```http
POST /properties/:id/verify-satellite   Authorization: Bearer <token>  (seller only)
{ "latitude": -15.4, "longitude": 28.3, "description": "Vacant 1-acre residential plot" }   # description optional
→ {
    "satellite": {
      "verified": true,
      "confidence_score": 0.88,
      "image_url": "https://…/staticmap?center=-15.4,28.3&…",   // API key stripped
      "matches_description": true,
      "analysis": "Open land consistent with a vacant plot",
      "latitude": -15.4, "longitude": 28.3,
      "verified_at": "2026-06-11T…"
    },
    "success": true
  }
```

Fetches a satellite image for the coordinates and asks **Claude vision** whether
the imagery matches the listing description; stores the result in
`properties.satellite_data` (JSONB) and returns `422` if imagery is unavailable.
The image source and the vision step are both injected (`SatelliteImageProvider`
/ `SatelliteVisionAnalyzer`), so tests run offline. A deterministic mock provider
auto-activates when `SATELLITE_API_KEY` is empty; the default real provider uses
Google Static Maps satellite imagery (point `SATELLITE_IMAGE_URL_TEMPLATE` at a
Google Earth Engine thumbnail for production). The API key is stripped from the
stored `image_url` so it never leaks into the DB or API responses.

### Fraud rules engine

```http
POST /properties/:id/check-rules   Authorization: Bearer <token>  (seller only)
{
  "property":  { "market_value_usd": 100000, "deed_registry_match": true,
                 "duplicate_listing_count": 0, "seller_dispute_count": 0 },
  "ocr_data":  { "transaction_date": "2024-01-01", "amount_in_numbers": 100000, "buyer_name": "…" },
  "identity":  { "verified": true, "nrc": "ZM0123456789" },
  "satellite": { "matches_description": true }
}
→ {
    "red_flags": ["rule_2_triggered", "rule_7_triggered"],
    "rule_score": 16,
    "details": { "rule_1": { "triggered": false, "weight": 8, "severity": "flag", … }, … },
    "success": true
  }
```

Runs 12 deterministic fraud rules via
[json-rules-engine](https://github.com/CacheControl/json-rules-engine) and stores
the result in `properties.rules_check` (JSONB). **All body sections are
optional** — anything omitted falls back to data already stored on the property
(its OCR `deed_data` and `identity_data`), so a bare `{}` body still evaluates
what's on record.

| # | Rule | Weight |
|---|------|--------|
| 1 | Deed number not found in registry | 8 |
| 2 | Price unusually low (< 30% market) | 8 |
| 3 | Price unusually high (> 300% market) | 8 |
| 4 | Seller identity not verified | 8 |
| 5 | Seller NRC invalid format | 8 |
| 6 | Property listed multiple times simultaneously | 8 |
| 7 | Deed date very old (> 10 years) | 8 |
| 8 | Satellite image doesn't match description | 8 |
| 9 | Buyer name missing | 8 |
| 10 | Transaction amount ≠ stated price | 8 |
| 11 | Location outside Lusaka metro | **0 (warning)** |
| 12 | Seller has history of disputes | 8 |

Each triggered rule adds its weight to `rule_score` (capped at 100). Rule 11 is a
warning: it surfaces in `red_flags` and `details` but contributes 0 to the score.
Rules whose inputs are unknown (e.g. no market value, no OCR data) do not fire.

### Fraud analysis

```http
POST /properties/:id/analyze       Authorization: Bearer <token>

# Free tier:
→ { "fraud_score": null, "locked": true, … }

# Premium / professional / enterprise:
→ {
    "fraud_score": 50,          // combined = round((rule_score + claude_score) / 2)
    "rule_score": 40,           // deterministic rules engine (uses stored OCR/identity/satellite)
    "claude_score": 60,         // Claude Haiku analysis of the listing
    "red_flags": ["price unusually low", "rule_2_triggered"],
    "recommendation": "review",
    "verification_status": "caution"
  }
```

`analyze` runs **both** the rules engine and Claude and averages them into the
stored `fraud_score`. `fraud_score` → `verification_status`: `< 25` → `verified`,
`25–60` → `caution`, `> 60` → `flagged`. (`POST /properties/:id/check-rules`
still exists to run the rules engine on its own.)

### Messaging

```http
POST /properties/:id/message-seller   Authorization: Bearer <token>   (buyer)
{ "content": "Hi, is this plot still available?" }
→ { "conversation": { id, property_id, buyer_id, seller_id, … }, "message": { … } }   # starts/reuses a thread

POST /messages                        Authorization: Bearer <token>
{ "conversation_id": "…", "content": "Yes, it is." }
→ { id, conversation_id, sender_id, content, read_at, created_at }

GET /conversations                    Authorization: Bearer <token>
→ [ { …conversation, "unread_count": 2, "last_message": "See you then" }, … ]   # newest activity first

GET /conversations/:id/messages       Authorization: Bearer <token>
→ [ { …message }, … ]   # oldest first; marks the other party's messages read
```

Threads are unique per `(property, buyer, seller)` triple (`getOrCreateConversation`
upserts atomically). Every read/write path verifies the caller is a participant,
so users can only see their own conversations. Opening a thread marks the other
party's messages as read. Stored in the new `conversations` and `messages` tables.

### Payments

Plans (monthly, Zambian Kwacha): **Buyer K600** → `premium`, **Seller K1,200** →
`professional`, **Bank K8,000** (+K400/fraud check) → `enterprise`. Pricing is
server-authoritative — the client picks a plan, never an amount.

```http
POST /payments/stripe/checkout    Authorization: Bearer <token>
{ "tier": "buyer" }
→ { "sessionId": "cs_…", "url": "https://checkout.stripe.com/…" }   # redirect the user here

POST /payments/webhook/stripe     (no auth — verified by Stripe-Signature)
→ on checkout.session.completed: marks payment paid, grants the tier, sets a 30-day expiry

POST /payments/mobile-money       Authorization: Bearer <token>
{ "provider": "mtn", "amount": 600 }          # mtn | airtel | zamtel
→ { id, status: "pending", provider: "mobile_money", … }   # confirmed out-of-band

GET /payments/invoice/:id         Authorization: Bearer <token>   (owner only)
→ JSON invoice (with html_content);  add ?format=pdf to stream a generated PDF
```

Tables: `payments` and `invoices`. Stripe and pdfkit power card checkout and PDF
invoices; mobile money is recorded as `pending` for provider callback confirmation.

**Webhook security:** the webhook route is mounted with a **raw-body** parser
(before `express.json`) so the `Stripe-Signature` can be verified against the
unparsed payload via `STRIPE_WEBHOOK_SECRET`. It is intentionally unauthenticated
(Stripe authenticates via the signature). Configure `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET`; until then, card endpoints return a clear
"not configured" error and the rest of the API runs normally.

### Admin dashboard

All `/admin/*` routes require a valid JWT **and** an admin role. The `adminOnly`
middleware reads `admin_role` from the database on every request (not the JWT),
so promoting, demoting, or suspending an admin takes effect immediately.

```http
GET   /admin/analytics                 → { users, fraud_cases, properties, revenue }
GET   /admin/users?tier=premium&suspended=false&search=jane&limit=50
PATCH /admin/users/:id                  { "subscription_tier": "professional", "suspended": true, "admin_role": "admin" }
GET   /admin/fraud-cases?status=open&severity=critical&min_score=50
PATCH /admin/fraud-cases/:id            { "notes": "Confirmed fraudulent deed", "status": "resolved" }   # or "dismissed"
GET   /admin/reports?type=users&format=csv     # type: users | fraud_cases | payments | revenue; format: csv | json
```

- **Analytics** aggregates users (total/verified/suspended/new + by-tier), fraud
  cases (open/resolved/severity/avg score), properties, and completed revenue.
- **Fraud cases** are fraud analyses joined with their property, with a severity
  derived from `fraud_score` (`<25` low, `<50` medium, `<75` high, else critical)
  and a workflow status (`open` → `resolved`/`dismissed` with admin notes).
- **Reports** stream CSV (RFC-4180 quoting) or JSON as a file download.

Make a user an admin directly in the database (no endpoint can self-promote
without an existing admin):

```sql
UPDATE users SET admin_role = 'admin' WHERE phone = '+260...';
```

### Rate limiting

Three tiers, enforced by fixed-window counters (in-memory by default, or Redis
when `REDIS_URL` is set so limits are shared across instances):

| Scope | Limit | Keyed by |
|-------|-------|----------|
| `POST /auth/request-otp` | 5 / hour | phone number |
| `POST /properties/:id/analyze` | 10 / day | user id |
| All other endpoints (global) | 100 / minute | client IP |

`GET /health` and CORS preflight are exempt. Every response carries
`X-RateLimit-Limit/Remaining/Reset`; a `429` adds a `Retry-After` header and the
body below. `GET /rate-limit/test` (5/min) is a low-limit endpoint for smoke-testing.

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Try again in 30 seconds.",
    "retryAfter": 30
  }
}
```

Client IP comes from `req.ip`, so set `TRUST_PROXY_HOPS` to your proxy depth
(Vercel/Render/Fly = 1) for correct attribution behind a load balancer.

### Error format

Every error returns a consistent envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [...], "requestId": "…" } }
```

---

## Deployment

The app is a stateless HTTP service — deploy anywhere that runs Node.

### Generic (Docker-less)

```bash
npm ci
npm run build
npm run db:migrate          # once, against the production DATABASE_URL
NODE_ENV=production npm start
```

### Render / Railway / Fly.io

- **Build command:** `npm ci && npm run build`
- **Start command:** `npm start`
- **Health check path:** `/health`
- Set all environment variables from `.env.example` in the dashboard.
- Run `npm run db:migrate` once (a one-off job / shell) after the DB is provisioned.

### Supabase (database)

1. Create a project; copy the connection string into `DATABASE_URL`.
2. Set `DATABASE_SSL=true`.
3. Apply the schema: `npm run db:migrate`.

### Frontend (Vercel) CORS

Add your Vercel domain(s) to `CORS_ORIGINS`, e.g.
`CORS_ORIGINS=https://your-app.vercel.app,http://localhost:3000`.

---

## Security notes

- All SQL is parameterised; dynamic clauses (search filters, partial updates)
  are built from fixed column allow-lists.
- OTPs are single-use, time-boxed, and compared in constant time.
- JWTs are revocable server-side; refresh rotates and invalidates the old token.
- Helmet sets secure HTTP headers; CORS is an explicit allow-list.
- Upload type/size is validated before anything reaches S3.

> **Known advisory:** the official `africastalking` SDK pins older `axios` and
> `lodash` versions that carry advisories (surfaced by `npm audit`). They are
> transitive dev-path dependencies of the SMS client; track upstream for a fix,
> or swap the SMS service for a direct REST call if your security policy requires
> a clean audit. The `sms.service.ts` interface (`SmsClient`) makes that a
> one-file change.

---

## Testing

```bash
npm test
```

Covers: input validators, OTP generation, the auth flow (request/verify/me),
property creation, ownership enforcement, the free-tier fraud lock, the full
premium fraud-analysis path, and the health endpoint. Services are injected as
fakes, so tests need no database or external credentials.

---

## License

UNLICENSED — © InDeed.
