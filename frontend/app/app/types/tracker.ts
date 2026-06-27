// Issue-tracker selection shapes, mirroring `@cat-factory/contracts` (tracker.ts).
// A workspace designates one tracker — GitHub Issues or Jira — where the tech-debt
// recurring pipeline files its ticket before implementation starts.
//
// All wire shapes are sourced from @cat-factory/contracts (single source of truth).

export type {
  TrackerKind,
  TrackerSettings,
  PutTrackerSettingsInput,
  WritebackOverride,
} from '@cat-factory/contracts'
