import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from './env';
import { logger } from '../utils/logger';

/**
 * A single shared PostgreSQL connection pool for the whole process.
 *
 * Every query in the application goes through {@link query} (or
 * {@link withTransaction}), which keeps SQL parameterised — the only safe way
 * to prevent SQL injection — and gives us one place to log slow queries.
 */
const pool = new Pool({
  connectionString: config.database.url,
  // SSL is verified by default. If your managed Postgres uses a private CA,
  // point DATABASE_CA_CERT at the PEM bundle rather than disabling verification.
  // DATABASE_SSL_REJECT_UNAUTHORIZED=false is an explicit, last-resort escape
  // hatch for dev only — it disables TLS verification and exposes you to MITM.
  ssl: config.database.ssl
    ? {
        rejectUnauthorized: config.database.sslRejectUnauthorized,
        ...(config.database.caCert ? { ca: config.database.caCert } : {}),
      }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err: Error) => {
  // Errors on idle clients should never crash the process.
  logger.error('Unexpected error on idle PostgreSQL client', { error: err.message });
});

/**
 * Run a parameterised query against the pool.
 *
 * @typeParam T   Shape of each returned row.
 * @param text    SQL with `$1, $2, …` placeholders — NEVER interpolate values.
 * @param params  Ordered parameter values bound to the placeholders.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  const start = Date.now();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const duration = Date.now() - start;
    if (duration > 500) {
      logger.warn('Slow query', { duration, rows: result.rowCount, sql: text.slice(0, 120) });
    }
    return result;
  } catch (err) {
    logger.error('Database query failed', {
      error: err instanceof Error ? err.message : String(err),
      sql: text.slice(0, 120),
    });
    throw err;
  }
}

/**
 * Run a set of statements inside a single transaction. The callback receives a
 * dedicated client; the transaction is committed if it resolves and rolled back
 * if it throws.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight connectivity probe used by the health-check endpoint. */
export async function isDatabaseConnected(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Gracefully drain the pool on shutdown. */
export async function closePool(): Promise<void> {
  await pool.end();
}

export { pool };
