import type { UserSettings } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence port for per-user settings (the `user_settings` table, PK user_id).
// Today it carries only the user-tier spend budget. The domain depends only on this
// interface; each facade implements it (D1 / Drizzle).
// ---------------------------------------------------------------------------

export interface UserSettingsRepository {
  /** The user's settings row, or null when they have never saved one. */
  get(userId: string): Promise<UserSettings | null>
  /** Create or replace the user's settings row. */
  upsert(userId: string, settings: UserSettings): Promise<void>
}
