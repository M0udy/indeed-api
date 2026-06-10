import express, { type Application, type Request, type Response } from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { config } from './config/env';
import { requestLogger } from './middleware/requestLogger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authRouter } from './routes/auth.routes';
import { propertyRouter } from './routes/property.routes';
import { healthRouter } from './routes/health.routes';

/**
 * Build and configure the Express application. Kept free of any `listen()` call
 * so tests can import the app and drive it with supertest without binding a port.
 */
export function createApp(): Application {
  const app = express();

  // Security headers.
  app.use(helmet());

  // CORS — only allow the configured frontend origins (e.g. the Vercel app).
  const corsOptions: CorsOptions = {
    origin(origin, callback) {
      // Allow same-origin / non-browser requests (no Origin header) and any
      // explicitly whitelisted origin.
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  };
  app.use(cors(corsOptions));

  // Body parsing (JSON + urlencoded) with sane size limits.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Per-request logging + correlation id.
  app.use(requestLogger);

  // Routes.
  app.get('/', (_req: Request, res: Response) => {
    res.json({ name: 'InDeed API', version: '1.0.0', status: 'running' });
  });
  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/properties', propertyRouter);

  // 404 + centralised error handling (must be last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
