import type { TutorialProgress } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence port for one user's in-app tutorial progress (the `tutorial_progress` table,
// PK user_id). The sibling of `UserSettingsRepository`: per-user, self-scoped, no secrets.
//
// The domain depends only on this interface; each facade implements it (D1 / Drizzle). Nothing
// here knows which tours exist — the catalog is SPA data, and a deployment that contributes its
// own tours needs no backend change for its progress to be remembered.
// ---------------------------------------------------------------------------

export interface TutorialProgressRepository {
  /** The user's row, or null when they have never saved one. */
  get(userId: string): Promise<TutorialProgress | null>
  /** Create or replace the user's row. */
  upsert(userId: string, progress: TutorialProgress): Promise<void>
  /**
   * Remove the row entirely (the "Reset progress" action).
   *
   * A DELETE rather than an upsert of the default value, because "never touched the tutorial"
   * and "reset it back to the start" must be the same state: writing a row of defaults would
   * leave a user who reset indistinguishable from one mid-way through in every future read that
   * checks for a row's existence.
   */
  remove(userId: string): Promise<void>
}
