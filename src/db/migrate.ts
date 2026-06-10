import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool, closePool } from '../config/database';
import { logger } from '../utils/logger';

/**
 * Apply `schema.sql` to the configured database. Idempotent — every statement
 * uses `IF NOT EXISTS`, so it is safe to run repeatedly.
 *
 * Usage: `npm run db:migrate`
 */
async function migrate(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');

  logger.info('Applying database schema', { schemaPath });
  await pool.query(sql);
  logger.info('Database schema applied successfully');
}

migrate()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
    void closePool().finally(() => process.exit(1));
  });
