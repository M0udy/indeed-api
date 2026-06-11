import { query } from '../config/database';
import { logger } from '../utils/logger';

/**
 * Downgrade users whose paid subscription has lapsed.
 *
 * A user is downgraded to `free` when:
 *  - they currently hold a non-free tier, AND
 *  - they have at least one completed payment whose `valid_until` is in the
 *    past, AND
 *  - they have NO completed payment that is still valid (so a user who renewed
 *    is never downgraded just because an older payment expired).
 *
 * Users on a tier with no payment history at all (e.g. an admin-granted tier)
 * are intentionally left untouched — there is no expiry to act on.
 *
 * @returns the number of users downgraded.
 */
export async function checkExpiredSubscriptions(): Promise<number> {
  const { rowCount } = await query(
    `UPDATE users u
        SET subscription_tier = 'free', updated_at = now()
      WHERE u.subscription_tier <> 'free'
        AND EXISTS (
          SELECT 1 FROM payments p
           WHERE p.user_id = u.id
             AND p.status = 'completed'
             AND p.valid_until IS NOT NULL
             AND p.valid_until < now()
        )
        AND NOT EXISTS (
          SELECT 1 FROM payments p2
           WHERE p2.user_id = u.id
             AND p2.status = 'completed'
             AND p2.valid_until IS NOT NULL
             AND p2.valid_until > now()
        )
      RETURNING u.id`,
  );

  const count = rowCount ?? 0;
  logger.info(`Downgraded ${count} users due to expired subscriptions`);
  return count;
}
