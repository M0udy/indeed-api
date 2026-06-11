import type { Response } from 'express';
import { adminService, AdminService } from '../services/admin.service';
import { ValidationError } from '../utils/errors';
import { toUserPublic } from '../utils/mappers';
import type { AdminRequest } from '../middleware/adminAuth';
import type { ValidatedLocals } from '../middleware/validate';
import type {
  AdminFraudCaseFilters,
  AdminUserFilters,
  AdminUserUpdate,
} from '../types';
import type {
  AdminFraudCaseFiltersQuery,
  AdminUserFiltersQuery,
  AdminUserUpdateBody,
  ReportQuery,
  ResolveFraudCaseBody,
} from '../utils/validators';

/**
 * HTTP handlers for the admin dashboard. Every route is gated by the
 * `adminOnly` middleware, so handlers can assume an authenticated admin.
 * The service is constructor-injected for testability.
 */
export class AdminController {
  constructor(private readonly admin: AdminService = adminService) {}

  /** GET /admin/analytics — platform metrics. */
  analytics = async (_req: AdminRequest, res: Response): Promise<void> => {
    const analytics = await this.admin.getAnalytics();
    res.status(200).json(analytics);
  };

  /** GET /admin/users — filtered user list. */
  listUsers = async (_req: AdminRequest, res: Response): Promise<void> => {
    const q = (res.locals as ValidatedLocals).queryParams as AdminUserFiltersQuery;
    const filters: AdminUserFilters = {
      ...(q.tier !== undefined ? { tier: q.tier } : {}),
      ...(q.admin_role !== undefined ? { admin_role: q.admin_role } : {}),
      ...(q.suspended !== undefined ? { suspended: q.suspended } : {}),
      ...(q.kyc_status !== undefined ? { kyc_status: q.kyc_status } : {}),
      ...(q.search !== undefined ? { search: q.search } : {}),
      limit: q.limit,
      offset: q.offset,
    };
    const users = await this.admin.listUsers(filters);
    res.status(200).json(users.map(toUserPublic));
  };

  /** PATCH /admin/users/:id — update tier / role / suspension. */
  updateUser = async (req: AdminRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) throw new ValidationError('Missing user id');
    const body = (res.locals as ValidatedLocals).body as AdminUserUpdateBody;
    const updates: AdminUserUpdate = body;

    const user = await this.admin.updateUser(id, updates);
    res.status(200).json(user);
  };

  /** GET /admin/fraud-cases — filtered fraud-case list. */
  listFraudCases = async (_req: AdminRequest, res: Response): Promise<void> => {
    const q = (res.locals as ValidatedLocals).queryParams as AdminFraudCaseFiltersQuery;
    const filters: AdminFraudCaseFilters = {
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.severity !== undefined ? { severity: q.severity } : {}),
      ...(q.min_score !== undefined ? { min_score: q.min_score } : {}),
      limit: q.limit,
      offset: q.offset,
    };
    const cases = await this.admin.listFraudCases(filters);
    res.status(200).json(cases);
  };

  /** PATCH /admin/fraud-cases/:id — resolve or dismiss a case. */
  resolveFraudCase = async (req: AdminRequest, res: Response): Promise<void> => {
    const id = req.params.id;
    if (!id) throw new ValidationError('Missing fraud case id');
    const { notes, status } = (res.locals as ValidatedLocals).body as ResolveFraudCaseBody;

    const resolved = await this.admin.resolveFraudCase(id, notes, req.adminUser?.id, status);
    res.status(200).json(resolved);
  };

  /** GET /admin/reports — export data as CSV or JSON. */
  reports = async (_req: AdminRequest, res: Response): Promise<void> => {
    const { type, format } = (res.locals as ValidatedLocals).queryParams as ReportQuery;
    const report = await this.admin.generateReport(type, format);

    res.setHeader('Content-Type', report.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${report.filename}"`);
    res.status(200).send(report.content);
  };
}

export const adminController = new AdminController();
