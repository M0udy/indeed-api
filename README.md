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
| **Fraud detection** | `POST /properties/:id/analyze` (Claude Haiku) |
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

### Fraud analysis

```http
POST /properties/:id/analyze       Authorization: Bearer <token>

# Free tier:
→ { "fraud_score": null, "locked": true, … }

# Premium / professional / enterprise:
→ {
    "fraud_score": 45,
    "red_flags": ["price unusually low", "deed not verified"],
    "recommendation": "review",
    "verification_status": "caution"
  }
```

`fraud_score` → `verification_status`: `< 25` → `verified`, `25–60` → `caution`,
`> 60` → `flagged`.

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
