import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Issue-tracker wire contracts. A workspace can designate ONE issue tracker —
// GitHub Issues or Jira — where automated flows (notably the tech-debt recurring
// pipeline's `tracker` step) file the ticket they raise before implementation
// starts. The choice is workspace-level config; the credentials it uses come from
// the existing GitHub App installation (for GitHub) or the workspace's Jira
// `task_connections` row (for Jira), so only the selection + Jira project key live
// here.
// ---------------------------------------------------------------------------

export const trackerKindSchema = v.picklist(['github', 'jira'])
export type TrackerKind = v.InferOutput<typeof trackerKindSchema>

/** A workspace's issue-tracker selection. `tracker: null` means none configured. */
export const trackerSettingsSchema = v.object({
  tracker: v.nullable(trackerKindSchema),
  /** Jira project key new tickets are filed under (e.g. "ENG"); null unless Jira. */
  jiraProjectKey: v.nullable(v.string()),
  updatedAt: v.number(),
})
export type TrackerSettings = v.InferOutput<typeof trackerSettingsSchema>

/** Set a workspace's issue-tracker selection. */
export const putTrackerSettingsSchema = v.object({
  tracker: v.nullable(trackerKindSchema),
  jiraProjectKey: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
})
export type PutTrackerSettingsInput = v.InferOutput<typeof putTrackerSettingsSchema>
