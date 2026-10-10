import type {
  TrackerSettings,
  TrackerSettingsPatch,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TrackerRow {
  tracker: string | null
  jira_project_key: string | null
  linear_team_id: string | null
  writeback_comment_on_pr_open: number
  writeback_resolve_on_merge: number
  writeback_questions_on_park: number
  updated_at: number
}

/**
 * Every settable field and the column it lands in.
 *
 * A `Record` over the patch's own key union, so a field added to `TrackerSettings` fails to COMPILE
 * here rather than being silently dropped by a merge that never names its column. The sibling
 * Drizzle repository carries the same table for the same reason.
 */
const COLUMNS: Record<keyof Required<TrackerSettingsPatch>, string> = {
  tracker: 'tracker',
  jiraProjectKey: 'jira_project_key',
  linearTeamId: 'linear_team_id',
  writebackCommentOnPrOpen: 'writeback_comment_on_pr_open',
  writebackResolveOnMerge: 'writeback_resolve_on_merge',
  writebackQuestionsOnPark: 'writeback_questions_on_park',
}

const FIELDS = Object.keys(COLUMNS) as (keyof Required<TrackerSettingsPatch>)[]

/** A workspace's issue-tracker selection, one row per workspace (migration 0029). */
export class D1TrackerSettingsRepository implements TrackerSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<TrackerSettings | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tracker_settings WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<TrackerRow>()
    return row ? toSettings(row) : null
  }

  async merge(
    workspaceId: string,
    patch: TrackerSettingsPatch,
    defaults: Omit<TrackerSettings, 'updatedAt'>,
    updatedAt: number,
  ): Promise<TrackerSettings> {
    // The INSERT carries a complete row (the defaults, overlaid with whatever the patch names) and
    // the conflict branch touches ONLY the named columns. That is what makes the merge atomic: an
    // unnamed column is never read up into this process and written back, so a concurrent writer
    // naming a different one cannot be clobbered by a value that was stale before it was written.
    const inserted = { ...defaults, ...patch }
    const assignments = FIELDS.filter((field) => patch[field] !== undefined)
      .map((field) => `${COLUMNS[field]} = excluded.${COLUMNS[field]}`)
      .concat('updated_at = excluded.updated_at')
    const row = await this.db
      .prepare(
        `INSERT INTO tracker_settings
           (workspace_id, ${FIELDS.map((field) => COLUMNS[field]).join(', ')}, updated_at)
         VALUES (?, ${FIELDS.map(() => '?').join(', ')}, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET ${assignments.join(', ')}
         RETURNING *`,
      )
      .bind(workspaceId, ...FIELDS.map((field) => encode(inserted[field])), updatedAt)
      .first<TrackerRow>()
    if (!row) {
      throw new Error(
        `Writing tracker settings for workspace ${workspaceId} returned no row, so what the ` +
          `store now holds cannot be reported.`,
      )
    }
    return toSettings(row)
  }
}

/**
 * One field's value as SQLite stores it.
 *
 * Total over what a settable field can hold today, which is how a field of a new SHAPE (a number, a
 * JSON column) is caught: it fails to compile here rather than binding something SQLite coerces.
 */
function encode(value: string | boolean | null): string | number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value
}

function toSettings(row: TrackerRow): TrackerSettings {
  return {
    tracker: (row.tracker as TrackerSettings['tracker']) ?? null,
    jiraProjectKey: row.jira_project_key,
    linearTeamId: row.linear_team_id,
    writebackCommentOnPrOpen: row.writeback_comment_on_pr_open === 1,
    writebackResolveOnMerge: row.writeback_resolve_on_merge === 1,
    writebackQuestionsOnPark: row.writeback_questions_on_park === 1,
    updatedAt: row.updated_at,
  }
}
