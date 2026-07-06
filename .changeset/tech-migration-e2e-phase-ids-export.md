---
'@cat-factory/agents': patch
---

Re-export the canonical migration phase-id constants (`MIGRATION_PHASE_IDS`,
`MIGRATION_PHASE_ID_ORDER`, and the `MigrationPhaseId` type) from the package index. They are the
contract shared by the tech-migration preset's `phaseTemplate`, its `promptAdditions`, and
`seedMigrationPlan`; exporting them lets the migration end-to-end test reference the ids by import
rather than retyping strings that could silently drift from the template the ingest normalizer
matches on. Additive — no behaviour change.
