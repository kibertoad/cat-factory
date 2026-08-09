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
   * issue(s). Per-task overridable via `Block.trackerCommentOnPrOpen`. Default off.
   */
  writebackCommentOnPrOpen: v.boolean(),
  /**
   * Writeback: when a task's PR merges, comment + close the linked tracker issue(s)
   * as resolved (GitHub closes natively; Jira transitions to its Done category).
   * Per-task overridable via `Block.trackerResolveOnMerge`. Default off.
   */
  writebackResolveOnMerge: v.boolean(),
  /**
   * Writeback: when a HEADLESS run's requirements review parks with open findings, post
   * them — each with its stable finding id — as a comment on the task's linked tracker
   * issue(s), so the loop is answerable from where the work was requested. Per-task
   * overridable via `Block.trackerQuestionsOnPark`. Default off.
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

/** Set a workspace's issue-tracker selection. */
export const putTrackerSettingsSchema = v.object({
  tracker: v.nullable(trackerKindSchema),
  jiraProjectKey: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
  linearTeamId: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
  writebackCommentOnPrOpen: v.optional(v.boolean()),
  writebackResolveOnMerge: v.optional(v.boolean()),
  writebackQuestionsOnPark: v.optional(v.boolean()),
})
export type PutTrackerSettingsInput = v.InferOutput<typeof putTrackerSettingsSchema>
