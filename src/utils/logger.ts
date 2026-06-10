/**
 * Tiny dependency-free structured logger.
 *
 * Emits single-line JSON in production (easy for log aggregators to parse) and
 * a friendlier human format in development. Swap the implementation for pino /
 * winston later without touching call sites.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const isProduction = process.env.NODE_ENV === 'production';
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || (isProduction ? 'info' : 'debug');

/** Metadata bag attached to a log line. Values must be JSON-serialisable. */
export type LogContext = Record<string, unknown>;

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minLevel]) return;

  const timestamp = new Date().toISOString();

  if (isProduction) {
    process.stdout.write(`${JSON.stringify({ timestamp, level, message, ...context })}\n`);
    return;
  }

  const ctx = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
  process.stdout.write(`[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}${ctx}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext): void => write('debug', message, context),
  info: (message: string, context?: LogContext): void => write('info', message, context),
  warn: (message: string, context?: LogContext): void => write('warn', message, context),
  error: (message: string, context?: LogContext): void => write('error', message, context),
};
