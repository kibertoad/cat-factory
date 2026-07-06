---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
built-in "Claude Opus 4.8" preset (everything `claude-opus`).

- Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
  and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
  `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
  (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
  a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
  merge-preset ones.
- The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
  Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
  (local runs subscription models via the ambient CLI / a leased personal credential). The
  deployment default is applied only at first seed, so a user's later manual default choice is
  always preserved.

Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
(D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
the three stable built-ins are offered via the reseed advisory rather than migrated in place.
