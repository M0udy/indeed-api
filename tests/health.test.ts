import request from 'supertest';

// Mock the database layer so the app never touches a real Postgres instance.
jest.mock('../src/config/database', () => ({
  isDatabaseConnected: jest.fn().mockResolvedValue(true),
  query: jest.fn(),
  withTransaction: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { createApp } from '../src/app';
import { isDatabaseConnected } from '../src/config/database';

describe('GET /health', () => {
  const app = createApp();

  it('reports ok when the database is connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'connected' });
  });

  it('reports degraded with a 503 when the database is down', async () => {
    (isDatabaseConnected as jest.Mock).mockResolvedValueOnce(false);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'disconnected' });
  });
});

describe('unknown routes', () => {
  const app = createApp();

  it('returns a structured 404', async () => {
    const res = await request(app).get('/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });
});
