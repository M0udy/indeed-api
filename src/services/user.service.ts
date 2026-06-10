import { query } from '../config/database';
import type { User } from '../types';

/**
 * Read access to the `users` table. Kept separate from auth logic so other
 * features (property seller lookups, dashboards) can reuse it cleanly.
 */
export class UserService {
  /** Fetch a user by id, or null if not found. */
  async findById(id: string): Promise<User | null> {
    const { rows } = await query<User>(`SELECT * FROM users WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }

  /** Fetch a user by phone, or null if not found. */
  async findByPhone(phone: string): Promise<User | null> {
    const { rows } = await query<User>(`SELECT * FROM users WHERE phone = $1`, [phone]);
    return rows[0] ?? null;
  }
}

export const userService = new UserService();
