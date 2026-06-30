---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Add a built-in "Manual review only" merge-threshold preset and reseeding for the
merge-preset catalog (mirroring pipelines).

- "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
  never auto-merges a task using it — every PR is routed to a human `merge_review`
  notification regardless of the assessment scores. The flag is editable on any preset via
  a toggle in the Merge thresholds settings.
- Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
  monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
  SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
  new built-in appeared upstream, offering a one-click reseed
  (`POST /workspaces/:ws/merge-presets/:id/reseed`).

Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
(default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
seeds the whole built-in catalog (Balanced + Manual review only), not just the default.
