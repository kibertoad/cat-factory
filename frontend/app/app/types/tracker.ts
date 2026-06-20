// Issue-tracker selection shapes, mirroring `@cat-factory/contracts` (tracker.ts).
// A workspace designates one tracker — GitHub Issues or Jira — where the tech-debt
// recurring pipeline files its ticket before implementation starts.

export type TrackerKind = 'github' | 'jira'

export interface TrackerSettings {
  /** The selected tracker, or null when none is configured. */
  tracker: TrackerKind | null
  /** Jira project key new tickets are filed under (e.g. 'ENG'); null unless Jira. */
  jiraProjectKey: string | null
  updatedAt: number
}

export interface PutTrackerSettingsInput {
  tracker: TrackerKind | null
  jiraProjectKey?: string | null
}
