import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Issue-tracker wire contracts. A workspace can designate ONE issue tracker —
// GitHub Issues, Jira, or Linear — where automated flows (notably the tech-debt
// recurring pipeline's `tracker` step) file the ticket they raise before
// implementation starts. The choice is workspace-level config; the credentials it
// uses come from the existing GitHub App installation (for GitHub) or the
// workspace's Jira/Linear `task_connections` row, so only the selection + the
// per-tracker target (Jira project key / Linear team id) live here.
// ---------------------------------------------------------------------------

export const trackerKindSchema = v.picklist(['github', 'jira', 'linear'])
export type TrackerKind = v.InferOutput<typeof trackerKindSchema>

/** A workspace's issue-tracker selection. `tracker: null` means none configured. */
export const trackerSettingsSchema = v.object({
  tracker: v.nullable(trackerKindSchema),
  /** Jira project key new tickets are filed under (e.g. "ENG"); null unless Jira. */
  jiraProjectKey: v.nullable(v.string()),
  /** Linear team id new issues are created under; null unless Linear. */
  linearTeamId: v.nullable(v.string()),
  /**
   * Writeback: when a task's PR opens, post a comment on the task's linked tracker
   * issue(s). Per-task overridable via `Block.trackerCommentOnPrOpen`; the default a
   * workspace that has set nothing runs on is {@link DEFAULT_TRACKER_WRITEBACK}.
   */
  writebackCommentOnPrOpen: v.boolean(),
  /**
   * Writeback: when a task's PR merges, comment + close the linked tracker issue(s)
   * as resolved (GitHub closes natively; Jira transitions to its Done category).
   * Per-task overridable via `Block.trackerResolveOnMerge`; default
   * {@link DEFAULT_TRACKER_WRITEBACK}.
   */
  writebackResolveOnMerge: v.boolean(),
  /**
   * Writeback: when a HEADLESS run's requirements review parks with open findings, post
   * them — each with its stable finding id — as a comment on the task's linked tracker
   * issue(s), so the loop is answerable from where the work was requested. Per-task
   * overridable via `Block.trackerQuestionsOnPark`; default
   * {@link DEFAULT_TRACKER_WRITEBACK}.
   *
   * Deliberately scoped to runs whose `ExecutionInstance.intakeOrigin` is HEADLESS
   * (`isHeadlessIntake`: a `/api/v1` start or a per-ticket tracker dispatch): a task started
   * in the SPA has a human overseer in the app and its clarification surface is unchanged
   * (see `backend/docs/adr/0047-headless-clarification-loop.md`).
   */
  writebackQuestionsOnPark: v.boolean(),
  updatedAt: v.number(),
})
export type TrackerSettings = v.InferOutput<typeof trackerSettingsSchema>

/** The three writeback actions, as they are spelled on a workspace's settings row. */
export type TrackerWritebackFlags = Pick<
  TrackerSettings,
  'writebackCommentOnPrOpen' | 'writebackResolveOnMerge' | 'writebackQuestionsOnPark'
>

/**
 * What each writeback action does for a workspace that has never set one.
 *
 * **ON, and that is a deliberate change of stance** (it was off for all three). The action only
 * ever touches an issue a task is LINKED to, and nothing links one by accident: a link arrives by
 * an operator importing an issue, by the recurring intake picking one up, or by a headless caller
 * filing a task with `ticket`. Every one of those is a request to work the issue where it was
 * filed, so leaving the loop half-closed by default meant the common outcome was a merged pull
 * request and an issue still sitting open, with nothing on it saying the work had been done. The
 * writeback is what makes the tracker, rather than this platform's own board, the place the
 * reporter can keep watching.
 *
 * ONE constant rather than a literal per reader, because three readers have to agree about it: the
 * settings service (what an absent row reports, and what the row is seeded with on first write),
 * the writeback service (what it does when no row exists), and the SPA's store (what the toggles
 * show before a row does). They disagreed here once already, and the failure is silent both ways
 * round: a reader defaulting off never posts and logs nothing, and one defaulting on closes issues
 * a panel is drawing as off.
 *
 * It is a SEED and never a reset. No write path fills an omitted action in from here: absence means
 * the caller is not moving that action, which is the rule on both the internal PUT and
 * `PATCH /api/v1/tracker/writeback`. Filling one in would make every partial write carry these
 * values into a workspace that had chosen otherwise, and this flip to ON is exactly when that stops
 * being harmless.
 */
export const DEFAULT_TRACKER_WRITEBACK: TrackerWritebackFlags = {
  writebackCommentOnPrOpen: true,
  writebackResolveOnMerge: true,
  writebackQuestionsOnPark: true,
}

/**
 * Set a workspace's issue-tracker FILING selection, and optionally move writeback actions with it.
 *
 * The filing half (`tracker` plus that vendor's target) is a wholesale replace, which is why
 * `tracker` is the one required field: those three are one decision, and a caller editing it has
 * the whole of it in front of them.
 *
 * The writeback half MERGES. An omitted action keeps whatever the row holds, and a caller that
 * names none moves none, which is what lets a dialog about something else (the recurring
 * tech-debt schedule, which persists the filing tracker) touch this row without deciding a
 * workspace's writeback policy as a side effect. A caller that wants
 * {@link DEFAULT_TRACKER_WRITEBACK} sends those values.
 *
 * `PATCH /api/v1/tracker/writeback` is the writeback half on its own, for a caller with no business
 * naming a filing tracker.
 */
export const putTrackerSettingsSchema = v.object({
  tracker: v.nullable(trackerKindSchema),
  jiraProjectKey: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
  linearTeamId: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
  writebackCommentOnPrOpen: v.optional(v.boolean()),
  writebackResolveOnMerge: v.optional(v.boolean()),
  writebackQuestionsOnPark: v.optional(v.boolean()),
})
export type PutTrackerSettingsInput = v.InferOutput<typeof putTrackerSettingsSchema>
