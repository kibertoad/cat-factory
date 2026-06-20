---
'@cat-factory/app': minor
---

Redesign the left panel from draggable palettes into a navbar + command bar. The
draggable block and pipeline palettes are gone; blocks and pipelines are now
created through a ⌘K command bar (`CommandBar.vue`) and the existing task-card /
inspector run affordances. The sidebar becomes navigation: a command-bar
launcher, a Create section (build pipeline / add block), repository management,
integration management (GitHub, document + task sources grouped under
Integrations), a Workspace-context section linking the workspace-wide context
fragment library, and a Configuration section.

Configuration adds two new settings panels: **Merge thresholds**
(`MergeThresholdsPanel.vue`, full CRUD over the merge-preset library) and
**Default models** (`ModelDefaultsPanel.vue`), the per-agent-kind default model
overrides for the workspace — hydrated from the snapshot's `modelDefaults` and
edited via the new `modelDefaults` store against `GET|PUT
/workspaces/:ws/model-defaults`. Saved-pipeline management (list + delete) moved
into the pipeline builder.

Agent-kind icon rendering is consolidated into one safe path: a new
`agentKindMeta()` accessor (total over palette archetypes, the engine "system"
kinds — `ci`/`ci-fixer`/`merger`/`blueprints`/`conflicts` — and unknown/custom
kinds) backs a reusable `AgentKindIcon.vue` used everywhere the pipeline builder
lists steps. This fixes a crash where the saved-pipelines list indexed
`AGENT_BY_KIND` for a system kind present in every seeded pipeline. The default-
models panel also no longer mislabels a pinned-but-uncatalogued model as
"Deployment default".
