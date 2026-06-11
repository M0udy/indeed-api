import { query } from '../config/database';
import { logger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';
import type {
  AdminAnalytics,
  AdminFraudCaseFilters,
  AdminUserFilters,
  AdminUserUpdate,
  FraudCase,
  FraudCaseStatus,
  FraudSeverity,
  GeneratedReport,
  ReportFormat,
  ReportType,
  User,
} from '../types';

/**
 * Admin dashboard data access: platform analytics, user administration, fraud
 * case management, and data exports.
 *
 * All SQL is parameterised; dynamic filter clauses are built from fixed column
 * allow-lists. Aggregations cast Postgres `count`/`sum` to numbers in SQL so the
 * service returns clean numeric types.
 */

/** SQL expression mapping a fraud_score to a severity bucket. */
const SEVERITY_CASE = `CASE
  WHEN fa.fraud_score >= 75 THEN 'critical'
  WHEN fa.fraud_score >= 50 THEN 'high'
  WHEN fa.fraud_score >= 25 THEN 'medium'
  ELSE 'low'
END`;

export class AdminService {
  /** Aggregate platform metrics for the dashboard home. */
  async getAnalytics(): Promise<AdminAnalytics> {
    const usersAgg = await query<{
      total: number;
      verified: number;
      suspended: number;
      new_last_30_days: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE verification_badge)::int AS verified,
              count(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended,
              count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_last_30_days
         FROM users`,
    );

    const tierRows = await query<{ tier: string; count: number }>(
      `SELECT subscription_tier AS tier, count(*)::int AS count FROM users GROUP BY subscription_tier`,
    );

    const fraudAgg = await query<{
      total: number;
      open: number;
      resolved: number;
      high_or_critical: number;
      avg_score: number;
    }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'open')::int AS open,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE fraud_score >= 50)::int AS high_or_critical,
              COALESCE(round(avg(fraud_score))::int, 0) AS avg_score
         FROM fraud_analyses`,
    );

    const propsAgg = await query<{ total: number; flagged: number; verified: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE verification_status = 'flagged')::int AS flagged,
              count(*) FILTER (WHERE verification_status = 'verified')::int AS verified
         FROM properties`,
    );

    const revenueAgg = await query<{ total: number; completed_payments: number }>(
      `SELECT COALESCE(sum(amount), 0)::float AS total,
              count(*)::int AS completed_payments
         FROM payments
        WHERE status = 'completed'`,
    );

    const byTier: Record<string, number> = {};
    for (const row of tierRows.rows) byTier[row.tier] = row.count;

    const users = usersAgg.rows[0] ?? { total: 0, verified: 0, suspended: 0, new_last_30_days: 0 };
    const fraud = fraudAgg.rows[0] ?? {
      total: 0,
      open: 0,
      resolved: 0,
      high_or_critical: 0,
      avg_score: 0,
    };
    const props = propsAgg.rows[0] ?? { total: 0, flagged: 0, verified: 0 };
    const revenue = revenueAgg.rows[0] ?? { total: 0, completed_payments: 0 };

    return {
      users: { ...users, by_tier: byTier },
      fraud_cases: fraud,
      properties: props,
      revenue: { total: revenue.total, currency: 'ZMW', completed_payments: revenue.completed_payments },
    };
  }

  /** List users with optional filters, newest first. */
  async listUsers(filters: AdminUserFilters): Promise<User[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.tier !== undefined) {
      params.push(filters.tier);
      conditions.push(`subscription_tier = $${params.length}`);
    }
    if (filters.admin_role !== undefined) {
      params.push(filters.admin_role);
      conditions.push(`admin_role = $${params.length}`);
    }
    if (filters.kyc_status !== undefined) {
      params.push(filters.kyc_status);
      conditions.push(`kyc_status = $${params.length}`);
    }
    if (filters.suspended !== undefined) {
      conditions.push(filters.suspended ? `suspended_at IS NOT NULL` : `suspended_at IS NULL`);
    }
    if (filters.search !== undefined) {
      params.push(`%${filters.search}%`);
      conditions.push(`(phone ILIKE $${params.length} OR name ILIKE $${params.length})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(filters.limit);
    const limit = `$${params.length}`;
    params.push(filters.offset);
    const offset = `$${params.length}`;

    const { rows } = await query<User>(
      `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return rows;
  }

  /**
   * Update an admin-editable subset of a user's fields (tier, admin role,
   * suspension). Returns the updated user.
   *
   * @throws {NotFoundError} if the user does not exist.
   */
  async updateUser(userId: string, updates: AdminUserUpdate): Promise<User> {
    const assignments: string[] = [];
    const params: unknown[] = [];

    if (updates.subscription_tier !== undefined) {
      params.push(updates.subscription_tier);
      assignments.push(`subscription_tier = $${params.length}`);
    }
    if (updates.admin_role !== undefined) {
      params.push(updates.admin_role);
      assignments.push(`admin_role = $${params.length}`);
    }
    if (updates.suspended !== undefined) {
      // true → stamp now(); false → clear the suspension.
      assignments.push(`suspended_at = ${updates.suspended ? 'now()' : 'NULL'}`);
    }

    if (assignments.length === 0) {
      const current = await query<User>(`SELECT * FROM users WHERE id = $1`, [userId]);
      const user = current.rows[0];
      if (!user) throw new NotFoundError('User not found');
      return user;
    }

    assignments.push(`updated_at = now()`);
    params.push(userId);

    const { rows } = await query<User>(
      `UPDATE users SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params,
    );
    const user = rows[0];
    if (!user) throw new NotFoundError('User not found');
    logger.info('Admin updated user', { userId, fields: Object.keys(updates) });
    return user;
  }

  /** List fraud cases (fraud analyses + property) with optional filters. */
  async listFraudCases(filters: AdminFraudCaseFilters): Promise<FraudCase[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.status !== undefined) {
      params.push(filters.status);
      conditions.push(`fa.status = $${params.length}`);
    }
    if (filters.severity !== undefined) {
      params.push(filters.severity);
      conditions.push(`${SEVERITY_CASE} = $${params.length}`);
    }
    if (filters.min_score !== undefined) {
      params.push(filters.min_score);
      conditions.push(`fa.fraud_score >= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(filters.limit);
    const limit = `$${params.length}`;
    params.push(filters.offset);
    const offset = `$${params.length}`;

    const { rows } = await query<FraudCase>(
      `SELECT fa.id, fa.property_id, fa.fraud_score, fa.status, fa.recommendation,
              fa.red_flags, fa.resolution_notes, fa.resolved_at, fa.analyzed_at,
              ${SEVERITY_CASE} AS severity,
              p.title AS property_title, p.location AS property_location
         FROM fraud_analyses fa
         JOIN properties p ON p.id = fa.property_id
         ${where}
        ORDER BY fa.analyzed_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return rows;
  }

  /**
   * Resolve (or dismiss) a fraud case with admin notes.
   *
   * @throws {NotFoundError} if the case does not exist.
   */
  async resolveFraudCase(
    caseId: string,
    notes: string,
    adminId?: string,
    status: Extract<FraudCaseStatus, 'resolved' | 'dismissed'> = 'resolved',
  ): Promise<FraudCase> {
    const { rows } = await query<{
      id: string;
      property_id: string;
      fraud_score: number;
      status: FraudCaseStatus;
      recommendation: string | null;
      red_flags: string[];
      resolution_notes: string | null;
      resolved_at: Date | null;
      analyzed_at: Date;
    }>(
      `UPDATE fraud_analyses
          SET status = $2, resolution_notes = $3, resolved_at = now(), resolved_by = $4
        WHERE id = $1
        RETURNING id, property_id, fraud_score, status, recommendation,
                  red_flags, resolution_notes, resolved_at, analyzed_at`,
      [caseId, status, notes, adminId ?? null],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Fraud case not found');

    logger.info('Admin resolved fraud case', { caseId, status, adminId });
    return {
      ...row,
      severity: severityForScore(row.fraud_score),
      property_title: null,
      property_location: null,
    };
  }

  /**
   * Generate an export report of the given type in CSV or JSON.
   *
   * @throws {NotFoundError} for an unknown report type (defensive — validated upstream).
   */
  async generateReport(type: ReportType, format: ReportFormat = 'csv'): Promise<GeneratedReport> {
    const rows = await this.fetchReportRows(type);

    const timestamp = new Date().toISOString().slice(0, 10);
    const filename = `indeed-${type}-${timestamp}.${format}`;

    if (format === 'json') {
      return {
        filename,
        contentType: 'application/json',
        content: JSON.stringify(rows, null, 2),
      };
    }
    return {
      filename,
      contentType: 'text/csv; charset=utf-8',
      content: toCsv(rows),
    };
  }

  /** Fetch the underlying rows for a report type. */
  private async fetchReportRows(type: ReportType): Promise<Array<Record<string, unknown>>> {
    switch (type) {
      case 'users': {
        const { rows } = await query<Record<string, unknown>>(
          `SELECT id, phone, name, email, subscription_tier, kyc_status, admin_role,
                  verification_badge, suspended_at, created_at
             FROM users ORDER BY created_at DESC`,
        );
        return rows;
      }
      case 'fraud_cases': {
        const { rows } = await query<Record<string, unknown>>(
          `SELECT fa.id, fa.property_id, fa.fraud_score, fa.status, fa.recommendation,
                  fa.resolved_at, fa.analyzed_at, ${SEVERITY_CASE} AS severity
             FROM fraud_analyses fa
             JOIN properties p ON p.id = fa.property_id
            ORDER BY fa.analyzed_at DESC`,
        );
        return rows;
      }
      case 'payments': {
        const { rows } = await query<Record<string, unknown>>(
          `SELECT id, user_id, amount, currency, status, provider, subscription_tier, created_at
             FROM payments ORDER BY created_at DESC`,
        );
        return rows;
      }
      case 'revenue': {
        const { rows } = await query<Record<string, unknown>>(
          `SELECT date_trunc('day', created_at)::date AS day,
                  sum(amount)::float AS total,
                  count(*)::int AS payments
             FROM payments
            WHERE status = 'completed'
            GROUP BY day ORDER BY day DESC`,
        );
        return rows;
      }
      default:
        throw new NotFoundError(`Unknown report type: ${String(type)}`);
    }
  }
}

/** Map a fraud score to a severity bucket (mirrors {@link SEVERITY_CASE}). */
function severityForScore(score: number): FraudSeverity {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}

/** Serialise an array of flat records to CSV (RFC-4180-ish quoting). */
function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const header = columns.map(escapeCsv).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeCsv(formatCell(row[col]))).join(','));
  return [header, ...lines].join('\n');
}

/** Render a cell value to a string for CSV output. */
function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Make a value safe for CSV output:
 *  1. Neutralise spreadsheet formula triggers (OWASP CSV Injection) by prefixing
 *     a single quote, so a cell like `=cmd()` or `@SUM(...)` can't execute when
 *     the file is opened in Excel / Google Sheets. Plain numbers (including
 *     negatives) are left intact so numeric columns aren't corrupted.
 *  2. Quote the field if it contains a comma, quote, or newline (RFC 4180).
 */
function escapeCsv(value: string): string {
  let out = value;
  if (/^[=+\-@\t\r]/.test(out) && !isPlainNumber(out)) {
    out = `'${out}`;
  }
  if (/[",\n\r]/.test(out)) {
    return `"${out.replace(/"/g, '""')}"`;
  }
  return out;
}

/** Whether a string is a plain (optionally negative/decimal) number. */
function isPlainNumber(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

/** Shared singleton used by controllers. */
export const adminService = new AdminService();
