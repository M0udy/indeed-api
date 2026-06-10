import { Router, type Request, type Response } from 'express';
import { isDatabaseConnected } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';

/** /health router — liveness + database connectivity probe. */
export const healthRouter = Router();

healthRouter.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const dbConnected = await isDatabaseConnected();
    const status = dbConnected ? 'ok' : 'degraded';

    res.status(dbConnected ? 200 : 503).json({
      status,
      uptime: `${Math.floor(process.uptime())}s`,
      database: dbConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  }),
);
