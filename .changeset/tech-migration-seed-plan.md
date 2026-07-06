---
'@cat-factory/agents': minor
'@cat-factory/prompt-fragments': minor
---

Add `seedMigrationPlan`, the `preset_tech_migration` plan post-processor (tech-migration slice T7),
landed unwired ahead of the preset registration (T8). Running at ingest after the generic
phase-template normalizer, it stamps per-item spawn DECORATION keyed off each item's migration phase:
the blast-zone report + transition-design document(s) become `document` tasks with `.md` target paths
under the frozen `migrationDocsDir` on the doc-quick pipeline; coverage/delivery/verify items stay
ordinary coding tasks routed by the policy's estimate rules. It wires the phase-2 confidence case — a
single human-gated `confidence-case.md` document that `dependsOn` every surviving coverage item,
canonicalizing a planner-authored one or injecting it when omitted — caps phase-2 coverage at eight
items (scrubbing dropped ids from every surviving `dependsOn`), and applies the human-review gate
policy (confidence-case + transition-design are always gated as the coverage→delivery control points;
`humanReview` additionally gates the informational blast-zone report). Every spawned item carries the
`migration.*` fragments, now exposed as `MIGRATION_FRAGMENT_IDS` from `@cat-factory/prompt-fragments`
(derived from the fragment definitions, the single source of truth T8's `defaultFragmentIds` reuses).
Pure + total; no runtime behaviour changes until T8 registers the preset.
