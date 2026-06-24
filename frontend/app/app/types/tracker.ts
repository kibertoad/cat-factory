// Issue-tracker selection shapes, mirroring `@cat-factory/contracts` (tracker.ts).
// A workspace designates one tracker — GitHub Issues or Jira — where the tech-debt
// recurring pipeline files its ticket before implementation starts.

export type TrackerKind = 'github' | 'jira'

export interface TrackerSettings {
  /** The selected tracker, or null when none is configured. */
  tracker: TrackerKind | null
  /** Jira project key new tickets are filed under (e.g. 'ENG'); null unless Jira. */
  jiraProjectKey: string | null
  /** Writeback: comment on a task's linked issue when its PR opens. Per-task overridable. */
  writebackCommentOnPrOpen: boolean
  /** Writeback: comment + close a task's linked issue as resolved when its PR merges. */
  writebackResolveOnMerge: boolean
  updatedAt: number
}

export interface PutTrackerSettingsInput {
  tracker: TrackerKind | null
  jiraProjectKey?: string | null
  writebackCommentOnPrOpen?: boolean
  writebackResolveOnMerge?: boolean
}

/** Per-task writeback override; absent ⇒ inherit the workspace setting. */
export type WritebackOverride = 'on' | 'off'
