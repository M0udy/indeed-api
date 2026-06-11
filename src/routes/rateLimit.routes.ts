import { Router, type Request, type Response } from 'express';
import { rateLimit } from '../middleware/rateLimit';

/**
 * A dedicated endpoint for smoke-testing rate limiting end-to-end. It uses a
 * low, isolated limit (5 requests per IP per minute) so you can quickly observe
 * the `429` response and `Retry-After` header without exhausting a real limit.
 *
 *   GET /rate-limit/test  → { ok: true, remaining }  (429 after 5/min)
 */
export const rateLimitRouter = Router();

rateLimitRouter.get(
  '/rate-limit/test',
  rateLimit('test', 5, 60 * 1000),
  (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, remaining: res.getHeader('X-RateLimit-Remaining') });
  },
);
