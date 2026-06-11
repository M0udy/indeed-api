import { logger } from './logger';
import { checkExpiredSubscriptions } from '../jobs/subscriptionExpiry';

/**
 * Minimal interval-based job scheduler.
 *
 * Jobs run on a fixed interval; every run is wrapped so a failure is logged but
 * never crashes the process. Timers are `unref`'d so they don't keep the event
 * loop (or Jest) alive. Swap this for a cron library / external scheduler later
 * without changing the job functions themselves.
 */

const HOUR_MS = 60 * 60 * 1000;

/** A unit of recurring work. */
export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
  /** Run once immediately when scheduled (in addition to the interval). */
  runOnStart?: boolean;
}

let timers: NodeJS.Timeout[] = [];
let started = false;

/** Run a job, swallowing and logging any error so the scheduler never crashes. */
export async function runJobSafely(job: ScheduledJob): Promise<void> {
  const start = Date.now();
  try {
    await job.run();
    logger.debug('Scheduled job completed', { job: job.name, durationMs: Date.now() - start });
  } catch (err) {
    logger.error('Scheduled job failed', {
      job: job.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Register a job: optionally run it now, then on every interval. */
export function schedule(job: ScheduledJob): void {
  if (job.runOnStart) {
    void runJobSafely(job);
  }
  const timer = setInterval(() => {
    void runJobSafely(job);
  }, job.intervalMs);
  timer.unref?.();
  timers.push(timer);
}

/** Start all background jobs. Idempotent — safe to call more than once. */
export function startScheduler(): void {
  if (started) return;
  started = true;

  schedule({
    name: 'subscription-expiry',
    intervalMs: HOUR_MS,
    run: checkExpiredSubscriptions,
    runOnStart: true,
  });

  logger.info('Scheduler started', { jobs: ['subscription-expiry'] });
}

/** Stop all scheduled jobs and reset state (used on shutdown / in tests). */
export function stopScheduler(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  started = false;
}
