import type { TutorialDecision, TutorialProgress } from '@cat-factory/contracts'
import type { TutorialProgressRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TutorialProgressRow {
  user_id: string
  decision: string | null
  completed_tour_ids: string
  nudged_tour_ids: string
  updated_at: number
}

/**
 * Parse a stored JSON id array LENIENTLY: anything that is not an array of strings reads as
 * empty.
 *
 * The row is composed by a browser, so a value that fails to parse means a client or a migration
 * wrote something unexpected. Throwing here would take down the workspace snapshot this is read
 * as part of, over a tutorial-progress list — the correct degradation is to forget the
 * walkthroughs, which costs a re-offer, not the board.
 */
function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    // silent-catch-ok: a malformed list degrades to "no tours remembered"; the fallback IS the
    // report, and there is nothing an operator would do about one row of client-authored JSON.
    return []
  }
}

/**
 * The stored decision, narrowed against the closed vocabulary. An unrecognised value reads as
 * "never answered", so a retired member cannot be spliced into the SPA's state as a decision it
 * has no branch for.
 */
function parseDecision(raw: string | null): TutorialDecision | null {
  return raw === 'accepted' || raw === 'declined' ? raw : null
}

function rowToProgress(row: TutorialProgressRow): TutorialProgress {
  return {
    decision: parseDecision(row.decision),
    completedTourIds: parseIds(row.completed_tour_ids),
    nudgedTourIds: parseIds(row.nudged_tour_ids),
  }
}

/** D1-backed per-user tutorial progress (migration 0080). */
export class D1TutorialProgressRepository implements TutorialProgressRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(userId: string): Promise<TutorialProgress | null> {
    const row = await this.db
      .prepare('SELECT * FROM tutorial_progress WHERE user_id = ?')
      .bind(userId)
      .first<TutorialProgressRow>()
    return row ? rowToProgress(row) : null
  }

  async upsert(userId: string, progress: TutorialProgress): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tutorial_progress
           (user_id, decision, completed_tour_ids, nudged_tour_ids, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           decision = excluded.decision,
           completed_tour_ids = excluded.completed_tour_ids,
           nudged_tour_ids = excluded.nudged_tour_ids,
           updated_at = excluded.updated_at`,
      )
      .bind(
        userId,
        progress.decision,
        JSON.stringify(progress.completedTourIds),
        JSON.stringify(progress.nudgedTourIds),
        Date.now(),
      )
      .run()
  }

  async remove(userId: string): Promise<void> {
    await this.db.prepare('DELETE FROM tutorial_progress WHERE user_id = ?').bind(userId).run()
  }
}
