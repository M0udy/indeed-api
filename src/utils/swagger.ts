import swaggerJSDoc from 'swagger-jsdoc';
import { config } from '../config/env';

/**
 * OpenAPI 3.0 specification for the InDeed API.
 *
 * The document is authored as a single typed object and finalised through
 * `swagger-jsdoc` (so JSDoc `@openapi` annotations in route files can augment it
 * later via `apis`). It is served interactively at `/api-docs` and as raw JSON
 * at `/api-docs.json`.
 */

/** Reusable references. */
const errorRef = (name: string) => ({ $ref: `#/components/responses/${name}` });
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const secured = [{ bearerAuth: [] }];
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Resource UUID',
  schema: { type: 'string', format: 'uuid' },
};

/** Standard error envelope schema, mirroring the error handler. */
const errorSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'VALIDATION_ERROR' },
        message: { type: 'string', example: 'Request validation failed' },
        details: { type: 'array', items: { type: 'object' }, nullable: true },
        retryAfter: { type: 'integer', nullable: true, description: 'Present on 429 responses' },
        requestId: { type: 'string', nullable: true },
      },
      required: ['code', 'message'],
    },
  },
};

/** Build a reusable error response component. */
function errorResponse(description: string, code: string, message: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: schemaRef('Error'),
        example: { error: { code, message } },
      },
    },
  };
}

/** Build a JSON request body. */
function jsonBody(schema: Record<string, unknown>, example?: unknown): Record<string, unknown> {
  return {
    required: true,
    content: { 'application/json': { schema, ...(example !== undefined ? { example } : {}) } },
  };
}

/** Build a JSON success response. */
function jsonResponse(
  description: string,
  schema?: Record<string, unknown>,
  example?: unknown,
): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        ...(schema ? { schema } : {}),
        ...(example !== undefined ? { example } : {}),
      },
    },
  };
}

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'InDeed API',
    version: '1.0.0',
    description:
      'AI-powered property fraud detection platform for Zambia and East Africa. ' +
      'Most endpoints require a Bearer JWT obtained via the OTP auth flow.',
    license: { name: 'UNLICENSED' },
  },
  servers: [
    { url: `http://localhost:${config.port}`, description: 'Local' },
    { url: '/', description: 'Same-origin' },
  ],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Properties' },
    { name: 'Verification', description: 'OCR, identity, satellite, fraud analysis' },
    { name: 'Rules' },
    { name: 'Messaging' },
    { name: 'Payments' },
    { name: 'Admin' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: errorSchema,
      UserPublic: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          phone: { type: 'string', example: '+260123456789' },
          email: { type: 'string', nullable: true },
          name: { type: 'string', nullable: true },
          subscription_tier: { type: 'string', enum: ['free', 'premium', 'professional', 'enterprise'] },
          verification_badge: { type: 'boolean' },
        },
      },
      PropertySummary: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          title: { type: 'string' },
          location: { type: 'string', nullable: true },
          price_usd: { type: 'number', nullable: true },
          image_urls: { type: 'array', items: { type: 'string' } },
          fraud_score: { type: 'integer', nullable: true },
          verification_status: { type: 'string', enum: ['unverified', 'verified', 'caution', 'flagged'] },
        },
      },
      PropertyDetail: {
        allOf: [
          schemaRef('PropertySummary'),
          {
            type: 'object',
            properties: {
              description: { type: 'string', nullable: true },
              size_acres: { type: 'number', nullable: true },
              deed_number: { type: 'string', nullable: true },
              fraud_flags: { type: 'object', additionalProperties: { type: 'boolean' } },
              seller: {
                type: 'object',
                properties: {
                  name: { type: 'string', nullable: true },
                  phone: { type: 'string' },
                  badge: { type: 'boolean' },
                },
              },
            },
          },
        ],
      },
      FraudAnalysisResult: {
        type: 'object',
        properties: {
          fraud_score: { type: 'integer', nullable: true, description: 'round((rule_score + claude_score) / 2)' },
          rule_score: { type: 'integer', nullable: true },
          claude_score: { type: 'integer', nullable: true },
          red_flags: { type: 'array', items: { type: 'string' } },
          recommendation: { type: 'string', enum: ['approve', 'review', 'reject'], nullable: true },
          verification_status: { type: 'string', enum: ['unverified', 'verified', 'caution', 'flagged'] },
          locked: { type: 'boolean', description: 'true for free-tier users' },
        },
      },
      Message: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          conversation_id: { type: 'string', format: 'uuid' },
          sender_id: { type: 'string', format: 'uuid' },
          content: { type: 'string' },
          read_at: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      ConversationSummary: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          property_id: { type: 'string', format: 'uuid' },
          buyer_id: { type: 'string', format: 'uuid' },
          seller_id: { type: 'string', format: 'uuid' },
          last_message_at: { type: 'string', format: 'date-time' },
          unread_count: { type: 'integer' },
          last_message: { type: 'string', nullable: true },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          user_id: { type: 'string', format: 'uuid' },
          amount: { type: 'string', example: '600.00' },
          currency: { type: 'string', example: 'ZMW' },
          status: { type: 'string', enum: ['pending', 'completed', 'failed', 'refunded'] },
          provider: { type: 'string', enum: ['stripe', 'mobile_money'] },
          subscription_tier: { type: 'string', nullable: true },
          valid_until: { type: 'string', format: 'date-time', nullable: true },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
      AdminAnalytics: {
        type: 'object',
        properties: {
          users: { type: 'object' },
          fraud_cases: { type: 'object' },
          properties: { type: 'object' },
          revenue: { type: 'object' },
        },
      },
      FraudCase: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          property_id: { type: 'string', format: 'uuid' },
          fraud_score: { type: 'integer' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          status: { type: 'string', enum: ['open', 'resolved', 'dismissed'] },
          red_flags: { type: 'array', items: { type: 'string' } },
          resolution_notes: { type: 'string', nullable: true },
        },
      },
    },
    responses: {
      BadRequest: errorResponse('Validation failed', 'VALIDATION_ERROR', 'Request validation failed'),
      Unauthorized: errorResponse('Missing or invalid token', 'UNAUTHORIZED', 'Authentication required'),
      Forbidden: errorResponse('Not permitted', 'FORBIDDEN', 'You do not have permission to perform this action'),
      NotFound: errorResponse('Resource not found', 'NOT_FOUND', 'Resource not found'),
      Unprocessable: errorResponse('Could not process the request', 'UNPROCESSABLE_ENTITY', 'The request could not be processed'),
      TooManyRequests: {
        description: 'Rate limit exceeded',
        headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds to wait' } },
        content: {
          'application/json': {
            schema: schemaRef('Error'),
            example: { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Try again in 30 seconds.', retryAfter: 30 } },
          },
        },
      },
      ServerError: errorResponse('Unexpected error', 'INTERNAL_ERROR', 'An unexpected error occurred'),
    },
  },
  paths: {
    '/': {
      get: {
        tags: ['Health'],
        summary: 'API banner',
        responses: { '200': jsonResponse('Banner', undefined, { name: 'InDeed API', version: '1.0.0', status: 'running' }) },
      },
    },
    '/rate-limit/test': {
      get: {
        tags: ['Health'],
        summary: 'Rate-limit smoke endpoint (5/min/IP)',
        responses: {
          '200': jsonResponse('OK', undefined, { ok: true, remaining: '4' }),
          '429': errorRef('TooManyRequests'),
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness + database connectivity probe',
        responses: {
          '200': jsonResponse('Service healthy', undefined, { status: 'ok', uptime: '1234s', database: 'connected' }),
          '503': jsonResponse('Database unreachable', undefined, { status: 'degraded', database: 'disconnected' }),
        },
      },
    },

    // ── Auth ────────────────────────────────────────────────
    '/auth/request-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Request an OTP code (rate limited: 5/hour/phone)',
        requestBody: jsonBody(
          { type: 'object', required: ['phone'], properties: { phone: { type: 'string', example: '+260123456789' } } },
          { phone: '+260123456789' },
        ),
        responses: {
          '200': jsonResponse('OTP dispatched', undefined, { success: true, phone: '+260123456789', otp_sent: true }),
          '400': errorRef('BadRequest'),
          '429': errorRef('TooManyRequests'),
          '500': errorRef('ServerError'),
        },
      },
    },
    '/auth/verify-otp': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an OTP and receive a JWT (creates the user on first login)',
        requestBody: jsonBody(
          { type: 'object', required: ['phone', 'otp'], properties: { phone: { type: 'string' }, otp: { type: 'string', example: '123456' } } },
          { phone: '+260123456789', otp: '123456' },
        ),
        responses: {
          '200': jsonResponse('Authenticated', undefined, {
            token: 'eyJhbGciOi...',
            user: { id: 'uuid', phone: '+260123456789', name: null, subscription_tier: 'free' },
          }),
          '400': errorRef('BadRequest'),
          '500': errorRef('ServerError'),
        },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: "Current user's profile",
        security: secured,
        responses: {
          '200': jsonResponse('Profile', schemaRef('UserPublic')),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the current token for a fresh one',
        security: secured,
        responses: {
          '200': jsonResponse('New token', undefined, { token: 'eyJhbGciOi...' }),
          '401': errorRef('Unauthorized'),
        },
      },
    },

    // ── Properties ──────────────────────────────────────────
    '/properties': {
      post: {
        tags: ['Properties'],
        summary: 'Create a listing',
        security: secured,
        requestBody: jsonBody(
          {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              location: { type: 'string' },
              latitude: { type: 'number' },
              longitude: { type: 'number' },
              size_acres: { type: 'number' },
              price_usd: { type: 'number' },
              deed_number: { type: 'string' },
            },
          },
          { title: 'Plot in Thornpark', location: 'Thornpark, Lusaka', size_acres: 0.5, price_usd: 15000, deed_number: 'ZM-2024-001234' },
        ),
        responses: {
          '201': jsonResponse('Created', undefined, { id: 'uuid', title: 'Plot in Thornpark', location: 'Thornpark, Lusaka', price_usd: 15000, fraud_score: null }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
        },
      },
      get: {
        tags: ['Properties'],
        summary: 'Search / filter listings',
        parameters: [
          { name: 'location', in: 'query', schema: { type: 'string' } },
          { name: 'price_min', in: 'query', schema: { type: 'number' } },
          { name: 'price_max', in: 'query', schema: { type: 'number' } },
          { name: 'size_min', in: 'query', schema: { type: 'number' } },
          { name: 'size_max', in: 'query', schema: { type: 'number' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          '200': jsonResponse('Results', { type: 'array', items: schemaRef('PropertySummary') }),
        },
      },
    },
    '/properties/{id}': {
      get: {
        tags: ['Properties'],
        summary: 'Listing detail (with seller summary)',
        parameters: [idParam],
        responses: {
          '200': jsonResponse('Detail', schemaRef('PropertyDetail')),
          '404': errorRef('NotFound'),
        },
      },
      put: {
        tags: ['Properties'],
        summary: 'Update a listing (seller only)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody({ type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, price_usd: { type: 'number' } } }),
        responses: {
          '200': jsonResponse('Updated', schemaRef('PropertyDetail')),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
      delete: {
        tags: ['Properties'],
        summary: 'Delete a listing (seller only)',
        security: secured,
        parameters: [idParam],
        responses: {
          '200': jsonResponse('Deleted', undefined, { success: true }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/properties/user/{userId}': {
      get: {
        tags: ['Properties'],
        summary: 'All listings for a seller',
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': jsonResponse('Results', { type: 'array', items: schemaRef('PropertySummary') }) },
      },
    },
    '/properties/{id}/upload': {
      post: {
        tags: ['Properties'],
        summary: 'Upload an image or deed document to S3 (seller only)',
        security: secured,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } },
        },
        responses: {
          '201': jsonResponse('Uploaded', undefined, { url: 'https://bucket.s3.amazonaws.com/...', property_id: 'uuid', kind: 'image' }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
        },
      },
    },

    // ── Verification ────────────────────────────────────────
    '/properties/{id}/analyze': {
      post: {
        tags: ['Verification'],
        summary: 'Combined fraud analysis (rules + Claude). Rate limited: 10/day/user',
        security: secured,
        parameters: [idParam],
        responses: {
          '200': jsonResponse('Analysis (or locked for free tier)', schemaRef('FraudAnalysisResult'), {
            fraud_score: 50, rule_score: 40, claude_score: 60, red_flags: ['price unusually low', 'rule_2_triggered'], recommendation: 'review', verification_status: 'caution',
          }),
          '401': errorRef('Unauthorized'),
          '404': errorRef('NotFound'),
          '429': errorRef('TooManyRequests'),
        },
      },
    },
    '/properties/{id}/ocr': {
      post: {
        tags: ['Verification'],
        summary: 'Parse a deed image with OCR (seller only)',
        security: secured,
        parameters: [idParam],
        requestBody: {
          required: true,
          content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } },
        },
        responses: {
          '200': jsonResponse('Parsed deed data', undefined, { deed_data: { deed_number: 'ZM-2024-001234', confidence_score: 0.92 }, success: true }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '422': errorRef('Unprocessable'),
        },
      },
    },
    '/properties/{id}/verify-identity': {
      post: {
        tags: ['Verification'],
        summary: 'Verify the seller NRC via Idswyft (seller only)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(
          { type: 'object', required: ['seller_nrc'], properties: { seller_nrc: { type: 'string', example: 'ZM0123456789' }, seller_photo_url: { type: 'string' } } },
          { seller_nrc: 'ZM0123456789' },
        ),
        responses: {
          '200': jsonResponse('Verification result', undefined, { identity: { verified: true, confidence_score: 0.95, nrc: 'ZM0123456789' }, success: true }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '422': errorRef('Unprocessable'),
        },
      },
    },
    '/properties/{id}/verify-satellite': {
      post: {
        tags: ['Verification'],
        summary: 'Verify location against satellite imagery via Claude vision (seller only)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(
          { type: 'object', required: ['latitude', 'longitude'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, description: { type: 'string' } } },
          { latitude: -15.4, longitude: 28.3, description: 'Vacant residential plot' },
        ),
        responses: {
          '200': jsonResponse('Verification result', undefined, { satellite: { verified: true, confidence_score: 0.88, matches_description: true }, success: true }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '422': errorRef('Unprocessable'),
        },
      },
    },

    // ── Rules ───────────────────────────────────────────────
    '/properties/{id}/check-rules': {
      post: {
        tags: ['Rules'],
        summary: 'Run the 12-rule fraud engine (body optional — falls back to stored data)',
        security: secured,
        parameters: [idParam],
        requestBody: {
          required: false,
          content: { 'application/json': { schema: { type: 'object', properties: { property: { type: 'object' }, ocr_data: { type: 'object' }, identity: { type: 'object' }, satellite: { type: 'object' } } } } },
        },
        responses: {
          '200': jsonResponse('Rule evaluation', undefined, { red_flags: ['rule_2_triggered'], rule_score: 8, details: {}, success: true }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },

    // ── Messaging ───────────────────────────────────────────
    '/messages': {
      post: {
        tags: ['Messaging'],
        summary: 'Send a message into a conversation',
        security: secured,
        requestBody: jsonBody(
          { type: 'object', required: ['conversation_id', 'content'], properties: { conversation_id: { type: 'string', format: 'uuid' }, content: { type: 'string' } } },
          { conversation_id: 'uuid', content: 'Is this still available?' },
        ),
        responses: {
          '201': jsonResponse('Message sent', schemaRef('Message')),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/conversations': {
      get: {
        tags: ['Messaging'],
        summary: 'List my conversations (newest activity first)',
        security: secured,
        responses: {
          '200': jsonResponse('Conversations', { type: 'array', items: schemaRef('ConversationSummary') }),
          '401': errorRef('Unauthorized'),
        },
      },
    },
    '/conversations/{id}/messages': {
      get: {
        tags: ['Messaging'],
        summary: 'Fetch a thread (marks the other party messages read)',
        security: secured,
        parameters: [idParam],
        responses: {
          '200': jsonResponse('Messages', { type: 'array', items: schemaRef('Message') }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/properties/{id}/message-seller': {
      post: {
        tags: ['Messaging'],
        summary: "Start/reuse a thread with a listing's seller and send the first message",
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody({ type: 'object', required: ['content'], properties: { content: { type: 'string' } } }, { content: 'Hi, is this plot still available?' }),
        responses: {
          '201': jsonResponse('Conversation + first message', undefined, { conversation: { id: 'uuid' }, message: { id: 'uuid', content: '...' } }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '404': errorRef('NotFound'),
        },
      },
    },

    // ── Payments ────────────────────────────────────────────
    '/payments/stripe/checkout': {
      post: {
        tags: ['Payments'],
        summary: 'Create a Stripe Checkout Session for a plan',
        security: secured,
        requestBody: jsonBody({ type: 'object', required: ['tier'], properties: { tier: { type: 'string', enum: ['buyer', 'seller', 'bank'] } } }, { tier: 'buyer' }),
        responses: {
          '201': jsonResponse('Checkout session', undefined, { sessionId: 'cs_test_...', url: 'https://checkout.stripe.com/...' }),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
        },
      },
    },
    '/payments/webhook/stripe': {
      post: {
        tags: ['Payments'],
        summary: 'Stripe webhook sink (no auth — verified by Stripe-Signature)',
        description: 'Raw body is required for signature verification. Not called directly by clients.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: {
          '200': jsonResponse('Acknowledged', undefined, { received: true, handled: true }),
          '400': errorRef('BadRequest'),
        },
      },
    },
    '/payments/mobile-money': {
      post: {
        tags: ['Payments'],
        summary: 'Record a pending mobile-money payment',
        security: secured,
        requestBody: jsonBody(
          { type: 'object', required: ['provider', 'amount'], properties: { provider: { type: 'string', enum: ['mtn', 'airtel', 'zamtel'] }, amount: { type: 'number' } } },
          { provider: 'mtn', amount: 600 },
        ),
        responses: {
          '201': jsonResponse('Pending payment', schemaRef('Payment')),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
        },
      },
    },
    '/payments/invoice/{id}': {
      get: {
        tags: ['Payments'],
        summary: 'Invoice for a payment (owner only). ?format=pdf streams a PDF',
        security: secured,
        parameters: [idParam, { name: 'format', in: 'query', schema: { type: 'string', enum: ['json', 'pdf'] } }],
        responses: {
          '200': jsonResponse('Invoice JSON (or PDF stream)', undefined, { id: 'uuid', payment_id: 'uuid', html_content: '<html>...' }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },

    // ── Admin ───────────────────────────────────────────────
    '/admin/analytics': {
      get: {
        tags: ['Admin'],
        summary: 'Platform metrics (admin only)',
        security: secured,
        responses: {
          '200': jsonResponse('Analytics', schemaRef('AdminAnalytics')),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
        },
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'],
        summary: 'List users with filters (admin only)',
        security: secured,
        parameters: [
          { name: 'tier', in: 'query', schema: { type: 'string' } },
          { name: 'admin_role', in: 'query', schema: { type: 'string', enum: ['user', 'admin'] } },
          { name: 'suspended', in: 'query', schema: { type: 'string', enum: ['true', 'false'] } },
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: {
          '200': jsonResponse('Users', { type: 'array', items: schemaRef('UserPublic') }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
        },
      },
    },
    '/admin/users/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Update a user (tier / admin role / suspension) — admin only',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(
          { type: 'object', properties: { subscription_tier: { type: 'string' }, admin_role: { type: 'string', enum: ['user', 'admin'] }, suspended: { type: 'boolean' } } },
          { suspended: true },
        ),
        responses: {
          '200': jsonResponse('Updated user', schemaRef('UserPublic')),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/admin/fraud-cases': {
      get: {
        tags: ['Admin'],
        summary: 'List fraud cases with filters (admin only)',
        security: secured,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'resolved', 'dismissed'] } },
          { name: 'severity', in: 'query', schema: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } },
          { name: 'min_score', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': jsonResponse('Fraud cases', { type: 'array', items: schemaRef('FraudCase') }),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
        },
      },
    },
    '/admin/fraud-cases/{id}': {
      patch: {
        tags: ['Admin'],
        summary: 'Resolve or dismiss a fraud case (admin only)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(
          { type: 'object', required: ['notes'], properties: { notes: { type: 'string' }, status: { type: 'string', enum: ['resolved', 'dismissed'] } } },
          { notes: 'Confirmed fraudulent deed', status: 'resolved' },
        ),
        responses: {
          '200': jsonResponse('Updated case', schemaRef('FraudCase')),
          '400': errorRef('BadRequest'),
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
          '404': errorRef('NotFound'),
        },
      },
    },
    '/admin/reports': {
      get: {
        tags: ['Admin'],
        summary: 'Export data as CSV or JSON (admin only)',
        security: secured,
        parameters: [
          { name: 'type', in: 'query', required: true, schema: { type: 'string', enum: ['users', 'fraud_cases', 'payments', 'revenue'] } },
          { name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'json'], default: 'csv' } },
        ],
        responses: {
          '200': {
            description: 'Report file',
            content: { 'text/csv': { schema: { type: 'string' } }, 'application/json': { schema: { type: 'array', items: { type: 'object' } } } },
          },
          '401': errorRef('Unauthorized'),
          '403': errorRef('Forbidden'),
        },
      },
    },
  },
};

/** The finalised OpenAPI document, served by the swagger routes. */
export const openApiSpec = swaggerJSDoc({
  definition: definition as unknown as swaggerJSDoc.OAS3Definition,
  apis: [],
}) as Record<string, unknown>;
