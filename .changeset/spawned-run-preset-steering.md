---
'@cat-factory/orchestration': patch
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/kernel': patch
---

Initiatives: an initiative preset's per-agent-kind `promptAddition` now reaches the
runs SPAWNED by that initiative (a task's coder / tester / custom kind), not only the
initiative's own planning run. The `AgentContextBuilder` resolves the preset's steering
for any block carrying `initiativeId` (gated on it, so plain tasks pay nothing), and a
shared `initiativePresetSection` renderer folds the `## Initiative preset:` steering into
the standard-phase, generic custom-kind, and planning prompts alike. This is the vehicle
for an org to attach standing role/task methodology to built-in agents without forking
them (slice 1 of the custom-initiative-definitions initiative). No behaviour changes for
non-initiative runs — their prompts stay byte-for-byte identical.
