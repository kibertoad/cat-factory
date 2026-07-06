---
'@cat-factory/agents': minor
---

Register `preset_tech_migration`, the Technological-migration initiative preset (tech-migration slice
T8) — the second real consumer of the initiative-preset primitives and the one that proves "preset as
a mandated multi-phase methodology". It is pure WIRING that composes the already-landed migration
pieces: a create-time FORM (which migration, from/to tech, stored-proc policy, compat posture,
coverage bar, migration docs dir), the interviewer-driven `pl_initiative` planning pipeline
(`interview: 'full'`, `humanReviewDefault: true`), a declarative five-phase `phaseTemplate`
(blast-zone → coverage → transition-design → delivery → verify-decommission, all required, no extras)
enforced by the generic ingest normalizer, the conservative execution policy (`maxConcurrent: 2`,
`pl_quick` default escalating risky/complex items to `pl_full`, `onMissingEstimate: 'strongest'`),
`seedMigrationPlan` (T7) as its `seedPlan` for per-item spawn decoration + the confidence-case
control point, the T5 methodology `promptAdditions` for the interviewer/analyst/planner, and the
full T4 `MIGRATION_FRAGMENT_IDS` as `defaultFragmentIds`. It registers as an import side effect (the
docs-refresh / `@cat-factory/gates` pattern) so both runtimes pick it up with no per-facade wiring,
and carries NO `detect` hook (its derived `probe` is false — a create-time probe could read only the
FROM-side stack, which the analyst rediscovers far more thoroughly at planning time).
