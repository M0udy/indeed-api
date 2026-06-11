// Mock the database layer so the job runs against controlled query results.
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  isDatabaseConnected: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { checkExpiredSubscriptions } from '../src/jobs/subscriptionExpiry';
import { query } from '../src/config/database';
import { runJobSafely, schedule, stopScheduler } from '../src/utils/scheduler';
import { logger } from '../src/utils/logger';

const mockQuery = query as jest.Mock;

function sql(): string {
  return String(mockQuery.mock.calls[0]?.[0] ?? '');
}

describe('checkExpiredSubscriptions', () => {
  beforeEach(() => mockQuery.mockReset());

  it('downgrades users with expired subscriptions and returns the count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1' }, { id: 'u2' }], rowCount: 2 });

    const count = await checkExpiredSubscriptions();

    expect(count).toBe(2);
    // Downgrade to free, gated on an expired payment…
    expect(sql()).toContain("subscription_tier = 'free'");
    expect(sql()).toContain('valid_until < now()');
    // …and explicitly NOT downgrading anyone who still has a valid payment.
    expect(sql()).toContain('NOT EXISTS');
    expect(sql()).toContain('valid_until > now()');
  });

  it('returns 0 when no subscriptions have expired (active subs untouched)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await checkExpiredSubscriptions()).toBe(0);
  });

  it('logs how many users were downgraded', async () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1' }], rowCount: 1 });

    await checkExpiredSubscriptions();

    expect(infoSpy).toHaveBeenCalledWith('Downgraded 1 users due to expired subscriptions');
    infoSpy.mockRestore();
  });

  it('treats a null rowCount as zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: null });
    expect(await checkExpiredSubscriptions()).toBe(0);
  });
});

describe('scheduler', () => {
  afterEach(() => stopScheduler());

  it('runJobSafely runs a job and resolves', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    await runJobSafely({ name: 'ok', intervalMs: 1000, run });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runJobSafely swallows and logs a job error instead of throwing', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const run = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(runJobSafely({ name: 'bad', intervalMs: 1000, run })).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      'Scheduled job failed',
      expect.objectContaining({ job: 'bad', error: 'boom' }),
    );
    errorSpy.mockRestore();
  });

  it('schedule runs a runOnStart job immediately', async () => {
    const run = jest.fn().mockResolvedValue(undefined);
    schedule({ name: 'immediate', intervalMs: 60_000, run, runOnStart: true });
    // Let the queued microtask resolve.
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stopScheduler clears registered timers', () => {
    const run = jest.fn().mockResolvedValue(undefined);
    schedule({ name: 'recurring', intervalMs: 60_000, run });
    expect(() => stopScheduler()).not.toThrow();
  });
});
