import type { Server } from 'node:http';
import { createApp } from './app';
import { config } from './config/env';
import { closePool, isDatabaseConnected } from './config/database';
import { logger } from './utils/logger';

/**
 * Process entry point: build the app, verify the database is reachable, start
 * listening, and wire up graceful shutdown on SIGTERM/SIGINT.
 */
async function bootstrap(): Promise<void> {
  const app = createApp();

  const connected = await isDatabaseConnected();
  if (!connected) {
    logger.warn('Database is not reachable at startup — continuing, /health will report degraded');
  }

  const server: Server = app.listen(config.port, () => {
    logger.info('InDeed API listening', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (signal: string): void => {
    logger.info('Shutting down', { signal });
    server.close(() => {
      void closePool().finally(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      });
    });
    // Force-exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

bootstrap().catch((err: unknown) => {
  logger.error('Failed to start server', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
