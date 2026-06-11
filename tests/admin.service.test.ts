// Mock the database layer so the service runs against controlled query results.
jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  isDatabaseConnected: jest.fn(),
  closePool: jest.fn(),
  pool: {},
}));

import { AdminService } from '../src/services/admin.service';
import { query } from '../src/config/database';
import { NotFoundError } from '../src/utils/errors';
import type { FraudCase, User } from '../src/types';

const mockQuery = query as jest.Mock;

function nextRows(rows: unknown[]): void {
  mockQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

/** SQL text + params of the Nth query() call. */
function callOf(i: number): { sql: string; params: unknown[] } {
  const call = mockQuery.mock.calls[i];
  return { sql: String(call?.[0] ?? ''), params: (call?.[1] as unknown[]) ?? [] };
}

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    phone: '+260123456789',
    email: null,
    name: 'Jane',
    kyc_status: 'pending',
    subscription_tier: 'free',
    verification_badge: false,
    admin_role: 'user',
    suspended_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('AdminService', () => {
  const service = new AdminService();

  beforeEach(() => mockQuery.mockReset());

  describe('getAnalytics', () => {
    it('assembles analytics from the aggregate queries', async () => {
      nextRows([{ total: 100, verified: 40, suspended: 3, new_last_30_days: 12 }]); // users agg
      nextRows([
        { tier: 'free', count: 70 },
        { tier: 'premium', count: 20 },
        { tier: 'enterprise', count: 10 },
      ]); // by tier
      nextRows([{ total: 25, open: 8, resolved: 17, high_or_critical: 6, avg_score: 42 }]); // fraud
      nextRows([{ total: 200, flagged: 9, verified: 50 }]); // properties
      nextRows([{ total: 1_234_567.89, completed_payments: 88 }]); // revenue

      const result = await service.getAnalytics();

      expect(result.users).toMatchObject({ total: 100, verified: 40, suspended: 3 });
      expect(result.users.by_tier).toEqual({ free: 70, premium: 20, enterprise: 10 });
      expect(result.fraud_cases).toMatchObject({ open: 8, resolved: 17, avg_score: 42 });
      expect(result.properties).toMatchObject({ total: 200, flagged: 9 });
      expect(result.revenue).toEqual({ total: 1_234_567.89, currency: 'ZMW', completed_payments: 88 });
      expect(mockQuery).toHaveBeenCalledTimes(5);
    });
  });

  describe('listUsers', () => {
    it('lists users with no filters', async () => {
      nextRows([fakeUser(), fakeUser({ id: 'user-2' })]);
      const result = await service.listUsers({ limit: 50, offset: 0 });
      expect(result).toHaveLength(2);
      expect(callOf(0).sql).not.toContain('WHERE');
      expect(callOf(0).params).toEqual([50, 0]);
    });

    it('applies tier and suspended filters', async () => {
      nextRows([fakeUser({ subscription_tier: 'premium' })]);
      await service.listUsers({ tier: 'premium', suspended: true, limit: 10, offset: 5 });
      const { sql, params } = callOf(0);
      expect(sql).toContain('subscription_tier = $1');
      expect(sql).toContain('suspended_at IS NOT NULL');
      expect(params).toEqual(['premium', 10, 5]);
    });

    it('builds a search clause over phone and name', async () => {
      nextRows([]);
      await service.listUsers({ search: 'jane', limit: 50, offset: 0 });
      const { sql, params } = callOf(0);
      expect(sql).toContain('ILIKE');
      expect(params[0]).toBe('%jane%');
    });
  });

  describe('updateUser', () => {
    it('updates the subscription tier', async () => {
      nextRows([fakeUser({ subscription_tier: 'professional' })]);
      const user = await service.updateUser('user-1', { subscription_tier: 'professional' });
      expect(user.subscription_tier).toBe('professional');
      const { sql, params } = callOf(0);
      expect(sql).toContain('subscription_tier = $1');
      expect(params).toEqual(['professional', 'user-1']);
    });

    it('suspends a user by stamping suspended_at', async () => {
      nextRows([fakeUser({ suspended_at: new Date() })]);
      await service.updateUser('user-1', { suspended: true });
      expect(callOf(0).sql).toContain('suspended_at = now()');
    });

    it('un-suspends a user by clearing suspended_at', async () => {
      nextRows([fakeUser({ suspended_at: null })]);
      await service.updateUser('user-1', { suspended: false });
      expect(callOf(0).sql).toContain('suspended_at = NULL');
    });

    it('promotes a user to admin', async () => {
      nextRows([fakeUser({ admin_role: 'admin' })]);
      const user = await service.updateUser('user-1', { admin_role: 'admin' });
      expect(user.admin_role).toBe('admin');
    });

    it('throws NotFound when the user does not exist', async () => {
      nextRows([]); // update returns no row
      await expect(
        service.updateUser('missing', { subscription_tier: 'premium' }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listFraudCases', () => {
    function fakeCase(overrides: Partial<FraudCase> = {}): FraudCase {
      return {
        id: 'case-1',
        property_id: 'prop-1',
        fraud_score: 80,
        severity: 'critical',
        status: 'open',
        recommendation: 'reject',
        red_flags: ['rule_2_triggered'],
        resolution_notes: null,
        resolved_at: null,
        analyzed_at: new Date('2026-06-01T00:00:00Z'),
        property_title: 'Plot',
        property_location: 'Lusaka',
        ...overrides,
      };
    }

    it('lists cases with no filters', async () => {
      nextRows([fakeCase()]);
      const result = await service.listFraudCases({ limit: 50, offset: 0 });
      expect(result).toHaveLength(1);
      expect(callOf(0).sql).toContain('JOIN properties');
    });

    it('filters by status', async () => {
      nextRows([fakeCase({ status: 'resolved' })]);
      await service.listFraudCases({ status: 'resolved', limit: 50, offset: 0 });
      const { sql, params } = callOf(0);
      expect(sql).toContain('fa.status = $1');
      expect(params[0]).toBe('resolved');
    });

    it('filters by severity using the score CASE expression', async () => {
      nextRows([fakeCase()]);
      await service.listFraudCases({ severity: 'high', limit: 50, offset: 0 });
      const { sql, params } = callOf(0);
      expect(sql).toContain('= $1'); // CASE ... END = $1
      expect(params[0]).toBe('high');
    });

    it('filters by minimum score', async () => {
      nextRows([fakeCase()]);
      await service.listFraudCases({ min_score: 60, limit: 50, offset: 0 });
      expect(callOf(0).params[0]).toBe(60);
    });
  });

  describe('resolveFraudCase', () => {
    it('resolves a case and derives severity from the score', async () => {
      nextRows([
        {
          id: 'case-1',
          property_id: 'prop-1',
          fraud_score: 90,
          status: 'resolved',
          recommendation: 'reject',
          red_flags: [],
          resolution_notes: 'Confirmed fraudulent deed',
          resolved_at: new Date(),
          analyzed_at: new Date('2026-06-01T00:00:00Z'),
        },
      ]);

      const result = await service.resolveFraudCase('case-1', 'Confirmed fraudulent deed', 'admin-1');

      expect(result.status).toBe('resolved');
      expect(result.severity).toBe('critical'); // 90 → critical
      const { sql, params } = callOf(0);
      expect(sql).toContain('UPDATE fraud_analyses');
      expect(params).toEqual(['case-1', 'resolved', 'Confirmed fraudulent deed', 'admin-1']);
    });

    it('supports dismissing a case', async () => {
      nextRows([
        {
          id: 'case-1',
          property_id: 'prop-1',
          fraud_score: 30,
          status: 'dismissed',
          recommendation: 'review',
          red_flags: [],
          resolution_notes: 'False alarm',
          resolved_at: new Date(),
          analyzed_at: new Date('2026-06-01T00:00:00Z'),
        },
      ]);
      const result = await service.resolveFraudCase('case-1', 'False alarm', 'admin-1', 'dismissed');
      expect(result.status).toBe('dismissed');
      expect(result.severity).toBe('medium'); // 30 → medium
    });

    it('throws NotFound for an unknown case', async () => {
      nextRows([]);
      await expect(service.resolveFraudCase('missing', 'notes', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('generateReport', () => {
    it('exports users as CSV with a header row', async () => {
      nextRows([
        { id: 'u1', phone: '+260111', name: 'Jane', subscription_tier: 'free', created_at: new Date('2026-01-01T00:00:00Z') },
        { id: 'u2', phone: '+260222', name: 'John, Jr', subscription_tier: 'premium', created_at: new Date('2026-02-01T00:00:00Z') },
      ]);
      const report = await service.generateReport('users', 'csv');

      expect(report.contentType).toBe('text/csv; charset=utf-8');
      expect(report.filename).toMatch(/^indeed-users-.*\.csv$/);
      const lines = report.content.split('\n');
      expect(lines[0]).toBe('id,phone,name,subscription_tier,created_at');
      expect(lines[2]).toContain('"John, Jr"'); // comma-containing field is quoted
    });

    it('neutralises spreadsheet formula injection while preserving numbers', async () => {
      nextRows([
        { id: 'u1', name: '=cmd()', note: '@SUM(A1)', score: '-15', amount: '600.00' },
      ]);
      const report = await service.generateReport('users', 'csv');
      const cells = report.content.split('\n')[1]?.split(',') ?? [];

      // Formula triggers are prefixed with a single quote…
      expect(cells[1]).toBe("'=cmd()");
      expect(cells[2]).toBe("'@SUM(A1)");
      // …but plain numbers (incl. negatives) are left untouched.
      expect(cells[3]).toBe('-15');
      expect(cells[4]).toBe('600.00');
    });

    it('exports as JSON when requested', async () => {
      nextRows([{ id: 'u1', amount: '600.00', status: 'completed' }]);
      const report = await service.generateReport('payments', 'json');
      expect(report.contentType).toBe('application/json');
      expect(JSON.parse(report.content)).toEqual([{ id: 'u1', amount: '600.00', status: 'completed' }]);
    });

    it('returns an empty string for an empty CSV export', async () => {
      nextRows([]);
      const report = await service.generateReport('fraud_cases', 'csv');
      expect(report.content).toBe('');
    });
  });
});
