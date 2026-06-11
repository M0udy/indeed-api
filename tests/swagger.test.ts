import request from 'supertest';
import { openApiSpec } from '../src/utils/swagger';

// The app pulls in the DB layer transitively; mock it so createApp is side-effect free.
jest.mock('../src/config/database', () => ({
  isDatabaseConnected: jest.fn().mockResolvedValue(true),
  query: jest.fn(),
  withTransaction: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { createApp } from '../src/app';

/** Cast the loosely-typed spec for assertions. */
const spec = openApiSpec as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
};

describe('OpenAPI specification', () => {
  it('is a valid OpenAPI 3.0 document', () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('InDeed API');
    expect(spec.info.version).toBe('1.0.0');
  });

  it('documents every endpoint group', () => {
    const paths = Object.keys(spec.paths);
    // A representative path from each group must be present.
    const required = [
      '/health',
      '/auth/request-otp',
      '/auth/verify-otp',
      '/auth/me',
      '/auth/refresh',
      '/properties',
      '/properties/{id}',
      '/properties/{id}/upload',
      '/properties/{id}/analyze',
      '/properties/{id}/ocr',
      '/properties/{id}/verify-identity',
      '/properties/{id}/verify-satellite',
      '/properties/{id}/check-rules',
      '/messages',
      '/conversations',
      '/conversations/{id}/messages',
      '/payments/stripe/checkout',
      '/payments/webhook/stripe',
      '/payments/mobile-money',
      '/payments/invoice/{id}',
      '/admin/analytics',
      '/admin/users',
      '/admin/fraud-cases',
      '/admin/reports',
    ];
    for (const p of required) expect(paths).toContain(p);
    expect(paths.length).toBeGreaterThanOrEqual(25);
  });

  it('defines the security scheme and standard error responses', () => {
    expect(spec.components.responses).toHaveProperty('Unauthorized');
    expect(spec.components.responses).toHaveProperty('Forbidden');
    expect(spec.components.responses).toHaveProperty('NotFound');
    expect(spec.components.responses).toHaveProperty('BadRequest');
    expect(spec.components.responses).toHaveProperty('TooManyRequests');
    expect(spec.components.responses).toHaveProperty('ServerError');
  });

  it('marks authenticated endpoints with bearer security', () => {
    const me = spec.paths['/auth/me']?.get as { security?: unknown[] };
    expect(me.security).toEqual([{ bearerAuth: [] }]);
  });
});

describe('docs endpoints', () => {
  const app = createApp();

  it('serves the raw OpenAPI JSON at /api-docs.json', async () => {
    const res = await request(app).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('serves the Swagger UI at /api-docs/', async () => {
    const res = await request(app).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
